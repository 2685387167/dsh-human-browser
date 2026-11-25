/**
 * extension-updater.js — 扩展的版本检查、下载、解压、安装。
 *
 * 设计前提（用户定的）：
 *  - 扩展**不进插件包**，发布在 GitHub Releases，一个版本一个 zip，旧版全部保留
 *  - 只在本机扩展**低于当前 DSH 插件的随包适配版本**时提示更新
 *  - 已装过的用户：逐个更新通过核验的旧版解压目录，写完后通知已连接的扩展
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
import { compareVersions, findExtensionInstallations, isExtensionVersion, readExtensionManifest, summarize } from './chrome-profile.js'

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-human-browser')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
/** 没装过时，扩展解压到这个固定目录，引导用户从这里加载 */
const FALLBACK_EXT_DIR = path.join(DATA_DIR, 'extension')
/** 下载与解压的临时区 */
const WORK_DIR = path.join(DATA_DIR, 'update-work')

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
   * @param {(version:string)=>Promise<boolean>|boolean|undefined} [opts.requestReload] 通知当前桥接并确认重连
   * @param {(s:string)=>void} [opts.log]
   */
  constructor({ extensionId, extensionVersionFile, requestReload, log = () => {} }) {
    this.extensionId = extensionId
    this.extensionVersionFile = extensionVersionFile
    this.requestReload = requestReload
    this.log = log

    /** @type {{stage:string, progress:number, error:string|null, installedPath:string|null, needsManualLoad:boolean, reloadState:string|null}} */
    this.progress = { stage: 'idle', progress: 0, error: null, installedPath: null, needsManualLoad: false, reloadState: null }
    this.running = false
    this.dismissedForSession = false
  }

  /** 检查和安装共用当前插件随包声明的适配版本及资产。 */
  readBundledRelease() {
    try {
      const j = JSON.parse(fs.readFileSync(this.extensionVersionFile, 'utf8'))
      const version = isExtensionVersion(j.extensionVersion) ? j.extensionVersion : null
      // 开发包可在随包元数据中指定使用同目录下的 ZIP。
      const assetPath = version && j.localAsset === true
        ? path.join(path.dirname(this.extensionVersionFile), 'dist', `dsh-human-browser-extension-${version}.zip`)
        : null
      return {
        version,
        repo: typeof j.repository === 'string' && GITHUB_REPO.test(j.repository) ? j.repository : null,
        releaseNotes: typeof j.releaseNotes === 'string' ? j.releaseNotes : '',
        tag: j.extensionTag,
        sha256: typeof j.sha256 === 'string' && SHA256.test(j.sha256) ? j.sha256 : null,
        assetPath,
      }
    } catch (e) {
      this.log(`读 extension-version.json 失败：${e?.message}`)
      return { version: null, repo: null, releaseNotes: '' }
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
    const rel = this.readBundledRelease()
    const installations = findExtensionInstallations(this.extensionId)
    const sum = summarize(installations, rel.version)
    const ignoredUpdate = sum.needsUpdate && readState().ignoredUpdateVersion === rel.version

    return {
      installed: sum.installed,
      userVersion: sum.lowest,
      targetVersion: rel.version,
      needsUpdate: sum.needsUpdate,
      pendingReloadOnly: Boolean(sum.pendingReloadOnly && !sum.needsUpdate),
      releaseNotes: rel.releaseNotes,
      downloadUrl: rel.assetPath ? null : this.downloadUrl(rel.repo, rel.version, rel.tag),
      dismissedForSession: this.dismissedForSession,
      ignoredUpdate,
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

  /** 取消只记在当前运行的插件实例里，供同次 DSH 启动的页面复用。 */
  dismiss() {
    this.dismissedForSession = true
    return { ok: true }
  }

  /** 只保存仍可更新的适配版本，避免过期弹窗忽略其他版本。 */
  ignoreUpdate(version) {
    const { targetVersion, needsUpdate } = this.getStatus()
    if (version !== targetVersion || !needsUpdate) {
      return { ok: false, error: '扩展更新状态已变化，请重新检查。' }
    }
    if (writeState({ ignoredUpdateVersion: version }).ignoredUpdateVersion !== version) {
      throw new Error('无法保存本次扩展更新的忽略设置。')
    }
    return { ok: true }
  }

  /** 启动安装（立即返回，真正的活在后台跑） */
  startInstall() {
    if (this.running) return { started: false, reason: 'already-running' }
    this.running = true
    this.progress = { stage: 'downloading', progress: 0, error: null, installedPath: null, needsManualLoad: false, reloadState: null }
    this._run().finally(() => {
      this.running = false
    })
    return { started: true }
  }

  async _run() {
    let work
    const plans = []
    try {
      const rel = this.readBundledRelease()
      if (!rel.version || (!rel.repo && !rel.assetPath)) throw new Error('插件包里的 extension-version.json 不完整')

      const plan = this.planInstall(rel.version)
      if (!plan.targets.length) {
        await this.finishInstall(rel.version, plan)
        return
      }
      const url = rel.assetPath ? null : this.downloadUrl(rel.repo, rel.version, rel.tag)
      if (!url && !rel.assetPath) throw new Error('拼不出下载地址（repository、tag 或 version 无效）')
      if (rel.assetPath && !rel.sha256) throw new Error('本地扩展包缺少 SHA-256 校验值')

      fs.mkdirSync(WORK_DIR, { recursive: true })
      work = fs.mkdtempSync(path.join(WORK_DIR, 'install-'))
      const zipPath = path.join(work, 'extension.zip')
      const extractDir = path.join(work, 'extension')

      this.log(rel.assetPath ? `读取本地扩展包 ${rel.assetPath}` : `开始下载 ${url}`)
      await this.stageArchive({ url, assetPath: rel.assetPath, sha256: rel.sha256 }, zipPath, (p) => {
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
      await this.finishInstall(rel.version, current)
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
        reloadState: null,
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
    if (sum.unknownVersion) {
      throw new Error('无法确认已装扩展的版本，请在 chrome://extensions 中检查扩展目录。')
    }
    const targets = updateTargets(installations, version, this.extensionId)
    if (sum.needsUpdate && !targets.length) {
      throw new Error('找到了旧版扩展，但无法验证可安全更新的解压目录。请检查 chrome://extensions 中的安装路径。')
    }
    return {
      targets, installedPath: targets[0] ?? sum.lowestInstance?.path ?? null,
      needsManualLoad: false, pendingReload: sum.pendingReloadOnly,
    }
  }

  /** 提交文件后才通知扩展；无法确认重连时保留已安装的文件。 */
  async finishInstall(version, { targets, installedPath, needsManualLoad, pendingReload }) {
    if (targets.length) {
      writeState({ lastInstall: { at: new Date().toISOString(), version, ok: true, path: installedPath } })
      this.log(`扩展 ${version} 安装完成 → ${installedPath}`)
    }
    let reloadState = null
    if (!needsManualLoad && (targets.length || pendingReload)) {
      reloadState = 'pending'
      if (this.requestReload) {
        this.progress = { stage: 'reloading', progress: 100, error: null, installedPath, needsManualLoad, reloadState }
        try {
          if (await this.requestReload(version)) reloadState = 'confirmed'
        } catch (error) {
          this.log(`扩展文件已就绪，等待扩展下次启动或重连：${error.message}`)
        }
      }
    }
    // 保留最后一次终态，避免客户端休眠后恢复轮询时丢失结果。
    this.progress = { stage: 'done', progress: 100, error: null, installedPath, needsManualLoad, reloadState }
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

  /** 将线上或本地 ZIP 流式复制到暂存区，两种来源共用大小和哈希校验。 */
  async stageArchive({ url, assetPath, sha256 }, dest, onProgress) {
    const signal = AbortSignal.timeout(120_000)
    let source
    let total
    if (assetPath) {
      const stat = fs.statSync(assetPath)
      if (!stat.isFile()) throw new Error(`扩展 ZIP 不是普通文件：${assetPath}`)
      total = stat.size
      source = fs.createReadStream(assetPath)
    } else {
      const res = await fetch(url, { redirect: 'follow', signal })
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
      if (!res.body) throw new Error('下载响应没有 ZIP 内容')
      total = Number(res.headers.get('content-length') || 0)
      source = Readable.fromWeb(res.body)
    }
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
    await pipeline(source, meter, fs.createWriteStream(dest, { flags: 'wx' }), { signal })
    if (total > 0 && received !== total) {
      throw new Error(`下载不完整：收到 ${received} / ${total} 字节`)
    }
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('扩展 ZIP 校验失败（SHA-256 不一致）')
  }
}

export const paths = { DATA_DIR, STATE_FILE, FALLBACK_EXT_DIR, WORK_DIR }
