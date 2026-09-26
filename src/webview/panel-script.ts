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
    // dsh 官方 ongoing 点阵（StateDot matrix）：外环 8 格，顺时针逐格变亮；
    // 每格负延时 = (序号 - 格数) × 相位步长，挂载瞬间即处于追逐中。
    const DOT_MATRIX_CELLS = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]]
    const DOT_MATRIX_PHASE_STEP_MS = 125
    const DOT_MATRIX = '<svg class="dot-matrix" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true">'
      + DOT_MATRIX_CELLS.map(function (c, i) {
        return '<rect class="cell" x="' + c[0] + '" y="' + c[1] + '" width="2" height="2" style="animation-delay:'
          + ((i - DOT_MATRIX_CELLS.length) * DOT_MATRIX_PHASE_STEP_MS) + 'ms"></rect>'
      }).join('')
      + '</svg>'
    document.getElementById('loadingMatrix').innerHTML = DOT_MATRIX
    let gotUpdate = false
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
        // Mirror the server-side guard: updating under a running/starting/
        // stopping server can break it, and an update already in flight must
        // not be started twice.
        updateBtn.disabled = !!(status.running || status.starting || status.installing || status.stopping || status.updating)
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
      // (checkout); data = ~/.dsh.
      const runtimeLabel = document.getElementById('runtimeLabel')
      if (runtimeLabel) runtimeLabel.textContent = status.mode === 'source' ? 'source' : 'package'
      const runtimePath = document.getElementById('runtimePath')
      runtimePath.textContent = status.dshPathShort || '—'
      runtimePath.title = status.dshPath || ''
      const runtimeData = document.getElementById('runtimeData')
      runtimeData.textContent = status.dshHomeShort || '—'
      runtimeData.title = status.dshHome || ''

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
      const list = document.getElementById('dsComponents')
      const comps = ds.components || []
      let html = ''
      for (const c of comps) {
        const st = c.status || 'operational'
        const stCls = compStateClass(st)
        html += '<div class="ds-comp"><span class="ds-comp-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span><span class="cdot' + (stCls ? ' ' + stCls : '') + '"></span></div>'
      }
      list.innerHTML = html || '<div class="ds-empty">' + (ds.state === 'unknown' ? 'Status unavailable — check your network' : 'No component data') + '</div>'
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
        vscode.postMessage({ command: b.dataset.cmd })
      })
    })
    document.getElementById('updateBtn').addEventListener('click', () => {
      const btn = document.getElementById('updateBtn')
      if (btn.disabled) return
      btn.disabled = true
      vscode.postMessage({ command: 'updateDsh' })
    })
    document.getElementById('dsOpenBtn').addEventListener('click', () => vscode.postMessage({ command: 'openStatus' }))
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
        const full = el.getAttribute('title')
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
      dot.innerHTML = on ? DOT_MATRIX : ''
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
      if (!m || m.type !== 'update') return
      gotUpdate = true
      document.getElementById('loadingOverlay').classList.add('hidden')
      if (refreshingBalance) {
        refreshingBalance = false
        document.getElementById('balanceBtn').disabled = false
      }
      setBrowserUI(m.browser || '${values.defaultBrowser}')
      const log = document.getElementById('log')
      const entries = Array.isArray(m.activity) ? m.activity : []
      const newline = String.fromCharCode(10)
      const text = entries.map((e) => e.text).join(newline)
      const hasNew = log.dataset.activity !== text
      log.dataset.activity = text
      let logHtml = entries.map((e) => {
        const txt = esc(e.text)
        if (!e.busy) return txt
        // Swap the leading icon (the char right after the timestamp) for the dsh dot matrix.
        const close = txt.indexOf('] ')
        if (close === -1) return txt
        return txt.slice(0, close + 2) + DOT_MATRIX + txt.slice(close + 3)
      }).join(newline)
      log.innerHTML = logHtml || '(no activity yet)'
      if (hasNew) log.scrollTop = log.scrollHeight
      const dsCard = document.getElementById('dsCard')
      if (dsCard) dsCard.style.display = m.showDs === false ? 'none' : ''
      renderRunning(m.status)
      renderRuntime(m.status)
      renderLogFiles(m.status)
      renderDebug(m.status)
      renderDs(m.dsStatus)
      renderBalance(m.balance)
      renderPricing(m.pricing)
    })`
}
