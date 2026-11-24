// DSH Web 将 ./client 作为浏览器脚本加载，factory 返回 Cordis 客户端插件。
window.__ModuleLoader__.load({
  id: 'dsh-human-browser',
  factory: () => {
    const dialogId = 'dsh-hb-update'
    const apiBase = 'human-browser/update/'
    const pollInterval = 1000
    const requestTimeout = 15000
    const styleText = `
      #${dialogId} {
        box-sizing: border-box;
        width: min(460px, calc(100vw - 32px));
        max-height: calc(100dvh - 32px);
        overflow: auto;
        padding: 24px;
        border: 1px solid var(--dsw-alias-border-l1, ButtonBorder);
        border-radius: var(--dsw-radius-panel, var(--dsw-radius-lg, 16px));
        background: var(--dsw-alias-bg-layer-2, Canvas);
        box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, none));
        color: var(--dsw-alias-label-primary, CanvasText);
        font: inherit;
        font-size: 14px;
        line-height: 1.55;
        overscroll-behavior: contain;
      }
      #${dialogId}::backdrop {
        inset: var(--dsh-frame-chrome-top, 0px) 0 0;
        background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, GrayText 45%, transparent));
        backdrop-filter: var(--dsw-mask-blur, none);
      }
      #${dialogId} h2 {
        margin: 0 0 12px;
        font-size: 18px;
        font-weight: 600;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
      #${dialogId} h2:focus {
        outline: none;
      }
      #${dialogId} p {
        margin: 0;
        overflow-wrap: anywhere;
      }
      #${dialogId} .hb-content {
        display: grid;
        gap: 12px;
      }
      #${dialogId} .hb-secondary {
        color: var(--dsw-alias-label-secondary, CanvasText);
      }
      #${dialogId} .hb-notes {
        max-height: min(240px, 40dvh);
        overflow: auto;
        padding-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1, ButtonBorder);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #${dialogId} footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
      }
      #${dialogId} button {
        min-height: 36px;
        padding: 6px 14px;
        border: 1px solid var(--dsw-alias-border-l2, ButtonBorder);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-button-elevated-fill, ButtonFace);
        color: var(--dsw-alias-label-primary, ButtonText);
        font: inherit;
        font-weight: 500;
        cursor: pointer;
      }
      #${dialogId} button:hover {
        background: var(--dsw-alias-interactive-bg-hover, ButtonFace);
      }
      #${dialogId} button.hb-primary {
        border-color: transparent;
        background: var(--dsw-alias-button-info-fill, Highlight);
        color: var(--dsw-alias-label-primary-foreground, HighlightText);
      }
      #${dialogId} button.hb-primary:hover {
        background: var(--dsw-alias-button-info-hover, Highlight);
      }
      #${dialogId} progress {
        width: 100%;
        height: 10px;
        accent-color: var(--dsw-alias-brand-primary, Highlight);
      }
      #${dialogId} .hb-path {
        padding: 8px 12px;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-markdown-code-block, ButtonFace);
        font-family: var(--ds-font-family-code, monospace);
        overflow-wrap: anywhere;
        user-select: text;
      }
      #${dialogId} .hb-error, #${dialogId}-notice {
        color: var(--dsw-alias-state-error-primary, CanvasText);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #${dialogId}-notice {
        position: fixed;
        z-index: 1000;
        right: 16px;
        bottom: 16px;
        box-sizing: border-box;
        width: min(460px, calc(100vw - 32px));
        max-height: 40vh;
        overflow: auto;
        padding: 12px 16px;
        border: 1px solid var(--dsw-alias-border-l1, ButtonBorder);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-specific-menu, Canvas);
        box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, none));
        pointer-events: none;
      }
    `

    /**
     * 通过同源路由向宿主请求 JSON。传入 body 时使用 POST，其余请求每次都读新状态。
     * @param {string} action 契约中的路由尾段
     * @param {AbortSignal} signal 随客户端卸载或当前安装界面关闭而取消
     * @param {object} [body] POST 请求体
     */
    async function request(action, signal, body) {
      const options = { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) }
      if (body !== undefined) {
        options.method = 'POST'
        options.headers = { 'content-type': 'application/json' }
        options.body = JSON.stringify(body)
      }
      const url = new URL(apiBase + action, document.baseURI)
      const response = await fetch(url.href, options)
      const payload = await response.json().catch(() => null)
      options.signal.throwIfAborted()
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status} ${response.statusText}`.trim())
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`宿主路由 ${action} 返回了无效数据（HTTP ${response.status}）`)
      }
      return payload
    }

    /** 按 Chrome 扩展版本的数字分段计数，避免把 0.1.10 算作早于 0.1.3。 */
    function isOlder(version, targetVersion) {
      if (!version) return false
      const current = version.split('.').map(Number)
      const target = targetVersion.split('.').map(Number)
      for (let index = 0; index < Math.max(current.length, target.length); index++) {
        const difference = (current[index] ?? 0) - (target[index] ?? 0)
        if (difference !== 0) return difference < 0
      }
      return false
    }

    /** 创建纯文本节点，保留发行说明和宿主错误原文，避免把外部数据解析成 HTML。 */
    function node(tag, text, className) {
      const element = document.createElement(tag)
      if (text !== undefined) element.textContent = text
      if (className) element.className = className
      return element
    }

    /** 原生模态负责拦截背景交互及约束焦点，Escape 沿用当前界面的关闭操作。 */
    function createDialog() {
      const dialog = node('dialog')
      const heading = node('h2')
      const content = node('div', undefined, 'hb-content')
      const footer = node('footer')
      let onClose
      dialog.id = dialogId
      heading.id = dialogId + '-title'
      heading.tabIndex = -1
      dialog.setAttribute('aria-labelledby', heading.id)
      dialog.setAttribute('closedby', 'closerequest')
      dialog.append(heading, content, footer)
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        onClose()
      })

      return {
        /** 就地替换弹窗内容，并把焦点移到新状态的标题。 */
        show(title, children, primary, close, closeLabel = '取消') {
          onClose = close
          heading.textContent = title
          content.replaceChildren(...children)
          const secondary = node('button', closeLabel)
          secondary.type = 'button'
          secondary.onclick = close
          footer.replaceChildren(secondary)
          if (primary) {
            const button = node('button', primary.label, 'hb-primary')
            button.type = 'button'
            button.onclick = primary.onClick
            footer.append(button)
          }
          if (!dialog.open) {
            document.body.append(dialog)
            dialog.showModal()
          }
          dialog.scrollTop = 0
          heading.focus({ preventScroll: true })
        },
        /** 先释放原生模态和焦点，再移除页面节点。 */
        close() {
          if (dialog.open) dialog.close()
          dialog.remove()
        },
      }
    }

    /** 启用 DSH 客户端组件并把样式、请求、定时器都纳入插件卸载周期。 */
    function apply(ctx) {
      ctx.effect(() => {
        const lifetime = new AbortController()
        const view = createDialog()
        const style = node('style', styleText)
        document.head.append(style)
        let status
        let installRun
        let pollTimer
        let notice
        let noticeTimer

        /** 结束本次进度跟踪，供取消、完成、失败和卸载共用。 */
        function stopPolling() {
          clearTimeout(pollTimer)
          installRun?.abort()
          installRun = undefined
        }

        /** 立即恢复主界面操作，稍后由宿主确认该版本是否已成功静默。 */
        async function dismiss() {
          stopPolling()
          view.close()
          if (!status) return
          try {
            await request('dismiss', lifetime.signal, { version: status.targetVersion })
          } catch (error) {
            if (lifetime.signal.aborted) return
            notice?.remove()
            clearTimeout(noticeTimer)
            notice = node('div', `未能记住本次取消\n${error.message}`)
            notice.id = dialogId + '-notice'
            notice.setAttribute('role', 'alert')
            document.body.append(notice)
            noticeTimer = setTimeout(() => notice.remove(), 8000)
          }
        }

        /** 只有首次安装需要保留完成态，让用户能选中路径并按步骤手动加载。 */
        function finishInstall(progress) {
          stopPolling()
          if (!progress.needsManualLoad) {
            view.close()
            return
          }
          view.show('扩展已解压', [
            node('p', '请在 Chrome 地址栏打开 chrome://extensions，开启「开发者模式」，选择「加载已解压的扩展程序」，然后选中下方目录。'),
            node('code', progress.installedPath || '宿主未返回解压路径', 'hb-path'),
          ], null, () => view.close(), '关闭')
        }

        /** 安装启动后按秒读进度。上一轮返回后才排下一轮，避免并发请求覆盖状态。 */
        function poll(signal, updateProgress) {
          pollTimer = setTimeout(async () => {
            try {
              const progress = await request('progress', signal)
              if (signal.aborted) return
              switch (progress.stage) {
                case 'done':
                  finishInstall(progress)
                  return
                case 'error':
                  throw new Error(progress.error || '宿主未返回安装错误详情')
                case 'idle':
                case 'downloading':
                case 'installing':
                  updateProgress(progress)
                  break
                default:
                  throw new Error(`宿主返回了未知的安装阶段 ${progress.stage}`)
              }
              poll(signal, updateProgress)
            } catch (error) {
              if (!signal.aborted) showInstallError(error)
            }
          }, pollInterval)
        }

        /** 显示原始错误，重试会走同一条安装入口。 */
        function showInstallError(error) {
          stopPolling()
          view.show('扩展安装遇到问题', [node('p', error.message, 'hb-error')],
            { label: '重试', onClick: install }, dismiss)
        }

        /** 启动安装或接管宿主正在处理的任务。取消仅关闭提示，宿主安装继续。 */
        async function install() {
          if (installRun) return
          installRun = new AbortController()
          const { signal } = installRun
          const label = node('p', '正在启动安装…')
          const bar = node('progress')
          bar.max = 100
          bar.setAttribute('aria-label', '扩展安装进度')
          view.show('正在处理浏览器扩展', [
            label,
            bar,
            node('p', '已开始的安装会在后台继续。', 'hb-secondary'),
          ], null, dismiss)
          try {
            const result = await request('install', signal, {})
            if (signal.aborted) return
            if (result.started !== true && result.reason !== 'already-running') {
              throw new Error(result.error || '宿主未确认启动扩展安装')
            }
            poll(signal, (progress) => {
              if (progress.stage === 'idle') return
              if (progress.stage === 'downloading') {
                const percent = Math.round(Math.min(100, Math.max(0, progress.progress)))
                label.textContent = `正在下载… ${percent}%`
                bar.value = percent
              } else {
                label.textContent = '正在安装…'
                bar.removeAttribute('value')
              }
            })
          } catch (error) {
            if (!signal.aborted) showInstallError(error)
          }
        }

        /** 提示是否出现由宿主状态决定。前端只计算多配置的说明文字。 */
        async function checkStatus() {
          try {
            const current = await request('status', lifetime.signal)
            if (lifetime.signal.aborted) return
            if (typeof current.installed !== 'boolean' || typeof current.targetVersion !== 'string' || !current.targetVersion) {
              throw new Error('宿主缺少扩展版本状态')
            }
            if (Date.now() < Date.parse(current.dismissedUntil)) return
            if (current.installed && !current.needsUpdate && !current.pendingReloadOnly) return
            status = current
            if (!status.installed) {
              view.show('需要一个浏览器扩展', [
                node('p', '这个插件需要配合 Chrome 扩展使用，目前还没有安装。'),
                node('p', `扩展版本：${status.targetVersion}`, 'hb-secondary'),
              ], { label: '下载并安装', onClick: install }, dismiss)
              return
            }

            if (status.pendingReloadOnly) {
              view.show('等待浏览器自动重载扩展', [
                node('p', '扩展文件已更新。请保持浏览器和扩展开发者模式开启，扩展会在下次自检时重载。'),
              ], null, dismiss)
              return
            }

            const title = `推荐扩展版本 ${status.targetVersion}`
            const children = [node('p', `当前：${status.userVersion ?? '未知'} → 推荐：${status.targetVersion}`, 'hb-secondary')]
            const profiles = status.profiles ?? []
            const outdated = profiles.filter((profile) => isOlder(profile.version, status.targetVersion)).length
            if (profiles.length > 1 && outdated > 0) {
              children.push(node('p', `有 ${outdated} 个配置的扩展低于推荐版本。`, 'hb-secondary'))
            }
            if (status.releaseNotes) {
              const notes = node('section')
              const body = node('div', status.releaseNotes, 'hb-notes')
              body.tabIndex = 0
              body.setAttribute('aria-label', '更新内容')
              notes.append(node('p', '更新内容'), body)
              children.push(notes)
            }
            view.show(title, children, { label: '更新', onClick: install }, dismiss)
          } catch (error) {
            if (lifetime.signal.aborted) return
            view.show('无法检查浏览器扩展', [node('p', error.message, 'hb-error')],
              { label: '重试', onClick: () => { view.close(); void checkStatus() } }, dismiss)
          }
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', checkStatus, { once: true, signal: lifetime.signal })
        } else {
          void checkStatus()
        }
        return () => {
          lifetime.abort()
          stopPolling()
          view.close()
          clearTimeout(noticeTimer)
          notice?.remove()
          style.remove()
        }
      }, 'dsh-human-browser: update dialog')
    }

    return { apply, inject: [] }
  },
})
