const $ = (id) => document.getElementById(id)

/** 保存弹窗当前显示的标签页 ID 和来源，点击时由后台重新核对。 */
let state = null
let busy = false
/** 较早的轮询结果不得覆盖点击操作完成后的状态。 */
let refreshSequence = 0

/** 读取后台确认的默认权限。后台不可用或正在更新时禁用开关。 */
function paintSwitch(id, setting) {
  const enabled = setting === true
  $(id).disabled = busy || typeof setting !== 'boolean'
  $(id).setAttribute('aria-checked', String(enabled))
  $(`${id}-state`).textContent = enabled ? '开启' : '关闭'
}

/** 根据后台确认的状态更新全局及当前页面权限。 */
function paint(status) {
  state = status
  const connected = status?.connected === true
  const dot = $('conn').querySelector('.dot')
  dot.className = `dot ${connected ? 'on' : 'off'}`
  $('conn').replaceChildren(dot, connected ? '已连接' : '未连接')
  $('tabs').textContent = String(status?.authorizedCount || 0)
  $('ver').textContent = status?.version || '—'
  $('origin').textContent = status?.origin || '当前页面不可授权'
  paintSwitch('global-access', status?.globalAuthorization)
  paintSwitch('global-scripts', status?.globalScriptExecution)
  $('access').disabled = busy || !status?.origin
  $('access').textContent = status?.authorized ? '撤销当前标签页授权' : '授权当前标签页'
  $('scripts').disabled = busy || !status?.authorized
  $('scripts').textContent = status?.eval ? '禁用本页脚本执行' : '允许本页执行脚本'
  $('reconnect').disabled = busy
  $('hint').textContent = status?.error || status?.lastError || (status?.eval
    ? 'DSH 可以在此页运行脚本。脚本可以读取数据和修改页面。'
    : '授权后，DSH 可以读取和操作此页。')
}

/** 查询扩展连接状态及当前页授权。 */
async function refresh() {
  if (busy) return
  const sequence = ++refreshSequence
  try {
    const status = await chrome.runtime.sendMessage({ type: 'hb-status' })
    if (!busy && sequence === refreshSequence) paint(status)
  } catch {
    if (!busy && sequence === refreshSequence) paint({ error: '扩展后台暂时未响应' })
  }
}

/** 同时只处理一个弹窗动作，并在完成后刷新授权状态。 */
async function update(type, extra = {}) {
  if (busy) return
  busy = true
  refreshSequence++
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
$('global-access').addEventListener('click', () => void update('hb-global-authorization', { enabled: !state?.globalAuthorization }))
$('global-scripts').addEventListener('click', () => void update('hb-global-script-execution', { enabled: !state?.globalScriptExecution }))
$('access').addEventListener('click', () => void update(state?.authorized ? 'hb-revoke' : 'hb-grant'))
$('scripts').addEventListener('click', () => void update('hb-eval', { enabled: !state?.eval }))
void refresh()
setInterval(refresh, 1500)

