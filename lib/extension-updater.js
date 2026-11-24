/**
 * extension-updater.js — 扩展的版本检查、下载、解压、安装。
 *
 * 设计前提（用户定的）：
 *  - 扩展**不进插件包**，发布在 GitHub Releases，一个版本一个 zip，旧版全部保留
 *  - 只在用户版本**低于**推荐版本时提示；用户改高版本号（自己动过）就完全不碰
 *  - 已装过的用户：逐个更新通过核验的旧版解压目录，扩展自行重载
 *  - 没装过的用户：解压到固定目录，前端展示路径 + 手动加载指引（Chrome 137+ 的硬限制）
 *
 * 进度用内存状态 + 轮询，不做流式推送 —— 前端每秒读一次比处理事件流简单也可靠。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PLUGIN_PROTOCOL } from './protocol.js'
import { compareVersions, findExtensionInstallations, isExtensionVersion, readExtensionManifest, summarize } from './chrome-profile.js'

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-human-browser')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
/** 没装过时，扩展解压到这个固定目录，引导用户从这里加载 */
const FALLBACK_EXT_DIR = path.join(DATA_DIR, 'extension')
/** 下载与解压的临时区 */
const WORK_DIR = path.join(DATA_DIR, 'update-work')

const DISMISS_MS = 24 * 60 * 60 * 1000
const RECOMMENDATION_TTL = 5 * 60 * 1000
const SHA256 = /^[a-f0-9]{64}$/
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/

/** 递归列出目录下所有文件的相对路径（正斜杠统一） */
function listFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel)
      else if (e.isFile()) out.push(childRel)
      else throw new Error(`扩展包包含不支持的文件类型：${childRel}`)
    }
  }
  walk(root, '')
  return out
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const next = { ...readState(), ...patch }
    // 先写临时文件再替换，避免半个 JSON
    const tmp = `${STATE_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
    return next
  } catch {
    return readState()
  }
}

/**
 * 用 PowerShell 的 .NET API 解压。
 *
 * 路径里有中文，直接拼进 -Command 会被 PowerShell 的编码坑到，所以走 base64 传参，
 * 让 PowerShell 解回 UTF-8 字符串 —— 这一步能省掉整类"路径乱码导致找不到文件"的问题。
 */
function unzipTo(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(zipPath)}'))`,
    `$dst = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(destDir)}'))`,
    // 调用方准备空的临时目录，使用 Windows PowerShell 5.1 支持的两参重载。
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dst)',
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'pipe',
    timeout: 60_000,
  })
}

/** 只跟随已解析的安装目录，拒绝安装文件路径下的链接或非普通文件。 */
function safeDestination(root, rel) {
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (rootStat && !rootStat.isDirectory()) throw new Error(`扩展安装目录已改变：${root}`)
  const parts = rel.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stat && !(index === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
      throw new Error(`扩展目录存在不能覆盖的路径：${current}`)
    }
  }
  return current
}

/** 在同一磁盘备齐新文件和旧文件副本，准备失败时原目录尚未写入。 */
function prepareInstall(sourceDir, target, files) {
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.dsh-hb-update-'))
  const changes = []
  const createdDirs = new Set()
  for (const [index, rel] of files.entries()) {
    try {
      const dest = safeDestination(target, rel)
      const next = path.join(stage, `new-${index}`)
      const previous = fs.existsSync(dest) ? path.join(stage, `old-${index}`) : null
      fs.copyFileSync(path.join(sourceDir, rel), next)
      if (previous) fs.copyFileSync(dest, previous)
      changes.push({ rel, dest, next, previous, applied: false })
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true })
      throw error
    }
  }
  return { target, stage, changes, createdDirs, preserveStage: false }
}

/** 提交时先写资源，最后才替换 manifest，让运行中的扩展看到完整的新版本。 */
function commitInstall(plan) {
  for (const change of plan.changes) {
    safeDestination(plan.target, change.rel)
    const parent = path.dirname(change.dest)
    for (let dir = parent; !fs.existsSync(dir); dir = path.dirname(dir)) plan.createdDirs.add(dir)
    fs.mkdirSync(parent, { recursive: true })
    fs.renameSync(change.next, change.dest)
    change.applied = true
  }
}

/** 按提交的逆序恢复，恢复失败时保留该目录的原文件副本及其位置。 */
function rollbackInstall(plan) {
  const errors = []
  for (const { dest, previous, applied } of [...plan.changes].reverse()) {
    if (!applied) continue
    try {
      if (previous) fs.renameSync(previous, dest)
      else fs.unlinkSync(dest)
    } catch (error) {
      errors.push(`${dest}${previous ? `（副本 ${path.basename(previous)}）` : ''}：${error.message}`)
    }
  }
  for (const dir of [...plan.createdDirs].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(dir) } catch {}
  }
  plan.preserveStage = errors.length > 0
  return errors.length ? [`旧文件副本保留在 ${plan.stage}（${errors.join('；')}）`] : []
}

/** 只处理身份已确认的旧版解压目录。多个配置共享的目录只改一次。 */
function updateTargets(installations, version, extensionId) {
  const targets = new Map()
  const newer = new Set()
  for (const inst of installations) {
    if (!inst.path || !inst.diskVersion || inst.location !== 4 || inst.fromWebstore) continue
    const target = fs.realpathSync(inst.path)
    const manifest = readExtensionManifest(target)
    if (manifest?.id !== extensionId || !manifest.version) continue
    const key = process.platform === 'win32' ? target.toLowerCase() : target
    if (inst.recordedVersion && compareVersions(inst.recordedVersion, version) > 0) newer.add(key)
    if (compareVersions(manifest.version, version) < 0) targets.set(key, target)
  }
  return [...targets].filter(([key]) => !newer.has(key)).map(([, target]) => target)
}

export class ExtensionUpdater {
  /**
   * @param {object} opts
   * @param {string} opts.extensionId      扩展 ID（manifest 里 key 推导出的那个）
   * @param {string} opts.extensionVersionFile  插件包内 extension-version.json 的路径
   * @param {(s:string)=>void} [opts.log]
   */
  constructor({ extensionId, extensionVersionFile, log = () => {} }) {
    this.extensionId = extensionId
    this.extensionVersionFile = extensionVersionFile
    this.log = log

    /** @type {{stage:string, progress:number, error:string|null, installedPath:string|null, needsManualLoad:boolean}} */
    this.progress = { stage: 'idle', progress: 0, error: null, installedPath: null, needsManualLoad: false }
    this.running = false
    this.recommendation = null
    this.refreshing = null
    this.refreshAfter = 0
  }

  /** 读取随 DSH 包分发的扩展推荐，也是网络不可用时的回退值。 */
  readBundledRelease() {
    try {
      const j = JSON.parse(fs.readFileSync(this.extensionVersionFile, 'utf8'))
      return {
        version: isExtensionVersion(j.extensionVersion) ? j.extensionVersion : null,
        repo: typeof j.repository === 'string' && GITHUB_REPO.test(j.repository) ? j.repository : null,
        releaseNotes: typeof j.releaseNotes === 'string' ? j.releaseNotes : '',
        tag: j.extensionTag,
        sha256: typeof j.sha256 === 'string' && SHA256.test(j.sha256) ? j.sha256 : null,
        trackRecommendation: j.trackRecommendation === true,
      }
    } catch (e) {
      this.log(`读 extension-version.json 失败：${e?.message}`)
      return { version: null, repo: null, releaseNotes: '' }
    }
  }

  /** 扩展可独立发布。线上推荐必须匹配当前协议和扩展 ID，并提供 ZIP 校验值。 */
  async refreshReleaseInfo() {
    const local = this.readBundledRelease()
    if (!local.trackRecommendation || !local.repo || !local.version || Date.now() < this.refreshAfter) return
    if (!this.refreshing) {
      this.refreshing = this.fetchRecommendation(local).finally(() => {
        this.refreshAfter = Date.now() + RECOMMENDATION_TTL
        this.refreshing = null
      })
    }
    await this.refreshing
  }

  /** 只从随包指定的仓库读取推荐，网络失败时保留最近的有效推荐。 */
  async fetchRecommendation(local) {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${local.repo}/main/extension-version.json`, {
        redirect: 'error', signal: AbortSignal.timeout(3500),
      })
      if (!response.ok) return
      const info = await response.json()
      const version = info.extensionVersion
      if (info.repository !== local.repo || info.extensionId !== this.extensionId || info.protocol !== PLUGIN_PROTOCOL ||
          !isExtensionVersion(version) || compareVersions(version, this.recommendation?.version ?? local.version) < 0 ||
          ![`v${version}`, `extension-v${version}`].includes(info.extensionTag) ||
          typeof info.sha256 !== 'string' || !SHA256.test(info.sha256)) return
      this.recommendation = {
        version, repo: local.repo, tag: info.extensionTag, sha256: info.sha256,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      }
    } catch (error) {
      this.log(`检查线上扩展推荐失败：${error.message}`)
    }
  }

  /** 固定扩展标签和资产名。旧元数据继续使用 v<扩展版本>。 */
  downloadUrl(repo, version, tag = `v${version}`) {
    if (!repo || !version) return null
    if (tag !== `v${version}` && tag !== `extension-v${version}`) return null
    return `https://github.com/${repo}/releases/download/${tag}/dsh-human-browser-extension-${version}.zip`
  }

  /** 当前状态（前端轮询这个） */
  getStatus() {
    const rel = this.recommendation ?? this.readBundledRelease()
    const installations = findExtensionInstallations(this.extensionId)
    const sum = summarize(installations, rel.version)
    const state = readState()

    const dismissedUntil = state.dismissedUntil || null
    const dismissedVersion = state.dismissedVersion || null
    // 只有"同一个目标版本"才算是被忽略过
    const stillDismissed =
      dismissedUntil && dismissedVersion === rel.version && Date.now() < Date.parse(dismissedUntil)

    return {
      installed: sum.installed,
      userVersion: sum.lowest,
      targetVersion: rel.version,
      needsUpdate: sum.needsUpdate,
      pendingReloadOnly: Boolean(sum.pendingReloadOnly && !sum.needsUpdate),
      releaseNotes: rel.releaseNotes,
      downloadUrl: this.downloadUrl(rel.repo, rel.version, rel.tag),
      dismissedUntil: stillDismissed ? dismissedUntil : null,
      profiles: installations.map((i) => ({
        browser: i.browser,
        profile: i.profile,
        version: i.version,
        enabled: i.enabled,
        incognito: i.incognito,
      })),
    }
  }

  getProgress() {
    return { ...this.progress }
  }

  dismiss(version) {
    const until = new Date(Date.now() + DISMISS_MS).toISOString()
    writeState({ dismissedVersion: version || null, dismissedUntil: until })
    return { ok: true, until }
  }

  /** 启动安装（立即返回，真正的活在后台跑） */
  startInstall() {
    if (this.running) return { started: false, reason: 'already-running' }
    this.running = true
    this.progress = { stage: 'downloading', progress: 0, error: null, installedPath: null, needsManualLoad: false }
    this._run().finally(() => {
      this.running = false
    })
    return { started: true }
  }

  async _run() {
    let work
    const plans = []
    try {
      await this.refreshReleaseInfo()
      const rel = this.recommendation ?? this.readBundledRelease()
      if (!rel.version || !rel.repo) throw new Error('插件包里的 extension-version.json 不完整')

      const plan = this.planInstall(rel.version)
      if (!plan.targets.length) return this.finishInstall(rel.version, plan)
      const url = this.downloadUrl(rel.repo, rel.version, rel.tag)
      if (!url) throw new Error('拼不出下载地址（repository 或 version 缺失）')

      fs.mkdirSync(WORK_DIR, { recursive: true })
      work = fs.mkdtempSync(path.join(WORK_DIR, 'install-'))
      const zipPath = path.join(work, 'extension.zip')
      const extractDir = path.join(work, 'extension')

      this.log(`开始下载 ${url}`)
      await this._download(url, zipPath, rel.sha256, (p) => {
        this.progress.progress = Math.min(99, p)
      })

      this.progress.stage = 'installing'
      this.progress.progress = 0
      unzipTo(zipPath, extractDir)

      // zip 里可能多套一层目录，自动认一下
      const sourceDir = this._findManifestDir(extractDir)
      if (!sourceDir) throw new Error('解压后找不到 manifest.json')
      const manifest = readExtensionManifest(sourceDir)
      if (manifest?.id !== this.extensionId) throw new Error('下载的扩展公钥与预期 ID 不符')
      if (manifest.version !== rel.version) throw new Error(`下载的扩展版本不是 ${rel.version}`)

      // 下载期间浏览器配置可能改变，写入前按当前目录和版本重新决策。
      const current = this.planInstall(rel.version)
      const files = listFiles(sourceDir).filter((file) => file !== 'manifest.json').concat('manifest.json')
      for (const target of current.targets) plans.push(prepareInstall(sourceDir, target, files))
      for (const prepared of plans) commitInstall(prepared)
      this.finishInstall(rel.version, current)
    } catch (e) {
      const rollbackErrors = plans.reverse().flatMap(rollbackInstall)
      const msg = [e?.message || String(e), ...rollbackErrors].join('；')
      this.log(`安装失败：${msg}`)
      writeState({ lastInstall: { at: new Date().toISOString(), ok: false, error: msg } })
      this.progress = {
        stage: 'error',
        progress: 0,
        error: msg,
        installedPath: null,
        needsManualLoad: false,
      }
    } finally {
      for (const prepared of plans) {
        if (!prepared.preserveStage) {
          try { fs.rmSync(prepared.stage, { recursive: true, force: true }) } catch {}
        }
      }
      if (work) {
        try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
        try { fs.rmdirSync(WORK_DIR) } catch {}
      }
    }
  }

  /** 查明需要写入的目录，首装时允许复用已安全解压的同版或更高版本。 */
  planInstall(version) {
    const installations = findExtensionInstallations(this.extensionId)
    const sum = summarize(installations, version)
    if (!sum.installed) {
      const existing = fs.lstatSync(FALLBACK_EXT_DIR, { throwIfNoEntry: false })
      const manifest = existing?.isDirectory() && readExtensionManifest(FALLBACK_EXT_DIR)
      if (existing && (!existing.isDirectory() ||
          ((!manifest?.version || manifest.id !== this.extensionId) && fs.readdirSync(FALLBACK_EXT_DIR).length))) {
        throw new Error(`首装目录已有无法验证的内容，请检查目录后重试：${FALLBACK_EXT_DIR}`)
      }
      const reuse = manifest?.version && compareVersions(manifest.version, version) >= 0
      return { targets: reuse ? [] : [FALLBACK_EXT_DIR], installedPath: FALLBACK_EXT_DIR, needsManualLoad: true }
    }
    const targets = updateTargets(installations, version, this.extensionId)
    if (sum.needsUpdate && !targets.length) {
      throw new Error('找到了旧版或版本未知的扩展，但无法验证可安全更新的解压目录。请检查 chrome://extensions 中的安装路径。')
    }
    return { targets, installedPath: targets[0] ?? sum.lowestInstance?.path ?? null, needsManualLoad: false }
  }

  /** 保留最后一次终态，等下一次安装取代它，避免休眠后恢复轮询时丢失结果。 */
  finishInstall(version, { targets, installedPath, needsManualLoad }) {
    if (targets.length) {
      writeState({ lastInstall: { at: new Date().toISOString(), version, ok: true, path: installedPath } })
      this.log(`扩展 ${version} 安装完成 → ${installedPath}`)
    }
    this.progress = { stage: 'done', progress: 100, error: null, installedPath, needsManualLoad }
  }

  /** 在解压结果里找含 manifest.json 的那一层（兼容 zip 里套了一层目录的情况） */
  _findManifestDir(dir) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const sub = path.join(dir, e.name)
      if (fs.existsSync(path.join(sub, 'manifest.json'))) return sub
    }
    return null
  }

  /** 流式下载并上报百分比（拿不到 content-length 时进度按 0 处理，不假装到 100） */
  async _download(url, dest, expectedHash, onProgress) {
    const signal = AbortSignal.timeout(120_000)
    const res = await fetch(url, { redirect: 'follow', signal })
    if (!res.ok) {
      throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
    }
    const total = Number(res.headers.get('content-length') || 0)
    if (!res.body) throw new Error('下载响应没有 ZIP 内容')
    const hash = createHash('sha256')
    let received = 0
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length
        hash.update(chunk)
        if (total > 0) onProgress(Math.floor((received / total) * 100))
        done(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest, { flags: 'wx' }), { signal })
    if (total > 0 && received !== total) {
      throw new Error(`下载不完整：收到 ${received} / ${total} 字节`)
    }
    if (expectedHash && hash.digest('hex') !== expectedHash) throw new Error('下载的 ZIP 校验失败（SHA-256 不一致）')
  }
}

export const paths = { DATA_DIR, STATE_FILE, FALLBACK_EXT_DIR, WORK_DIR }
