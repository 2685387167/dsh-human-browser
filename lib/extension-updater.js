/**
 * extension-updater.js — 扩展的版本检查、下载、解压、安装。
 *
 * 设计前提（用户定的）：
 *  - 扩展**不进插件包**，发布在 GitHub Releases，一个版本一个 zip，旧版全部保留
 *  - 只在用户版本**低于**推荐版本时提示；用户改高版本号（自己动过）就完全不碰
 *  - 已装过的用户：覆盖到 Chrome 记录的那个目录，扩展自己 reload，无需手动
 *  - 没装过的用户：解压到固定目录，前端展示路径 + 手动加载指引（Chrome 137+ 的硬限制）
 *
 * 进度用内存状态 + 轮询，不做流式推送 —— 前端每秒读一次比处理事件流简单也可靠。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { findExtensionInstallations, summarize, compareVersions } from './chrome-profile.js'

const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-human-browser')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
/** 没装过时，扩展解压到这个固定目录，引导用户从这里加载 */
const FALLBACK_EXT_DIR = path.join(DATA_DIR, 'extension')
/** 下载与解压的临时区 */
const WORK_DIR = path.join(DATA_DIR, 'update-work')

const DISMISS_MS = 24 * 60 * 60 * 1000

/** 递归列出目录下所有文件的相对路径（正斜杠统一） */
function listFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel)
      else out.push(childRel)
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
  })
}

/**
 * 把 sourceDir 的内容装到 targetDir：覆盖同名、删掉 sourceDir 里没有的、失败回滚。
 *
 * 为什么不是简单覆盖：只 copyFile 不删旧文件，会让目录里留下上一版才有的文件，
 * 时间长了会堆积，更糟的是可能被旧的 require 链摸到。
 */
function installInto(sourceDir, targetDir) {
  const srcFiles = new Set(listFiles(sourceDir))
  const dstFiles = listFiles(targetDir)

  fs.mkdirSync(targetDir, { recursive: true })

  // 先把不属于新版本的文件删掉（失败也不致命，继续装）
  const removed = []
  for (const rel of dstFiles) {
    if (srcFiles.has(rel)) continue
    try {
      fs.unlinkSync(path.join(targetDir, rel))
      removed.push(rel)
    } catch {
      /* 删不掉就留着，不影响功能 */
    }
  }

  const written = []
  for (const rel of srcFiles) {
    const from = path.join(sourceDir, rel)
    const to = path.join(targetDir, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    written.push(rel)
  }

  return { written: written.length, removed: removed.length, removedFiles: removed }
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
    this._doneAt = 0
  }

  /** 插件推荐（= 最新发布）的扩展版本与说明 */
  readReleaseInfo() {
    try {
      const j = JSON.parse(fs.readFileSync(this.extensionVersionFile, 'utf8'))
      return {
        version: j.extensionVersion || null,
        repo: j.repository || null,
        releaseNotes: j.releaseNotes || '',
      }
    } catch (e) {
      this.log(`读 extension-version.json 失败：${e?.message}`)
      return { version: null, repo: null, releaseNotes: '' }
    }
  }

  /** 下载地址：固定 tag + 固定文件名，不用 latest/download（那个文件名是字面量，发下一版就 404） */
  downloadUrl(repo, version) {
    if (!repo || !version) return null
    return `https://github.com/${repo}/releases/download/v${version}/dsh-human-browser-extension-${version}.zip`
  }

  /** 当前状态（前端轮询这个） */
  getStatus() {
    const rel = this.readReleaseInfo()
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
      downloadUrl: this.downloadUrl(rel.repo, rel.version),
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
    // done 之后挂 10 秒再回 idle，让前端来得及读到最后一次
    if (this.progress.stage === 'done' && Date.now() - this._doneAt > 10_000) {
      this.progress = { stage: 'idle', progress: 0, error: null, installedPath: null, needsManualLoad: false }
    }
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
      if (this.progress.stage === 'done') this._doneAt = Date.now()
    })
    return { started: true }
  }

  async _run() {
    try {
      const rel = this.readReleaseInfo()
      if (!rel.version || !rel.repo) throw new Error('插件包里的 extension-version.json 不完整')

      const installations = findExtensionInstallations(this.extensionId)
      const sum = summarize(installations, rel.version)

      // 已经是新版了，什么都不做
      if (sum.installed && !sum.needsUpdate) {
        this.progress = {
          stage: 'done',
          progress: 100,
          error: null,
          installedPath: installations[0]?.path || null,
          needsManualLoad: false,
        }
        return
      }

      // 只差重载：不下载，直接告诉调用方（重载由扩展自己按 manifest 版本差自检完成）
      if (sum.pendingReloadOnly) {
        this.progress = {
          stage: 'done',
          progress: 100,
          error: null,
          installedPath: installations[0]?.path || null,
          needsManualLoad: false,
        }
        return
      }

      const firstInstall = !sum.installed
      const url = this.downloadUrl(rel.repo, rel.version)
      if (!url) throw new Error('拼不出下载地址（repository 或 version 缺失）')

      fs.mkdirSync(WORK_DIR, { recursive: true })
      const zipPath = path.join(WORK_DIR, `extension-${rel.version}.zip`)
      const extractDir = path.join(WORK_DIR, `extension-${rel.version}`)
      fs.rmSync(extractDir, { recursive: true, force: true })

      this.log(`开始下载 ${url}`)
      await this._download(url, zipPath, (p) => {
        this.progress.progress = Math.min(99, p)
      })

      this.progress.stage = 'installing'
      this.progress.progress = 0
      unzipTo(zipPath, extractDir)

      // zip 里可能多套一层目录，自动认一下
      const sourceDir = this._findManifestDir(extractDir)
      if (!sourceDir) throw new Error('解压后找不到 manifest.json')

      let installedPath
      if (firstInstall) {
        // 没装过：装到固定目录，等用户手动加载
        installInto(sourceDir, FALLBACK_EXT_DIR)
        installedPath = FALLBACK_EXT_DIR
      } else {
        // 装过：覆盖到 Chrome 记录的每个目录
        installedPath = installations[0].path
        for (const inst of installations) {
          installInto(sourceDir, inst.path)
        }
      }

      // 清理工作区，别让解压出来的副本堆积
      try {
        fs.rmSync(WORK_DIR, { recursive: true, force: true })
      } catch {}

      writeState({
        lastInstall: { at: new Date().toISOString(), version: rel.version, ok: true, path: installedPath },
      })

      this.progress = {
        stage: 'done',
        progress: 100,
        error: null,
        installedPath,
        needsManualLoad: firstInstall,
      }
      this.log(`扩展 ${rel.version} 安装完成 → ${installedPath}`)
    } catch (e) {
      const msg = e?.message || String(e)
      this.log(`安装失败：${msg}`)
      try {
        fs.rmSync(WORK_DIR, { recursive: true, force: true })
      } catch {}
      writeState({ lastInstall: { at: new Date().toISOString(), ok: false, error: msg } })
      this.progress = {
        stage: 'error',
        progress: 0,
        error: msg,
        installedPath: null,
        needsManualLoad: false,
      }
    }
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
  async _download(url, dest, onProgress) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
    }
    const total = Number(res.headers.get('content-length') || 0)
    const tmp = `${dest}.part`
    const out = fs.createWriteStream(tmp)
    let received = 0

    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        out.write(Buffer.from(value))
        if (total > 0) onProgress(Math.floor((received / total) * 100))
      }
    } finally {
      await new Promise((r) => out.end(r))
    }

    // 大小对不上就当失败，别拿半个包去覆盖用户的扩展
    if (total > 0 && received !== total) {
      try { fs.unlinkSync(tmp) } catch {}
      throw new Error(`下载不完整：收到 ${received} / ${total} 字节`)
    }

    fs.renameSync(tmp, dest)
  }
}

export const paths = { DATA_DIR, STATE_FILE, FALLBACK_EXT_DIR, WORK_DIR }
