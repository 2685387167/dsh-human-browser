/**
 * bridge.js — 插件侧：命名管道服务端 + 请求/响应。
 *
 * 职责边界：本文件只管「把一条 JSON 送到扩展、把结果带回来」。
 * 所有人类化策略在 human.js，所有浏览器语义在扩展侧。
 */

import net from 'node:net'
import crypto from 'node:crypto'
import { LineDecoder, encodeLine, log, MAX_HOST_MESSAGE_BYTES, PLUGIN_PROTOCOL, LEGACY_EXTENSION_PROTOCOL } from './protocol.js'

export class Bridge {
  /**
   * @param {object} opts
   * @param {string} opts.pipe 命名管道路径
   * @param {string} opts.token 握手 token
   * @param {number} [opts.handshakeMs] 等 hello 的上限
   */
  constructor({ pipe, token, handshakeMs = 8000 }) {
    this.pipe = pipe
    this.token = token
    this.handshakeMs = handshakeMs
    /** 同时可能有两个 listener（管道 + TCP） */
    this.servers = []
    this.sockets = new Set()
    this.sock = null
    this.pending = new Map()
    this.seq = 0
    this.ready = false
    this.lastError = ''
    this.hostInfo = null
    this.everConnected = false
    /** 'pipe' | 'tcp' —— 实际用上的端点类型 */
    this.mode = null
    this.endpoint = null
    this.tcpPort = null
  }

  get connected() {
    return Boolean(this.ready && this.sock && !this.sock.destroyed)
  }

  /**
   * 起服务端。**两种端点同时监听**，由 host 自己挑能连上的那个。
   *
   * 为什么不是"一个失败再回退"：宿主以管理员身份运行时（High 完整性），它创建的命名管道
   * 是**能建成功的**，只是普通权限进程连过来会 EPERM。所以"建失败才回退"这条判断永远不触发。
   * 同时监听就没有这个问题：host 先试管道，EPERM 就换 127.0.0.1 的随机端口。
   */
  async start() {
    await this.stop()
    this.tcpPort = null
    const ok = []
    try {
      await this._listenPipe()
      ok.push('pipe')
    } catch (e) {
      log(`命名管道不可用（${e?.code || e?.message}）`)
    }
    try {
      await this._listenTcp()
      ok.push('tcp')
    } catch (e) {
      log(`TCP 端点不可用（${e?.message}）`)
    }
    if (!ok.length) throw new Error('两种端点都起不来')
    this.mode = ok.length === 2 ? 'dual' : ok[0]
    this.endpoint = [
      ok.includes('pipe') ? `pipe:${this.pipe}` : null,
      ok.includes('tcp') ? `tcp:127.0.0.1:${this.tcpPort}` : null,
    ].filter(Boolean).join(' + ')
    log(`端点已就绪 ${this.endpoint}`)
    return this
  }

  _listenPipe() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this._onConnection(sock))
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') this.lastError = 'pipe busy'
        reject(err)
      })
      server.listen(this.pipe, () => {
        this.servers.push(server)
        resolve()
      })
    })
  }

  _listenTcp() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this._onConnection(sock))
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const addr = server.address()
        this.tcpPort = addr && typeof addr === 'object' ? addr.port : null
        if (!this.tcpPort) {
          try { server.close() } catch {}
          reject(new Error('拿不到 TCP 端口'))
          return
        }
        this.servers.push(server)
        resolve()
      })
    })
  }

  _onConnection(sock) {
    this.sockets.add(sock)
    let greeted = false
    const handshake = setTimeout(() => {
      if (!greeted) {
        try {
          sock.destroy()
        } catch {}
      }
    }, this.handshakeMs)

    const decoder = new LineDecoder((msg) => {
      // 1) 握手
      if (!greeted) {
        if (msg?.type === 'hello' && safeEqual(msg.token, this.token)) {
          if (this.connected) {
            sock.end(encodeLine({ type: 'hello-rejected', reason: '已有浏览器连接' }))
            return
          }
          greeted = true
          clearTimeout(handshake)
          this._adopt(sock, msg)
          sock.write(encodeLine({ type: 'hello-ack', error: this.lastError || undefined }))
          return
        }
        log('handshake 被拒绝（token 不匹配或格式不对）')
        try {
          sock.destroy()
        } catch {}
        return
      }
      // 2) 响应
      if (this.sock === sock && msg && typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error || 'unknown error from extension'))
      }
    })

    sock.on('data', (chunk) => {
      try {
        decoder.push(chunk)
      } catch (e) {
        log(`解码失败：${e?.message}`)
        try {
          sock.destroy()
        } catch {}
      }
    })
    sock.on('error', (e) => log(`socket 错误：${e?.message}`))
    sock.on('close', () => {
      this.sockets.delete(sock)
      clearTimeout(handshake)
      if (this.sock === sock) this._drop(this.hostInfo?.protocolError || 'host 断开')
    })
  }

  _adopt(sock, hello) {
    // 兼容连接由入口处优先保留；诊断连接可让位给下一次握手。
    const previous = this.sock
    if (previous && previous !== sock) previous.destroy()
    const reported = hello.protocol === undefined ? LEGACY_EXTENSION_PROTOCOL : hello.protocol
    const protocol = Number.isSafeInteger(reported) && reported > 0 ? reported : null
    let protocolError = ''
    if (protocol !== PLUGIN_PROTOCOL) {
      const detail = `扩展协议 ${protocol ?? '无效'}，插件需要 ${PLUGIN_PROTOCOL}`
      protocolError = protocol !== null && protocol < PLUGIN_PROTOCOL
        ? `扩展协议过旧，请更新（${detail}）`
        : `扩展协议不匹配（${detail}）`
    }
    this.sock = sock
    this.ready = !protocolError
    if (this.ready) this.everConnected = true
    this.lastError = protocolError
    this.hostInfo = { pid: hello.pid ?? null, version: hello.version ?? null, protocol, protocolError, at: Date.now() }
    log(`host 已接入 pid=${hello.pid ?? '?'} v=${hello.version ?? '?'} protocol=${protocol ?? '?'}${protocolError ? ` ${protocolError}` : ''}`)
  }

  _drop(reason) {
    const had = this.ready
    this.ready = false
    this.sock = null
    if (reason) this.lastError = reason
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`浏览器连接中断：${reason}`))
    }
    this.pending.clear()
    if (had) log(`连接断开：${reason}`)
  }

  /**
   * 发一条请求。超时后 reject —— 工具调用不该无限挂着。
   */
  request(method, params = {}, timeoutMs = 30000) {
    if (!this.connected) {
      return Promise.reject(new Error(this.lastError || '浏览器未连接'))
    }
    const id = ++this.seq
    const sock = this.sock
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const request = encodeLine({ id, method, params, deadline })
      if (request.length - 1 > MAX_HOST_MESSAGE_BYTES) {
        reject(new Error('浏览器请求过大，请拆成更短的请求'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.sock === sock && !sock.destroyed) {
          try { sock.write(encodeLine({ type: 'cancel', id })) } catch {}
        }
        reject(new Error(`浏览器操作超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        sock.write(request)
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  async stop() {
    this._drop('关闭')
    const servers = this.servers.slice()
    this.servers = []
    // server.close 会等现有连接结束，因此先关闭所有已接受的 socket。
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(
      servers.map(
        (s) =>
          new Promise((resolve) => {
            try {
              s.close(() => resolve())
            } catch {
              resolve()
            }
          }),
      ),
    )
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}
