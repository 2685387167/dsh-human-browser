const $ = (id) => document.getElementById(id)

/** 保存弹窗当前显示的标签页 ID 和来源，点击时由后台重新核对。 */
let state = null
let busy = false

function paint(status) {
  state = status
  const connected = status?.connected === true
  const dot = $('conn').querySelector('.dot')
  dot.className = `dot ${connected ? 'on' : 'off'}`
  $('conn').replaceChildren(dot, connected ? '已连接' : '未连接')
  $('tabs').textContent = String(status?.authorizedCount || 0)
  $('ver').textContent = status?.version || '—'
  $('origin').textContent = status?.origin || '当前页面不可授权'
  $('access').disabled = busy || !status?.origin
  $('access').textContent = status?.authorized ? '撤销当前标签页授权' : '授权当前标签页'
  $('scripts').disabled = busy || !status?.authorized
  $('scripts').textContent = status?.eval ? '取消脚本执行权限' : '允许本页执行脚本'
  $('reconnect').disabled = busy
  $('hint').textContent = status?.error || status?.lastError || (status?.eval
    ? 'DSH 可以在此页运行脚本。脚本可以读取数据和修改页面。'
    : '授权后，DSH 可以读取和操作此页。脚本执行需要单独开启。')
}

async function refresh() {
  if (busy) return
  try {
    const status = await chrome.runtime.sendMessage({ type: 'hb-status' })
    if (!busy) paint(status)
  } catch {
    if (!busy) paint({ error: '扩展后台暂时未响应' })
  }
}

/** 同时只处理一个弹窗动作，并在完成后刷新授权状态。 */
async function update(type, extra = {}) {
  if (busy) return
  busy = true
  const target = { tabId: state?.tabId, origin: state?.origin }
  paint(state)
  let error
  try {
    const result = await chrome.runtime.sendMessage({ type, ...target, ...extra })
    error = result?.error
  } catch {
    error = '扩展后台暂时未响应'
  } finally {
    busy = false
  }
  await refresh()
  if (error) $('hint').textContent = error
}

$('reconnect').addEventListener('click', () => void update('hb-reconnect'))
$('access').addEventListener('click', () => void update(state?.authorized ? 'hb-revoke' : 'hb-grant'))
$('scripts').addEventListener('click', () => void update('hb-eval', { enabled: !state?.eval }))
void refresh()
setInterval(refresh, 1500)

