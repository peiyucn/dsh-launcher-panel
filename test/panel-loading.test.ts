import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_CSS } from '../src/webview/panel-styles.ts'
import { panelScript } from '../src/webview/panel-script.ts'
import { panelBody } from '../src/webview/panel-body.ts'

/**
 * 面板 loading 指示器与 **dsh 官方 `StateDot`** 的外观契约。
 *
 * ## 为什么有这条测试
 *
 * 面板的 loading 是**手抄官方几何**的（它不能 import 官方组件：本扩展零运行时依赖、
 * 而且那是 VS Code webview，不是 DSH 客户端）。手抄的东西必然会漂 —— 实际就漂过一次：
 * 这里原本画的是官方**更老的**「点阵」（`StateDot` 的 matrix 分支，8 个 2px 方块追逐），
 * 而官方早在 `4937343a5e feat(web): unify the client visual language`（先于 `0.1.7-rc.1`）
 * 就把 `ongoing` 换成了 **SVG 圆弧 spinner**。owner 报的正是这类「官方改了、我们没跟进」。
 *
 * 于是把官方的**几何 / 时长 / 减动效兜底**逐条钉在这里（真值取自
 * `dsh-v0.2.0-rc.2:packages/client/ui-primitives/src/StateDot.module.css`）：
 * 整圈 1.5s 匀速旋转 + arc 的 `stroke-dasharray` 呼吸，两者同相；track 25% 不透明；
 * 减动效时停在静态弧（18 150 / -3）。
 *
 * ⚠️ 官方哪天再改这几个数，这里**会红**——那是**有意的**：红了就说明该人工去看一眼
 * 新版长什么样，而不是让面板悄悄留在旧形态上。
 */

/** 取某条规则体（按行首锚定选择器，避开 `.state-spinner-track, .state-spinner-arc` 那条合并规则）。 */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{([^}]*)\\}`, 'u')
  const m = re.exec(css)
  assert.ok(m, `PANEL_CSS 里找不到 "${selector}" 规则`)
  return m[1]
}

/** 取某个 @keyframes 的完整块（花括号配对）。 */
function keyframesBody(css: string, name: string): string {
  const at = css.indexOf(`@keyframes ${name}`)
  assert.ok(at >= 0, `PANEL_CSS 里找不到 @keyframes ${name}`)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  assert.fail(`@keyframes ${name} 的花括号不配对`)
}

const script = panelScript({ peakWindows: '[]', defaultBrowser: 'internal' })
const body = panelBody({ version: '0.0.0-test' })

test('面板指示器与官方 StateDot 同形：圆弧 spinner，不再是点阵', () => {
  // 旧形态（官方更老的 matrix 分支）必须彻底消失，否则「统一」只是嘴上说。
  for (const [what, text] of [['PANEL_CSS', PANEL_CSS], ['panel-script', script], ['panel-body', body]] as const) {
    assert.ok(!/dot-matrix|DOT_MATRIX|lap-dot-chase|loadingMatrix/u.test(text), `${what} 里仍有旧的官方点阵实现`)
    assert.ok(!/matrix-size/u.test(text), `${what} 里仍有 --matrix-size（点阵尺寸变量）`)
  }
})

test('脚本把官方几何的 SVG 注入 spinner 挂载点', () => {
  assert.match(script, /getElementById\('loadingSpinner'\)\.innerHTML = SPINNER_SVG/u, '注入目标应为 loadingSpinner')
  // 官方 StateDot 的 ongoing 分支：24 视图里的 9.5 半径圆、一根 track + 一根 arc，整体同相。
  assert.match(script, /viewBox="0 0 24 24"/u, '用官方的 24 viewBox')
  assert.equal((script.match(/r="9\.5"/gu) ?? []).length, 2, 'track 与 arc 两根 9.5 半径圆')
  assert.match(script, /class="state-spinner-motion"/u, '旋转组')
  assert.match(script, /class="state-spinner-track"/u, '底色整圈')
  assert.match(script, /class="state-spinner-arc"/u, '呼吸弧')
})

test('body 的挂载点与脚本一致（id 对不上就等于没有 loading）', () => {
  assert.match(body, /class="loading-spinner" id="loadingSpinner"/u, 'body 里的挂载点要与脚本查询的 id/class 一致')
})

test('PANEL_CSS 逐条复刻官方 StateDot 的几何与时序', () => {
  const track = ruleBody(PANEL_CSS, '.state-spinner-track')
  const arc = ruleBody(PANEL_CSS, '.state-spinner-arc')
  const both = ruleBody(PANEL_CSS, '.state-spinner-track, .state-spinner-arc')

  assert.match(arc, /stroke-dasharray:\s*12 150/u, 'arc 静止态 dasharray = 12 150')
  assert.match(arc, /animation:\s*lap-spinner-dash 1\.5s ease-in-out infinite/u, 'arc 呼吸 1.5s ease-in-out')
  assert.match(both, /fill:\s*none/u, '官方两根圆都是 fill:none')
  assert.match(both, /stroke:\s*currentColor/u, '取 currentColor（配色交给容器 token）')
  assert.match(both, /stroke-width:\s*2/u, '描边宽 2')
  assert.match(both, /stroke-linecap:\s*round/u, '圆头线帽')
  assert.match(track, /opacity:\s*\.25/u, '整圈 25% 不透明')

  const spin = ruleBody(PANEL_CSS, '.state-spinner-motion')
  assert.match(spin, /transform-origin:\s*center/u, '绕圆心旋转')
  assert.match(spin, /animation:\s*lap-spinner-spin 1\.5s linear infinite/u, '整圈 1.5s 匀速（与呼吸同周期 ⇒ 同相）')

  const spinKf = keyframesBody(PANEL_CSS, 'lap-spinner-spin')
  assert.match(spinKf, /to\s*\{\s*transform:\s*rotate\(360deg\)/u, '整圈转到 360 度')

  const dashKf = keyframesBody(PANEL_CSS, 'lap-spinner-dash')
  assert.match(dashKf, /0%\s*\{\s*stroke-dasharray:\s*12 150;\s*stroke-dashoffset:\s*0/u, '起点 12 150 / 0')
  assert.match(dashKf, /50%\s*\{\s*stroke-dasharray:\s*24 150;\s*stroke-dashoffset:\s*-6/u, '中点 24 150 / -6')
  assert.match(dashKf, /100%\s*\{\s*stroke-dasharray:\s*12 150;\s*stroke-dashoffset:\s*0/u, '回起点（闭环）')
})

test('减少动态偏好：停在静态弧（与官方一致，不再旋转）', () => {
  const at = PANEL_CSS.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(at >= 0, '必须有 prefers-reduced-motion 兜底')
  const block = PANEL_CSS.slice(at, at + 400)
  assert.match(block, /\.state-spinner-motion,\s*\.state-spinner-arc\s*\{\s*animation:\s*none/u, '旋转与呼吸都停')
  assert.match(block, /stroke-dasharray:\s*18 150;\s*stroke-dashoffset:\s*-3/u, '静止形态 = 官方那组 18 150 / -3')
})

test('大 loader 用官方非 inline 档的 28px，状态行用小档', () => {
  const overlay = ruleBody(PANEL_CSS, '.loading-spinner')
  assert.match(overlay, /--spinner-size:\s*28px/u, '整页 loading 的 spinner 尺寸 = 官方 LoadingIndicator 非 inline 档 28')
  const dot = ruleBody(PANEL_CSS, '.dot.matrix')
  assert.match(dot, /width:\s*14px;\s*height:\s*14px/u, '状态行的 spinner 槽位 = 官方 StateDot ongoing 默认 14')
})
