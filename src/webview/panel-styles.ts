/**
 * Dashboard CSS.
 *
 * Extracted verbatim from the webview template so the panel's markup, styling,
 * and client script can be read and reviewed separately. It is a TS module (not
 * a .css asset) because the extension ships compiled output only: a string
 * constant needs no asset-copy step and cannot go missing from the VSIX.
 *
 * Brand colours mirror dsh's own design-platform palette; light/dark follow the
 * VS Code theme classes, which is why this is one string rather than two files.
 *
 * @module webview/panel-styles
 */

export const PANEL_CSS = `
  html, body { height: 100%; }
  /* 滚动条等原生渲染跟随主题的关键声明。 */
  body {
    color-scheme: light;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    padding: 10px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-sizing: border-box;
    overflow-y: auto;
    /* 官方 dsh 静态色板（design-platform.css）关键值；明暗主题跟随 VS Code 主题类。 */
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
    /* dsh 官方 ongoing 点阵色（design-platform.css 静态色板 deepseek-450；明暗主题同值）。 */
    --lap-ongoing: #5686FE;
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
  /* 卡片：官方 rowCard 同款（0.5px hairline l4 + r16）。 */
  .card { border: 0.5px solid var(--lap-border); border-radius: 16px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .status { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--lap-danger); flex: none; }
  .dot.running { background: var(--lap-success); box-shadow: 0 0 0 3px var(--lap-success-bg); }
  /* dsh 官方 ongoing 指示器（ui-primitives StateDot 的 ongoing 分支）：SVG 圆弧 spinner。
     几何 / 时长 / 减动效兜底逐字照 StateDot.module.css —— 整圈 1.5s 匀速旋转，arc 的
     stroke-dasharray 同步呼吸（两者同相）；--spinner-size 决定渲染尺寸，默认取官方
     StateDot 的 ongoing 默认值 14px。配色用面板自己的 --lap-ongoing。
     ⚠️ 这里以前画的是官方的「点阵」（更老的 StateDot matrix），官方早已改成圆弧 spinner。 */
  .dot.matrix { background: none; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; }
  .state-spinner { display: inline-block; width: var(--spinner-size, 14px); height: var(--spinner-size, 14px); color: var(--lap-ongoing); flex: none; vertical-align: -1.5px; }
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
  /* 减少动态偏好：停在弧的静态形态（与官方一致，不再旋转/呼吸）。 */
  @media (prefers-reduced-motion: reduce) {
    .state-spinner-motion, .state-spinner-arc { animation: none; }
    .state-spinner-arc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
  }
  .status-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .status-main { font-weight: 600; }
  .status-sub { color: var(--lap-fg2); font-size: 11px; word-break: break-all; }
  .mode-toggle { display: flex; flex-direction: row; margin-left: auto; background: var(--lap-track); border: 0.5px solid var(--lap-border-soft); border-radius: 14px; padding: 2px; gap: 2px; flex: none; }
  /* 模式切换：普通药丸按钮（选中 = 主色实心 + 白字）。药丸半径取高的一半（22/2 = 11），
     与面板里 h28 + r14 的胶囊同一套比例；不再是圆形图标钮。 */
  .mode-option { display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 11px; height: 22px; min-width: 38px; padding: 0 9px; background: transparent; color: var(--lap-fg2); cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; transition: background .12s, color .12s, border-color .12s; }
  .mode-option:hover { background: var(--lap-hover); color: var(--lap-fg); }
  .mode-option.active { background: var(--lap-accent); color: #fff; }
  .mode-option:focus-visible { outline: 2px solid var(--lap-accent); outline-offset: 1px; }
  .runtime-section { border-top: 0.5px solid var(--lap-border-soft); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .runtime-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .runtime-label { flex: none; width: 52px; color: var(--lap-fg2); font-size: 10px; opacity: .65; }
  .runtime-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--lap-fg); }
  .runtime-path, .runtime-data { font-size: 11px; color: var(--lap-fg2); word-break: break-all; font-family: var(--vscode-editor-font-family); min-width: 0; cursor: pointer; }
  .runtime-path:hover, .runtime-data:hover { color: var(--lap-accent); text-decoration: underline; }
  .buttons { display: flex; gap: 8px; }
  /* 按钮：官方 Button 几何（h28 + r14 胶囊 + 超椭圆；无支持时退普通圆角）。 */
  button { height: 28px; border: none; border-radius: 14px; padding: 0 12px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; transition: background .12s, border-color .12s, color .12s; }
  button.primary { background: var(--lap-accent); color: #fff; flex: 1; }
  button.primary:hover { background: var(--lap-accent-hover); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary:disabled:hover { background: var(--lap-accent); }
  button.secondary { background: transparent; color: var(--lap-fg); border: 0.5px solid var(--lap-border-soft); }
  button.secondary:hover { background: var(--lap-hover); }
  button.danger:hover { border-color: var(--lap-danger); color: var(--lap-danger); background: var(--lap-danger-bg); }
  .console { height: 200px; margin: 0; padding: 8px; background: var(--lap-surface); border: 0.5px solid var(--lap-border); border-radius: 12px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: var(--lap-fg2); font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .log-files { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
  .log-file-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .log-size { color: var(--lap-fg2); font-size: 10px; opacity: .65; flex: none; }
  .console-header { display: flex; align-items: center; gap: 6px; }
  .console-title { font-weight: 600; font-size: 11px; }
  /* debug 状态药丸：文字在按钮内，on = 绿色点亮（owner 拍板恢复原方式）。 */
  .debug-pill { border: 0.5px solid var(--lap-border-soft); border-radius: 8px; padding: 0 8px; font-size: 10px; font-weight: 600; line-height: 18px; cursor: pointer; background: transparent; color: var(--lap-fg2); flex: none; font-family: inherit; height: auto; margin-left: auto; }
  .debug-pill.on { color: var(--lap-success); border-color: var(--lap-success-bg); background: var(--lap-success-bg); }
  .console-header .mini-btn { flex: none; }
  .icon-btn { background: transparent; border: none; border-radius: 8px; color: var(--lap-fg); cursor: pointer; padding: 2px 6px; font-size: 12px; flex: none; height: auto; }
  .icon-btn:hover { color: var(--lap-accent); }
  .icon-btn.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; background: var(--lap-bg); z-index: 10; transition: opacity .2s ease; }
  .loading-overlay.hidden { opacity: 0; pointer-events: none; }
  .loading-spinner { --spinner-size: 28px; }
  .loading-text { color: var(--lap-fg2); font-size: 12px; }
  .mini-btn { background: transparent; border: 0.5px solid var(--lap-border-soft); border-radius: 8px; color: var(--lap-fg); cursor: pointer; padding: 0 8px; font-size: 10px; font-weight: 500; flex: none; height: 22px; }
  .mini-btn:hover { background: var(--lap-hover); }
  .ds-header { display: flex; align-items: center; gap: 6px; }
  .ds-title { font-weight: 600; }
  .ds-open { background: transparent; border: none; color: var(--lap-accent); cursor: pointer; padding: 0; font-size: 11px; flex: none; text-decoration: none; margin-left: auto; height: auto; }
  .ds-open:hover { text-decoration: underline; }
  .ds-pricing { flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px; line-height: 16px; }
  .ds-pricing.peak { color: var(--lap-danger); background: var(--lap-danger-bg); }
  .ds-pricing.offpeak { color: var(--lap-success); background: var(--lap-success-bg); }
  .ds-components { display: flex; flex-direction: column; gap: 4px; }
  .ds-comp { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .ds-comp-name { flex: 1; min-width: 0; color: var(--lap-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cdot { width: 8px; height: 8px; margin: 0 4px; border-radius: 50%; background: #888; flex: none; }
  .cdot.ok { background: var(--lap-success); }
  .cdot.degraded { background: var(--lap-warning); }
  .cdot.down { background: var(--lap-danger); }
  .cdot.maintenance { background: var(--lap-info); }
  .ds-incidents { display: flex; flex-direction: column; gap: 3px; }
  .ds-incident { font-size: 11px; color: var(--lap-danger); word-break: break-all; }
  .ds-empty { font-size: 11px; color: var(--lap-fg2); }
  .balance-row { border-top: 0.5px solid var(--lap-border-soft); padding-top: 6px; margin-top: 2px; display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .balance-value { color: var(--lap-fg); }
  .footer { border-top: 0.5px solid var(--lap-border-soft); padding-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--lap-fg2); }
  .lap-select-title { padding: 8px 10px; font-size: 12px; line-height: 16px; color: var(--lap-fg2); }
  /* 自绘下拉：触发器 + 向上展开的菜单（官方菜单样式）。 */
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
  .balance-btn:hover { background: var(--lap-hover); }
  .balance-btn:disabled { opacity: .6; cursor: progress; }
  /* 官方全局规则的同款曲率：非圆角形状一律走 superellipse(1.5)（不支持的引擎退普通圆角）。 */
  @supports (corner-shape: superellipse(1.5)) {
    button, .mini-btn, .icon-btn, .balance-btn, .ds-open, .card, .console, .mode-toggle, .lap-select-menu { corner-shape: superellipse(1.5); }
  }
  .version-row { display: flex; justify-content: flex-end; gap: 8px; }
  .plugin-version { font-size: 10px; color: var(--lap-fg2); opacity: .65; }`
