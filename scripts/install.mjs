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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const EXT_DIR = path.join(ROOT, 'extension')
const MANIFEST = path.join(EXT_DIR, 'manifest.json')
const HOST_MJS = path.join(ROOT, 'host', 'host.mjs')

const HOST_NAME = 'com.dsh.humanbrowser'
const HOST_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-human-browser')
const HOST_CMD = path.join(HOST_DIR, `${HOST_NAME}.cmd`)
const NM_FILE = path.join(HOST_DIR, `${HOST_NAME}.json`)

/**
 * host 运行时复制到这里。
 *
 * 为什么要复制：Chrome 启动 host 走的是 `cmd.exe`（.cmd 包装），而 cmd.exe 按**系统 ANSI**
 * 读脚本、按 ANSI 解析命令行。项目目录在 `E:\肥鱼专用\项目\...` —— 中文，一旦被写进 .cmd
 * 就是 UTF-8 字节被 GBK 解析的乱码，node 会报找不到文件。复制到 %LOCALAPPDATA% 这条纯
 * ASCII 路径上，整条链路就没有编码问题了。
 */
const RUNTIME_DIR = path.join(HOST_DIR, 'runtime')
const HOST_RUNTIME = path.join(RUNTIME_DIR, 'host', 'host.mjs')
const LIB_RUNTIME = path.join(RUNTIME_DIR, 'lib', 'protocol.js')

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const nodeArg = args.includes('--node') ? args[args.indexOf('--node') + 1] : null

const say = (s = '') => process.stdout.write(s + '\n')
const ok = (s) => say(`  \x1b[32m✓\x1b[0m ${s}`)
const warn = (s) => say(`  \x1b[33m!\x1b[0m ${s}`)
const bad = (s) => say(`  \x1b[31m✗\x1b[0m ${s}`)

// ── 1. 扩展 ID ───────────────────────────────────────────────────────────────

/** Chromium: id = sha256(publicKeyDer) 的前 16 字节，每个 hex nibble 映射到 a-p */
export function idFromPublicKey(derBuffer) {
  const hex = crypto.createHash('sha256').update(derBuffer).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function ensureKey() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  if (manifest.key) {
    return { manifest, der: Buffer.from(manifest.key, 'base64'), created: false }
  }
  if (CHECK_ONLY) {
    warn('扩展 manifest 里还没有 key（ID 会随目录路径变化）')
    return { manifest, der: null, created: false }
  }
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  manifest.key = Buffer.from(publicKey).toString('base64')
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { manifest, der: publicKey, created: true }
}

// ── 2. node 可执行文件 ──────────────────────────────────────────────────────

function resolveNode() {
  if (nodeArg) {
    if (!fs.existsSync(nodeArg)) throw new Error(`--node 指向的文件不存在：${nodeArg}`)
    return nodeArg
  }
  const fromEnv = process.env.DSH_HUMAN_BROWSER_NODE
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const base = path.basename(process.execPath).toLowerCase()
  if (base === 'node.exe' || base === 'node') return process.execPath

  // DSH 自带运行时
  const rt = path.join(os.homedir(), '.dsh', 'dsh-runtimes')
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
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true })
}
function regQuery(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true })
    const m = out.match(/REG_SZ\s+(.+)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

const BROWSERS = [
  ['Chrome', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`],
  ['Edge', `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`],
  ['Chromium', `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`],
]

// ── 主流程 ─────────────────────────────────────────────────────────────────

say('\n\x1b[1mdsh-human-browser · 安装\x1b[0m\n')

const { manifest, der, created } = ensureKey()
if (der) {
  const extId = idFromPublicKey(der)
  ok(`扩展 ID：${extId}${created ? '（刚生成公钥）' : ''}`)

  if (CHECK_ONLY) {
    const cur = regQuery(BROWSERS[0][1])
    if (cur === NM_FILE) ok(`注册表已指向 ${NM_FILE}`)
    else warn(`注册表未就绪（当前：${cur || '不存在'}）`)
    say('\n（--check 模式，未做任何改动）\n')
    process.exit(0)
  }

  const node = resolveNode()
  ok(`node：${node}`)

  fs.mkdirSync(HOST_DIR, { recursive: true })

  // 把 host 与它依赖的 protocol.js 复制到纯 ASCII 路径，避免 cmd.exe 的 ANSI 解析把中文路径弄坏
  fs.mkdirSync(path.join(RUNTIME_DIR, 'host'), { recursive: true })
  fs.mkdirSync(path.join(RUNTIME_DIR, 'lib'), { recursive: true })
  fs.copyFileSync(HOST_MJS, HOST_RUNTIME)
  fs.copyFileSync(path.join(ROOT, 'lib', 'protocol.js'), LIB_RUNTIME)
  ok(`host 运行时：${RUNTIME_DIR}`)

  // host 启动器：Chrome 用 cmd.exe 跑这个 .cmd，命令行里只出现 ASCII
  fs.writeFileSync(
    HOST_CMD,
    `@echo off\r\n"${node}" "${HOST_RUNTIME}" %*\r\n`,
    'utf8',
  )
  ok(`host 启动器：${HOST_CMD}`)
  if (/[^\x20-\x7e\r\n]/.test(fs.readFileSync(HOST_CMD, 'utf8'))) {
    warn('警告：启动器里仍有非 ASCII 字符，cmd.exe 可能解析出错')
  }

  // native messaging manifest
  const nm = {
    name: HOST_NAME,
    description: 'dsh-human-browser native host (Chrome to DSH plugin)',
    path: HOST_CMD,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  }
  fs.writeFileSync(NM_FILE, JSON.stringify(nm, null, 2) + '\n', 'utf8')
  ok(`native manifest：${NM_FILE}`)

  // 注册表
  for (const [label, key] of BROWSERS) {
    try {
      regSet(key, NM_FILE)
      ok(`注册 ${label}`)
    } catch (e) {
      warn(`注册 ${label} 失败：${e?.message?.split('\n')[0]}`)
    }
  }

  say('\n\x1b[1m在 Chrome 和 DSH 中启用更新\x1b[0m')
  say(`  1. 打开 chrome://extensions`)
  say(`  2. 已安装时，点 dsh-human-browser 卡片的重新加载按钮。`)
  say(`  3. 首次安装时，打开「开发者模式」，点「加载已解压的扩展程序」，选择下方目录。`)
  say(`     \x1b[36m${EXT_DIR}\x1b[0m`)
  say(`  4. 重载 DSH bundle，在扩展弹窗查看连接状态并授权测试标签页。`)
  say('')
} else {
  bad('没有公钥，无法确定扩展 ID')
  process.exit(1)
}
