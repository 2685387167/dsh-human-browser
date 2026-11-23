/**
 * host.mjs — Chrome native messaging host。
 *
 * 它是个**纯转发器**，刻意不做任何业务：Chrome 启动它、用 stdio 跟扩展说话；
 * 它再把同样的消息沿命名管道送到 DSH 插件。两个方向都是 JSON Lines。
 *
 * 为什么不直接让扩展连 HTTP：
 *   页面 JS 能 `new WebSocket('ws://127.0.0.1:PORT')` 扫端口，扫到就等于承认
 *   「本机有自动化宿主」。命名管道在浏览器沙箱里不可达，也不占端口。
 *
 * 标准输出只允许出现 native messaging 帧，任何日志都走 stderr。
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, SESSION_FILE, readSession, FrameDecoder, encodeFrame, LineDecoder, encodeLine } from '../lib/protocol.js'
const HOST_LOG = path.join(DATA_DIR, 'host.log')

const stderr = (s) => {
  try { process.stderr.write(`[human-browser host] ${s}\n`) } catch {}
}

/**
 * 额外写一份文件日志。
 * Chrome 会把 native host 的 stderr 吞掉（除非开 --enable-logging），
 * 光靠 stderr 排查等于摸黑，所以关键节点同时落盘。
 *
 * 逐条收发属于高频噪音，走 vlog（默认开，设 HB_VERBOSE=0 关掉）；
 * 连接、重试、退出这类关键转折走 flog，永远保留。
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024
const VERBOSE = process.env.HB_VERBOSE !== '0'

let logReady = null
function flog(s) {
  try {
    if (logReady === null) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      // 超过上限就滚一次，只留一代 .old —— 长期挂着跑也不会撑爆磁盘
      try {
        if (fs.statSync(HOST_LOG).size > LOG_MAX_BYTES) fs.renameSync(HOST_LOG, HOST_LOG + '.old')
      } catch {}
      logReady = true
    }
    fs.appendFileSync(HOST_LOG, `${new Date().toISOString()} [${process.pid}] ${s}\n`)
  } catch {
    logReady = false
  }
}
function vlog(s) {
  if (VERBOSE) flog(s)
}

// ── native messaging 侧（stdio）──────────────────────────────────────────────

let cdpSock = null
let connected = false

const stdioDecoder = new FrameDecoder((msg) => {
  // 扩展 → 插件：原样转发
  vlog(`← 扩展 ${msg?.id ?? msg?.type}`)
  if (!connected) {
    // 插件不在时**不能回包**。早先这里回了一条 {id, ok:false, error}，
    // 而扩展的 onMessage 分不清「请求」和「响应」，会把它当新请求再发回来 —— 直接打成死循环。
    // 正确做法是丢弃；插件那边本来就会超时报错，信息足够。
    vlog(`插件未连接，丢弃扩展消息 id=${msg?.id ?? msg?.type}`)
    return
  }
  try {
    cdpSock.write(encodeLine(msg))
  } catch (e) {
    flog(`转发到插件失败: ${e?.message}`)
  }
})

/**
 * 从**插件**收到消息（cdpSock 是 host 主动连过去的那端）。
 * 方向是 插件 → 扩展，所以必须 writeStdout。
 *
 * 这里踩过一个很贵的坑：早先写成 cdpSock.write(...)，等于把插件的请求原样写回插件自己，
 * 请求永远到不了扩展，表现成「host 连上了但每个操作都超时」。
 */
function writeStdout(obj) {
  try {
    const frame = encodeFrame(obj)
    process.stdout.write(frame)
    vlog(`→ 扩展 ${obj?.id ?? obj?.type} (${frame.length}B)`)
  } catch (e) {
    flog(`写 stdout 失败: ${e?.message}`)
  }
}

// ── 命名管道侧 ──────────────────────────────────────────────────────────────

let retry = 0
let retryTimer = null

function connectPlugin() {
  const session = readSession()
  if (!session?.token || (!session.pipe && !session.port)) {
    flog(`读不到可用的 session.json（${SESSION_FILE}），1.5s 后重试`)
    scheduleRetry()
    return
  }
  attempt(session, false)
}

/**
 * 先试命名管道；连不上（典型是 EPERM —— 宿主以管理员运行时管道会拒绝普通权限进程）就换 TCP。
 * 两条路由插件那边是同时监听的，所以这里只需要挑能通的那条。
 */
function attempt(session, tcpOnly) {
  const usePipe = !tcpOnly && session.mode !== 'tcp' && Boolean(session.pipe)
  if (!usePipe && !session.port) {
    flog('没有可用端点（既无管道也无端口），等下一轮')
    scheduleRetry()
    return
  }

  const label = usePipe ? session.pipe : `127.0.0.1:${session.port}`
  flog(`尝试连接 ${label}`)
  const sock = usePipe ? net.connect(session.pipe) : net.connect(session.port, '127.0.0.1')
  let ready = false
  let reason = 'DSH 连接断开'
  // 每条连接有独立的解码器与握手期限，避免重连沿用旧连接里的半条消息。
  const handshake = setTimeout(() => {
    reason = '等待 DSH 握手超时'
    sock.destroy()
  }, 3000)
  const decoder = new LineDecoder((msg) => {
    if (sock.destroyed) return
    if (!ready) {
      if (msg?.type !== 'hello-ack') {
        reason = msg?.reason || 'DSH 握手未通过'
        sock.destroy()
        return
      }
      clearTimeout(handshake)
      ready = true
      cdpSock = sock
      connected = true
      retry = 0
      stderr(`已接到插件 ${label}`)
      flog(`已连上插件 ${label}`)
      writeStdout({ type: 'host-connected' })
      return
    }
    vlog(`收到插件消息 id=${msg?.id} method=${msg?.method || msg?.type}`)
    writeStdout(msg)
  })

  sock.on('connect', () => {
    sock.write(encodeLine({ type: 'hello', token: session.token, pid: process.pid, version: '0.1.2' }))
  })

  sock.on('data', (chunk) => {
    try { decoder.push(chunk) } catch (error) {
      reason = error.message
      sock.destroy()
    }
  })

  sock.on('error', (e) => {
    reason = e?.code || e?.message || reason
  })

  sock.on('close', () => {
    clearTimeout(handshake)
    flog(`连接 ${label} 关闭: ${reason}`)
    if (cdpSock === sock) {
      connected = false
      cdpSock = null
    }
    if (!ready && usePipe && session.port && reason !== '已有浏览器连接') {
      flog('改走 TCP 端点')
      attempt(session, true)
      return
    }
    writeStdout({ type: 'host-disconnected', reason })
    scheduleRetry()
  })
}

function scheduleRetry() {
  if (retryTimer) return
  retry = Math.min(retry + 1, 20)
  const delay = Math.min(500 * retry, 8000)
  retryTimer = setTimeout(() => {
    retryTimer = null
    connectPlugin()
  }, delay)
}

// ── 启动 ────────────────────────────────────────────────────────────────────

process.stdin.on('data', (chunk) => {
  try {
    stdioDecoder.push(chunk)
  } catch (e) {
    flog(`stdio 解帧失败: ${e?.message}`)
    stderr(`stdio 解帧失败: ${e?.message}`)
  }
})

process.stdin.on('end', () => {
  flog('stdin 关闭，退出')
  stderr('stdin 关闭，退出')
  try { cdpSock?.end() } catch {}
  process.exit(0)
})

process.on('uncaughtException', (e) => {
  flog(`未捕获异常: ${e?.stack || e?.message}`)
  stderr(`未捕获异常: ${e?.stack || e?.message}`)
})

flog(`host 启动 node=${process.version} tmp=${os.tmpdir()} session=${SESSION_FILE}`)
stderr(`host 启动 pid=${process.pid}`)
connectPlugin()
