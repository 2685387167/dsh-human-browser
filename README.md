# dsh-human-browser

让 AI 在**你正在用的那个 Chrome** 里干活，并且尽量看不出是机器在动。

插件使用你已经连接的 Chrome 配置，可以接管现有窗口，也可以新开普通窗口或无痕窗口。

> 仅 Windows · 需要 Chrome 或 Edge 116+ · 扩展从 GitHub Releases 下载，首次需手动加载

---

## 这是什么

一个 DeepSeek Harness 插件，加上一个配套的 Chrome MV3 扩展。扩展用 `chrome.debugger` 派发**真实的 CDP 输入事件**，插件把"像人"这件事算好之后下发给它。

装好之后，模型可以直接调 15 个 `browser_*` 工具操作你的浏览器：快照、点击、输入、滚动、等待、截图、跑脚本、反检测自检和卸载清理。

---

## 为什么这样设计

浏览器自动化被检测，绝大多数时候输在"指纹是假的"：

| 常见做法 | 为什么会被看出来 |
|---|---|
| Playwright / Puppeteer 自启 chromium | 默认带 `--enable-automation` → `navigator.webdriver === true` |
| 无头模式 | WebGL 报 `SwiftShader`、字体极少、`navigator.plugins` 为空 |
| content script 合成事件 | `dispatchEvent()` 的 `event.isTrusted === false` |
| 全新 profile | 没有历史、没有扩展、没有 cookie → 风控判为"新设备" |
| 通用 CDP 插件 | 一上来就 `Runtime.enable` + `DOM.enable` + `Network.enable`，检测面全开 |

这个插件的做法是**根本不用伪造**：

1. **就在你真实浏览器里** —— UA、WebGL、Canvas、字体、扩展列表、cookie、历史、TLS，全部是真的。
2. **`chrome.debugger` 派发 `Input.*`** —— 点击和按键是真的 CDP 输入事件，`isTrusted === true`，带用户手势。
3. **一个 CDP 域都不 enable** —— `Runtime.evaluate`、`Page.captureScreenshot`、`Input.*` 都是独立命令，不需要先 `.enable`。而 `Runtime.enable` 正是最著名的一类探测的抓手。
4. **页面里什么都不写** —— 不用 `addInitScript` 抹 `navigator.webdriver`（本来就没有），不挂全局变量存元素引用（ref 用 remoteObject 句柄存在扩展侧），不打 `data-` 属性。
5. **要焦点就真的切前台** —— 不用 `Emulation.setFocusEmulationEnabled` 伪造。那玩意会让 `document.hasFocus()` 返回 true 而 `document.visibilityState` 停在 `hidden`。
6. **动作是人的形状** —— 贝塞尔轨迹 + 手抖 + 末端过冲、落点在元素内正态散布（不点正中心、不贴边）、逐字符键盘事件带词边界与标点停顿、滚动分段带惯性收尾。

---

## 工具

| 工具 | 干什么 |
|---|---|
| `browser_status` | 连接状态、已授权标签页、扩展版本及协议版本 |
| `browser_tabs` | 列出、绑定、打开、关闭或切换标签页，支持新窗口和无痕窗口 |
| `browser_snapshot` | 读可交互元素清单，每个带完整 ref 和人类可读标签 |
| `browser_read` | 读正文 / HTML / 元素属性 / 页面元信息 |
| `browser_click` | 点击元素或坐标 —— 真实鼠标事件 + 轨迹 + 随机落点 |
| `browser_type` | 打字 —— 逐字符真键盘事件，词边界与标点停顿 |
| `browser_key` | Enter / Tab / Escape / 方向键 / PageUp/Down |
| `browser_hover` | 悬停 |
| `browser_scroll` | 按像素 / 滚到顶底 / 滚到某元素 |
| `browser_wait` | 等选择器、等网址、等时长（轮询，不注入观察器） |
| `browser_screenshot` | 截图，直接给模型看 |
| `browser_eval` | 页面 JS（需要网页授权和脚本执行权限） |
| `browser_stealth` | 反检测自检，报四层信号实测值 |
| `browser_detach` | 释放接管并撤销授权 |
| `browser_cleanup` | 显式清理 native host，返回实际处理结果 |

15 个工具的 schema 合计约 7500 字节（≈1900 tokens），是每次请求都要付的固定成本。

启用插件后，需要在 Chrome 中打开网页、点击、输入或截图时，DSH 默认优先使用 `browser_*`。连接状态不明时会检查连接，遇到断线、未授权或能力限制时会说明情况。只查询公开资料时仍可直接使用网页搜索或抓取。

需要操作现有网页时，用 `browser_tabs list` 找到目标，再用 `browser_tabs bind` 绑定其标签页 ID。用 `browser_tabs open` 打开页面时会自动绑定本聊天。默认使用已绑定的窗口和标签页。切换焦点、打开另一个 Chrome 窗口都不会改变绑定。原目标关闭、移到另一窗口或浏览器重连后，可用 `list` 加 `all: true` 重新选择并绑定。

用 `browser_tabs open` 的 `window: "new"` 新建普通窗口。无痕访问用 `window: "incognito"`，会先在现有无痕窗口里开新标签页，没有可用窗口时创建。明确要求新建无痕窗口时用 `window: "newIncognito"`。无痕访问要求在 `chrome://extensions` 的扩展详情中开启「在无痕模式下启用」，开页后沿用现有网页授权和脚本执行权限。

---

## 安装

### 1. DSH 插件

```powershell
dsh plugin --profile desktop add github:2685387167/dsh-human-browser
```

装好后重启 DSH。插件会在加载时自动注册 native messaging host（写 HKCU 注册表，不需要管理员）。

如需固定安装 DSH 插件 0.1.6，使用下面的命令。配套的 Chrome 扩展资产见 [Chrome 扩展 0.1.5](https://github.com/2685387167/dsh-human-browser/releases/tag/extension-v0.1.5)。

```powershell
dsh plugin --profile desktop add 'github:2685387167/dsh-human-browser#plugin-v0.1.6'
```

从旧版升级后，重启 DSH 会同步更新本机 native host。若 `browser_status` 显示宿主注册失败，可以在插件目录运行 `node scripts/install.mjs --check` 检查注册，或运行 `node scripts/install.mjs` 手动修复。

### 2. Chrome 扩展

插件启动后会检测你 Chrome 里的扩展版本：

- **首次安装** → 在提示中点「下载并安装」。解压完成后，打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择提示中的目录。
- **升级扩展** → 在提示中点一次「更新」。下载并校验完成后，插件会自动更新旧版解压目录，每个共享目录写入一次，再通知已连接且支持主动重载的扩展。首次从 0.1.3 升到 0.1.4 时，可等待旧版扩展自检。升级后仍等待重载时，可在 `chrome://extensions` 点击「重新加载」。

扩展的每个版本都发布在 [Releases](https://github.com/2685387167/dsh-human-browser/releases) 上，旧版本保留。想用特定版本可以自己下载解压再用 `chrome://extensions` 加载。

DSH 插件版本和 Chrome 扩展版本独立维护。每个 DSH 插件通过随包 [适配配置](extension-version.json) 指定一个扩展版本。启动时，只有已启用、目录可以核验且版本低于适配版本的解压扩展才会触发更新提示。禁用扩展或失效目录的旧记录会被跳过。等待重连的提示随实际扩展更新进度显示。

更新弹窗中的「取消」只关闭本次 DSH 启动的提示，重启后可再次提示。左下角的「忽略本次更新」会记住本次适配版本，之后按新适配版本重新判断。

### 3. 授权

在浏览器扩展弹窗中管理授权。「全局授权」默认关闭，可逐页点「授权当前标签页」。也可以打开「全局授权」，让标签页首次加载某个 HTTP(S) 来源时自动授权。开关只决定新页面的初始状态，已经加载的网页保留当前授权状态。

可以随时点「撤销当前标签页授权」。刷新或在同一标签页返回该来源后，可手动重新授权。跨来源导航时，原来源的授权随之结束。

「全局脚本执行权限」默认关闭。开启后，已授权的网页默认可以使用 `browser_eval`，刷新后继续生效。可用「禁用本页脚本执行」覆盖全局默认，直到手动恢复或标签页撤权。

全局脚本权限关闭时，也可以单独点「允许本页执行脚本」。单独允许适用于当前文档，刷新或导航后需要重新允许。

### 清理宿主

- `browser_cleanup({ scope: 'host' })` 删除 Chrome、Edge、Chromium 的 native messaging 注册表项、宿主启动器、注册清单及运行时。
- `browser_cleanup({ scope: 'all' })` 还清理默认临时会话目录与更新缓存。扩展目录和静默状态会保留。运行后可重新启用插件以恢复会话。

---

## 平台限制

- **仅 Windows**：native host 用注册表 + `cmd` 启动器实现。
- **需要本机 Chrome / Edge 116+**：更老的版本没有 `chrome.minimum_chrome_version` 支持的 API 集。
- **一个标签页同时只能一个调试器**：开着 DevTools 时接管会失败，会明确告诉你关掉。
- **接管时 Chrome 顶部会显示调试提示条**：这是浏览器自己的安全护栏，页面 JS 读不到它。给 Chrome 快捷方式加 `--silent-debugger-extension-api` 可以隐藏。

---

## 架构

```
DSH 工具 (browser_*)
      │  策略层：轨迹、落点、按键节奏、滚动分段
插件进程（Node）
      │  命名管道 / TCP(127.0.0.1) JSON Lines
native host（Chrome 启动，纯转发）
      │  stdio（native messaging 帧）
MV3 扩展（chrome.debugger，零域 enable）
      │  Input.* / Runtime.evaluate
你的页面
```

数据目录：`%TEMP%\dsh-human-browser\`（日志与端点），`%LOCALAPPDATA%\dsh-human-browser\`（host 运行时副本、扩展解压目录、状态）。

---

## 宿主诊断

```powershell
# 检查当前用户的 native host 注册
node scripts/install.mjs --check
```

---

## 许可

MIT。见 [LICENSE](LICENSE)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
