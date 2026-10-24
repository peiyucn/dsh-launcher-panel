/**
 * Dashboard markup (the webview body).
 *
 * Extracted verbatim from the webview template. One value is substituted: the
 * extension version shown in the footer. Element ids here are the contract with
 * {@link panelScript}, so the two belong together even though they are separate
 * files.
 *
 * @module webview/panel-body
 */

export interface PanelBodyValues {
  /** Extension version shown in the footer line. */
  version: string
}

/** The dashboard body markup, with the footer version filled in. */
export function panelBody(values: PanelBodyValues): string {
  return `  <div class="loading-overlay" id="loadingOverlay" role="status" aria-label="Loading…">
    <div class="loading-spinner" id="loadingSpinner"></div>
  </div>
  <div class="card">
    <div class="instance-tabs" id="instanceTabs" role="tablist" aria-label="DSH instances"></div>
    <div class="status">
      <span class="dot" id="dot"></span>
      <div class="status-text">
        <span class="status-main" id="statusText">Checking…</span>
        <span class="status-sub" id="statusSub"></span>
      </div>
      <div class="status-actions">
        <span class="status-sep" aria-hidden="true"></span>
        <button class="icon-btn" id="editInstanceBtn" title="Edit this instance's name, home, profile and browser settings" aria-label="Edit instance">✎</button>
        <button class="icon-btn" id="deleteInstanceBtn" title="Remove this instance from the launcher; DSH data is kept" aria-label="Delete instance">🗑</button>
      </div>
    </div>
    <div class="instance-meta">
      <div class="runtime-row">
        <span class="runtime-label">home</span>
        <span class="runtime-value runtime-data" id="instanceHome">—</span>
      </div>
      <div class="runtime-row">
        <span class="runtime-label">profile</span>
        <span class="runtime-value runtime-data" id="instanceProfile">—</span>
      </div>
      <div class="runtime-row">
        <span class="runtime-label" id="runtimeLabel">package</span>
        <span class="runtime-path" id="runtimePath"></span>
      </div>
    </div>
    <div class="instance-error" id="instanceError"></div>
  </div>
  <div class="buttons">
    <button id="startBtn" data-cmd="start" class="primary" title="Start dsh and open the browser (or open a new tab when already running)">▶ Start</button>
    <button data-cmd="stop" class="secondary danger when-running" title="Stop the local dsh server">■ Stop</button>
  </div>
  <div class="card shared-card" title="Shared by every instance: one dsh install, one run mode">
    <div class="shared-header">
      <span class="shared-title">Shared runtime</span>
      <div class="mode-toggle" id="modeToggle" role="group" aria-label="dsh run mode" title="Global run mode: all instances share one dsh tree; stop all instances before switching.">
        <button class="mode-option" data-mode="pnpm" aria-pressed="true" title="Install & run the published dsh via pnpm">pkg</button>
        <button class="mode-option" data-mode="source" aria-pressed="false" title="Clone & run the deepseek-harness source">src</button>
      </div>
    </div>
    <div class="shared-row">
      <span class="runtime-label">dsh</span>
      <span class="runtime-value" id="dshVersion" title="Shared dsh install used by every instance">—</span>
      <button class="mini-btn" id="updateBtn" title="Update the shared dsh" style="display:none">Update</button>
      <button class="icon-btn" id="refreshBtn" title="Check for shared dsh updates">⟳</button>
    </div>
  </div>
  <div class="card" id="dsCard">
    <div class="ds-header">
      <span class="ds-title">DeepSeek API Status</span>
      <span class="ds-pricing" id="dsPricing" title=""></span>
      <button class="ds-open" id="dsOpenBtn" title="status.deepseek.com (official DeepSeek status)">↗</button>
    </div>
    <div class="ds-components" id="dsComponents"></div>
    <div class="ds-incidents" id="dsIncidents"></div>
    <div class="ds-balance-row">
      <span class="ds-balance-label">Account</span>
      <span class="balance-value" id="balanceValue"></span>
      <button class="balance-btn" id="balanceBtn" title="Query this instance's DeepSeek account balance">Balance</button>
    </div>
  </div>
  <div class="console-header">
    <span class="console-title">Console</span>
    <button class="mini-btn" id="clearConsoleBtn" title="Clear console log">Clear</button>
    <button class="debug-pill" id="debugToggle" title="Toggle NODE_DEBUG=module in source mode">debug off</button>
  </div>
  <pre class="console" id="log"></pre>
  <div class="log-files">
    <div class="log-file-row">
      <span class="runtime-path" id="launcherLogPath" data-log="1"></span>
      <span class="log-size" id="launcherLogSize"></span>
    </div>
    <div class="log-file-row">
      <span class="runtime-path" id="serverLogPath" data-log="1"></span>
      <span class="log-size" id="serverLogSize"></span>
    </div>
  </div>
  <div class="footer">
    <button class="icon-btn" id="settingsBtn" title="Open the global extension settings">⚙ Global Settings</button>
    <div class="lap-select">
      <button type="button" class="lap-select-trigger" id="browserSelectBtn" aria-haspopup="listbox" aria-expanded="false" title="Browser">
        <span class="lap-select-label" id="browserSelectLabel">Built-in</span>
        <svg class="lap-select-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="lap-select-menu" id="browserSelectMenu" role="listbox" hidden>
        <div class="lap-select-title" role="presentation">Browser</div>
        <button type="button" class="lap-select-option" data-value="built-in" role="option" aria-selected="true">Built-in<svg class="lap-select-check" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" class="lap-select-option" data-value="external" role="option" aria-selected="false">External<svg class="lap-select-check" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
  </div>
  <div class="version-row">
    <span class="version-spacer"></span>
    <span class="plugin-version" id="nodeVersionFooter">node —</span>
    <span class="plugin-version">·</span>
    <span class="plugin-version" id="pluginVersion">dsh-launcher-panel v${values.version}</span>
  </div>
  <div class="instance-modal" id="instanceModal" hidden>
    <div class="instance-modal-card" role="dialog" aria-modal="true" aria-labelledby="instanceModalTitle">
      <div class="instance-modal-title" id="instanceModalTitle">New instance</div>
      <label class="instance-field">Name
        <input id="instanceFormName" autocomplete="off">
      </label>
      <label class="instance-field">DSH_HOME
        <input id="instanceFormHome" autocomplete="off">
      </label>
      <label class="instance-field">Profile
        <input id="instanceFormProfile" autocomplete="off">
      </label>
      <label class="instance-field">Auto-open
        <select id="instanceFormAuto">
          <option value="global">Use global default</option>
          <option value="true">Always auto-open</option>
          <option value="false">Never auto-open</option>
        </select>
      </label>
      <label class="instance-field">Browser
        <select id="instanceFormBrowser">
          <option value="global">Use global default</option>
          <option value="built-in">Built-in</option>
          <option value="external">External</option>
        </select>
      </label>
      <div class="instance-modal-error" id="instanceFormError"></div>
      <div class="instance-modal-actions">
        <button type="button" class="mini-btn" id="instanceFormCancel">Cancel</button>
        <button type="button" class="mini-btn primary" id="instanceFormSave">Create</button>
      </div>
    </div>
  </div>`
}
