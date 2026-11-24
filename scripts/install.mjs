#!/usr/bin/env node
/**
 * install.mjs — 一次性落地：扩展公钥、扩展 ID、native messaging manifest、注册表、host 启动器。
 *
 * 做的事：
 *   1. 扩展 manifest 里没有 `key` 就生成一对 RSA-2048，把公钥 DER 写进 `key`。
 *      → 扩展 ID 从此与目录路径无关（Chrome 的 ID = sha256(DER)[0..16] 的每个 nibble 映射到 a-p）。
 *   2. 用 DER 算出扩展 ID，写进 native messaging manifest 的 allowed_origins。
 *   3. 生成 host 启动器（.cmd 包一层 node.exe）。
 *   4. 写 HKCU 注册表，让 Chrome 与 Edge 都能找到这个 host。
 *
 * 用法：
 *   node scripts/install.mjs            # 安装/更新
 *   node scripts/install.mjs --check    # 只体检，不改动
 *   node scripts/install.mjs --node X   # 指定 node.exe
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOST_NAME, HOST_DIR, HOST_REGISTRATIONS, idFromPublicKey } from '../lib/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const EXT_DIR = path.join(ROOT, 'extension')
const MANIFEST = path.join(EXT_DIR, 'manifest.json')
const HOST_MJS = path.join(ROOT, 'host', 'host.mjs')

const HOST_CMD = path.join(HOST_DIR, `${HOST_NAME}.cmd`)
const NM_FILE = path.join(HOST_DIR, `${HOST_NAME}.json`)

/** 把宿主复制到每用户的固定目录，让启动器能通过自身目录定位脚本。 */
const RUNTIME_DIR = path.join(HOST_DIR, 'runtime')
const HOST_RUNTIME = path.join(RUNTIME_DIR, 'host', 'host.mjs')
const LIB_RUNTIME = path.join(RUNTIME_DIR, 'lib', 'protocol.js')

const say = (s = '') => process.stdout.write(s + '\n')
const ok = (s) => say(`  \x1b[32m✓\x1b[0m ${s}`)
const warn = (s) => say(`  \x1b[33m!\x1b[0m ${s}`)
const bad = (s) => say(`  \x1b[31m✗\x1b[0m ${s}`)

// ── 1. 扩展 ID ───────────────────────────────────────────────────────────────

/**
 * 确定扩展 ID（必要时先生成公钥）。
 *
 * 两种安装形态：
 *  ① 开发目录：有 `extension/manifest.json`，读/生成 key，由 key 算出 ID
 *  ② 发布包：**不含 `extension/`**（扩展走 GitHub Releases），ID 来自 `extension-version.json`
 *
 * 生成新 key 后必须把新 ID 同步写回 `extension-version.json` —— 否则运行时的更新检测
 * 会拿着旧 ID 去 Chrome 配置里找扩展，永远找不到，误判成"未安装"。
 */
function ensureKey(checkOnly) {
  const metaFile = path.join(ROOT, 'extension-version.json')
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  } catch {
    /* 没有就按空处理 */
  }

  // 情形 ②：发布包里没有 manifest，只能信 extension-version.json
  if (!fs.existsSync(MANIFEST)) {
    if (meta.extensionId) {
      return { manifest: null, der: null, created: false, extId: meta.extensionId }
    }
    throw new Error(`既找不到 ${MANIFEST}，extension-version.json 里也没有 extensionId`)
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  if (manifest.key) {
    const der = Buffer.from(manifest.key, 'base64')
    return { manifest, der, created: false, extId: idFromPublicKey(der) }
  }
  if (checkOnly) {
    warn('扩展 manifest 里还没有 key（ID 会随目录路径变化）')
    return { manifest, der: null, created: false, extId: meta.extensionId || null }
  }

  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  manifest.key = Buffer.from(publicKey).toString('base64')
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const extId = idFromPublicKey(publicKey)
  // 公钥换了 = ID 换了，必须让运行时知道新的那个
  if (fs.existsSync(metaFile)) {
    meta.extensionId = extId
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  }
  return { manifest, der: publicKey, created: true, extId }
}

// ── 2. node 可执行文件 ──────────────────────────────────────────────────────

/** 选择独立的 Node 可执行程序，桌面插件进程本身可能是 Electron。 */
function resolveNode(nodeArg) {
  if (nodeArg) {
    if (!fs.existsSync(nodeArg)) throw new Error(`--node 指向的文件不存在：${nodeArg}`)
    return nodeArg
  }
  const fromEnv = process.env.DSH_HUMAN_BROWSER_NODE
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const base = path.basename(process.execPath).toLowerCase()
  if (base === 'node.exe' || base === 'node') return process.execPath

  // DSH 自带运行时
  const rt = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes')
  try {
    for (const dir of fs.readdirSync(rt)) {
      const cand = path.join(rt, dir, 'dependencies', 'node', 'bin', 'node.exe')
      if (fs.existsSync(cand)) return cand
    }
  } catch {}

  // PATH
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && fs.existsSync(first)) return first
  } catch {}

  throw new Error('找不到 node.exe。用 --node <路径> 指定，或设环境变量 DSH_HUMAN_BROWSER_NODE。')
}

// ── 3. 注册表 ───────────────────────────────────────────────────────────────

function regSet(key, value) {
  execFileSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'],
    { windowsHide: true, stdio: 'pipe', timeout: 5000 })
}
function regQuery(key) {
  try {
    // reg.exe 的输出依赖系统代码页，用 .NET 读注册表并明确按 UTF-8 返回。
    const subkey = key.replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\')
    const command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(\$false); [Console]::WriteLine([Microsoft.Win32.Registry]::GetValue('${subkey}', '', ''))`
    return execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 5000 }).trim() || null
  } catch {
    return null
  }
}

/** 内容改变时才替换文件，避免重启 DSH 时反复写入运行中的宿主。 */
function writeIfChanged(file, contents) {
  const bytes = Buffer.from(contents)
  try {
    if (fs.readFileSync(file).equals(bytes)) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, bytes)
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/** cmd 按本机代码页读批处理，非 ASCII 的 Node 路径改用启动器旁的运行时副本。 */
function nodeForLauncher(node) {
  if (/^[\x20-\x7e]+$/.test(node)) return node.replaceAll('%', '%%')
  const copy = path.join(RUNTIME_DIR, 'node.exe')
  const fingerprintFile = path.join(RUNTIME_DIR, 'node-source.json')
  const source = fs.statSync(node)
  const fingerprint = JSON.stringify({ node, version: source.size, mtimeMs: source.mtimeMs })
  try {
    if (fs.readFileSync(fingerprintFile, 'utf8') === fingerprint && fs.statSync(copy).size === source.size) {
      return '%~dp0runtime\\node.exe'
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temp = `${copy}.${crypto.randomUUID()}.tmp`
  try {
    fs.copyFileSync(node, temp)
    fs.renameSync(temp, copy)
    writeIfChanged(fingerprintFile, fingerprint)
  } finally {
    fs.rmSync(temp, { force: true })
  }
  return '%~dp0runtime\\node.exe'
}

/**
 * 准备 Windows 用户级宿主，由插件启动和命令行安装器共用。
 * @param {string} extensionId 已发布扩展的 ID，用于 native messaging 白名单
 * @param {object} [options] 命令行安装器可指定独立的 Node 路径
 */
export function ensureNativeHost(extensionId, { nodeArg } = {}) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 无效，无法注册浏览器宿主')
  const node = path.resolve(resolveNode(nodeArg))
  writeIfChanged(path.join(RUNTIME_DIR, 'package.json'), '{"type":"module"}\n')
  writeIfChanged(LIB_RUNTIME, fs.readFileSync(path.join(ROOT, 'lib', 'protocol.js')))
  writeIfChanged(HOST_RUNTIME, fs.readFileSync(HOST_MJS))
  const launcher = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodeForLauncher(node)}" "%~dp0runtime\\host\\host.mjs" %*\r\n`
  writeIfChanged(HOST_CMD, launcher)

  // 宿主文件准备好之后才登记，避免浏览器发现未写完的注册清单。
  const nm = {
    name: HOST_NAME,
    description: 'dsh-human-browser native host (Chrome to DSH plugin)',
    path: HOST_CMD,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
  writeIfChanged(NM_FILE, JSON.stringify(nm, null, 2) + '\n')
  const registrations = HOST_REGISTRATIONS.map(([label, key]) => {
    try {
      if (regQuery(key) !== NM_FILE) regSet(key, NM_FILE)
      return { label, error: null }
    } catch (e) {
      return { label, error: e?.stderr?.toString().trim() || e.message }
    }
  })
  return { node, launcher, registrations }
}

/** 命令行保留 --check、--node 和开发目录的公钥初始化行为。 */
function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const nodeArg = args.includes('--node') ? args[args.indexOf('--node') + 1] : null
  say('\n\x1b[1mdsh-human-browser · 安装\x1b[0m\n')
  const { created, extId } = ensureKey(checkOnly)
  if (!extId) {
    bad('没有公钥，无法确定扩展 ID')
    process.exitCode = 1
    return
  }
  ok(`扩展 ID：${extId}${created ? '（刚生成公钥）' : ''}`)
  if (checkOnly) {
    const cur = regQuery(HOST_REGISTRATIONS[0][1])
    if (cur === NM_FILE) ok(`注册表已指向 ${NM_FILE}`)
    else warn(`注册表未就绪（当前：${cur || '不存在'}）`)
    say('\n（--check 模式，未做任何改动）\n')
    return
  }

  const { node, registrations } = ensureNativeHost(extId, { nodeArg })
  ok(`node：${node}`)
  ok(`host 运行时：${RUNTIME_DIR}`)
  ok(`host 启动器：${HOST_CMD}`)
  ok(`native manifest：${NM_FILE}`)
  for (const { label, error } of registrations) {
    if (error) warn(`注册 ${label} 失败：${error}`)
    else ok(`注册 ${label}`)
  }

  say('\n\x1b[1m启用扩展\x1b[0m')
  say(`  1. 打开 chrome://extensions`)
  say(`  2. 已装过：点 dsh-human-browser 卡片的重新加载按钮。`)
  if (fs.existsSync(EXT_DIR)) {
    // 开发目录：扩展就在手边，直接指过去
    say(`  3. 首次安装：打开「开发者模式」，点「加载已解压的扩展程序」，选择下方目录。`)
    say(`     \x1b[36m${EXT_DIR}\x1b[0m`)
  } else {
    // 发布包：扩展不在包里，走插件弹窗下载
    say(`  3. 首次安装：在 DSH 里看插件弹窗，点「下载并安装」，它会自动下载解压并给出目录。`)
  }
  say(`  4. 重载 DSH bundle，在扩展弹窗查看连接状态并授权测试标签页。`)
  say('')
}

// pnpm 的包入口可能经过链接，比较真实路径，保证直接执行时才运行 CLI。
const invoked = process.argv[1]
if (invoked && fs.existsSync(invoked) && fs.realpathSync(invoked) === fileURLToPath(import.meta.url)) main()
