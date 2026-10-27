/**
 * Dashboard CSS, kept as a string so the extension ships no asset files.
 * Colours mirror dsh's design-platform palette; light/dark follow the VS Code
 * theme class on `body`.
 *
 * @module webview/panel-styles
 */

export const PANEL_CSS = `
  html, body { height: 100%; }
  body {
    color-scheme: light;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    padding: 8px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    overflow: hidden;
    /* Official dsh palette; dark values below override the same tokens. */
    --lap-bg: #FFFFFF;
    --lap-fg: #0F1115;
    --lap-fg2: #61666B;
    --lap-border: rgba(15, 17, 21, 0.16);
    --lap-border-soft: rgba(15, 17, 21, 0.12);
    --lap-hover: rgba(15, 17, 21, 0.06);
    --lap-surface: #F6F7F9;
    --lap-menu: #FFFFFF;
    --lap-menu-hover: rgba(38, 49, 72, 0.06);
    --lap-track: #F6F7F9;
    --lap-accent: #4176E6;
    --lap-accent-hover: #679EFE;
    --lap-danger: #EC1313;
    --lap-danger-bg: rgba(236, 19, 19, 0.10);
    --lap-success: #22C55E;
    --lap-success-bg: rgba(34, 197, 94, 0.12);
    --lap-warning: #F59E0B;
    --lap-info: #316DCA;
    background: var(--lap-bg);
    color: var(--lap-fg);
  }
  body.vscode-dark {
    color-scheme: dark;
    --lap-bg: #1B1B1C;
    --lap-fg: #F5F6F7;
    --lap-fg2: #81868C;
    --lap-border: rgba(255, 255, 255, 0.20);
    --lap-border-soft: rgba(255, 255, 255, 0.16);
    --lap-hover: rgba(255, 255, 255, 0.08);
    --lap-surface: #151517;
    --lap-menu: #353638;
    --lap-menu-hover: rgba(255, 255, 255, 0.08);
    --lap-track: #232324;
    --lap-accent: #679EFE;
    --lap-accent-hover: #4176E6;
    --lap-danger: #F24242;
    --lap-danger-bg: rgba(242, 66, 66, 0.12);
    --lap-success: #22C55E;
    --lap-success-bg: rgba(34, 197, 94, 0.16);
    --lap-warning: #F59E0B;
    --lap-info: #4D8BFE;
  }
  .section { flex: 0 0 auto; border: 0.5px solid var(--lap-border); border-radius: 14px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .section-head { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .section-title { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--lap-fg); line-height: 16px; }
  .section-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .section-head > .mode-toggle { margin-left: auto; }
  .section-toggle { width: 100%; height: auto; padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .section-toggle:hover .section-title { color: var(--lap-accent); }
  .section-chevron { margin-left: auto; color: var(--lap-fg2); font-size: 10px; transition: transform .12s; }
  .section-toggle[aria-expanded='true'] .section-chevron { transform: rotate(90deg); }
  .ds-body { display: flex; flex-direction: column; gap: 6px; }
  .ds-body[hidden] { display: none; }
  .status { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--lap-danger); flex: none; }
  .dot.running { background: var(--lap-success); box-shadow: 0 0 0 3px var(--lap-success-bg); }
  .dot.stopped { background: var(--lap-fg2); opacity: .5; box-shadow: none; }
  /* Mirrors dsh's StateDot ongoing spinner (geometry and timing are copied). */
  .dot.matrix { background: none; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; }
  .state-spinner { display: inline-block; width: var(--spinner-size, 14px); height: var(--spinner-size, 14px); color: var(--lap-fg2); flex: none; vertical-align: -1.5px; }
  .state-spinner-motion { transform-origin: center; animation: lap-spinner-spin 1.5s linear infinite; }
  .state-spinner-track, .state-spinner-arc { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .state-spinner-track { opacity: .25; }
  .state-spinner-arc { stroke-dasharray: 12 150; animation: lap-spinner-dash 1.5s ease-in-out infinite; }
  @keyframes lap-spinner-spin { to { transform: rotate(360deg); } }
  @keyframes lap-spinner-dash {
    0% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
    50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; }
    100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .state-spinner-motion, .state-spinner-arc { animation: none; }
    .state-spinner-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
  }
  .status-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .status-main { font-size: 12px; font-weight: 600; }
  .status-sub { color: var(--lap-fg2); font-size: 10px; word-break: break-all; }
  .mode-toggle { display: flex; flex-direction: row; background: var(--lap-track); border: 0.5px solid var(--lap-border-soft); border-radius: 14px; padding: 2px; gap: 2px; flex: none; }
  .mode-option { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 11px; height: 22px; min-width: 38px; padding: 0 9px; background: transparent; color: var(--lap-fg2); cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; transition: background .12s, color .12s, border-color .12s; }
  .mode-option:hover { background: var(--lap-hover); color: var(--lap-fg); }
  .mode-option.active { background: var(--lap-accent); color: #fff; }
  .mode-option:focus-visible { outline: 2px solid var(--lap-accent); outline-offset: 1px; }
  .status-actions { display: flex; align-items: center; gap: 2px; flex: none; }
  .status-sep { width: 1px; height: 16px; background: var(--lap-border-soft); flex: none; margin: 0 3px; }
  .runtime-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .runtime-label { flex: none; width: 56px; color: var(--lap-fg2); font-size: 10px; }
  .runtime-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--lap-fg); }
  .runtime-version-row { flex-wrap: wrap; }
  .runtime-version-label { width: auto; }
  .runtime-path, .runtime-data { font-size: 10px; color: var(--lap-fg2); word-break: break-all; font-family: var(--vscode-editor-font-family); min-width: 0; cursor: pointer; }
  .runtime-path:hover, .runtime-data:hover { color: var(--lap-accent); text-decoration: underline; }
  .instance-buttons { display: flex; gap: 8px; margin-top: 2px; }
  button { height: 28px; border: none; border-radius: 14px; padding: 0 12px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; transition: background .12s, border-color .12s, color .12s; }
  button.primary { background: var(--lap-accent); color: #fff; flex: 1; }
  button.primary:hover { background: var(--lap-accent-hover); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary:disabled:hover { background: var(--lap-accent); }
  button.secondary { background: transparent; color: var(--lap-fg); border: 0.5px solid var(--lap-border-soft); }
  button.secondary:hover { background: var(--lap-hover); }
  button.danger:hover { border-color: var(--lap-danger); color: var(--lap-danger); background: var(--lap-danger-bg); }
  .console { flex: 1 1 auto; height: auto; min-height: 48px; max-height: none; margin: 0; padding: 8px; background: var(--lap-surface); border: 0.5px solid var(--lap-border); border-radius: 10px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: var(--lap-fg2); font-family: var(--vscode-editor-font-family); font-size: 11px; }
  #consoleSection { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .log-files { display: flex; flex-direction: column; gap: 3px; }
  .log-file-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .log-size { color: var(--lap-fg2); font-size: 10px; flex: none; }
  .debug-pill { border: 0.5px solid var(--lap-border-soft); border-radius: 8px; padding: 0 8px; font-size: 10px; font-weight: 500; line-height: 18px; cursor: pointer; background: transparent; color: var(--lap-fg2); flex: none; font-family: inherit; height: auto; }
  .debug-pill.on { color: var(--lap-success); border-color: var(--lap-success-bg); background: var(--lap-success-bg); }
  .icon-btn { background: transparent; border: none; border-radius: 8px; color: var(--lap-fg); cursor: pointer; padding: 2px 6px; font-size: 12px; flex: none; height: auto; }
  .icon-btn:hover { color: var(--lap-accent); }
  .icon-btn.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--lap-bg); z-index: 10; transition: opacity .2s ease; }
  .loading-overlay.hidden { opacity: 0; pointer-events: none; }
  .loading-spinner { --spinner-size: 28px; }
  .mini-btn { background: transparent; border: 0.5px solid var(--lap-border-soft); border-radius: 8px; color: var(--lap-fg); cursor: pointer; padding: 0 8px; font-size: 10px; font-weight: 500; flex: none; height: 22px; }
  .mini-btn:hover { background: var(--lap-hover); }
  .ds-open { background: transparent; border: none; color: var(--lap-accent); cursor: pointer; padding: 0; font-size: 11px; flex: none; text-decoration: none; margin-left: auto; height: auto; }
  .ds-open:hover { text-decoration: underline; }
  .ds-pricing { flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px; line-height: 16px; }
  .ds-pricing.peak { color: var(--lap-danger); background: var(--lap-danger-bg); }
  .ds-pricing.offpeak { color: var(--lap-success); background: var(--lap-success-bg); }
  .ds-columns { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; row-gap: 6px; align-items: start; }
  .ds-columns::after { content: ''; position: absolute; left: 50%; top: 2px; bottom: 2px; width: 0.5px; background: var(--lap-border-soft); }
  .ds-column { min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 0 2px; }
  .ds-column-title { font-size: 10px; color: var(--lap-fg2); }
  .ds-components { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
  .ds-comp { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 10px; color: var(--lap-fg); background: var(--lap-surface); border-radius: 999px; padding: 2px 7px; }
  .ds-comp-name { max-width: 140px; color: var(--lap-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ds-column .ds-comp-name { max-width: 100%; }
  .cdot { width: 6px; height: 6px; margin: 0; border-radius: 50%; background: #888; flex: none; }
  .cdot.ok { background: var(--lap-success); }
  .cdot.degraded { background: var(--lap-warning); }
  .cdot.down { background: var(--lap-danger); }
  .cdot.maintenance { background: var(--lap-info); }
  .ds-incidents { display: flex; flex-direction: column; gap: 3px; }
  .ds-incident { font-size: 10px; color: var(--lap-danger); word-break: break-all; }
  .ds-empty { font-size: 10px; color: var(--lap-fg2); }
  .ds-balance-row { border-top: 0.5px solid var(--lap-border-soft); padding-top: 5px; display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .ds-balance-label { color: var(--lap-fg2); font-size: 10px; }
  .balance-value { color: var(--lap-fg); font-size: 11px; margin-left: auto; text-align: right; word-break: break-all; }
  .ds-balance-row .ds-open { margin-left: 0; }
  .settings-area { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
  .settings-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .lap-select-title { padding: 8px 10px; font-size: 12px; line-height: 16px; color: var(--lap-fg2); }
  .lap-select { position: relative; flex: none; margin-left: auto; }
  .lap-select-trigger { display: inline-flex; align-items: center; justify-content: space-between; gap: 4px; box-sizing: border-box; width: 96px; height: 28px; padding: 0 8px 0 12px; border: 0.5px solid var(--lap-border-soft); border-radius: 14px; background: var(--lap-surface); color: var(--lap-fg); font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
  .lap-select-trigger:hover { background: var(--lap-hover); }
  .lap-select-trigger:focus-visible { outline: 2px solid var(--lap-accent); outline-offset: 1px; }
  .lap-select-chevron { color: var(--lap-fg2); flex: none; transition: transform 120ms ease; }
  .lap-select-trigger[aria-expanded="true"] .lap-select-chevron { transform: rotate(180deg); }
  .lap-select-menu { position: absolute; right: 0; bottom: calc(100% + 4px); z-index: 30; min-width: 218px; padding: 4px; display: flex; flex-direction: column; border: 0.5px solid var(--lap-border); border-radius: 20px; background: var(--lap-menu); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24); }
  .lap-select-menu[hidden] { display: none; }
  .lap-select-option { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 6px 10px; border: none; border-radius: 10px; background: transparent; color: var(--lap-fg); font-family: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; }
  .lap-select-option:hover { background: var(--lap-menu-hover); }
  .lap-select-check { margin-left: auto; width: 16px; height: 16px; flex: none; color: var(--lap-accent); visibility: hidden; }
  .lap-select-option[aria-selected='true'] .lap-select-check { visibility: visible; }
  .balance-btn { background: var(--lap-hover); color: var(--lap-fg); border: none; border-radius: 8px; padding: 0 8px; font-size: 11px; font-family: inherit; cursor: pointer; flex: none; height: 22px; }
  .balance-btn:disabled { opacity: .6; cursor: progress; }
  @supports (corner-shape: superellipse(1.5)) {
    button, .mini-btn, .icon-btn, .balance-btn, .ds-open, .section, .console, .mode-toggle, .lap-select-menu { corner-shape: superellipse(1.5); }
  }
  .version-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .version-spacer { flex: 1; min-width: 8px; }
  .plugin-version { font-size: 10px; color: var(--lap-fg2); }
  .instance-tabs { display: flex; align-items: center; gap: 2px; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scrollbar-width: thin; padding: 0 0 4px; margin: 0; border-bottom: 0.5px solid var(--lap-border-soft); }
  .instance-tab { display: inline-flex; align-items: center; gap: 5px; max-width: 150px; height: 24px; padding: 0 8px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: var(--lap-fg2); font-family: inherit; font-size: 11px; cursor: pointer; flex: 0 0 auto; position: relative; }
  .instance-tab:hover { background: var(--lap-hover); color: var(--lap-fg); }
  .instance-tab[aria-selected='true'] { background: var(--lap-surface); color: var(--lap-fg); font-weight: 600; }
  .instance-tab .tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .instance-tabs-empty { color: var(--lap-fg2); font-size: 11px; padding: 4px 6px; }
  .instance-summary { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lap-fg2); font-size: 10px; }
  .instance-issues { display: flex; flex-direction: column; gap: 2px; }
  .instance-issues:empty { display: none; }
  .instance-issue { font-size: 10px; line-height: 14px; word-break: break-word; color: var(--lap-fg2); }
  .instance-issue.warning { color: var(--lap-warning); }
  .instance-issue.error { color: var(--lap-danger); }
  .new-instance-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin-left: 4px; padding: 0; border-radius: 8px; font-size: 16px; line-height: 1; flex: none; }
  .new-instance-btn:hover { background: var(--lap-hover); }
  .instance-meta { border-top: 0.5px solid var(--lap-border-soft); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .instance-error { color: var(--lap-danger); font-size: 10px; min-height: 12px; }
  .instance-error:empty { display: none; }
  .instance-tab .dot { width: 7px; height: 7px; margin: 0; flex: none; }
  .instance-tab .dot.matrix { width: 10px; height: 10px; }
  .instance-tab .state-spinner { --spinner-size: 10px; }
  .instance-modal { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, .45); }
  .instance-modal[hidden] { display: none; }
  .instance-modal-card { width: 100%; max-width: 320px; max-height: 90vh; overflow-y: auto; box-sizing: border-box; padding: 12px; border: 0.5px solid var(--lap-border); border-radius: 12px; background: var(--lap-menu); color: var(--lap-fg); box-shadow: 0 8px 28px rgba(0, 0, 0, .35); }
  .instance-modal-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  .instance-field { display: flex; flex-direction: column; gap: 3px; margin: 0 0 8px; font-size: 10px; color: var(--lap-fg2); }
  .instance-field input, .instance-field select { height: 24px; box-sizing: border-box; border: 0.5px solid var(--lap-border-soft); border-radius: 6px; background: var(--lap-surface); color: var(--lap-fg); font-family: inherit; font-size: 11px; padding: 0 6px; }
  .instance-field input:focus, .instance-field select:focus { outline: 2px solid var(--lap-accent); outline-offset: 1px; }
  .instance-modal-error { color: var(--lap-danger); font-size: 10px; min-height: 12px; margin-bottom: 6px; word-break: break-word; }
  .instance-modal-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .instance-modal-actions .primary { color: #fff; background: var(--lap-accent); border-color: var(--lap-accent); }
  .instance-modal-actions .primary:hover { background: var(--lap-accent-hover); }`
