/**
 * chrome-profile.js — 找出用户的 Chrome / Edge 里，这个扩展到底装在哪、什么版本。
 *
 * 为什么不用扩展自己上报路径：Chrome 的扩展跑在沙箱里，没有任何文件系统 API，
 * 它连自己加载自哪个目录都不知道。但 **Chrome 知道**，而且把路径写在一个位置固定的
 * 配置文件里。
 *
 * ⚠️ 关键：扩展配置**不在** `Preferences`，而在 **`Secure Preferences`**
 *    （`Preferences` 里的 `extensions.settings` 是空的，实测如此）。
 *    两个文件都在 `<User Data>\<Profile>\` 下。
 *
 * 实测拿到的条目形状（Chrome 157，unpacked 扩展）：
 *   path                                : 加载目录（绝对路径）
 *   location                            : 4 = UNPACKED
 *   incognito                           : 无痕可用开关  ← 用户说的"参数"就在这，不在扩展目录
 *   newAllowFileAccess                  : 允许访问文件网址
 *   service_worker_registration_info.version : Chrome 上次加载时的版本
 *   没有 `state` / `manifest` 字段（新版本已改结构）
 *
 * 注意：**只读不写**。`Secure Preferences` 带 HMAC 校验，改动会被 Chrome 判定为
 * 配置篡改。我们只读它找路径，写的是扩展目录本身。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { idFromPublicKey } from './protocol.js'

/** Chrome 系的 User Data 根目录（含 Edge / Chromium） */
const BROWSERS = [
  {
    name: 'Chrome',
    userData: () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'),
  },
  {
    name: 'Edge',
    userData: () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data'),
  },
  {
    name: 'Chromium',
    userData: () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Chromium', 'User Data'),
  },
]

/** 扩展配置所在的文件，按优先级排列 */
const CONFIG_FILES = ['Secure Preferences', 'Preferences']

/** profile 目录名：Default、Profile 1、Profile 2… */
function listProfileDirs(userDataDir) {
  let entries
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => n === 'Default' || /^Profile \d+$/.test(n))
}

/**
 * 读一个 JSON 配置文件。
 * Chrome 写这些文件不是原子的，解析可能失败；重试几次再放弃，别一次失败就当成"没安装"。
 */
function readJsonFile(file, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e?.code === 'ENOENT') return null
      if (i === attempts - 1) return null
      const until = Date.now() + 120
      while (Date.now() < until) { /* 短暂等待 Chrome 写完 */ }
    }
  }
  return null
}

/** 从优先级最高且包含目标扩展的配置读取记录。 */
function readProfileEntry(profileDir, extensionId) {
  for (const name of CONFIG_FILES) {
    const json = readJsonFile(path.join(profileDir, name))
    const entry = json?.extensions?.settings?.[extensionId]
    if (entry) return { file: name, entry }
  }
  return null
}

/** 只接受 Chromium 支持的版本格式，避免误判版本或把它当成路径。 */
export function isExtensionVersion(version) {
  return typeof version === 'string' &&
    /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version) &&
    version.split('.').every((part) => Number(part) <= 65535) &&
    version.split('.').some((part) => Number(part) !== 0)
}

/** 读取清单并用公钥验证扩展身份，供下载和本机目录共用。 */
export function readExtensionManifest(extPath) {
  if (!extPath) return null
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'))
    return {
      version: isExtensionVersion(mf?.version) ? mf.version : null,
      id: typeof mf?.key === 'string' && mf.key
        ? idFromPublicKey(Buffer.from(mf.key, 'base64')) : null,
    }
  } catch {
    return null
  }
}

/** 把 Preferences 里记的 path 规整成绝对路径 */
function normalizeExtPath(p, userDataDir) {
  if (typeof p !== 'string' || !p) return null
  if (path.isAbsolute(p)) return p
  return path.resolve(userDataDir, p)
}

/**
 * 在所有已知浏览器、所有 profile 里找这个扩展。
 *
 * @param {string} extensionId 扩展 ID
 * @param {object} [opts]
 * @param {string[]} [opts.onlyBrowsers] 只查这些浏览器，例如 ['Chrome']
 * @returns {Array<object>} 每个安装点一条
 */
export function findExtensionInstallations(extensionId, opts = {}) {
  const results = []
  const only = opts.onlyBrowsers ? new Set(opts.onlyBrowsers) : null

  for (const browser of BROWSERS) {
    if (only && !only.has(browser.name)) continue
    const userDataDir = browser.userData()
    if (!fs.existsSync(userDataDir)) continue

    for (const profile of listProfileDirs(userDataDir)) {
      const profileDir = path.join(userDataDir, profile)
      const cfg = readProfileEntry(profileDir, extensionId)
      if (!cfg) continue
      const { entry } = cfg

      const extPath = normalizeExtPath(entry.path, userDataDir)
      const manifest = readExtensionManifest(extPath)
      const diskVersion = manifest?.version ?? null
      const recorded = entry?.service_worker_registration_info?.version || entry?.manifest?.version
      const recordedVersion = isExtensionVersion(recorded) ? recorded : null

      // 磁盘版本优先：它反映文件现状。两者不同就说明"文件换了但还没重载"。
      const version = diskVersion || recordedVersion

      results.push({
        browser: browser.name,
        profile,
        configFile: cfg.file,
        path: extPath,
        version,
        recordedVersion,
        diskVersion,
        /** 文件已更新但 Chrome 还在跑旧版本 —— 这种只需要重载，不需要重新下载 */
        pendingReload: Boolean(manifest?.id === extensionId && diskVersion && recordedVersion &&
          compareVersions(diskVersion, recordedVersion) > 0),
        enabled: !(Array.isArray(entry.disable_reasons) && entry.disable_reasons.length) && entry.state !== 0,
        incognito: entry.incognito === true,
        allowFileAccess: entry.newAllowFileAccess === true,
        fromWebstore: entry.from_webstore === true,
        location: entry.location ?? null, // 4 = UNPACKED
      })
    }
  }

  return results
}

/**
 * 汇总一次：所有安装点里最低的那个版本，用于判断"要不要提示更新"。
 *
 * 规则（用户定的，只升不降）：
 *  - 一个都没装                 → installed: false
 *  - 有任何一个低于推荐版本      → needsUpdate: true，lowest 是最低的那个
 *  - 全都 >= 推荐版本            → needsUpdate: false（用户改高版本号也不提示）
 */
export function summarize(installations, targetVersion) {
  if (!installations.length) {
    return { installed: false, needsUpdate: false, lowest: null, instances: [] }
  }

  const withVersion = installations.filter((i) => i.version)
  if (!withVersion.length) {
    return { installed: true, needsUpdate: true, lowest: null, instances: installations, unknownVersion: true }
  }

  let lowest = withVersion[0]
  for (const inst of withVersion) {
    if (compareVersions(inst.version, lowest.version) < 0) lowest = inst
  }

  const needsUpdate = targetVersion ? compareVersions(lowest.version, targetVersion) < 0 : false
  const pendingReloadOnly = !needsUpdate && installations.some((i) => i.pendingReload && i.enabled !== false)
  return { installed: true, needsUpdate, lowest: lowest.version, lowestInstance: lowest, instances: installations, pendingReloadOnly }
}

/**
 * 语义化版本比较（处理 x.y.z 和 x.y.z-pre）。返回 -1 / 0 / 1。
 *
 * 字符串比较在这里是错的：`"0.1.10" < "0.1.9"` 按字符成立，按版本不成立。
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '')
    const [core, pre = ''] = s.split('-', 2)
    const nums = core.split('.').map((n) => {
      const x = parseInt(n, 10)
      return Number.isFinite(x) ? x : 0
    })
    while (nums.length < 3) nums.push(0)
    return { nums, pre }
  }

  const A = parse(a)
  const B = parse(b)

  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const left = A.nums[i] ?? 0
    const right = B.nums[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }

  if (A.pre && !B.pre) return -1
  if (!A.pre && B.pre) return 1
  if (A.pre === B.pre) return 0
  return A.pre < B.pre ? -1 : 1
}
