/**
 * protocol.js — 插件侧与 native host 之间的共享约定。
 *
 * 链路：
 *   DSH 工具 → 本插件（管道服务端）→ native host（管道客户端）→ stdio → MV3 扩展 → chrome.debugger → 页面
 *
 * 为什么用命名管道而不是 localhost 端口：
 *   页面 JS 可以 `new WebSocket('ws://127.0.0.1:PORT')` 挨个探端口，一旦探到就等于告诉对方
 *   "这台机器上有个自动化宿主在跑"。Windows 命名管道在 Web 上下文里完全不可达，无可探测性。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/** Chrome 接收 native host 单条消息的最大 JSON 字节数。 */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024

/** Chrome 用这个名字查 HKCU\Software\Google\Chrome\NativeMessagingHosts\<name> */
export const HOST_NAME = 'com.dsh.humanbrowser'

/** 数据目录：插件与 host 都要读写，放用户 TEMP 下（本就只属当前用户） */
export const DATA_DIR = process.env.DSH_HUMAN_BROWSER_DIR || path.join(os.tmpdir(), 'dsh-human-browser')
export const SESSION_FILE = path.join(DATA_DIR, 'session.json')
export const LOG_FILE = path.join(DATA_DIR, 'plugin.log')

/** Windows 命名管道路径 */
export const PIPE_PATH = process.env.DSH_HUMAN_BROWSER_PIPE || `\\\\.\\pipe\\dsh-human-browser-${userTag()}`

function userTag() {
  try {
    const name = os.userInfo().username || 'user'
    return crypto.createHash('sha1').update(`${name}|${os.hostname()}`).digest('hex').slice(0, 10)
  } catch {
    return 'default'
  }
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  return DATA_DIR
}

/** 插件启动时写一张名片：host 靠它找到端点与 token */
export function writeSession(info) {
  ensureDataDir()
  const body = {
    // 'pipe' = 命名管道（首选，页面完全不可达）；'tcp' = 回退（127.0.0.1 + token）
    mode: info.mode || 'pipe',
    pipe: info.mode === 'tcp' ? null : (info.pipe || PIPE_PATH),
    port: info.port || null,
    token: info.token,
    pid: process.pid,
    at: new Date().toISOString(),
  }
  // 先完整写入再替换，避免 host 读取半份 JSON。
  const temp = `${SESSION_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
    fs.renameSync(temp, SESSION_FILE)
  } finally {
    fs.rmSync(temp, { force: true })
  }
  return body
}

export function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function clearSession(token) {
  try {
    // 同一进程内重载时，旧实例只能清理自己的会话。
    if (token && readSession()?.token === token) fs.unlinkSync(SESSION_FILE)
  } catch {
    /* 没有就算了 */
  }
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex')
}

// ── native messaging 帧 ──────────────────────────────────────────────────────
// Chrome 的 native messaging：每条消息 = 4 字节小端长度 + UTF-8 JSON。

export function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32LE(json.length, 0)
  return Buffer.concat([head, json])
}

/** 流式解帧器：喂 chunk，吐完整消息 */
export class FrameDecoder {
  constructor(onMessage, { maxBytes = 64 * 1024 * 1024 } = {}) {
    this.buf = Buffer.alloc(0)
    this.onMessage = onMessage
    this.maxBytes = maxBytes
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.buf.length < 4) return
      const len = this.buf.readUInt32LE(0)
      if (len > this.maxBytes) throw new Error(`frame too large: ${len}`)
      if (this.buf.length < 4 + len) return
      const body = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        continue // 坏帧直接丢，不能让一条坏消息拖垮整条链路
      }
      this.onMessage(msg)
    }
  }
}

/** JSON Lines：插件 ↔ host 的管道上用，简单、好排查 */
export function encodeLine(obj) {
  return Buffer.from(JSON.stringify(obj) + '\n', 'utf8')
}

export class LineDecoder {
  constructor(onMessage) {
    this.buf = ''
    this.decoder = new StringDecoder('utf8')
    this.onMessage = onMessage
  }

  push(chunk) {
    this.buf += this.decoder.write(chunk)
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      if (idx > 64 * 1024 * 1024) throw new Error('JSON Lines 消息过长')
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this.onMessage(msg)
    }
    if (this.buf.length > 64 * 1024 * 1024) throw new Error('JSON Lines 消息过长')
  }
}

// ── 日志 ────────────────────────────────────────────────────────────────────

export function log(line) {
  try {
    ensureDataDir()
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}
