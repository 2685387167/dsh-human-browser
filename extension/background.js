/**
 * dsh-human-browser — MV3 extension background.
 *
 * 设计取舍（每一条都对应一个具体的检测面或被检测的错觉）：
 *
 *  1. **chrome.debugger，不是注入脚本。** 点击与按键走 `Input.dispatchMouseEvent` /
 *     `Input.dispatchKeyEvent`，产生的是 `isTrusted === true` 的真事件，带用户手势。
 *     用 content script `dispatchEvent(new MouseEvent())` 合成的事件 `isTrusted === false`，
 *     这是最容易被风控一票否决的信号。
 *
 *  2. **一个 CDP 域都不 enable。** `Runtime.evaluate`、`Runtime.callFunctionOn`、
 *     `Page.captureScreenshot`、`Page.navigate`、`Input.*` 都是独立命令，不需要先 `.enable`。
 *     `Runtime.enable` 会带来著名的一类探测（console.debug 陷阱 / 异常回溯副作用），
 *     通用插件为了 console 与网络日志必然全开，我们不要那些日志，所以能全关。
 *
 *  3. **不往页面里写任何东西。** 不用 `addInitScript` 抹 `navigator.webdriver`（我们本来
 *     就没有），不挂全局变量存 ref（ref 用 remoteObject 句柄存在扩展侧），不打 data- 属性。
 *     页面能读到自己 DOM 里的一切 —— 所以我们什么都不放进去。
 *
 *  4. **要焦点就真的切前台。** `Emulation.setFocusEmulationEnabled` 会伪造
 *     `document.hasFocus()`，但 `document.visibilityState` 仍是 hidden，对得上就是破绽。
 *     真正的做法是 `Page.bringToFront`，状态天然自洽。
 *
 *  5. **人类化在 Node 侧算，这里只执行时间表。** 轨迹点、每点延迟、按键节奏都是下发好的
 *     数组，这里只负责按时派发。换策略不用动扩展。
 */

import { snapshotExpression } from './snapshot.js'

const HOST_NAME = 'com.dsh.humanbrowser'
const CDP_VERSION = '1.3'
const VERSION = chrome.runtime.getManifest().version
/** 通信格式不兼容时才递增，与扩展发布版本独立。 */
const PROTOCOL = 1
const SNAP_TTL = 5 * 60 * 1000
const MAX_NODES = 260
const GLOBAL_AUTHORIZATION_KEY = 'hb-global-authorization'
const GLOBAL_SCRIPT_EXECUTION_KEY = 'hb-global-script-execution'
const TAB_AUTHORIZATION_KEY = 'hb-tab-authorization'

// ── 状态 ────────────────────────────────────────────────────────────────────

/** 已 attach 的 tabId */
const attached = new Set()
/** 当前浏览器会话内已授权的标签页及其来源。 */
const grants = new Map()
/** 每个标签页已加载的来源，用于保留初始决定和单页撤销。 */
const seenOrigins = new Map()
let globalAuthorization = false
/** 已授权标签页执行脚本的默认状态，逐页设置优先。 */
let globalScriptExecution = false
let tabAuthorizationWrites = Promise.resolve()
let globalSettingsWrites = Promise.resolve()
/** 并发请求共用同一次 debugger attach。 */
const attaching = new Map()
/** 跨来源后重新接管前，等待旧来源的调试连接释放。 */
const detaching = new Map()
/** tabId -> { objectId, snapshotId, count, at } */
const snaps = new Map()
/** tabId -> { x, y } 上一次鼠标位置，轨迹从这里出发才连续 */
const mouseAt = new Map()

let port = null
let connectTimer = null
let backoff = 1000
let lastError = ''
let hostReady = false
/** 等请求完成并发出回执后再销毁服务工作线程。 */
let reloadRequested = false
let reloadTimer = null
/** 当前 DSH 连接上的待执行请求，包括排队和运行中的请求。 */
const operations = new Map()
const tabQueues = new Map()

/** 根据失效的范围取消请求，包括在队列里尚未开始的请求。 */
function abortOperations(message, predicate = () => true) {
  for (const op of operations.values()) {
    if (predicate(op)) op.controller.abort(new Error(message))
  }
}

/** 断开后旧请求的结果不得发送到下一次连接。 */
function disconnected(message) {
  hostReady = false
  lastError = message
  abortOperations(message)
  operations.clear()
  scheduleReload()
}

// ── native messaging ────────────────────────────────────────────────────────

function scheduleConnect(delay = 0) {
  if (connectTimer) return
  connectTimer = setTimeout(() => {
    connectTimer = null
    connectHost()
  }, delay)
}

function connectHost() {
  if (port) return
  let nativePort
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME)
    port = nativePort
    // 扩展只上报自己的身份，宿主转发时补充会话 token 和进程号。
    nativePort.postMessage({ type: 'hello', version: VERSION, protocol: PROTOCOL, supportsReload: true })
  } catch (e) {
    lastError = String(e?.message || e)
    port = null
    backoff = Math.min(backoff * 2, 30000)
    scheduleConnect(backoff)
    return
  }

  nativePort.onMessage.addListener((msg) => {
    if (port !== nativePort) return
    if (msg?.type === 'host-connected') {
      hostReady = true
      backoff = 1000
      lastError = ''
      void checkSelfUpdate()
    } else if (msg?.type === 'host-disconnected') {
      disconnected(msg.reason || 'DSH 未连接')
    } else if (msg?.type === 'cancel') {
      operations.get(msg.id)?.controller.abort(new Error('DSH 已取消请求'))
    } else if (hostReady && typeof msg?.id === 'number' && typeof msg.method === 'string') {
      void handleRequest(msg, nativePort)
    }
  })

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    if (port !== nativePort) return
    disconnected(err?.message || 'native host 断开')
    port = null
    backoff = Math.min(backoff * 2, 30000)
    scheduleConnect(backoff)
  })

}

// 保留断线重连用的定时唤醒，升级检查改为启动、重连或 DSH 通知时触发。
chrome.alarms.create('hb-keepalive', { periodInMinutes: 1 })
void chrome.alarms.clear('hb-self-update')
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'hb-keepalive' && !port) connectHost()
})
chrome.runtime.onStartup.addListener(() => {
  connectHost()
})
chrome.runtime.onInstalled.addListener(() => connectHost())
connectHost()
void checkSelfUpdate()

/**
 * 只检查这个扩展所加载的目录。收到 DSH 通知时还须匹配目标版本，
 * 避免当前连上的浏览器配置重载另一个配置刚完成的更新。
 */
async function newerDiskVersion(expectedVersion) {
  try {
    const url = `${chrome.runtime.getURL('manifest.json')}?t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return false
    const disk = await res.json()
    const next = disk?.version
    return (expectedVersion === undefined || next === expectedVersion) && isNewerVersion(next, VERSION)
  } catch {
    return false
  }
}

/** 启动或重连时补查一次，覆盖更新完成时未接到通知的情况。 */
async function checkSelfUpdate() {
  if (reloadRequested || !(await newerDiskVersion())) return
  reloadRequested = true
  scheduleReload()
}

/** 等未完成的浏览器请求退出；短暂让出事件循环让 Native Messaging 送出回执。 */
function scheduleReload() {
  if (!reloadRequested || operations.size || reloadTimer !== null) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    if (operations.size) return
    reloadRequested = false
    chrome.runtime.reload()
  }, 100)
}

/** Chromium 的清单版本由最多四段整数构成，只接受严格更新。 */
function isNewerVersion(a, b) {
  if (typeof a !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(a)) return false
  const A = a.split('.').map(Number)
  const B = b.split('.').map(Number)
  if (A.some((n) => n > 65535)) return false
  for (let i = 0; i < 4; i++) {
    const x = A[i] || 0
    const y = B[i] || 0
    if (x !== y) return x > y
  }
  return false
}

// ── CDP 基础 ────────────────────────────────────────────────────────────────

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {})
}

/** 授权范围为 HTTP(S) 来源，包括协议、域名和端口。 */
function httpOrigin(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
  } catch {}
  return null
}

/** 恢复会话授权。扩展刚启用时，将当时已打开的网页登记为已加载。 */
async function loadAuthorization() {
  const [settings, session, tabs] = await Promise.all([
    chrome.storage.local.get([GLOBAL_AUTHORIZATION_KEY, GLOBAL_SCRIPT_EXECUTION_KEY]),
    chrome.storage.session.get(TAB_AUTHORIZATION_KEY),
    chrome.tabs.query({}),
  ])
  const saved = session[TAB_AUTHORIZATION_KEY]
  if (saved) {
    const openTabs = new Map(tabs.map((tab) => [tab.id, tab]))
    for (const [tabId, origins, grantedOrigin, scriptsBlocked] of saved) {
      const tab = openTabs.get(tabId)
      if (!tab) continue
      seenOrigins.set(tabId, new Set(origins))
      if (grantedOrigin && httpOrigin(tab.url) === grantedOrigin) {
        grants.set(tabId, { origin: grantedOrigin, ...(scriptsBlocked === true ? { eval: false } : {}) })
      }
    }
  } else {
    for (const tab of tabs) rememberOrigin(tab.id, httpOrigin(tab.url))
    await saveTabAuthorization()
  }
  globalAuthorization = settings[GLOBAL_AUTHORIZATION_KEY] === true
  globalScriptExecution = settings[GLOBAL_SCRIPT_EXECUTION_KEY] === true
}

const authorizationReady = loadAuthorization().catch((error) => {
  console.warn('无法恢复扩展授权设置', error)
})

/** 依照变更顺序写入会话。保留逐页脚本禁用，手动允许仅适用于当前文档。 */
function saveTabAuthorization() {
  const entries = [...seenOrigins].map(([id, origins]) => {
    const grant = grants.get(id)
    return [id, [...origins], grant?.origin ?? null, grant?.eval === false]
  })
  const save = tabAuthorizationWrites.then(() => chrome.storage.session.set({ [TAB_AUTHORIZATION_KEY]: entries }))
  tabAuthorizationWrites = save.catch((error) => console.warn('无法保存标签页授权', error))
  return save
}

/** 记录某来源第一次在这个标签页加载，刷新和返回已访问来源时返回 false。 */
function rememberOrigin(tabId, origin) {
  if (tabId == null || !origin) return false
  let origins = seenOrigins.get(tabId)
  if (!origins) {
    origins = new Set()
    seenOrigins.set(tabId, origins)
  }
  if (origins.has(origin)) return false
  origins.add(origin)
  return true
}

/** 新来源采用当前默认值。后续授权由原有的逐页控制负责。 */
function applyDefaultAuthorization(tabId, url) {
  const origin = httpOrigin(url)
  if (!rememberOrigin(tabId, origin)) return
  if (globalAuthorization) grants.set(tabId, { origin })
  void saveTabAuthorization().catch(() => {})
}

/** 按顺序保存弹窗修改的全局设置，成功后应用新的默认值。 */
function setGlobalSetting(key, enabled) {
  const save = globalSettingsWrites.then(async () => {
    await chrome.storage.local.set({ [key]: enabled })
    if (key === GLOBAL_AUTHORIZATION_KEY) globalAuthorization = enabled
    else globalScriptExecution = enabled
  })
  globalSettingsWrites = save.catch(() => {})
  return save
}

/** 调用方须先核对页面授权，逐页脚本决定优先于全局默认。 */
function canEvaluate(grant) {
  return grant.eval ?? globalScriptExecution
}

/** 手动允许只适用于当前文档。覆盖全局默认的禁用保留到该标签页撤权。 */
async function setTabScriptExecution(grant, enabled) {
  const wasBlocked = grant.eval === false
  if (enabled) grant.eval = true
  else if (globalScriptExecution) grant.eval = false
  else if (grant.eval === true) delete grant.eval
  if (wasBlocked !== (grant.eval === false)) await saveTabAuthorization()
}

/** 提交和待提交的页面必须与授权来源相同。 */
function grantMatchesTab(grant, tab) {
  return !!grant && grant.origin === httpOrigin(tab?.url) &&
    (!tab.pendingUrl || grant.origin === httpOrigin(tab.pendingUrl))
}

/** 在调用时核对实时 URL，避免导航事件尚未到达时沿用旧授权。 */
async function authorizedTab(tabId) {
  const id = Number(tabId)
  const grant = grants.get(id)
  if (!grant) throw new Error(`请在扩展弹窗授权标签页 ${id}`)
  const tab = await chrome.tabs.get(id)
  if (grants.get(id) !== grant || !grantMatchesTab(grant, tab)) {
    throw new Error('页面已变化，请在扩展弹窗重新授权')
  }
  return { tab, grant }
}

/** attach 的归属只由本扩展实际建立的连接确认。 */
async function ensureAttached(tabId) {
  await detaching.get(Number(tabId))?.catch(() => {})
  const { tab, grant } = await authorizedTab(tabId)
  const id = tab.id
  if (attached.has(id)) return id
  let task = attaching.get(id)
  if (!task) {
    task = attachTab(id, grant).finally(() => attaching.delete(id))
    attaching.set(id, task)
  }
  await task
  return id
}

/** 授权在 attach 期间被撤销时，立即释放刚建立的调试会话。 */
async function attachTab(id, grant) {
  try {
    await chrome.debugger.attach({ tabId: id }, CDP_VERSION)
  } catch (e) {
    const m = String(e?.message || e)
    if (/already attached/i.test(m)) {
      // 我们没记过这个标签页 → 是别人（DevTools 或另一个浏览器插件）占着
      throw new Error(
        '这个标签页已经被别的调试器接管了，多半是该页面的 DevTools 开着，或另一个浏览器插件在控制它。' +
          '关掉 DevTools / 那个插件再试。',
      )
    }
    throw new Error(`无法接管标签页 ${id}：${m}`)
  }
  if (grants.get(id) !== grant) {
    await chrome.debugger.detach({ tabId: id }).catch(() => {})
    throw new Error('标签页授权已撤销')
  }
  attached.add(id)
}

function dropAttached(tabId) {
  attached.delete(Number(tabId))
  snaps.delete(Number(tabId))
  mouseAt.delete(Number(tabId))
}

/** 撤销接管并取消该页的排队请求与正在执行的操作。 */
async function revokeTab(tabId, message) {
  grants.delete(tabId)
  abortOperations(message, (op) => op.tabId === tabId)
  const wasAttached = attached.has(tabId)
  dropAttached(tabId)
  let detach
  if (wasAttached) {
    detach = chrome.debugger.detach({ tabId }).finally(() => detaching.delete(tabId))
    detaching.set(tabId, detach)
  }
  await Promise.all([detach, saveTabAuthorization()])
}

/** 标签页关闭后清理授权及已加载来源。 */
function forgetTab(tabId) {
  const seen = seenOrigins.delete(tabId)
  grants.delete(tabId)
  dropAttached(tabId)
  abortOperations('标签页已关闭', (op) => op.tabId === tabId && op.method !== 'close')
  if (seen) void saveTabAuthorization().catch(() => {})
}

chrome.tabs.onCreated.addListener((tab) => {
  void authorizationReady.then(() => applyDefaultAuthorization(tab.id, tab.url))
})
chrome.tabs.onRemoved.addListener((tabId) => {
  void authorizationReady.then(() => forgetTab(tabId))
})
chrome.tabs.onReplaced.addListener((tabId, previousId) => {
  void authorizationReady.then(async () => {
    // Chrome 预渲染替换标签页时，保留旧标签页已经作出的逐来源决定。
    const previousOrigins = seenOrigins.get(previousId)
    const previousGrant = grants.get(previousId)
    if (previousOrigins) {
      seenOrigins.set(tabId, new Set([...previousOrigins, ...(seenOrigins.get(tabId) ?? [])]))
      const replacementGrant = grants.get(tabId)
      if (previousOrigins.has(replacementGrant?.origin) && previousGrant?.origin !== replacementGrant.origin) {
        void revokeTab(tabId, '保留原标签页的授权决定').catch(() => {})
      } else if (previousGrant) {
        const grant = replacementGrant ?? { origin: previousGrant.origin }
        if (grant.origin === previousGrant.origin && previousGrant.eval === false) grant.eval = false
        grants.set(tabId, grant)
      }
    }
    forgetTab(previousId)
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab) updateTabAuthorization(tabId, { url: tab.url }, tab)
  })
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  void authorizationReady.then(() => updateTabAuthorization(tabId, change, tab))
})

/** 保留原有的导航撤销逻辑，再为尚未加载过的来源应用默认授权。 */
function updateTabAuthorization(tabId, change, tab) {
  const grant = grants.get(tabId)
  const committedUrl = change.url ?? (change.status === 'complete' ? tab?.url : undefined)
  if (committedUrl && grant && httpOrigin(committedUrl) !== grant.origin) {
    void revokeTab(tabId, '页面已离开授权来源').catch(() => {})
  } else if (change.status === 'loading' || change.url) {
    if (grant?.eval === true) delete grant.eval
    const previous = snaps.get(tabId)
    snaps.delete(tabId)
    if (previous) void send(tabId, 'Runtime.releaseObject', { objectId: previous.objectId }).catch(() => {})
    abortOperations('页面已导航，请重新确认目标', (op) => op.tabId === tabId && op.documentBound)
  }
  if (committedUrl) applyDefaultAuthorization(tabId, committedUrl)
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  abortOperations('前台标签页已切换', (op) => op.inputStarted && op.tabId !== tabId)
})
chrome.windows.onFocusChanged.addListener((windowId) => {
  abortOperations('浏览器窗口焦点已变化', (op) => op.inputStarted && op.windowId !== windowId)
})
chrome.debugger.onDetach.addListener((source) => {
  if (attached.has(source?.tabId)) {
    grants.delete(source.tabId)
    dropAttached(source.tabId)
    abortOperations('Chrome 调试会话已断开', (op) => op.tabId === source.tabId && op.method !== 'close')
    void saveTabAuthorization().catch(() => {})
  }
})

// ── 页面求值（无需 Runtime.enable）───────────────────────────────────────────

async function evaluate(tabId, expression, { byValue = true, objectGroup, awaitPromise = false } = {}) {
  const r = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: byValue,
    awaitPromise,
    ...(objectGroup ? { objectGroup } : {}),
  })
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails
    const desc = d.exception?.description || d.text || 'script error'
    throw new Error(`页面脚本出错：${String(desc).split('\n')[0]}`)
  }
  return r?.result
}

async function callOn(tabId, objectId, fn, args = [], byValue = true) {
  const r = await send(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((v) => ({ value: v })),
    returnByValue: byValue,
    awaitPromise: false,
  })
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error(`页面脚本出错：${String(d.exception?.description || d.text || '').split('\n')[0]}`)
  }
  return r?.result
}

// ── 快照 ────────────────────────────────────────────────────────────────────

// 快照表达式已移到 snapshot.js —— 那段代码需要能单独编译测试，见 tests/snapshot.test.mjs

async function doSnapshot(tabId, opts, op) {
  const id = await ensureAttached(tabId)
  op.check()
  const max = Math.min(Number(opts.max) || MAX_NODES, 600)

  const res = await evaluate(id, snapshotExpression(max, !!opts.includeOffscreen), {
    byValue: false,
    objectGroup: 'hb-snap',
  })
  const objectId = res?.objectId
  if (!objectId) throw new Error('快照失败：页面没有返回可用的句柄')

  try {
    const meta = await callOn(id, objectId, 'function(){ return { title: this.title, url: this.url, scroll: this.scroll, count: this.desc.length, desc: this.desc } }')
    op.check()
    const value = meta?.value || { desc: [], count: 0 }
    const snapshotId = crypto.randomUUID()
    const desc = value.desc.map((node) => ({ ...node, ref: `${snapshotId}:${node.i}` }))
    const prev = snaps.get(id)
    snaps.set(id, { objectId, snapshotId, count: value.count, at: Date.now() })
    if (prev) void send(id, 'Runtime.releaseObject', { objectId: prev.objectId }).catch(() => {})
    return { ...value, desc }
  } catch (error) {
    await send(id, 'Runtime.releaseObject', { objectId }).catch(() => {})
    throw error
  }
}

/** 引用与标签页、快照版本及条目绑定，整数下标和旧引用一律失效。 */
function resolveRef(tabId, ref) {
  const snap = snaps.get(Number(tabId))
  if (!snap) throw new Error('请先调 browser_snapshot 获取当前页面的快照和 ref')
  if (Date.now() - snap.at > SNAP_TTL) throw new Error('快照已过期，请重新获取 ref')
  const [snapshotId, ordinal, extra] = String(ref).split(':')
  const index = Number(ordinal)
  if (extra !== undefined || snapshotId !== snap.snapshotId || !Number.isInteger(index) ||
      String(index) !== ordinal || index < 0 || index >= snap.count) {
    throw new Error('ref 不属于当前快照，请重新获取 ref')
  }
  return { snap, index }
}

/**
 * 从 ref 取元素盒（顺带确认它还连着 DOM）。
 *
 * 关键点：元素可能在同源 iframe 里，此时 getBoundingClientRect 是相对**那个 iframe** 的，
 * 而 `Input.dispatchMouseEvent` 要的是顶层视口坐标。所以要沿着 frameElement 逐层加偏移。
 * 顺序必须是「先 scrollIntoView 再取 rect」，否则滚动后坐标是旧的。
 */
async function boxOfRef(tabId, ref, { scroll = true, point } = {}) {
  const { snap, index } = resolveRef(tabId, ref)
  const r = await callOn(
    tabId,
    snap.objectId,
    `function(i, scroll, point){
      const el = this.els[i];
      if (!el) return { missing: true };
      if (!el.isConnected) return { detached: true };
      if (scroll) try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {
        try { el.scrollIntoView(); } catch (e2) {}
      }
      let ox = 0, oy = 0;
      try {
        let w = el.ownerDocument && el.ownerDocument.defaultView;
        let guard = 0;
        while (w && w !== window && guard++ < 8) {
          const fe = w.frameElement;
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          ox += fr.x + fe.clientLeft; oy += fr.y + fe.clientTop;
          w = fe.ownerDocument && fe.ownerDocument.defaultView;
        }
      } catch (e) { /* 跨域 frame 读不到，退回顶层坐标 */ }
      const b = el.getBoundingClientRect();
      if (point) {
        const x = point.x - ox, y = point.y - oy;
        const root = el.getRootNode();
        const hit = (root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(x, y);
        if (!hit || (hit !== el && !el.contains(hit))) return { miss: true };
        let frame = el.ownerDocument.defaultView.frameElement;
        let fx = x, fy = y;
        while (frame) {
          const rect = frame.getBoundingClientRect();
          fx += rect.x + frame.clientLeft; fy += rect.y + frame.clientTop;
          const frameRoot = frame.getRootNode();
          if ((frameRoot.elementFromPoint ? frameRoot : frame.ownerDocument).elementFromPoint(fx, fy) !== frame) return { miss: true };
          frame = frame.ownerDocument.defaultView.frameElement;
        }
      }
      return { x: b.x + ox, y: b.y + oy, w: b.width, h: b.height, tag: el.tagName.toLowerCase() };
    }`,
    [index, scroll, point || null],
  )
  const v = r?.value || {}
  if (v.missing) throw new Error(`ref ${ref} 不存在（快照里有 ${snap.count} 个元素，下标从 0 开始）`)
  if (v.detached) throw new Error(`ref ${ref} 的元素已经不在页面上了（页面重渲染了）。重新 browser_snapshot。`)
  if (v.miss) throw new Error('元素已移动或被遮挡，请重新获取快照')
  if (!v.w || !v.h) throw new Error('元素当前不可见')
  return v
}

// ── 输入派发 ────────────────────────────────────────────────────────────────

/** 让计划里的停顿能在请求被取消时立刻唤醒。 */
function sleep(ms, op) {
  op.check()
  return new Promise((resolve, reject) => {
    const signal = op.controller.signal
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      try { op.check(); resolve() } catch (error) { reject(error) }
    }, Math.min(Math.max(0, ms), op.deadline - Date.now()))
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 每次派发都先核对期限和取消状态。 */
function input(tabId, method, params, op) {
  op.check()
  return send(tabId, method, params)
}

const VK = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
}

/** 把鼠标送到目标点：先走轨迹，再真的按下 */
async function dispatchMove(tabId, points, final, op) {
  for (const p of points) {
    await input(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clampi(p.x), y: clampi(p.y),
      buttons: 0,
      pointerType: 'mouse',
    }, op)
    if (p.delay) await sleep(p.delay, op)
  }
  if (final) {
    await input(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: clampi(final.x), y: clampi(final.y), buttons: 0, pointerType: 'mouse',
    }, op)
  }
  const last = final || points[points.length - 1]
  if (last) mouseAt.set(Number(tabId), { x: last.x, y: last.y })
}

const clampi = (v) => Math.max(0, Math.round(Number(v) || 0))

async function dispatchClick(tabId, { points, final, aimPause, button = 'left', clickCount = 1 }, ref, op) {
  const base = {
    x: clampi(final?.x ?? points?.[points.length - 1]?.x),
    y: clampi(final?.y ?? points?.[points.length - 1]?.y),
    button,
    clickCount,
    pointerType: 'mouse',
  }
  if (ref == null) {
    const vp = await evaluate(tabId, '({ w: innerWidth, h: innerHeight })')
    if (!final || !Number.isFinite(final.x) || !Number.isFinite(final.y) || final.x < 0 || final.y < 0 ||
        !vp?.value || base.x >= vp.value.w || base.y >= vp.value.h) throw new Error('点击坐标超出当前视口')
  }
  await dispatchMove(tabId, points || [], final, op)
  await sleep(aimPause || 60, op)
  if (ref != null) await boxOfRef(tabId, ref, { scroll: false, point: { x: base.x, y: base.y } })
  op.check()
  // 一次提交按下和抬起。两者之间等待会让超时或断线后的抬起触发迟到的点击。
  await Promise.all([
    send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: button === 'left' ? 1 : 2, ...base }),
    send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base }),
  ])
}

async function dispatchType(tabId, plan, op, verifyFocus) {
  for (const step of plan) {
    await verifyFocus()
    const ch = step.ch
    if (step.kind === 'insert') {
      // 非 ASCII（中文等）走 insertText：键盘布局产生不了它
      await input(tabId, 'Input.insertText', { text: ch }, op)
    } else {
      const code = keyInfo(ch)
      await input(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        unmodifiedText: ch,
        key: ch,
        code: code.code,
        windowsVirtualKeyCode: code.vk,
        nativeVirtualKeyCode: code.vk,
      }, op)
      await send(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: ch,
        code: code.code,
        windowsVirtualKeyCode: code.vk,
        nativeVirtualKeyCode: code.vk,
      })
    }
    if (step.delay) await sleep(step.delay, op)
  }
}

function keyInfo(ch) {
  const up = ch.toUpperCase()
  if (/^[A-Z]$/.test(up)) return { code: 'Key' + up, vk: up.charCodeAt(0) }
  if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, vk: ch.charCodeAt(0) }
  if (ch === ' ') return { code: 'Space', vk: 32 }
  const shiftMap = {
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
    '-': 'Minus', _: 'Minus', '=': 'Equal', '+': 'Equal',
    '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
    '\\': 'Backslash', '|': 'Backslash', ';': 'Semicolon', ':': 'Semicolon',
    "'": 'Quote', '"': 'Quote', ',': 'Comma', '<': 'Comma', '.': 'Period', '>': 'Period',
    '/': 'Slash', '?': 'Slash', '`': 'Backquote', '~': 'Backquote',
  }
  if (shiftMap[ch]) return { code: shiftMap[ch], vk: ch.toUpperCase().charCodeAt(0) }
  return { code: '', vk: ch.charCodeAt(0) }
}

async function dispatchKey(tabId, key, modifiers, op) {
  const known = Object.hasOwn(VK, key)
  const vk = known ? VK[key] : (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
  if (!vk) throw new Error(`不认识的按键：${key}`)
  const code = known ? key : keyInfo(key).code
  const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await input(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common }, op)
  try {
    if (key === 'Enter') await input(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', ...common }, op)
  } finally {
    if (grants.has(tabId) && attached.has(tabId)) await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }
}

async function dispatchWheel(tabId, parts, origin, op) {
  for (const p of parts) {
    // Chrome 偶尔不回 ACK。此时停止后续段并报告结果未知，避免盲目重试。
    let timer
    try {
      await Promise.race([input(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: clampi(origin.x),
        y: clampi(origin.y),
        deltaX: p.deltaX || 0,
        deltaY: p.delta || 0,
        pointerType: 'mouse',
      }, op), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Chrome 未确认滚轮事件，实际滚动位置可能已变化')), 1500)
      })])
    } finally {
      clearTimeout(timer)
    }
    if (p.delay) await sleep(p.delay, op)
  }
}

/** 返回真正获得焦点的可编辑元素，包括同源 iframe 和开放 shadow root。 */
const focusedElement = `(() => {
  let el = document.activeElement;
  for (let depth = 0; el && depth < 12; depth++) {
    const next = el.shadowRoot?.activeElement || el.contentDocument?.activeElement;
    if (!next) break;
    el = next;
  }
  if (!document.hasFocus() || !el || el.matches(':disabled') || el.readOnly) return null;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|search|url|tel|email|password|number)$/.test(el.type))) return el;
  return null;
})()`

/** 输入只使用此刻处于前台的目标，窗口或页签变化会取消后续派发。 */
async function startInput(tabId, op) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  op.check()
  if (tabs[0]?.id !== tabId) throw new Error('前台标签页已切换，请重新确认目标')
  // DSH 可能是桌面的前台应用。只聚焦当前浏览器窗口，不切换其中的标签页。
  await chrome.windows.update(tabs[0].windowId, { focused: true })
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  op.check()
  if (front?.id !== tabId) throw new Error('前台标签页已切换，请重新确认目标')
  op.windowId = front.windowId
  op.inputStarted = true
}

// ── 请求分发 ────────────────────────────────────────────────────────────────

const METHODS = {
  /** 只接受 DSH 指明且本目录已经写好的目标版本。 */
  async reloadExtension({ version }, op) {
    const scheduled = typeof version === 'string' && await newerDiskVersion(version)
    op.check()
    if (scheduled) reloadRequested = true
    return { scheduled }
  },

  async status() {
    const tabs = await chrome.tabs.query({})
    return {
      version: VERSION,
      protocol: PROTOCOL,
      globalAuthorization,
      globalScriptExecution,
      attached: [...attached],
      authorized: [...grants.keys()],
      tabCount: tabs.length,
      snaps: [...snaps.entries()].map(([tabId, s]) => ({ tabId, count: s.count, ageMs: Date.now() - s.at })),
    }
  },

  async tabs({ all }) {
    const list = await chrome.tabs.query(all ? {} : { lastFocusedWindow: true })
    const [front] = all ? await chrome.tabs.query({ active: true, lastFocusedWindow: true }) : list.filter((t) => t.active)
    return list
      .filter((t) => t.id != null)
      .map((t) => {
        const grant = grants.get(t.id)
        const authorized = grantMatchesTab(grant, t)
        return {
          id: t.id,
          title: authorized ? (t.title || '').slice(0, 90) : '',
          url: authorized ? (t.url || '').slice(0, 180) : '',
          authorized,
          windowId: t.windowId,
          attached: attached.has(t.id),
          mine: t.id === front?.id,
        }
      })
      .sort((a, b) => (a.windowId - b.windowId) || (a.id - b.id))
  },

  async activate({ tabId }, op) {
    const tab = await chrome.tabs.update(Number(tabId), { active: true })
    op.check()
    await chrome.windows.update(tab.windowId, { focused: true })
    return { tabId: Number(tabId) }
  },

  async open({ url, background }) {
    if (!httpOrigin(url)) throw new Error('只允许打开 HTTP 或 HTTPS 网址')
    const tab = await chrome.tabs.create({ url, active: !background })
    return { tabId: tab?.id ?? null, url, globalAuthorization }
  },

  async close({ tabId }) {
    await chrome.tabs.remove(Number(tabId))
    dropAttached(tabId)
    return { tabId: Number(tabId), closed: true }
  },

  async snapshot({ tabId, max, includeOffscreen }, op) {
    const info = await doSnapshot(tabId, { max, includeOffscreen }, op)
    return info
  },

  async read({ tabId, what, selector, maxChars }, op) {
    const id = await ensureAttached(tabId)
    op.check()
    const limit = Math.min(Math.max(Math.trunc(Number(maxChars) || 20000), 1), 200000)
    if (what === 'text') {
      const r = await evaluate(id, `(() => {
        const sel = ${JSON.stringify(selector || null)};
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return { missing: true };
        const t = (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return { text: t.slice(0, ${limit}), total: t.length };
      })()`)
      const v = r?.value || {}
      if (v.missing) throw new Error(`没有找到选择器：${selector}`)
      return v
    }
    if (what === 'html') {
      const r = await evaluate(id, `(() => {
        const sel = ${JSON.stringify(selector || null)};
        const el = sel ? document.querySelector(sel) : document.documentElement;
        if (!el) return { missing: true };
        const h = el.outerHTML || '';
        return { html: h.slice(0, ${limit}), total: h.length };
      })()`)
      const v = r?.value || {}
      if (v.missing) throw new Error(`没有找到选择器：${selector}`)
      return v
    }
    if (what === 'attr') {
      if (!selector) throw new Error('读取元素属性时需要 selector')
      const r = await evaluate(id, `(() => {
        const el = document.querySelector(${JSON.stringify(selector || '')});
        if (!el) return { missing: true };
        const out = {};
        for (const a of el.attributes) out[a.name] = String(a.value).slice(0, 400);
        return { attrs: out, tag: el.tagName.toLowerCase() };
      })()`)
      const v = r?.value || {}
      if (v.missing) throw new Error(`没有找到选择器：${selector}`)
      return v
    }
    // info：页面元信息
    const r = await evaluate(id, `(() => ({
      url: location.href, title: document.title,
      readyState: document.readyState,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight },
      visible: document.visibilityState, focused: document.hasFocus(),
      lang: document.documentElement.lang || null,
      forms: document.forms.length, links: document.links.length, images: document.images.length
    }))()`)
    return r?.value || {}
  },

  async elementBox({ tabId, ref }, op) {
    // 计算动作坐标时可能触发滚动，也要确保目标仍是当前页。
    resolveRef(tabId, ref)
    await startInput(tabId, op)
    return boxOfRef(tabId, ref)
  },

  /** 当前鼠标位置：Node 侧算轨迹要以它为起点，否则每段都从 (0,0) 飞过来 */
  async mouse({ tabId }) {
    return { at: mouseAt.get(Number(tabId)) || null }
  },

  /**
   * 点击。坐标一律是**视口绝对坐标**（CSS px），由 Node 侧算好下发——
   * 扩展不参与任何策略，只按时间表派发。
   */
  async click({ tabId, plan, ref }, op) {
    const id = await ensureAttached(tabId)
    if (ref != null) resolveRef(id, ref)
    await startInput(id, op)
    await dispatchClick(id, plan, ref, op)
    return {
      clicked: true,
      at: { x: Math.round(plan.final?.x ?? 0), y: Math.round(plan.final?.y ?? 0) },
    }
  },

  async hover({ tabId, plan, ref }, op) {
    const id = await ensureAttached(tabId)
    await startInput(id, op)
    await boxOfRef(id, ref, { scroll: false, point: plan.final })
    await dispatchMove(id, plan.points || [], plan.final, op)
    return { hovered: true, at: { x: Math.round(plan.final?.x ?? 0), y: Math.round(plan.final?.y ?? 0) } }
  },

  async type({ tabId, plan, clearFirst, ref, clickPlan, enterDelay }, op) {
    const id = await ensureAttached(tabId)
    const targetRef = ref == null ? null : resolveRef(id, ref)
    await startInput(id, op)
    if (targetRef) await dispatchClick(id, clickPlan, ref, op)

    const focused = await evaluate(id, focusedElement, { byValue: false })
    if (!focused?.objectId) throw new Error('焦点不在可编辑的输入框里')
    const verifyFocus = async () => {
      op.check()
      const result = await callOn(id, focused.objectId, `function(){ return this === ${focusedElement}; }`)
      if (result?.value !== true) throw new Error('输入框焦点已变化，已停止继续输入')
    }
    try {
      if (targetRef) {
        const match = await callOn(id, targetRef.snap.objectId, `function(index){
          const el = this.els[index]; const current = ${focusedElement};
          return !!current && (el === current || (el.isContentEditable && el.contains(current)));
        }`, [targetRef.index])
        if (match?.value !== true) throw new Error('点击后焦点未落在指定输入框，已停止输入')
      }
      if (clearFirst) {
        await verifyFocus()
        await dispatchKey(id, 'a', 2, op)
        await sleep(60, op)
        await verifyFocus()
        await dispatchKey(id, 'Backspace', 0, op)
        await sleep(70, op)
      }
      await dispatchType(id, plan, op, verifyFocus)
      if (enterDelay != null) {
        await sleep(enterDelay, op)
        await verifyFocus()
        await dispatchKey(id, 'Enter', 0, op)
      }
      return { typed: plan.length }
    } finally {
      void send(id, 'Runtime.releaseObject', { objectId: focused.objectId }).catch(() => {})
    }
  },

  async key({ tabId, key, modifiers }, op) {
    const id = await ensureAttached(tabId)
    await startInput(id, op)
    await dispatchKey(id, key, modifiers || 0, op)
    return { key }
  },

  async scroll({ tabId, parts, x, y }, op) {
    const id = await ensureAttached(tabId)
    await startInput(id, op)
    const info = await evaluate(id, '({ w: innerWidth, h: innerHeight })')
    const vp = info?.value || { w: 1280, h: 800 }
    const origin = { x: x ?? Math.round(vp.w * (0.4 + Math.random() * 0.2)), y: y ?? Math.round(vp.h * (0.4 + Math.random() * 0.2)) }
    await dispatchWheel(id, parts, origin, op)
    const after = await evaluate(id, '({ y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight })')
    return { at: origin, ...(after?.value || {}) }
  },

  async wait({ tabId, selector, gone, urlContains, ms, timeout }, op) {
    if ([!!selector, !!urlContains, ms != null].filter(Boolean).length !== 1) throw new Error('只指定一种等待条件')
    const limit = Math.min(Math.max(Number(timeout) || 30000, 1), 120000)
    const start = Date.now()
    if (ms != null) {
      if (!Number.isInteger(ms) || ms < 0 || ms > limit) throw new Error(`等待时长必须在 0 到 ${limit}ms 内`)
      await sleep(ms, op)
      return { waitedMs: Date.now() - start }
    }
    const id = await ensureAttached(tabId)
    const deadline = start + limit
    while (Date.now() < deadline) {
      op.check()
      if (selector) {
        const r = await evaluate(id, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible = b.width > 1 && b.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none';
          return { found: true, visible };
        })()`)
        const v = r?.value || {}
        const ok = gone ? !v.found || !v.visible : v.found && v.visible
        if (ok && Date.now() <= deadline) return { ok: true, selector, gone: !!gone, waitedMs: Date.now() - start }
      }
      if (urlContains) {
        const r = await evaluate(id, 'location.href')
        if (String(r?.value || '').includes(urlContains) && Date.now() <= deadline) return { ok: true, url: r.value }
      }
      await sleep(Math.min(200, Math.max(0, deadline - Date.now())), op)
    }
    throw new Error(`等待超时（${limit}ms）：${selector ? `选择器 ${selector}` : `网址包含 ${urlContains}`}`)
  },

  async screenshot({ tabId, format, quality, fullPage, ref, maxWidth }, op) {
    const id = await ensureAttached(tabId)
    op.check()
    const box = ref == null ? null : await boxOfRef(id, ref)
    op.check()
    const { cssLayoutViewport, cssVisualViewport, cssContentSize } = await send(id, 'Page.getLayoutMetrics')
    if (!cssLayoutViewport || !cssVisualViewport) throw new Error('Chrome 未返回页面视口坐标')

    // 给模型的图片限制宽度，避免截图占用过多内存和附件空间。
    const fmt = format === 'png' ? 'png' : 'jpeg'
    const wantW = Math.min(Math.max(Number(maxWidth) || (fmt === 'png' ? 1100 : 1400), 1), 4096)
    const view = cssVisualViewport
    // 输入坐标以视口为原点，CDP 截图裁剪以文档为原点。
    let clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight }
    if (box) {
      clip = { x: cssLayoutViewport.pageX + box.x, y: cssLayoutViewport.pageY + box.y, width: box.w, height: box.h }
    } else if (fullPage && cssContentSize) {
      clip = cssContentSize
    }
    if (clip.width <= 0 || clip.height <= 0) throw new Error('截图区域为空')
    const scale = Math.min(1, wantW / clip.width, 8192 / clip.height)

    const params = {
      format: fmt,
      ...(fmt === 'jpeg' ? { quality: Math.min(Math.max(Number(quality) || 72, 1), 100) } : {}),
      clip: { ...clip, scale },
      ...(box || fullPage ? { captureBeyondViewport: true } : {}),
    }
    op.check()
    const r = await send(id, 'Page.captureScreenshot', params)
    const b64 = r?.data
    if (!b64) throw new Error('Chrome 未返回截图')
    return { dataBase64: b64, format: fmt, scale, approxBytes: Math.round((b64.length * 3) / 4) }
  },

  async evaluate({ tabId, expression }, op) {
    const { grant } = await authorizedTab(tabId)
    if (!canEvaluate(grant)) throw new Error('请先在扩展弹窗单独允许本页执行脚本')
    const id = await ensureAttached(tabId)
    // 调试器连接期间，页面权限或全局脚本设置可能已被用户更改。
    const { grant: currentGrant } = await authorizedTab(id)
    op.check()
    if (currentGrant !== grant || !canEvaluate(currentGrant)) throw new Error('脚本执行授权已撤销')
    const r = await evaluate(id, `(() => { const __v = (${expression}); return { value: typeof __v === 'undefined' ? null : __v }; })()`, {
      byValue: true,
      awaitPromise: false,
    })
    return r?.value || { value: null }
  },

  async stealth({ tabId }) {
    const id = await ensureAttached(tabId)
    const r = await evaluate(id, `(() => {
      const out = { webdriver: navigator.webdriver, ua: navigator.userAgent };
      out.headlessUA = /HeadlessChrome/i.test(navigator.userAgent);
      out.plugins = navigator.plugins ? navigator.plugins.length : 0;
      out.mimeTypes = navigator.mimeTypes ? navigator.mimeTypes.length : 0;
      out.languages = (navigator.languages || []).join(',');
      out.hardwareConcurrency = navigator.hardwareConcurrency || 0;
      out.deviceMemory = navigator.deviceMemory || null;
      out.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio };
      out.window = { iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight };
      out.chromeRuntime = !!(window.chrome && window.chrome.runtime);
      out.chromeObj = typeof window.chrome;
      out.visibility = document.visibilityState;
      out.hasFocus = document.hasFocus();
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        out.webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a';
        out.webglVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a';
      } catch (e) { out.webglRenderer = 'error'; }
      try {
        const c = document.createElement('canvas'); c.width = 200; c.height = 40;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top'; ctx.font = '14px Arial';
        ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 100, 20);
        ctx.fillStyle = '#069'; ctx.fillText('human-browser', 2, 2);
        out.canvasHash = c.toDataURL().slice(-48);
      } catch (e) { out.canvasHash = 'error'; }
      out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.permissions = typeof navigator.permissions;
      return out;
    })()`)
    const v = r?.value || {}
    const findings = []
    if (v.webdriver === true) findings.push({ level: 'fail', code: 'webdriver', detail: 'navigator.webdriver 为 true —— 这是最致命的信号' })
    if (v.headlessUA) findings.push({ level: 'fail', code: 'headless-ua', detail: 'UA 里带 HeadlessChrome' })
    if (/swiftshader|software|llvmpipe/i.test(String(v.webglRenderer))) findings.push({ level: 'fail', code: 'software-gl', detail: `WebGL 走软件渲染（${v.webglRenderer}），headless 的典型特征` })
    if (!v.plugins) findings.push({ level: 'warn', code: 'no-plugins', detail: 'navigator.plugins 为空，真实桌面 Chrome 不该是这样' })
    if (v.visibility === 'hidden') findings.push({ level: 'warn', code: 'hidden', detail: '页面处于 hidden 状态（标签页在后台或被遮挡），部分风控会据此降权' })
    if (v.hasFocus === false) findings.push({ level: 'info', code: 'no-focus', detail: '窗口没有焦点；真实操作时建议先 bringToFront' })
    if (v.chromeRuntime === false) findings.push({ level: 'info', code: 'no-ext-runtime', detail: 'window.chrome.runtime 不可见（普通网页正常如此，不一定是问题）' })
    if (!findings.length) findings.push({ level: 'ok', code: 'clean', detail: '四层自检没有发现明显破绽' })
    return { metrics: v, findings }
  },

  async detach({ tabId }) {
    const id = Number(tabId)
    await revokeTab(id, '标签页授权已撤销')
    return { tabId: id, detached: true }
  },
}

/** 页面状态或输入有先后关系的请求，在同一标签页上依次执行。 */
const serializedMethods = new Set(['activate', 'close', 'snapshot', 'elementBox', 'click', 'hover', 'type', 'key', 'scroll', 'screenshot', 'evaluate'])
const globalMethods = new Set(['status', 'tabs', 'open', 'detach', 'reloadExtension'])

async function handleRequest(msg, nativePort) {
  const { id, method } = msg
  const params = msg.params || {}
  const controller = new AbortController()
  const global = globalMethods.has(method) || (method === 'wait' && params.ms != null)
  const tabId = global ? null : Number(params.tabId)
  const op = {
    tabId,
    method,
    deadline: msg.deadline,
    controller,
    documentBound: !global && !['activate', 'close', 'wait'].includes(method),
    check() {
      controller.signal.throwIfAborted()
      if (!Number.isFinite(msg.deadline) || Date.now() >= msg.deadline) throw new Error('请求已超时')
    },
  }
  operations.set(id, op)
  const reply = (body) => {
    if (port !== nativePort || !hostReady || operations.get(id) !== op) return
    try { nativePort.postMessage({ id, ...body }) } catch (e) { lastError = String(e?.message || e) }
  }
  try {
    if (!Object.hasOwn(METHODS, method)) throw new Error(`未知方法：${method}`)
    const run = async () => {
      await authorizationReady
      op.check()
      if (!global) await authorizedTab(tabId)
      op.check()
      return METHODS[method](params, op)
    }
    let result
    if (serializedMethods.has(method)) {
      const task = (tabQueues.get(tabId) || Promise.resolve()).then(run)
      const tail = task.catch(() => {})
      tabQueues.set(tabId, tail)
      try { result = await task } finally {
        if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId)
      }
    } else {
      result = await run()
    }
    op.check()
    reply({ ok: true, result })
  } catch (e) {
    reply({ ok: false, error: String(e?.message || e) })
  } finally {
    if (operations.get(id) === op) operations.delete(id)
    scheduleReload()
  }
}

/** 授权只从插件弹窗进入。再次核对用户看到的标签页与来源。 */
async function popupRequest(msg) {
  await authorizationReady
  if (msg.type === 'hb-reconnect') {
    const previous = port
    port = null
    disconnected('正在重新连接')
    previous?.disconnect()
    connectHost()
    return { ok: true }
  }
  if (msg.type === GLOBAL_AUTHORIZATION_KEY || msg.type === GLOBAL_SCRIPT_EXECUTION_KEY) {
    if (typeof msg.enabled !== 'boolean') throw new Error('全局设置状态无效')
    await setGlobalSetting(msg.type, msg.enabled)
    return { ok: true }
  }

  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const origin = httpOrigin(current?.url)
  const grant = grants.get(current?.id)
  if (msg.type === 'hb-status') {
    const authorized = grantMatchesTab(grant, current)
    return {
      connected: hostReady, attached: [...attached], authorizedCount: grants.size, lastError, version: VERSION,
      tabId: current?.id, origin, authorized, eval: authorized && canEvaluate(grant),
      globalAuthorization, globalScriptExecution,
    }
  }
  if (!origin || current.id !== msg.tabId || origin !== msg.origin ||
      (current.pendingUrl && httpOrigin(current.pendingUrl) !== origin)) {
    throw new Error('当前标签页已变化，请重新打开弹窗')
  }
  if (msg.type === 'hb-grant') {
    rememberOrigin(current.id, origin)
    if (grant?.origin !== origin) {
      grants.set(current.id, { origin })
      await saveTabAuthorization()
    }
  } else if (msg.type === 'hb-revoke') {
    rememberOrigin(current.id, origin)
    await revokeTab(current.id, '用户已撤销标签页授权')
  } else if (msg.type === 'hb-eval') {
    if (!grant || grant.origin !== origin) throw new Error('请先授权此标签页')
    if (typeof msg.enabled !== 'boolean') throw new Error('脚本执行状态无效')
    await setTabScriptExecution(grant, msg.enabled)
  }
  return { ok: true }
}

/** 仅扩展弹窗可查询或修改用户权限。 */
const popupActions = ['hb-status', 'hb-reconnect', GLOBAL_AUTHORIZATION_KEY, GLOBAL_SCRIPT_EXECUTION_KEY,
  'hb-grant', 'hb-revoke', 'hb-eval']
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.url !== chrome.runtime.getURL('popup.html') ||
      !popupActions.includes(msg?.type)) return false
  void popupRequest(msg).then(sendResponse, (error) => sendResponse({ error: error.message }))
  return true
})
