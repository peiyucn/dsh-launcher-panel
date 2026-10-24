/**
 * Dashboard client script (runs inside the webview).
 *
 * Extracted verbatim from the webview template. It is a *function* rather than
 * a constant because three values must be substituted at render time:
 *
 * - `peakWindows` — the configured peak windows, from {@link PEAK_WINDOWS_BJ_HOURS}
 * - `defaultBrowser` — the fallback browser mode, from {@link DEFAULT_BROWSER}
 *
 * Keeping them as parameters makes each substitution site explicit; the rest of
 * the script is untouched text. The script is a plain string that the host
 * inlines into a nonce-guarded `<script>` tag, so it must stay free of
 * backticks and `${}` beyond these two placeholders.
 *
 * @module webview/panel-script
 */

export interface PanelScriptValues {
  /** Peak windows as Beijing hours, serialized into the script. */
  peakWindows: string
  /** Default browser mode, used when none is reported. */
  defaultBrowser: string
}

export function panelScript(values: PanelScriptValues): string {
  return `    const vscode = acquireVsCodeApi()
    vscode.postMessage({ command: 'ready' })
    const LOADING_TIMEOUT_MS = 6000
    const ELAPSED_INTERVAL_MS = 1000
    // dsh 官方 ongoing 指示器（ui-primitives StateDot 的 ongoing 分支）：SVG 圆弧 spinner。
    // 几何 / 时长 / 减动效兜底逐字照 StateDot.module.css（1.5s 匀速旋转 + arc 的
    // stroke-dasharray 呼吸，两者同相），上色用面板自己的 --lap-ongoing；class 与
    // keyframes 在 panel-styles.ts。
    // ⚠️ 这里以前画的是官方的「点阵」（更老的 StateDot matrix 分支），官方早在
    // 4937343a5e 就换成了圆弧 spinner，本次跟进 —— 面板与两个插件面板同时统一。
    const SPINNER_SVG = '<svg class="state-spinner" viewBox="0 0 24 24" aria-hidden="true">'
      + '<g class="state-spinner-motion">'
      + '<circle class="state-spinner-track" cx="12" cy="12" r="9.5"></circle>'
      + '<circle class="state-spinner-arc" cx="12" cy="12" r="9.5"></circle>'
      + '</g></svg>'
    document.getElementById('loadingSpinner').innerHTML = SPINNER_SVG
    let gotUpdate = false
    let instanceList = []
    let currentInstanceId = ''
    let formMode = 'new'
    let formId = ''
    let formHomePrefix = ''
    let formHomeAuto = true
    setTimeout(() => {
      if (!gotUpdate) {
        const st = document.getElementById('statusText')
        if (st && st.textContent === 'Checking…') st.textContent = '⚠ No status updates received'
      }
      document.getElementById('loadingOverlay').classList.add('hidden')
    }, LOADING_TIMEOUT_MS)

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    }
    function compStateClass(st) {
      return st === 'operational' ? 'ok' : st === 'degraded' ? 'degraded' : st === 'maintenance' ? 'maintenance' : (st === 'partial_outage' || st === 'full_outage') ? 'down' : ''
    }
    function incidentLabel(st) {
      return { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' }[st] || st || ''
    }
    function fmtSize(bytes) {
      if (!bytes || bytes <= 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }
    function renderRunning(status) {
      status = status || {}
      const running = !!(status.running)
      const starting = !!(status.starting)
      const installing = !!(status.installing)
      const stopping = !!(status.stopping)
      // An update rewrites the tree before any spawn; Start must stay greyed for
      // the whole run, not just for the setup step a later Start would trigger.
      const updating = !!(status.updating)
      // Stop must be reachable while starting/installing too, so a slow start
      // or first-run install can be interrupted.
      document.querySelectorAll('.when-running').forEach((b) => { b.style.display = (running || starting || installing || stopping) ? '' : 'none' })
      const statusText = document.getElementById('statusText')
      const statusSub = document.getElementById('statusSub')
      const startBtn = document.getElementById('startBtn')
      if (starting || installing || stopping || updating) {
        const justStarted = startElapsed()
        if (justStarted) statusSub.textContent = 'Waited 0s'
        setStatusDot('working')
        statusText.textContent = stopping
          ? 'Stopping…'
          : (updating ? 'Updating dsh…' : (installing ? 'Installing dsh…' : 'Starting DeepSeek Harness Web UI…'))
        startBtn.textContent = stopping
          ? 'Stopping…'
          : (updating ? 'Updating…' : (installing ? 'Installing…' : 'Starting…'))
        startBtn.disabled = true
      } else {
        stopElapsed()
        startBtn.disabled = false
        setStatusDot(running ? 'running' : 'stopped')
        statusText.textContent = running ? 'Running' : 'Stopped'
        statusSub.textContent = running ? (status.url || '') : ''
        startBtn.textContent = running ? '↗ New Tab' : (status.dsh === 'missing' ? 'Install & Start' : '▶ Start')
      }
      const mode = status.mode === 'source' ? 'source' : 'pnpm'
      document.querySelectorAll('.mode-option').forEach((b) => {
        const active = b.dataset.mode === mode
        b.classList.toggle('active', active)
        b.setAttribute('aria-pressed', String(active))
      })
    }

    function instanceDot(state) {
      if (state === 'running') return '<span class="dot running"></span>'
      if (state === 'starting' || state === 'installing' || state === 'stopping') return '<span class="dot matrix">' + SPINNER_SVG + '</span>'
      if (state === 'error') return '<span class="dot"></span>'
      return '<span class="dot stopped"></span>'
    }
    function renderTabs(list, activeId) {
      const host = document.getElementById('instanceTabs')
      if (!host) return
      host.innerHTML = ''
      if (!Array.isArray(list) || list.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'instance-tabs-empty'
        empty.textContent = 'No instances — click + to create one'
        host.appendChild(empty)
      } else {
        list.forEach((item) => {
          const tab = document.createElement('button')
          tab.type = 'button'
          tab.className = 'instance-tab'
          tab.setAttribute('role', 'tab')
          tab.setAttribute('aria-selected', String(item.id === activeId))
          tab.dataset.id = item.id
          tab.title = 'Instance: ' + (item.name || '') + ' · ' + (item.state || 'stopped') + ' · ' + (item.home || '')
          tab.setAttribute('aria-label', 'Instance ' + (item.name || '') + ', ' + (item.state || 'stopped'))
          tab.innerHTML = instanceDot(item.state) + '<span class="tab-name"></span>'
          tab.querySelector('.tab-name').textContent = item.name || 'Instance'
          tab.addEventListener('click', () => vscode.postMessage({ command: 'selectInstance', value: item.id }))
          host.appendChild(tab)
          if (item.id === activeId) window.requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        })
      }
    }
    function renderInstanceSummary(list) {
      const el = document.getElementById('instanceSummary')
      if (!el) return
      const items = Array.isArray(list) ? list : []
      if (items.length === 0) {
        el.textContent = 'No instances'
        return
      }
      const running = items.filter((item) => item.running).length
      el.textContent = items.length + ' instance' + (items.length === 1 ? '' : 's') + (running ? ' · ' + running + ' running' : '')
    }
    function renderInstanceMeta(status) {
      status = status || {}
      const active = !!status.id
      const busy = !!(status.running || status.starting || status.installing || status.stopping)
      const home = document.getElementById('instanceHome')
      const edit = document.getElementById('editInstanceBtn')
      const del = document.getElementById('deleteInstanceBtn')
      if (home) {
        home.textContent = active && status.home ? (status.homeShort || status.home) : '—'
        home.title = active && status.home ? 'DSH_HOME (data root: sessions, credentials, profiles): ' + status.home : ''
        home.dataset.path = active && status.home ? status.home : ''
      }
      if (edit) edit.disabled = !active || busy
      if (del) del.disabled = !active || busy
      const err = document.getElementById('instanceError')
      if (err) err.textContent = active && status.error ? status.error : ''
      if (!active) {
        const start = document.getElementById('startBtn')
        if (start) { start.disabled = true; start.textContent = '+ New' }
      }
    }

    function slugInstanceName(name) {
      return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance'
    }
    function autoHomeFor(name) {
      return formHomePrefix + slugInstanceName(name)
    }

    function openInstanceForm(form) {
      form = form || {}
      formMode = form.mode === 'edit' ? 'edit' : 'new'
      formId = form.id || ''
      formHomePrefix = form.homePrefix || ''
      document.getElementById('instanceModalTitle').textContent = formMode === 'edit' ? 'Edit instance' : 'New instance'
      document.getElementById('instanceFormName').value = form.name || ''
      document.getElementById('instanceFormHome').value = form.home || ''
      formHomeAuto = formMode === 'new' || document.getElementById('instanceFormHome').value === autoHomeFor(form.name || '')
      document.getElementById('instanceFormAuto').value = form.autoOpenBrowser === true ? 'true' : form.autoOpenBrowser === false ? 'false' : 'global'
      document.getElementById('instanceFormBrowser').value = form.browser === 'built-in' || form.browser === 'external' ? form.browser : 'global'
      document.getElementById('instanceFormError').textContent = ''
      const save = document.getElementById('instanceFormSave')
      save.disabled = false
      save.textContent = formMode === 'edit' ? 'Save' : 'Create'
      const modal = document.getElementById('instanceModal')
      modal.hidden = false
      document.getElementById('instanceFormName').focus()
    }
    function closeInstanceForm() {
      document.getElementById('instanceModal').hidden = true
    }
    function saveInstanceForm() {
      const name = document.getElementById('instanceFormName').value
      const home = document.getElementById('instanceFormHome').value
      const autoText = document.getElementById('instanceFormAuto').value
      const browserText = document.getElementById('instanceFormBrowser').value
      const autoOpenBrowser = autoText === 'true' ? true : autoText === 'false' ? false : undefined
      const browser = browserText === 'built-in' || browserText === 'external' ? browserText : undefined
      const save = document.getElementById('instanceFormSave')
      save.disabled = true
      document.getElementById('instanceFormError').textContent = ''
      vscode.postMessage({
        command: 'saveInstanceForm',
        value: JSON.stringify({ mode: formMode, id: formId, name, home, autoOpenBrowser, browser }),
      })
    }

    function renderRuntime(status) {
      status = status || {}
      const dshMissingText = status.dsh === 'missing' ? (status.mode === 'pnpm' ? 'pnpm not found' : 'not found') : '—'
      // 服务端两种模式都给**裸版本号**（pkg = npm 版本号，source = git tag 去掉 dsh-v
      // 前缀，不在 tag 上时带 -N-gsha 后缀）；v 只在这里补一次，服务端别再补。
      document.getElementById('dshVersion').textContent = status.dshVersion
        ? 'v' + status.dshVersion
        : dshMissingText

      const upd = status.update
      const updateBtn = document.getElementById('updateBtn')
      if (upd && upd.hasUpdate) {
        updateBtn.style.display = ''
        updateBtn.textContent = 'Update to ' + (upd.label || 'latest')
        // The update rewrites the one shared dsh tree, so it requires every
        // instance stopped, not just the active one.
        const anyActive = Array.isArray(instanceList) && instanceList.some((i) => i.running || i.starting || i.installing || i.stopping)
        updateBtn.disabled = anyActive || !!(status.updating)
      } else {
        updateBtn.style.display = 'none'
      }

      // Check updates button mirrors Start: disabled while the server-side
      // check is in flight, re-enabled by the next status update.
      const checkBtn = document.getElementById('refreshBtn')
      if (checkBtn) {
        checkBtn.disabled = !!status.checking
        checkBtn.classList.toggle('spinning', !!status.checking)
        checkBtn.textContent = '⟳'
      }

      // The row label follows the mode: package (published dsh) or source
      // (checkout). It is grouped with home in the instance card.
      const runtimeLabel = document.getElementById('runtimeLabel')
      if (runtimeLabel) runtimeLabel.textContent = status.mode === 'source' ? 'source' : 'package'
      const runtimePath = document.getElementById('runtimePath')
      runtimePath.textContent = status.dshPathShort || '—'
      runtimePath.title = status.dshPath || ''

      // node + launcher versions live at the very bottom.
      document.getElementById('nodeVersionFooter').textContent = status.nodeVersion ? ('node v' + status.nodeVersion) : 'node —'
    }

    function renderLogFiles(status) {
      status = status || {}
      const launcher = document.getElementById('launcherLogPath')
      const server = document.getElementById('serverLogPath')
      if (launcher) {
        launcher.textContent = status.consoleLogPathShort || ''
        launcher.title = status.consoleLogPath || ''
      }
      if (server) {
        server.textContent = status.serverLogPathShort || ''
        server.title = status.serverLogPath || ''
      }
      const launcherSize = document.getElementById('launcherLogSize')
      const serverSize = document.getElementById('serverLogSize')
      if (launcherSize) launcherSize.textContent = fmtSize(status.consoleLogSize)
      if (serverSize) serverSize.textContent = fmtSize(status.serverLogSize)
    }

    function renderDebug(status) {
      const pill = document.getElementById('debugToggle')
      if (!pill) return
      // NODE_DEBUG=module only applies to source mode; hide the pill under pnpm.
      if (status && status.mode !== 'source') {
        pill.style.display = 'none'
        return
      }
      pill.style.display = ''
      const on = !!(status && status.sourceDebug)
      pill.textContent = on ? 'debug on' : 'debug off'
      pill.className = 'debug-pill' + (on ? ' on' : '')
    }

    function renderDs(ds) {
      ds = ds || {}
      const modelList = document.getElementById('dsComponents')
      const otherList = document.getElementById('dsComponentsOther')
      const comps = ds.components || []
      const emptyText = ds.state === 'unknown' ? 'Status unavailable — check your network' : 'No component data'
      const renderGroup = (list, items, empty) => {
        if (!list) return
        list.innerHTML = items.map((c) => {
          const st = c.status || 'operational'
          const stCls = compStateClass(st)
          return '<div class="ds-comp"><span class="cdot' + (stCls ? ' ' + stCls : '') + '"></span><span class="ds-comp-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span></div>'
        }).join('') || '<div class="ds-empty">' + empty + '</div>'
      }
      // Model services carry the deepseek-* label; search/fetch and any future
      // auxiliary APIs stay in the right column.
      renderGroup(modelList, comps.filter((c) => /^deepseek-/i.test(String(c.name || ''))), emptyText)
      renderGroup(otherList, comps.filter((c) => !/^deepseek-/i.test(String(c.name || ''))), '—')
      const inc = document.getElementById('dsIncidents')
      const incs = ds.incidents || []
      inc.innerHTML = incs.map((i) => '<div class="ds-incident">⚠ ' + esc(i.title) + (i.status ? ' · ' + esc(incidentLabel(i.status)) : '') + '</div>').join('')
      inc.style.display = incs.length ? '' : 'none'
    }

    function renderBalance(bal) {
      const val = document.getElementById('balanceValue')
      if (!bal) { val.textContent = ''; return }
      if (bal.balance) {
        val.textContent = bal.balance.total + ' ' + bal.balance.currency
      } else if (bal.error) {
        val.textContent = '⚠ ' + bal.error
      }
    }

    // Peak/off-peak is decided by the extension host (pricing.ts
    // pricingWindowAt) and only rendered here: the holiday table belongs to the
    // shipped build, and a second copy in the webview would be one more thing to
    // keep in step. A year without a calendar has no holiday override, so a
    // peak-window weekday is simply Peak.
    const PEAK_WINDOWS_BJ = ${values.peakWindows}
    function renderPricing(pricing) {
      const el = document.getElementById('dsPricing')
      el.textContent = pricing === 'peak' ? 'Peak' : 'Off-peak'
      el.className = 'ds-pricing ' + pricing
      const now = new Date()
      const local = (h) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0))
        return String(d.getHours()).padStart(2, '0') + ':00'
      }
      // Beijing hour H is UTC hour H-8; local() renders that instant at the
      // viewer's own offset.
      const windows = PEAK_WINDOWS_BJ.map(([from, to]) => local(from - 8) + '–' + local(to - 8)).join(', ')
      el.title = 'Peak: 09:00–12:00, 14:00–18:00 Beijing (your time ' + windows + '); off-peak is half the peak rate; weekends and Chinese public holidays are all off-peak'
    }

    document.querySelectorAll('button[data-cmd]').forEach((b) => {
      b.addEventListener('click', () => {
        // Gray the Start button instantly; the next status update re-enables it.
        if (b.dataset.cmd === 'start') b.disabled = true
        vscode.postMessage({ command: b.dataset.cmd, value: currentInstanceId })
      })
    })
    document.getElementById('newInstanceBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'instanceForm', value: 'new' })
    })
    document.getElementById('editInstanceBtn').addEventListener('click', () => {
      if (currentInstanceId) vscode.postMessage({ command: 'instanceForm', value: currentInstanceId })
    })
    document.getElementById('deleteInstanceBtn').addEventListener('click', () => {
      if (currentInstanceId) vscode.postMessage({ command: 'deleteInstance', value: currentInstanceId })
    })
    document.getElementById('instanceFormCancel').addEventListener('click', closeInstanceForm)
    document.getElementById('instanceFormSave').addEventListener('click', saveInstanceForm)
    const instanceNameField = document.getElementById('instanceFormName')
    const instanceHomeField = document.getElementById('instanceFormHome')
    instanceNameField.addEventListener('input', () => {
      if (formHomeAuto) instanceHomeField.value = autoHomeFor(instanceNameField.value)
    })
    instanceHomeField.addEventListener('input', () => {
      formHomeAuto = instanceHomeField.value === autoHomeFor(instanceNameField.value)
    })
    document.getElementById('instanceModal').addEventListener('click', (e) => {
      if (e.target.id === 'instanceModal') closeInstanceForm()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('instanceModal').hidden) closeInstanceForm()
    })
    document.getElementById('updateBtn').addEventListener('click', () => {
      const btn = document.getElementById('updateBtn')
      if (btn.disabled) return
      btn.disabled = true
      vscode.postMessage({ command: 'updateDsh' })
    })
    document.getElementById('dsOpenBtn').addEventListener('click', () => vscode.postMessage({ command: 'openStatus' }))
    const dsToggle = document.getElementById('dsToggle')
    const dsBody = document.getElementById('dsBody')
    if (dsToggle && dsBody) {
      const setDsOpen = (open) => {
        dsToggle.setAttribute('aria-expanded', String(open))
        dsBody.hidden = !open
      }
      dsToggle.addEventListener('click', () => setDsOpen(dsBody.hidden))
      setDsOpen(false)
    }
    document.getElementById('settingsBtn').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }))
    document.getElementById('clearConsoleBtn').addEventListener('click', () => vscode.postMessage({ command: 'clearConsole' }))
    document.getElementById('debugToggle').addEventListener('click', () => vscode.postMessage({ command: 'toggleDebug' }))
    const browserSelectBtn = document.getElementById('browserSelectBtn')
    const browserSelectMenu = document.getElementById('browserSelectMenu')
    const browserSelectLabel = document.getElementById('browserSelectLabel')
    function setBrowserUI(value) {
      const v = value === 'external' ? 'external' : '${values.defaultBrowser}'
      browserSelectLabel.textContent = v === 'external' ? 'External' : 'Built-in'
      browserSelectMenu.querySelectorAll('.lap-select-option').forEach((o) => {
        o.setAttribute('aria-selected', String(o.dataset.value === v))
      })
    }
    function closeBrowserMenu() {
      browserSelectMenu.hidden = true
      browserSelectBtn.setAttribute('aria-expanded', 'false')
    }
    browserSelectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (browserSelectMenu.hidden) {
        browserSelectMenu.hidden = false
        browserSelectBtn.setAttribute('aria-expanded', 'true')
      } else {
        closeBrowserMenu()
      }
    })
    browserSelectMenu.querySelectorAll('.lap-select-option').forEach((o) => {
      o.addEventListener('click', () => {
        setBrowserUI(o.dataset.value)
        closeBrowserMenu()
        browserSelectBtn.focus()
        vscode.postMessage({ command: 'setBrowser', value: o.dataset.value })
      })
    })
    document.addEventListener('click', (e) => {
      if (browserSelectMenu.hidden) return
      if (e.target.closest('.lap-select')) return
      closeBrowserMenu()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeBrowserMenu()
        return
      }
      // Leaving the open menu with Tab closes it instead of stranding focus.
      if (e.key === 'Tab' && !browserSelectMenu.hidden) closeBrowserMenu()
      // Roving-focus keyboard navigation while the menu is open; Enter/Space
      // pick the focused option via the button's native click.
      if (browserSelectMenu.hidden) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const opts = Array.from(browserSelectMenu.querySelectorAll('.lap-select-option'))
      if (opts.length === 0) return
      let idx = opts.findIndex((o) => o === document.activeElement)
      if (idx === -1) idx = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true')
      if (idx === -1) idx = 0
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? (idx + 1) % opts.length
        : e.key === 'ArrowUp' ? (idx - 1 + opts.length) % opts.length
        : e.key === 'Home' ? 0
        : opts.length - 1
      opts[next].focus()
    })
    document.querySelectorAll('.mode-option').forEach((b) => {
      b.addEventListener('click', () => {
        // No optimistic highlight: the pill only moves once the mode is
        // actually applied (confirmed), via the next status update.
        vscode.postMessage({ command: 'setMode', value: b.dataset.mode })
      })
    })
    document.querySelectorAll('.runtime-path, .runtime-data').forEach((el) => {
      el.addEventListener('click', () => {
        const full = el.dataset.path || el.getAttribute('title')
        if (!full) return
        if (el.dataset.log) vscode.postMessage({ command: 'openLog', value: full })
        else vscode.postMessage({ command: 'revealPath', value: full })
      })
    })

    document.getElementById('refreshBtn').addEventListener('click', () => {
      const btn = document.getElementById('refreshBtn')
      if (btn.disabled) return
      btn.disabled = true
      btn.classList.add('spinning')
      vscode.postMessage({ command: 'refreshRequirements' })
      // Re-enabled by renderRuntime once status.checking goes false (same as Start).
    })
    let refreshingBalance = false
    document.getElementById('balanceBtn').addEventListener('click', () => {
      refreshingBalance = true
      document.getElementById('balanceBtn').disabled = true
      document.getElementById('balanceValue').textContent = 'querying…'
      vscode.postMessage({ command: 'balance' })
    })

    let since = 0
    let elapsedTimer = undefined
    function stopElapsed() {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = undefined }
    }
    // 状态圆点三种形态：working = dsh 点阵（启动/安装/停止中），running = 绿色实心，
    // 其余 = 红色实心。点阵只在切换时重建一次，不随每次状态刷新写 DOM。
    const STATUS_DOT_CLASSES = { working: 'dot matrix', running: 'dot running', stopped: 'dot' }
    function setStatusDot(state) {
      const dot = document.getElementById('dot')
      dot.className = STATUS_DOT_CLASSES[state] || STATUS_DOT_CLASSES.stopped
      const on = state === 'working'
      if (on === (dot.dataset.matrix === '1')) return
      dot.dataset.matrix = on ? '1' : ''
      dot.innerHTML = on ? SPINNER_SVG : ''
    }
    function startElapsed() {
      if (elapsedTimer) return false
      since = Date.now()
      elapsedTimer = setInterval(() => {
        const e = document.getElementById('statusSub')
        if (e) e.textContent = 'Waited ' + Math.round((Date.now() - since) / 1000) + 's'
      }, ELAPSED_INTERVAL_MS)
      return true
    }

    window.addEventListener('message', (e) => {
      const m = e.data
      if (!m) return
      if (m.type === 'instanceForm') { openInstanceForm(m.form); return }
      if (m.type === 'instanceFormError') {
        document.getElementById('instanceFormError').textContent = m.message || 'Instance was not saved'
        document.getElementById('instanceFormSave').disabled = false
        return
      }
      if (m.type === 'instanceFormSaved') { closeInstanceForm(); return }
      if (m.type !== 'update') return
      gotUpdate = true
      document.getElementById('loadingOverlay').classList.add('hidden')
      if (refreshingBalance) {
        refreshingBalance = false
        document.getElementById('balanceBtn').disabled = false
      }
      setBrowserUI(m.browser || '${values.defaultBrowser}')
      instanceList = Array.isArray(m.instances) ? m.instances : []
      currentInstanceId = typeof m.activeId === 'string' ? m.activeId : ''
      const log = document.getElementById('log')
      const entries = Array.isArray(m.activity) ? m.activity : []
      const newline = String.fromCharCode(10)
      const text = entries.map((e) => e.text).join(newline)
      const hasNew = log.dataset.activity !== text
      log.dataset.activity = text
      let logHtml = entries.map((e) => {
        const txt = esc(e.text)
        if (!e.busy) return txt
        // Swap the leading icon (the char right after the timestamp) for the dsh spinner.
        const close = txt.indexOf('] ')
        if (close === -1) return txt
        return txt.slice(0, close + 2) + SPINNER_SVG + txt.slice(close + 3)
      }).join(newline)
      log.innerHTML = logHtml || '(no activity yet)'
      if (hasNew) log.scrollTop = log.scrollHeight
      const dsCard = document.getElementById('dsCard')
      if (dsCard) dsCard.style.display = m.showDs === false ? 'none' : ''
      renderRunning(m.status)
      renderTabs(instanceList, currentInstanceId)
      renderInstanceSummary(instanceList)
      renderInstanceMeta(m.active)
      renderRuntime(m.status)
      renderLogFiles(m.status)
      renderDebug(m.status)
      renderDs(m.dsStatus)
      renderBalance(m.balance)
      renderPricing(m.pricing)
    })`
}
