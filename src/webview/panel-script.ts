/**
 * Dashboard client script, inlined into the nonce-guarded script tag.
 *
 * It is a function because two values are substituted at render time:
 * `peakWindows` (host-serialized) and `defaultBrowser` (JSON-encoded here). The
 * text must stay free of backticks and `${}` beyond those placeholders.
 *
 * @module webview/panel-script
 */

export interface PanelScriptValues {
  /** Peak windows as Beijing hours, already serialized into a JS literal. */
  peakWindows: string
  /** Browser fallback; JSON-encoded so a quoted value cannot escape its literal. */
  defaultBrowser: string
}

export function panelScript(values: PanelScriptValues): string {
  // JSON.stringify keeps the value inside its literal; escaping `<` also stops a
  // value containing "</script>" from closing the host's inline script element.
  const defaultBrowserLiteral = JSON.stringify(values.defaultBrowser).replace(/</g, '\\u003c')
  return `    const vscode = acquireVsCodeApi()
    vscode.postMessage({ command: 'ready' })
    const LOADING_TIMEOUT_MS = 6000
    const ELAPSED_INTERVAL_MS = 1000
    // Mirrors dsh's StateDot geometry and timing; panel-styles.ts carries the CSS.
    const SPINNER_SVG = '<svg class="state-spinner" viewBox="0 0 24 24" aria-hidden="true">'
      + '<g class="state-spinner-motion">'
      + '<circle class="state-spinner-track" cx="12" cy="12" r="9.5"></circle>'
      + '<circle class="state-spinner-arc" cx="12" cy="12" r="9.5"></circle>'
      + '</g></svg>'
    document.getElementById('loadingSpinner').innerHTML = SPINNER_SVG
    // One lookup per repeatedly used element: the markup is static.
    const el = {
      loadingOverlay: document.getElementById('loadingOverlay'),
      statusText: document.getElementById('statusText'),
      statusSub: document.getElementById('statusSub'),
      startBtn: document.getElementById('startBtn'),
      instanceTabs: document.getElementById('instanceTabs'),
      editInstanceBtn: document.getElementById('editInstanceBtn'),
      deleteInstanceBtn: document.getElementById('deleteInstanceBtn'),
      updateBtn: document.getElementById('updateBtn'),
      refreshBtn: document.getElementById('refreshBtn'),
      debugToggle: document.getElementById('debugToggle'),
      log: document.getElementById('log'),
      balanceValue: document.getElementById('balanceValue'),
      balanceBtn: document.getElementById('balanceBtn'),
      instanceFormName: document.getElementById('instanceFormName'),
      instanceFormHome: document.getElementById('instanceFormHome'),
      instanceFormAuto: document.getElementById('instanceFormAuto'),
      instanceFormBrowser: document.getElementById('instanceFormBrowser'),
      instanceFormSave: document.getElementById('instanceFormSave'),
      instanceFormError: document.getElementById('instanceFormError'),
      instanceModal: document.getElementById('instanceModal'),
    }
    const modeOptions = document.querySelectorAll('.mode-option')
    const whenRunning = document.querySelectorAll('.when-running')
    let gotUpdate = false
    let instanceList = []
    let currentInstanceId = ''
    // Last rendered activity: text drives auto-scroll, HTML avoids needless repaints.
    let lastActivityText = ''
    let lastLogHtml = ''
    let formMode = 'new'
    let formId = ''
    let formHomePrefix = ''
    let formHomeAuto = true
    setTimeout(() => {
      if (!gotUpdate && el.statusText.textContent === 'Checking…') el.statusText.textContent = '⚠ No status updates received'
      el.loadingOverlay.classList.add('hidden')
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
      const running = !!status.running
      const starting = !!status.starting
      const installing = !!status.installing
      const stopping = !!status.stopping
      const updating = !!status.updating
      whenRunning.forEach((b) => { b.style.display = (running || starting || installing || stopping) ? '' : 'none' })
      if (starting || installing || stopping || updating) {
        if (startElapsed()) el.statusSub.textContent = 'Waited 0s'
        el.statusText.textContent = stopping ? 'Stopping…' : updating ? 'Updating dsh…' : installing ? 'Installing dsh…' : 'Starting DeepSeek Harness…'
        el.startBtn.textContent = stopping ? 'Stopping…' : updating ? 'Updating…' : installing ? 'Installing…' : 'Starting…'
        el.startBtn.disabled = true
      } else if (status.unknown) {
        // A stale snapshot must not be reported as "Stopped" while the server may run.
        stopElapsed()
        el.startBtn.disabled = false
        el.startBtn.textContent = '▶ Start'
        el.statusText.textContent = 'Status unknown'
        el.statusSub.textContent = 'Status refresh failed — retrying…'
      } else {
        stopElapsed()
        el.startBtn.disabled = false
        el.statusText.textContent = running ? 'Running' : 'Stopped'
        el.statusSub.textContent = running ? (status.url || '') : ''
        el.startBtn.textContent = running ? '↗ New Tab' : (status.dsh === 'missing' ? 'Install & Start' : '▶ Start')
      }
      const mode = status.mode === 'source' ? 'source' : 'pnpm'
      modeOptions.forEach((b) => {
        const active = b.dataset.mode === mode
        b.classList.toggle('active', active)
        b.setAttribute('aria-pressed', String(active))
      })
    }

    function instanceDot(state) {
      if (state === 'running') return '<span class="dot running"></span>'
      if (state === 'starting' || state === 'installing' || state === 'stopping') return '<span class="dot matrix">' + SPINNER_SVG + '</span>'
      return '<span class="dot' + (state === 'error' ? '' : ' stopped') + '"></span>'
    }
    function renderTabs(list, activeId) {
      const items = Array.isArray(list) ? list : []
      el.instanceTabs.innerHTML = items.length === 0
        ? '<span class="instance-tabs-empty">No instances — click + to create one</span>'
        : items.map((item) => {
          const selected = item.id === activeId
          return '<button type="button" class="instance-tab" role="tab" aria-selected="' + selected + '" data-id="' + esc(item.id) + '"'
            + ' title="' + esc('Instance: ' + (item.name || '') + ' · ' + (item.state || 'stopped') + ' · ' + (item.home || '')) + '"'
            + ' aria-label="' + esc('Instance ' + (item.name || '') + ', ' + (item.state || 'stopped')) + '">'
            + instanceDot(item.state) + '<span class="tab-name">' + esc(item.name || 'Instance') + '</span></button>'
        }).join('')
      const activeTab = el.instanceTabs.querySelector('.instance-tab[aria-selected="true"]')
      if (activeTab) window.requestAnimationFrame(() => activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
    function renderInstanceSummary(list) {
      const items = Array.isArray(list) ? list : []
      const running = items.filter((item) => item.running).length
      document.getElementById('instanceSummary').textContent = items.length === 0
        ? 'No instances'
        : items.length + ' instance' + (items.length === 1 ? '' : 's') + (running ? ' · ' + running + ' running' : '')
    }
    function renderIssues(list) {
      const issues = (Array.isArray(list) ? list : []).filter((issue) => issue && typeof issue.message === 'string' && issue.message !== '')
      document.getElementById('instanceIssues').innerHTML = issues.map((issue) => {
        const error = issue.severity === 'error'
        return '<div class="instance-issue ' + (error ? 'error' : 'warning') + '">' + (error ? '⚠ ' : 'ℹ ') + esc(issue.message) + '</div>'
      }).join('')
    }
    function renderInstanceMeta(status) {
      status = status || {}
      const active = !!status.id
      const busy = !!(status.running || status.starting || status.installing || status.stopping)
      const showHome = active && !!status.home
      const home = document.getElementById('instanceHome')
      home.textContent = showHome ? (status.homeShort || status.home) : '—'
      home.title = showHome ? 'DSH_HOME (data root: sessions, credentials, profiles): ' + status.home : ''
      home.dataset.path = showHome ? status.home : ''
      el.editInstanceBtn.disabled = el.deleteInstanceBtn.disabled = !active || busy
      document.getElementById('instanceError').textContent = active && status.error ? status.error : ''
      if (!active) {
        el.startBtn.disabled = true
        el.startBtn.textContent = '+ New'
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
      el.instanceFormName.value = form.name || ''
      el.instanceFormHome.value = form.home || ''
      formHomeAuto = formMode === 'new' || el.instanceFormHome.value === autoHomeFor(form.name || '')
      el.instanceFormAuto.value = form.autoOpenBrowser === true ? 'true' : form.autoOpenBrowser === false ? 'false' : 'global'
      el.instanceFormBrowser.value = form.browser === 'built-in' || form.browser === 'external' ? form.browser : 'global'
      el.instanceFormError.textContent = ''
      el.instanceFormSave.disabled = false
      el.instanceFormSave.textContent = formMode === 'edit' ? 'Save' : 'Create'
      el.instanceModal.hidden = false
      el.instanceFormName.focus()
    }
    function closeInstanceForm() {
      el.instanceModal.hidden = true
    }
    function saveInstanceForm() {
      const name = el.instanceFormName.value
      const home = el.instanceFormHome.value
      const autoText = el.instanceFormAuto.value
      const browserText = el.instanceFormBrowser.value
      const autoOpenBrowser = autoText === 'true' ? true : autoText === 'false' ? false : undefined
      const browser = browserText === 'built-in' || browserText === 'external' ? browserText : undefined
      el.instanceFormSave.disabled = true
      el.instanceFormError.textContent = ''
      vscode.postMessage({
        command: 'saveInstanceForm',
        value: JSON.stringify({ mode: formMode, id: formId, name, home, autoOpenBrowser, browser }),
      })
    }

    function renderRuntime(status) {
      status = status || {}
      const dshMissingText = status.dsh === 'missing' ? (status.mode === 'pnpm' ? 'pnpm not found' : 'not found') : '—'
      document.getElementById('dshVersion').textContent = status.dshVersion ? 'v' + status.dshVersion : dshMissingText
      const upd = status.update
      if (upd && upd.hasUpdate) {
        el.updateBtn.style.display = ''
        el.updateBtn.textContent = 'Update to ' + (upd.label || 'latest')
        const anyActive = Array.isArray(instanceList) && instanceList.some((i) => i.running || i.starting || i.installing || i.stopping)
        el.updateBtn.disabled = anyActive || !!status.updating
      } else {
        el.updateBtn.style.display = 'none'
      }
      el.refreshBtn.disabled = !!status.checking
      el.refreshBtn.classList.toggle('spinning', !!status.checking)
      document.getElementById('runtimeLabel').textContent = status.mode === 'source' ? 'source' : 'package'
      const runtimePath = document.getElementById('runtimePath')
      runtimePath.textContent = status.dshPathShort || '—'
      runtimePath.title = status.dshPath || ''
      document.getElementById('nodeVersionFooter').textContent = status.nodeVersion ? ('node v' + status.nodeVersion) : 'node —'
    }

    function renderLogFiles(status) {
      status = status || {}
      const launcher = document.getElementById('launcherLogPath')
      launcher.textContent = status.consoleLogPathShort || ''
      launcher.title = status.consoleLogPath || ''
      const server = document.getElementById('serverLogPath')
      server.textContent = status.serverLogPathShort || ''
      server.title = status.serverLogPath || ''
      document.getElementById('launcherLogSize').textContent = fmtSize(status.consoleLogSize)
      document.getElementById('serverLogSize').textContent = fmtSize(status.serverLogSize)
    }

    function renderDebug(status) {
      if (status && status.mode !== 'source') {
        el.debugToggle.style.display = 'none'
        return
      }
      el.debugToggle.style.display = ''
      const on = !!(status && status.sourceDebug)
      el.debugToggle.textContent = on ? 'debug on' : 'debug off'
      el.debugToggle.className = 'debug-pill' + (on ? ' on' : '')
    }

    function renderDs(ds) {
      ds = ds || {}
      const comps = ds.components || []
      const emptyText = ds.state === 'unknown' ? 'Status unavailable — check your network' : 'No component data'
      const renderGroup = (list, items, empty) => {
        list.innerHTML = items.map((c) => {
          const stCls = compStateClass(c.status || 'operational')
          return '<div class="ds-comp"><span class="cdot' + (stCls ? ' ' + stCls : '') + '"></span><span class="ds-comp-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span></div>'
        }).join('') || '<div class="ds-empty">' + empty + '</div>'
      }
      renderGroup(document.getElementById('dsComponents'), comps.filter((c) => /^deepseek-/i.test(String(c.name || ''))), emptyText)
      renderGroup(document.getElementById('dsComponentsOther'), comps.filter((c) => !/^deepseek-/i.test(String(c.name || ''))), '—')
      const inc = document.getElementById('dsIncidents')
      const incs = ds.incidents || []
      inc.innerHTML = incs.map((i) => '<div class="ds-incident">⚠ ' + esc(i.title) + (i.status ? ' · ' + esc(incidentLabel(i.status)) : '') + '</div>').join('')
      inc.style.display = incs.length ? '' : 'none'
    }

    function renderBalance(bal) {
      if (!bal) {
        el.balanceValue.textContent = ''
        return
      }
      if (bal.balance) el.balanceValue.textContent = bal.balance.total + ' ' + bal.balance.currency
      else if (bal.error) el.balanceValue.textContent = '⚠ ' + bal.error
    }

    // Peak/off-peak is decided by the host; the webview only renders it.
    const PEAK_WINDOWS_BJ = ${values.peakWindows}
    // JSON-encoded so a quoted value cannot escape this literal.
    const DEFAULT_BROWSER = ${defaultBrowserLiteral}
    function renderPricing(pricing) {
      const elPricing = document.getElementById('dsPricing')
      elPricing.textContent = pricing === 'peak' ? 'Peak' : 'Off-peak'
      elPricing.className = 'ds-pricing ' + pricing
      const now = new Date()
      const local = (h) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0))
        return String(d.getHours()).padStart(2, '0') + ':00'
      }
      // Beijing hour H is UTC hour H-8; local() renders that instant at the viewer's offset.
      const windows = PEAK_WINDOWS_BJ.map(([from, to]) => local(from - 8) + '–' + local(to - 8)).join(', ')
      elPricing.title = 'Peak: 09:00–12:00, 14:00–18:00 Beijing (your time ' + windows + '); off-peak is half the peak rate; weekends and Chinese public holidays are all off-peak'
    }

    document.querySelectorAll('button[data-cmd]').forEach((b) => {
      b.addEventListener('click', () => {
        // Start is greyed instantly; the next status update re-enables it.
        if (b.dataset.cmd === 'start') b.disabled = true
        vscode.postMessage({ command: b.dataset.cmd, value: currentInstanceId })
      })
    })
    el.instanceTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.instance-tab')
      if (tab) vscode.postMessage({ command: 'selectInstance', value: tab.dataset.id })
    })
    document.getElementById('newInstanceBtn').addEventListener('click', () => vscode.postMessage({ command: 'instanceForm', value: 'new' }))
    el.editInstanceBtn.addEventListener('click', () => {
      if (currentInstanceId) vscode.postMessage({ command: 'instanceForm', value: currentInstanceId })
    })
    el.deleteInstanceBtn.addEventListener('click', () => {
      if (currentInstanceId) vscode.postMessage({ command: 'deleteInstance', value: currentInstanceId })
    })
    document.getElementById('instanceFormCancel').addEventListener('click', closeInstanceForm)
    document.getElementById('instanceFormSave').addEventListener('click', saveInstanceForm)
    el.instanceFormName.addEventListener('input', () => {
      if (formHomeAuto) el.instanceFormHome.value = autoHomeFor(el.instanceFormName.value)
    })
    el.instanceFormHome.addEventListener('input', () => {
      formHomeAuto = el.instanceFormHome.value === autoHomeFor(el.instanceFormName.value)
    })
    el.instanceModal.addEventListener('click', (e) => {
      if (e.target.id === 'instanceModal') closeInstanceForm()
    })
    el.updateBtn.addEventListener('click', () => {
      el.updateBtn.disabled = true
      vscode.postMessage({ command: 'updateDsh' })
    })
    document.getElementById('dsOpenBtn').addEventListener('click', () => vscode.postMessage({ command: 'openStatus' }))
    const dsToggle = document.getElementById('dsToggle')
    const dsBody = document.getElementById('dsBody')
    const setDsOpen = (open) => {
      dsToggle.setAttribute('aria-expanded', String(open))
      dsBody.hidden = !open
    }
    dsToggle.addEventListener('click', () => setDsOpen(dsBody.hidden))
    setDsOpen(false)
    document.getElementById('settingsBtn').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }))
    document.getElementById('clearConsoleBtn').addEventListener('click', () => vscode.postMessage({ command: 'clearConsole' }))
    el.debugToggle.addEventListener('click', () => vscode.postMessage({ command: 'toggleDebug' }))
    const browserSelectBtn = document.getElementById('browserSelectBtn')
    const browserSelectMenu = document.getElementById('browserSelectMenu')
    const browserSelectLabel = document.getElementById('browserSelectLabel')
    const browserOptions = Array.from(browserSelectMenu.querySelectorAll('.lap-select-option'))
    function setBrowserUI(value) {
      const v = value === 'external' ? 'external' : DEFAULT_BROWSER
      browserSelectLabel.textContent = v === 'external' ? 'External' : 'Built-in'
      browserOptions.forEach((o) => o.setAttribute('aria-selected', String(o.dataset.value === v)))
    }
    function setBrowserMenuOpen(open) {
      browserSelectMenu.hidden = !open
      browserSelectBtn.setAttribute('aria-expanded', String(open))
    }
    browserSelectBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      setBrowserMenuOpen(browserSelectMenu.hidden)
    })
    browserOptions.forEach((o) => {
      o.addEventListener('click', () => {
        setBrowserUI(o.dataset.value)
        setBrowserMenuOpen(false)
        browserSelectBtn.focus()
        vscode.postMessage({ command: 'setBrowser', value: o.dataset.value })
      })
    })
    document.addEventListener('click', (e) => {
      if (!browserSelectMenu.hidden && !e.target.closest('.lap-select')) setBrowserMenuOpen(false)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.instanceModal.hidden) closeInstanceForm()
      if (e.key === 'Escape' && !browserSelectMenu.hidden) {
        setBrowserMenuOpen(false)
        return
      }
      if (e.key === 'Tab' && !browserSelectMenu.hidden) setBrowserMenuOpen(false)
      if (browserSelectMenu.hidden) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      e.preventDefault()
      let idx = browserOptions.findIndex((o) => o === document.activeElement)
      if (idx === -1) idx = browserOptions.findIndex((o) => o.getAttribute('aria-selected') === 'true')
      if (idx === -1) idx = 0
      const next = e.key === 'ArrowDown' ? (idx + 1) % browserOptions.length
        : e.key === 'ArrowUp' ? (idx - 1 + browserOptions.length) % browserOptions.length
        : e.key === 'Home' ? 0
        : browserOptions.length - 1
      browserOptions[next].focus()
    })
    modeOptions.forEach((b) => {
      b.addEventListener('click', () => {
        // No optimistic highlight: the next status update confirms the mode.
        vscode.postMessage({ command: 'setMode', value: b.dataset.mode })
      })
    })
    document.querySelectorAll('.runtime-path, .runtime-data').forEach((node) => {
      node.addEventListener('click', () => {
        const full = node.dataset.path || node.getAttribute('title')
        if (!full) return
        if (node.dataset.log) vscode.postMessage({ command: 'openLog', value: full })
        else vscode.postMessage({ command: 'revealPath', value: full })
      })
    })

    el.refreshBtn.addEventListener('click', () => {
      el.refreshBtn.disabled = true
      el.refreshBtn.classList.add('spinning')
      vscode.postMessage({ command: 'refreshRequirements' })
    })
    let refreshingBalance = false
    el.balanceBtn.addEventListener('click', () => {
      refreshingBalance = true
      el.balanceBtn.disabled = true
      el.balanceValue.textContent = 'querying…'
      vscode.postMessage({ command: 'balance' })
    })

    let since = 0
    let elapsedTimer = undefined
    function stopElapsed() {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = undefined }
    }
    function startElapsed() {
      if (elapsedTimer) return false
      since = Date.now()
      elapsedTimer = setInterval(() => {
        el.statusSub.textContent = 'Waited ' + Math.round((Date.now() - since) / 1000) + 's'
      }, ELAPSED_INTERVAL_MS)
      return true
    }

    function renderLog(entries) {
      const list = Array.isArray(entries) ? entries : []
      const newline = String.fromCharCode(10)
      const text = list.map((e) => e.text).join(newline)
      const hasNew = lastActivityText !== text
      lastActivityText = text
      let html = list.map((e) => {
        const txt = esc(e.text)
        if (!e.busy) return txt
        const close = txt.indexOf('] ')
        return close === -1 ? txt : txt.slice(0, close + 2) + SPINNER_SVG + txt.slice(close + 3)
      }).join(newline) || '(no activity yet)'
      // Compare rendered HTML, not just text: busy flags can flip without a text change.
      if (html === lastLogHtml) return
      lastLogHtml = html
      el.log.innerHTML = html
      if (hasNew) el.log.scrollTop = el.log.scrollHeight
    }

    window.addEventListener('message', (e) => {
      const m = e.data
      if (!m) return
      if (m.type === 'instanceForm') { openInstanceForm(m.form); return }
      if (m.type === 'instanceFormError') {
        el.instanceFormError.textContent = m.message || 'Instance was not saved'
        el.instanceFormSave.disabled = false
        return
      }
      if (m.type === 'instanceFormSaved') { closeInstanceForm(); return }
      if (m.type !== 'update') {
        // Surface protocol drift in the webview console instead of dropping it.
        console.debug('[dsh] ignored unknown panel message type: ' + String(m.type))
        return
      }
      gotUpdate = true
      el.loadingOverlay.classList.add('hidden')
      if (refreshingBalance) {
        refreshingBalance = false
        el.balanceBtn.disabled = false
      }
      setBrowserUI(m.browser || DEFAULT_BROWSER)
      instanceList = Array.isArray(m.instances) ? m.instances : []
      currentInstanceId = typeof m.activeId === 'string' ? m.activeId : ''
      renderLog(m.activity)
      document.getElementById('dsCard').style.display = m.showDs === false ? 'none' : ''
      renderRunning(m.status)
      renderTabs(instanceList, currentInstanceId)
      renderInstanceSummary(instanceList)
      renderIssues(m.issues)
      renderInstanceMeta(m.active)
      renderRuntime(m.status)
      renderLogFiles(m.status)
      renderDebug(m.status)
      renderDs(m.dsStatus)
      renderBalance(m.balance)
      renderPricing(m.pricing)
    })`
}
