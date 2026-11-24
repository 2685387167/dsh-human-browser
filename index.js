/**
 * dsh-human-browser — DSH 插件本体。
 *
 * 分工：
 *   这里（Node）算**策略** —— 鼠标轨迹、落点、按键节奏、滚动分段。
 *   扩展那边只按时间表派发真实的 CDP Input 事件。
 *
 * 所以调整"像不像人"，改的是这个文件和 lib/human.js，扩展不用动。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Bridge } from './lib/bridge.js'
import {
  movePlan, pickPoint, typePlan, scrollPlan,
  thinkPause, stepPause, resolveProfile, makeRng, entropySeed,
} from './lib/human.js'
import {
  PIPE_PATH, newToken, writeSession, ensureDataDir, clearSession, log, PLUGIN_PROTOCOL,
  HOST_NAME, HOST_DIR, HOST_REGISTRATIONS, DATA_DIR, DEFAULT_DATA_DIR, LOG_FILE,
} from './lib/protocol.js'
import { ExtensionUpdater } from './lib/extension-updater.js'
import { findExtensionInstallations } from './lib/chrome-profile.js'
import { ensureNativeHost } from './scripts/install.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 工具定义外壳（等价 dsh-tools 的 defineTool）────────────────────────────────

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: { schema: options.output.schema, render: options.output.render },
    execute: options.execute,
  }
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

// ── 状态 ────────────────────────────────────────────────────────────────────

/** 当前 Cordis 实例拥有的桥接和重试计时器。 */
let lifecycle = null
/** Cordis 的 ctx：截图要借它的附件库把图交给模型看 */
let pluginCtx = null
/** 防止同一插件进程同时执行清理与安装。 */
let cleanupInProgress = false

/** 截图结果 → 附件引用，render 是同步的所以要先存这儿 */
const shotRefs = new Map()

// ── 启动 ────────────────────────────────────────────────────────────────────

async function boot() {
  const owner = lifecycle
  if (!owner) throw new Error('浏览器插件尚未启用')
  if (owner.suspended) throw new Error('已清理会话，重新启用插件后可重连')
  if (owner.bridge) return owner.bridge
  if (owner.booting) return owner.booting
  owner.booting = (async () => {
    const token = newToken()
    ensureDataDir()
    const b = new Bridge({ pipe: PIPE_PATH, token })
    try {
      await b.start()
      if (lifecycle !== owner || owner.suspended) throw new Error('浏览器会话已停止')
      // 端点启动成功后才发布本实例的会话文件。
      writeSession({ mode: b.mode, pipe: PIPE_PATH, port: b.tcpPort, token })
      owner.bridge = b
      log(`插件已就绪 pid=${process.pid} 端点=${b.endpoint}`)
      return b
    } catch (error) {
      await b.stop()
      throw error
    }
  })()
  try {
    return await owner.booting
  } finally {
    owner.booting = null
  }
}

/** 逐项核对和删除本插件的注册表叶子，区分缺失与无权限等失败。 */
function cleanupHostRegistry() {
  const keys = HOST_REGISTRATIONS.map(([, key]) => key)
  const payload = Buffer.from(JSON.stringify(keys)).toString('base64')
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$keys = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    '$results = foreach ($key in $keys) {',
    '  $target = "Registry::HKEY_CURRENT_USER\\" + $key.Substring(5)',
    '  try {',
    '    if (!(Test-Path -LiteralPath $target -ErrorAction Stop)) { @{ path = $key; state = "absent" }; continue }',
    '    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop',
    '    @{ path = $key; state = "removed" }',
    '  } catch { @{ path = $key; state = "failed"; error = $_.Exception.Message } }',
    '}',
    'ConvertTo-Json -Compress -InputObject @($results)',
  ].join('\n')
  try {
    const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 })
    return JSON.parse(json)
  } catch (error) {
    return keys.map((key) => ({ path: key, state: 'failed', error: error.message }))
  }
}

/** 比较实际路径，避免递归删除时命中另一个 Chrome 配置正在用的目录。 */
function locationForCleanup(value) {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

/** 只处理固定根目录的直属目标，拒绝移动过的路径和链接。 */
function removeCleanupTarget(root, name, protectedPaths) {
  const target = path.resolve(root, name)
  try {
    if (path.dirname(target) !== root || path.relative(root, locationForCleanup(root))) {
      throw new Error('清理路径不在预期目录内')
    }
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return { path: target, state: 'preserved', error: '目标是链接' }
    const protectedTarget = protectedPaths.some((protectedPath) => {
      const relative = path.relative(target, protectedPath)
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    })
    if (protectedTarget) return { path: target, state: 'preserved', error: '包含扩展目录、静默状态或 Chrome 安装点' }
    fs.rmSync(target, { recursive: stat.isDirectory() })
    return { path: target, state: 'removed' }
  } catch (error) {
    if (error.code === 'ENOENT') return { path: target, state: 'absent' }
    return { path: target, state: 'failed', error: error.message }
  }
}

/** 用户显式清理全部时先停止这一进程的临时会话，避免马上把数据重新写回。 */
async function stopSessionForCleanup(owner) {
  if (!owner || path.relative(DEFAULT_DATA_DIR, path.resolve(DATA_DIR))) return
  owner.suspended = true
  clearInterval(owner.retry)
  await owner.booting?.catch(() => {})
  const bridge = owner.bridge
  if (!bridge) return
  owner.bridge = null
  clearSession(bridge.token)
  shotRefs.clear()
  await bridge.stop()
}

/** 按 scope 清理已知产物；扩展目录与静默状态始终保留。 */
async function cleanupBrowser(scope) {
  if (!['host', 'all'].includes(scope)) throw new Error('scope 必须是 host 或 all')
  if (process.platform !== 'win32') throw new Error('清理工具仅支持 Windows')
  if (cleanupInProgress) throw new Error('正在清理，请等待当前操作完成')
  const owner = lifecycle
  if (scope === 'all' && ['downloading', 'installing'].includes(owner?.updater?.getProgress()?.stage)) {
    throw new Error('扩展正在更新，请在更新结束后清理')
  }
  cleanupInProgress = true
  try {
    const { extensionId } = readExtensionMeta()
    const installations = extensionId ? findExtensionInstallations(extensionId) : []
    const protectedPaths = [path.join(HOST_DIR, 'extension'), path.join(HOST_DIR, 'state.json'),
      ...installations.map((item) => item.path).filter(Boolean)].map(locationForCleanup)
    const results = cleanupHostRegistry()
    if (scope === 'all') await stopSessionForCleanup(owner)
    for (const name of ['runtime', `${HOST_NAME}.cmd`, `${HOST_NAME}.json`]) {
      results.push(removeCleanupTarget(HOST_DIR, name, protectedPaths))
    }
    if (scope === 'all') {
      results.push(removeCleanupTarget(HOST_DIR, 'update-work', protectedPaths))
      results.push(removeCleanupTarget(path.dirname(DEFAULT_DATA_DIR), path.basename(DEFAULT_DATA_DIR), protectedPaths))
    }
    const labels = { removed: '已删除', absent: '原本不存在', failed: '删除失败', preserved: '已保留' }
    return { text: [
      ...results.map((item) => `${labels[item.state]} ${item.path}${item.error ? `（${item.error}）` : ''}`),
      `已保留 ${path.join(HOST_DIR, 'extension')} 与 state.json；扩展目录需要单独确认后再处理。`,
    ].join('\n') }
  } finally {
    cleanupInProgress = false
  }
}

function needBridge() {
  const bridge = lifecycle?.bridge
  if (!bridge || !bridge.connected) {
    const why = bridge?.lastError ? `（${bridge.lastError}）` : ''
    throw new Error(
      `浏览器还没接上${why}。\n` +
        '检查三件事：\n' +
        '  1. Chrome 正在运行\n' +
        '  2. chrome://extensions 里 dsh-human-browser 已启用\n' +
        '  3. 点一次扩展图标，看它是不是显示「已连接」',
    )
  }
  return bridge
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function rngNow() {
  return makeRng(entropySeed())
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function resolveTab(explicit) {
  if (explicit != null) {
    if (!Number.isInteger(explicit) || explicit < 0) throw new Error('tab 必须是有效的标签页 ID')
    return explicit
  }
  const b = needBridge()
  const tabs = await b.request('tabs', {})
  const active = tabs.find((t) => t.mine)
  if (!active) throw new Error('没找到活动标签页，先在 Chrome 里打开一个页面')

  return active.id
}

function fmtBox(b) {
  return `(${b.x},${b.y} ${b.w}×${b.h})`
}

function short(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 人类化点击计划：算轨迹 + 落点，全部下发，扩展只管播放 */
async function planClick(tabId, { ref, x, y, pacing }) {
  const b = needBridge()
  const profile = resolveProfile(pacing)
  const rng = rngNow()

  let box = null
  if (ref !== undefined && ref !== null) {
    box = await b.request('elementBox', { tabId, ref }, 12000)
  }
  const target = box
    ? pickPoint(box, profile, rng)
    : { x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) }

  const mouse = await b.request('mouse', { tabId }, 6000).catch(() => ({ at: null }))
  // 起点：上次位置；没有就从目标左上方一段距离起步（真人不会凭空出现）
  const from = mouse?.at || {
    x: Math.round(target.x - 90 - rng() * 140),
    y: Math.round(target.y - 70 - rng() * 90),
  }

  const plan = movePlan(from, target, profile, rng)

  return {
    ref: ref ?? null,
    box,
    target,
    plan: {
      points: plan.points,
      final: plan.final,
      aimPause: Math.round(profile.aimPause[0] + rng() * (profile.aimPause[1] - profile.aimPause[0])),
      button: 'left',
      clickCount: 1,
    },
    meta: { steps: plan.points.length, profile },
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 导出是为了让 tests/tools.test.mjs 能做契约测试（名字、schema 形状、上下文成本）。
 * Cordis 只认 `name` / `inject` / `apply`，多一个导出不影响加载。
 */
export const TOOLS = [
  defineTool({
    name: 'browser_status',
    description:
      '看浏览器连接状态：扩展是否接上、已接管几个标签页、快照是否还有效。任何 browser_* 报「还没接上」时先调这个。',
    parameters: {},
    output: textOutput,
    async execute() {
      let b = null
      try {
        b = await boot()
      } catch (e) {
        if (lifecycle?.suspended) return { text: e.message }
        log(`status: boot 失败 ${e?.message}`)
      }
      const lines = []
      lines.push(`插件：${b ? '已就绪' : '未就绪'}`)
      lines.push(`浏览器：${b?.connected ? '已连接' : '未连接'}${b?.lastError ? `（${b.lastError}）` : ''}`)
      if (!b?.connected && lifecycle?.nativeHostError) {
        lines.push(`本机宿主注册失败：${lifecycle.nativeHostError}`)
      }
      const info = b?.hostInfo
      lines.push(`协议版本：扩展 ${info?.protocol ?? '未知'}，插件 ${PLUGIN_PROTOCOL}`)
      if (info?.protocolError) {
        lines.push(`扩展版本：${info.version ?? '未知'}`)
        return { text: lines.join('\n') }
      }
      if (b?.connected) {
        const s = await b.request('status', {}, 8000)
        lines.push(`扩展版本：${s.version}`)
        lines.push(`已授权标签页：${s.authorized?.join(', ') || '无'}`)
        lines.push(`已 attach 的标签页：${s.attached.length ? s.attached.join(', ') : '无'}`)
        if (s.snaps.length) {
          lines.push(`快照：${s.snaps.map((x) => `tab ${x.tabId}（${x.count} 个元素，${Math.round(x.ageMs / 1000)}s 前）`).join('；')}`)
        }
        const tabs = await b.request('tabs', {}, 8000)
        const mine = tabs.find((t) => t.mine)
        if (mine) lines.push(`当前页：${mine.authorized ? `${short(mine.title, 50)} — ${short(mine.url, 80)}` : `tab ${mine.id}（请在扩展弹窗授权）`}`)
      } else {
        lines.push('')
        lines.push('连不上时按这个顺序查：')
        lines.push('  1. Chrome 是否在运行')
        lines.push('  2. chrome://extensions 里 dsh-human-browser 是否启用')
        lines.push('  3. 点扩展图标，看是否显示「已连接」；没有就点「重新连接」')
        lines.push(`  4. 日志：${LOG_FILE}`)
      }
      return { text: lines.join('\n') }
    },
  }),

  defineTool({
    name: 'browser_cleanup',
    description: '按用户明确要求清理浏览器原生宿主，返回逐项结果。保留已加载扩展。',
    parameters: {
      scope: { type: 'string', required: true, enum: ['host', 'all'], description: 'host 清理注册表与宿主运行时，all 另清理临时数据' },
    },
    output: textOutput,
    async execute({ scope }) {
      return cleanupBrowser(scope)
    },
  }),

  defineTool({
    name: 'browser_tabs',
    description: '列标签页 / 打开新标签页 / 关标签页 / 切到某个标签页。* 标记的是用户正在看的那个。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'open', 'close', 'activate'], description: 'list=列出，open=打开新标签页，close=关闭，activate=切过去' },
      tab: { type: 'integer', description: '标签页 id（close / activate 用）' },
      url: { type: 'string', description: 'open 时要打开的网址' },
      background: { type: 'boolean', description: 'open 时是否后台打开（默认 false，会切前台）' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      if (args.action === 'list') {
        const tabs = await b.request('tabs', { all: false }, 8000)
        if (!tabs.length) return { text: '（这个窗口没有标签页）' }
        const lines = tabs.map(
          (t) =>
            `${t.mine ? '*' : ' '} ${String(t.id).padStart(5)}  ${t.authorized ? `${t.attached ? '🔗 ' : ''}${short(t.title, 48)} — ${short(t.url, 76)}` : '（未授权）'}`,
        )
        return { text: `${lines.join('\n')}\n（* = 用户正在看；🔗 = 已被接管）` }
      }
      if (args.action === 'open') {
        if (!args.url) throw new Error('open 需要 url')
        const r = await b.request('open', { url: args.url, background: !!args.background }, 30000)

        return { text: `已打开标签页 ${r.tabId}：${r.url}${args.background ? '（后台）' : ''}。请在 Chrome 扩展弹窗授权此页后继续。` }
      }
      if (args.action === 'close') {
        if (args.tab == null) throw new Error('close 需要 tab')
        await b.request('close', { tabId: Number(args.tab) }, 10000)


        return { text: `已关闭标签页 ${args.tab}` }
      }
      if (args.action === 'activate') {
        if (args.tab == null) throw new Error('activate 需要 tab')
        await b.request('activate', { tabId: Number(args.tab) }, 10000)


        return { text: `已切到标签页 ${args.tab}` }
      }
      throw new Error(`不认识的 action：${args.action}`)
    },
  }),

  defineTool({
    name: 'browser_snapshot',
    description:
      '读当前页面的**可交互元素**清单，每个元素带完整 ref 和可读标签。点击/输入原样传入 ref。' +
      '这是操作页面的第一步；页面变了（跳转、弹窗、列表刷新）要重新快照。',
    parameters: {
      tab: { type: 'integer', description: '标签页 id，省略就用当前页' },
      max: { type: 'integer', description: '最多列多少个元素，默认 260' },
      includeOffscreen: { type: 'boolean', description: '是否连视口外的元素一起列（默认 false，只列看得见的）' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)

      const snap = await b.request(
        'snapshot',
        { tabId, max: args.max || 260, includeOffscreen: !!args.includeOffscreen },
        30000,
      )

      const nodes = snap.desc || []

      const head = [
        `# 页面快照  tab ${tabId}`,
        `${snap.title || '(无标题)'}`,
        `${snap.url}`,
        `视口 ${snap.scroll?.vh ?? '?'}px 高，已滚动 ${snap.scroll?.y ?? 0}px / 总高 ${snap.scroll?.h ?? '?'}px`,
        '',
      ]

      if (!nodes.length) {
        head.push('（没有找到可交互元素。页面可能还没加载完、或者内容在 shadow DOM 里；先用 browser_read what=text 看看正文）')
        return { text: head.join('\n') }
      }

      const body = nodes.map((n) => {
        const bits = []
        bits.push(`[${n.ref}]`)
        bits.push(n.kind)
        if (n.tag) bits.push(`<${n.tag}${n.type ? `:${n.type}` : ''}>`)
        bits.push(fmtBox(n.box))
        if (n.disabled) bits.push('disabled')
        if (n.checked !== undefined) bits.push(n.checked ? 'checked' : 'unchecked')
        if (n.label) bits.push(`"${short(n.label, 56)}"`)

        if (n.href) bits.push(`→ ${short(n.href, 70)}`)
        return bits.join('  ')
      })

      return {
        text: [
          ...head,
          ...body,
          '',
          `共 ${nodes.length} 个可交互元素。请原样传入方括号里的完整 ref`,
        ].join('\n'),
      }
    },
  }),

  defineTool({
    name: 'browser_read',
    description:
      '读页面内容：text=正文纯文本，html=HTML 片段，attr=某个元素的全部属性，info=页面元信息（URL/标题/滚动位置/是否前台）。',
    parameters: {
      what: { type: 'string', required: true, enum: ['text', 'html', 'attr', 'info'], description: '读什么' },
      selector: { type: 'string', description: 'CSS 选择器。attr 必须指定，text/html 省略时读整页' },
      maxChars: { type: 'integer', description: 'text/html 最多返回多少字符，默认 20000' },
      tab: { type: 'integer', description: '标签页 id，省略用当前页' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const r = await b.request(
        'read',
        { tabId, what: args.what, selector: args.selector, maxChars: args.maxChars },
        30000,
      )
      if (args.what === 'text') {
        const cut = r.total > r.text.length ? `\n\n[截断：共 ${r.total} 字符，只给了前 ${r.text.length}]` : ''
        return { text: r.text + cut }
      }
      if (args.what === 'html') {
        const cut = r.total > r.html.length ? `\n\n[截断：共 ${r.total} 字符]` : ''
        return { text: r.html + cut }
      }
      if (args.what === 'attr') {
        return { text: `<${r.tag}>\n` + Object.entries(r.attrs).map(([k, v]) => `  ${k}="${v}"`).join('\n') }
      }
      return {
        text: [
          `URL：${r.url}`,
          `标题：${r.title}`,
          `加载状态：${r.readyState}`,
          `视口：${r.viewport?.w}×${r.viewport?.h}`,
          `滚动：${r.scroll?.y} / 最大 ${r.scroll?.max}`,
          `可见性：${r.visible}　有焦点：${r.focused}`,
          `语言：${r.lang || '—'}　表单 ${r.forms}　链接 ${r.links}　图片 ${r.images}`,
        ].join('\n'),
      }
    },
  }),

  defineTool({
    name: 'browser_click',
    description:
      '用浏览器鼠标事件点击元素或视口坐标。' +
      '优先用 ref；不知道 ref 就先 browser_snapshot。',
    parameters: {
      ref: { type: 'string', description: '当前快照里的完整元素 ref' },
      x: { type: 'integer', description: '直接用坐标点击时的 x（CSS px，视口坐标）' },
      y: { type: 'integer', description: '直接用坐标点击时的 y' },
      pacing: { type: 'string', enum: ['cautious', 'normal', 'fast'], description: '节奏档位：强风控站用 cautious，自己家的后台用 fast，默认 normal' },
      tab: { type: 'integer', description: '标签页 id，省略用当前页' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const hasRef = args.ref !== undefined && args.ref !== null
      if (!hasRef && (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x < 0 || args.y < 0)) {
        throw new Error('请提供 ref 或一组非负整数坐标 x 和 y')
      }

      await sleep(thinkPause(resolveProfile(args.pacing), rngNow()))

      const { plan, box, target } = await planClick(tabId, { ref: args.ref, x: args.x, y: args.y, pacing: args.pacing })
      await b.request('click', { tabId, plan, ref: args.ref }, 60000)


      const where = box ? `[${args.ref}] 内落点 ${fmtBox({ ...box, x: target.x, y: target.y, w: 1, h: 1 })}` : `坐标 (${target.x},${target.y})`
      return {
        text: `已派发点击 ${where}`,
      }
    },
  }),

  defineTool({
    name: 'browser_type',
    description:
      '往元素里打字。逐字符派发真实键盘事件（ASCII）或逐字 insertText（中文），间隔带词边界与标点停顿。' +
      '先点焦再输入。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文字' },
      ref: { type: 'string', description: '当前快照里输入框的完整 ref，省略则用当前获得焦点的输入框' },
      clearFirst: { type: 'boolean', description: '先全选删除原有内容' },
      thenEnter: { type: 'boolean', description: '打完按一下回车' },
      pacing: { type: 'string', enum: ['cautious', 'normal', 'fast'], description: '节奏档位' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const profile = resolveProfile(args.pacing)
      const rng = rngNow()


      const plan = typePlan(String(args.text), profile, rng)
      const total = plan.reduce((s, p) => s + p.delay, 0)
      // 在聚焦或清空前拒绝明显无法按时完成的长文本。
      if (total > 95000) throw new Error('这段文本过长，请分段输入')
      const clickPlan = args.ref != null
        ? (await planClick(tabId, { ref: args.ref, pacing: args.pacing })).plan
        : undefined
      await b.request('type', {
        tabId, plan, ref: args.ref, clickPlan, clearFirst: !!args.clearFirst,
        enterDelay: args.thenEnter ? stepPause(profile, rng) : undefined,
      }, 120000)
      return {
        text: `已输入 ${plan.length} 个字符（预计节拍 ${(total / 1000).toFixed(1)}s）${args.clearFirst ? '，输入前清空了原内容' : ''}${args.thenEnter ? '，并按了回车' : ''}`,
      }
    },
  }),

  defineTool({
    name: 'browser_key',
    description: '按一个键：Enter / Tab / Escape / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown。',
    parameters: {
      key: { type: 'string', required: true, description: '键名' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)

      await b.request('key', { tabId, key: args.key }, 15000)
      return { text: `已按 ${args.key}` }
    },
  }),

  defineTool({
    name: 'browser_hover',
    description: '把鼠标移到元素上并停住（触发 hover 菜单、tooltip 等）。之后不要立刻移走。',
    parameters: {
      ref: { type: 'string', required: true, description: '当前快照里的完整元素 ref' },
      pacing: { type: 'string', enum: ['cautious', 'normal', 'fast'], description: '节奏档位' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      if (args.ref === undefined || args.ref === null) throw new Error('hover 需要 ref')

      const { plan } = await planClick(tabId, { ref: args.ref, pacing: args.pacing })
      await b.request('hover', { tabId, plan, ref: args.ref }, 30000)
      return { text: `鼠标已停在 [${args.ref}] 上` }
    },
  }),

  defineTool({
    name: 'browser_scroll',
    description: '滚动页面。可以按像素滚（delta，正数向下），也可以滚到顶/底/某个元素。分段滚，不是一次性跳。',
    parameters: {
      delta: { type: 'integer', description: '滚动多少像素，正数向下' },
      to: { type: 'string', enum: ['top', 'bottom'], description: '滚到顶或底' },
      ref: { type: 'string', description: '当前快照里的完整元素 ref，滚到该元素' },
      pacing: { type: 'string', enum: ['cautious', 'normal', 'fast'], description: '节奏档位' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const profile = resolveProfile(args.pacing)
      const rng = rngNow()


      if (args.ref != null) {
        await b.request('elementBox', { tabId, ref: args.ref }, 12000)
        return { text: `已将 [${args.ref}] 滚入视口` }
      }

      let delta = 0
      if (args.to) {
        const info = await b.request('read', { tabId, what: 'info' }, 15000)
        const cur = Number(info.scroll?.y || 0)
        const max = Number(info.scroll?.max || 0)
        delta = args.to === 'top' ? -cur : max - cur
        if (Math.abs(delta) < 2) return { text: `已经在页面${args.to === 'top' ? '顶部' : '底部'}` }
      } else {
        delta = Number(args.delta) || 0
      }
      if (!delta) throw new Error('给 delta、to 或 ref 之一')

      const parts = scrollPlan(delta, profile, rng)
      const r = await b.request('scroll', { tabId, parts }, 60000)

      return {
        text: `已派发 ${delta > 0 ? '+' : ''}${delta}px 滚轮事件（${parts.length} 段）\n实测页面位置 ${r.y} / 最大 ${r.max}`,
      }
    },
  }),

  defineTool({
    name: 'browser_wait',
    description:
      '等某个条件成立：等选择器出现/消失、等网址变化、或单纯等一段时间。默认超时 30s。' +
      '轮询而不是注入 MutationObserver —— 页面里不留任何监听器。',
    parameters: {
      selector: { type: 'string', description: '等这个 CSS 选择器出现（或消失）' },
      gone: { type: 'boolean', description: 'true=等它消失' },
      urlContains: { type: 'string', description: '等网址包含这段文字' },
      ms: { type: 'integer', description: '单纯等多少毫秒' },
      timeout: { type: 'integer', description: '超时毫秒，默认 30000' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const timed = args.ms != null
      if ([!!args.selector, !!args.urlContains, timed].filter(Boolean).length !== 1) throw new Error('请指定一种等待条件')
      const tabId = timed ? undefined : await resolveTab(args.tab)
      const r = await b.request(
        'wait',
        {
          tabId,
          selector: args.selector,
          gone: !!args.gone,
          urlContains: args.urlContains,
          ms: args.ms,
          timeout: Math.min(Math.max(Number(args.timeout) || 30000, 1), 120000),
        },
        150000,
      )
      if (timed) return { text: `等了 ${r.waitedMs}ms` }
      if (args.selector) return { text: `${args.gone ? '选择器已消失' : '选择器已出现'}：${args.selector}` }
      return { text: `网址已包含「${args.urlContains}」，当前 ${short(r.url, 120)}` }
    },
  }),

  defineTool({
    name: 'browser_screenshot',
    description: '截当前视口（或某个元素）。图会直接给你看。默认 jpeg 缩放，控制体积。',
    parameters: {
      ref: { type: 'string', description: '当前快照里的完整元素 ref，只截该元素' },
      format: { type: 'string', enum: ['jpeg', 'png'], description: '默认 jpeg' },
      maxWidth: { type: 'integer', description: '最宽多少像素，默认 jpeg 1400 / png 1100' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, token: { type: 'string' } },
        required: ['text', 'token'],
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }]
        const ref = shotRefs.get(value.token)
        if (ref) {
          shotRefs.delete(value.token)
          blocks.push({ type: 'image', attachment: ref })
        }
        return blocks
      },
    },
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)

      const r = await b.request(
        'screenshot',
        { tabId, format: args.format || 'jpeg', ref: args.ref, maxWidth: args.maxWidth },
        90000,
      )
      const buf = Buffer.from(r.dataBase64, 'base64')
      const token = crypto.randomUUID()
      const note = `截图（${r.format}，约 ${Math.round(buf.length / 1024)}KB${r.scale < 1 ? `，缩放 ${r.scale.toFixed(2)}` : ''}）`

      const attachments = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('attachments') : null
      if (attachments && typeof attachments.saveImages === 'function') {
        try {
          const [ref] = await attachments.saveImages([
            {
              data: buf,
              mediaType: r.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              name: `page-${Date.now()}.${r.format === 'jpeg' ? 'jpg' : 'png'}`,
            },
          ])
          shotRefs.set(token, ref)
          if (shotRefs.size > 20) shotRefs.delete(shotRefs.keys().next().value)
          return { text: note, token }
        } catch (e) {
          log(`存附件失败：${e?.message}`)
        }
      }
      const dir = path.join(os.tmpdir(), 'dsh-human-browser', 'shots')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `page-${Date.now()}.${r.format === 'jpeg' ? 'jpg' : 'png'}`)
      fs.writeFileSync(file, buf)
      return { text: `${note}\n附件库不可用，已存到 ${file}`, token: '' }
    },
  }),

  defineTool({
    name: 'browser_eval',
    description:
      '在当前授权页面执行 JavaScript 表达式并返回 JSON 结果。脚本可以修改页面，须先在扩展弹窗单独授权。',
    parameters: {
      expression: { type: 'string', required: true, description: '要执行的表达式，最后求值结果会返回' },
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const r = await b.request('evaluate', { tabId, expression: args.expression }, 30000)
      let out
      try {
        out = JSON.stringify(r.value, null, 2)
      } catch {
        out = String(r.value)
      }
      if (out && out.length > 20000) out = out.slice(0, 20000) + '\n…（截断）'
      return { text: out ?? 'undefined' }
    },
  }),

  defineTool({
    name: 'browser_stealth',
    description:
      '反检测自检：报告四层信号的实际值（navigator.webdriver、UA、WebGL 渲染器、plugins、屏幕/窗口尺寸、是否前台、canvas 指纹、时区）。' +
      '怀疑被风控盯上时先跑这个。',
    parameters: {
      tab: { type: 'integer', description: '标签页 id' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      const tabId = await resolveTab(args.tab)
      const r = await b.request('stealth', { tabId }, 30000)
      const m = r.metrics || {}
      const icon = { fail: '✗', warn: '!', info: '·', ok: '✓' }
      const lines = [
        '# 反检测自检',
        '',
        `${icon.fail} 致命 / ${icon.warn} 可疑 / ${icon.info} 提示`,
        '',
        ...(r.findings || []).map((f) => `${icon[f.level] || '·'} [${f.code}] ${f.detail}`),
        '',
        '## 实测值',
        `navigator.webdriver : ${m.webdriver}`,
        `UA                  : ${m.ua}`,
        `plugins / mimeTypes : ${m.plugins} / ${m.mimeTypes}`,
        `languages           : ${m.languages}`,
        `screen              : ${m.screen?.w}×${m.screen?.h} @${m.screen?.dpr}x（可用 ${m.screen?.aw}×${m.screen?.ah}）`,
        `window              : 内 ${m.window?.iw}×${m.window?.ih} / 外 ${m.window?.ow}×${m.window?.oh}`,
        `WebGL               : ${m.webglRenderer}  (${m.webglVendor})`,
        `canvas 指纹尾段      : …${m.canvasHash}`,
        `可见性 / 焦点        : ${m.visibility} / ${m.hasFocus}`,
        `时区                : ${m.tz}`,
        `CPU 核数            : ${m.hardwareConcurrency}`,
      ]
      return { text: lines.join('\n') }
    },
  }),

  defineTool({
    name: 'browser_detach',
    description: '释放某个标签页的接管并撤销授权。快照也会一起失效。',
    parameters: {
      tab: { type: 'integer', description: '标签页 id' },
      all: { type: 'boolean', description: '放掉全部' },
    },
    output: textOutput,
    async execute(args) {
      const b = needBridge()
      if (args.all) {
        const s = await b.request('status', {}, 8000)
        const ids = s.authorized || []
        const results = await Promise.allSettled(ids.map((tabId) => b.request('detach', { tabId }, 8000)))
        const failed = ids.filter((_, index) => results[index].status === 'rejected')
        if (failed.length) throw new Error(`这些标签页释放未确认：${failed.join(', ')}`)
        return { text: `已释放并撤销 ${ids.length} 个标签页的授权` }
      }
      const tabId = await resolveTab(args.tab)
      await b.request('detach', { tabId }, 8000)

      return { text: `已释放标签页 ${tabId}` }
    },
  }),
]

// ── 插件入口 ────────────────────────────────────────────────────────────────

export const name = 'human-browser'
export const inject = ['tools']

/** 注册失败时保留插件与更新路由，让诊断工具还能显示实际原因。 */
function prepareNativeHost(owner, extensionId) {
  if (process.platform !== 'win32') return
  try {
    const { registrations } = ensureNativeHost(extensionId)
    const failures = registrations.filter(({ error }) => error)
    if (!failures.length) {
      log('本机 native messaging host 已就绪')
      return
    }
    owner.nativeHostError = failures.map(({ label, error }) => `${label}：${error}`).join('；')
  } catch (error) {
    owner.nativeHostError = error.message
  }
  log(`本机宿主注册失败：${owner.nativeHostError}`)
}

export function apply(ctx) {
  lifecycle?.dispose()
  const owner = {
    bridge: null, booting: null, retry: null, dispose: null,
    suspended: false, updater: null, nativeHostError: null,
  }
  lifecycle = owner
  pluginCtx = ctx
  log('浏览器插件开始加载')
  owner.dispose = () => {
    clearInterval(owner.retry)
    if (lifecycle === owner) {
      lifecycle = null
      pluginCtx = null
      shotRefs.clear()
    }
    if (owner.bridge) {
      clearSession(owner.bridge.token)
      void owner.bridge.stop().catch((error) => log(`关闭桥接失败：${error.message}`))
      owner.bridge = null
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => owner.dispose)
  else ctx.on?.('dispose', owner.dispose)

  for (const tool of TOOLS) {
    try {
      ctx.tools.register(tool)
    } catch (e) {
      log(`注册 ${tool.name} 失败：${e?.message}`)
      owner.dispose()
      throw e
    }
  }
  log(`已注册 ${TOOLS.length} 个工具`)

  // ── 扩展更新的 HTTP 路由（给 client 侧弹窗用，契约见 docs/update-api.md）──
  // webServer 在 headless profile 里可能没有，挂不上也不影响工具，只影响弹窗。
  try {
    const meta = readExtensionMeta()
    if (meta.extensionId) {
      prepareNativeHost(owner, meta.extensionId)
      const updater = new ExtensionUpdater({
        extensionId: meta.extensionId,
        extensionVersionFile: path.join(__dirname, 'extension-version.json'),
        log,
      })
      owner.updater = updater
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer', 'connection'], (sub) => {
          // 使用 DSH /api 同一套登录和来源校验。老运行时没有该方法时不挂路由。
          if (!sub || typeof sub.effect !== 'function' || !sub.webServer ||
              typeof sub.connection?.requestRejection !== 'function') return
          sub.effect(
            () =>
              sub.webServer.register({
                kind: 'prefix',
                // 前缀不带尾斜杠 —— 这是 cyrene-theme 验证过的写法，带斜杠会匹配不上
                path: '/human-browser/update',
                handler: (req, res) => handleUpdateRoute(updater, sub.connection, req, res),
              }),
            'human-browser: extension update routes',
          )
          log('扩展更新路由已挂载：/human-browser/update')
        })
      }
    } else {
      log('extension-version.json 里没有 extensionId，跳过更新路由')
    }
  } catch (e) {
    log(`挂载更新路由失败（忽略）：${e?.message}`)
  }

  // 启动失败时限次重试，插件卸载会同步停止后续重试。
  void boot().catch((error) => {
    if (lifecycle !== owner || owner.suspended) return
    log(`启动失败：${error.message}`)
    let attempts = 0
    owner.retry = setInterval(() => {
      if (lifecycle !== owner || owner.suspended || owner.bridge || attempts++ >= 12) {
        clearInterval(owner.retry)
        return
      }
      void boot().catch((reason) => log(`重试启动失败：${reason.message}`))
    }, 2500)
  })
}

// ── 扩展更新的 HTTP 处理 ────────────────────────────────────────────────────

/** 读插件包里的 extension-version.json（扩展 ID、推荐版本、下载坐标、更新说明） */
function readExtensionMeta() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'extension-version.json'), 'utf8'))
  } catch (e) {
    log(`读 extension-version.json 失败：${e?.message}`)
    return {}
  }
}

/** 读取小型 JSON 请求，断线、超限和无效 JSON 都能结束处理。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let length = 0
    const onData = (chunk) => {
      length += chunk.length
      if (length <= 4096) chunks.push(chunk)
      else {
        req.off('data', onData)
        resolve({ error: 413 })
      }
    }
    req.on('data', onData)
    req.once('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? { body } : { error: 400 })
      } catch {
        resolve({ error: 400 })
      }
    })
    req.once('error', () => resolve({ error: 400 }))
    req.once('close', () => resolve({ error: 400 }))
  })
}

/**
 * 更新相关的四条路由。契约见 docs/update-api.md，前端（月月写的弹窗）按那份调用。
 * 返回的永远是 JSON，错误也带具体原因，不让前端去猜。
 */
async function handleUpdateRoute(updater, connection, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.replace(/^\/human-browser\/update\/?/, '').replace(/\/+$/, '')

  const send = (code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(obj))
    } catch (e) {
      log(`写更新路由响应失败：${e?.message}`)
    }
  }

  try {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      return send(rejection, { error: rejection === 401 ? '请先登录 DSH，再检查扩展更新' : 'DSH 拒绝了请求来源' })
    }
    if (req.method === 'GET' && route === 'status') {
      await updater.refreshReleaseInfo()
      return send(200, updater.getStatus())
    }
    if (req.method === 'GET' && route === 'progress') return send(200, updater.getProgress())
    if (req.method === 'POST' && (route === 'install' || route === 'dismiss') &&
        !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      return send(415, { error: '更新操作需要 application/json 请求' })
    }
    if (req.method === 'POST' && route === 'install') {
      if (cleanupInProgress) return send(409, { error: '正在清理浏览器宿主，请稍后重试' })
      return send(200, updater.startInstall())
    }
    if (req.method === 'POST' && route === 'dismiss') {
      const { body, error } = await readJsonBody(req)
      if (error) return send(error, { error: error === 413 ? '请求体太大' : '请求体必须是有效 JSON 对象' })
      const version = body.version || url.searchParams.get('version') || null
      if (version !== null && typeof version !== 'string') return send(400, { error: 'version 必须是字符串' })
      return send(200, updater.dismiss(version))
    }
    return send(404, { error: `没有这个路由：${req.method} ${route || '/'}` })
  } catch (e) {
    return send(500, { error: String(e?.message || e) })
  }
}

export default { name, inject, apply }
