# dsh-human-browser

让 AI 在**你正在用的那个 Chrome** 里干活，并且尽量看不出是机器在动。

不是另开一个浏览器，是接管你已经登录、有历史、装了扩展的那个窗口。

> Windows only · 需要 Chrome 或 Edge 116+ · 扩展通过 GitHub Release 分发，由插件自动安装

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
| `browser_tabs` | 列 / 开 / 关 / 切标签页 |
| `browser_snapshot` | 读可交互元素清单，每个带完整 ref 和人类可读标签 |
| `browser_read` | 读正文 / HTML / 元素属性 / 页面元信息 |
| `browser_click` | 点击元素或坐标 —— 真实鼠标事件 + 轨迹 + 随机落点 |
| `browser_type` | 打字 —— 逐字符真键盘事件，词边界与标点停顿 |
| `browser_key` | Enter / Tab / Escape / 方向键 / PageUp/Down |
| `browser_hover` | 悬停 |
| `browser_scroll` | 按像素 / 滚到顶底 / 滚到某元素 |
| `browser_wait` | 等选择器、等网址、等时长（轮询，不注入观察器） |
| `browser_screenshot` | 截图，直接给模型看 |
| `browser_eval` | 页面 JS（需单独授权） |
| `browser_stealth` | 反检测自检，报四层信号实测值 |
| `browser_detach` | 释放接管并撤销授权 |
| `browser_cleanup` | 显式清理 native host，返回实际处理结果 |

15 个工具的 schema 合计约 7500 字节（≈1900 tokens），是每次请求都要付的固定成本。

---

## 安装

### 1. DSH 插件

```powershell
dsh plugin --profile desktop add github:2685387167/dsh-human-browser
```

装好后重启 DSH。插件会在加载时自动注册 native messaging host（写 HKCU 注册表，不需要管理员）。

如需固定安装 DSH 插件 0.1.3，使用下面的命令。GitHub Release 的 `v0.1.3` 对应 Chrome 扩展资产。

```powershell
dsh plugin --profile desktop add 'github:2685387167/dsh-human-browser#plugin-v0.1.3'
```

从旧版升级后，重启 DSH 会同步更新本机 native host。若 `browser_status` 显示宿主注册失败，可以在插件目录运行 `node scripts/install.mjs --check` 检查注册，或运行 `node scripts/install.mjs` 手动修复。

### 2. Chrome 扩展

插件启动后会检测你 Chrome 里的扩展版本：

- **没装过** → 弹窗提示「下载并安装」，点一下自动下载解压，再到 `chrome://extensions` 打开「开发者模式」，选择「加载已解压的扩展程序」并选中提示的目录
- **装过但低于推荐版** → 弹窗提示「更新」，逐个更新可验证的旧版解压目录。保持开发者模式开启，扩展会在下一次版本自检时重载，通常在五分钟内

扩展的每个版本都发布在 [Releases](https://github.com/2685387167/dsh-human-browser/releases) 上，旧版本保留。想用特定版本可以自己下载解压再用 `chrome://extensions` 加载。

DSH 插件版本和 Chrome 扩展版本独立维护。插件读取线上 [扩展推荐](extension-version.json)，只接受与当前通信协议兼容的推荐；离线时使用本地已有的推荐。GitHub 的 Latest 标记只用于浏览发布页面。

### 3. 授权

装好扩展后，**每个要操作的页面都要在扩展弹窗点一次「授权当前标签页」**。需要 `browser_eval` 时再点「允许本页执行脚本」。

跨来源导航后授权失效，需要重新授权。

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
