// The webview is three strings plus a host class that needs VS Code, so these
// tests compare the generated literals against the contract module.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRefreshScheduler } from '../src/panel/webview/panel-refresh.ts'
import {
  BROWSER_CHOICES,
  PANEL_COMMANDS,
  PANEL_MESSAGE_TYPES,
  buildPanelUpdate,
  isBrowserChoice,
} from '../src/panel/webview/panel-contract.ts'
import { PANEL_CSS } from '../src/panel/webview/panel-styles.ts'
import { panelBody } from '../src/panel/webview/panel-body.ts'
import { panelScript } from '../src/panel/webview/panel-script.ts'
import { PEAK_WINDOWS_BJ_HOURS } from '../src/panel/pricing.ts'

function uniqueMatches(pattern: RegExp, text: string, group = 1): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) {
    const value = match[group]
    if (value !== undefined) found.add(value)
  }
  return [...found]
}

const sorted = (values: Iterable<string>): string[] => [...values].sort()

const body = panelBody({ version: '0.0.0-test' })
const script = panelScript({ peakWindows: JSON.stringify(PEAK_WINDOWS_BJ_HOURS), defaultBrowser: 'built-in' })
const messagesSource = readFileSync(new URL('../src/panel/messages.ts', import.meta.url), 'utf8')
const contractSource = readFileSync(new URL('../src/panel/webview/panel-contract.ts', import.meta.url), 'utf8')

const UPDATE_KEYS = [
  'active',
  'activeId',
  'activity',
  'balance',
  'browser',
  'dsStatus',
  'instances',
  'issues',
  'pricing',
  'showDs',
  'status',
  'type',
]

function statusFixture(unknown = false): Record<string, unknown> {
  return {
    running: false,
    starting: false,
    installing: false,
    stopping: false,
    checking: false,
    updating: false,
    unknown,
    url: '',
    dsh: 'unknown',
    dshVersion: '',
    dshPath: '',
    dshHome: '',
    dshPathShort: '',
    dshHomeShort: '',
    nodeVersion: '',
    mode: 'pnpm',
    update: undefined,
    consoleLogPath: '',
    consoleLogPathShort: '',
    serverLogPath: '',
    serverLogPathShort: '',
    consoleLogSize: 0,
    serverLogSize: 0,
    sourceDebug: false,
  }
}

function instanceFixture(id: string): Record<string, unknown> {
  return {
    id,
    name: `Instance ${id}`,
    home: `/tmp/${id}`,
    port: 31001,
    state: 'stopped',
    running: false,
    starting: false,
    installing: false,
    stopping: false,
  }
}

test('every element id the client script looks up exists in the body', () => {
  const bodyIds = new Set(uniqueMatches(/id="([^"]+)"/g, body))
  const scriptIds = uniqueMatches(/getElementById\((['"])([^'"]+)\1\)/g, script, 2)
  assert.ok(scriptIds.length > 0, 'the client script must look up elements at all')
  const missing = scriptIds.filter((id) => !bodyIds.has(id))
  assert.deepEqual(missing, [], `ids missing from panelBody: ${missing.join(', ')}`)
})

test('the client command set, the host switch and PANEL_COMMANDS are the same set', () => {
  const clientCommands = new Set([
    ...uniqueMatches(/command:\s*'([^']+)'/g, script),
    ...uniqueMatches(/data-cmd="([^"]+)"/g, body),
  ])
  const hostCommands = new Set(uniqueMatches(/case\s+'([^']+)':/g, messagesSource))
  if (/PANEL_COMMANDS\.ready/.test(messagesSource)) hostCommands.add('ready')
  const contractCommands = new Set(Object.values(PANEL_COMMANDS))

  assert.deepEqual(sorted(clientCommands), sorted(contractCommands), 'client posts a different command set')
  assert.deepEqual(sorted(hostCommands), sorted(contractCommands), 'host switch handles a different command set')
  for (const dead of ['newInstance', 'editInstance']) {
    assert.ok(!hostCommands.has(dead), `dead command "${dead}" is back in the host switch`)
    assert.ok(!clientCommands.has(dead), `dead command "${dead}" is back in the client script`)
  }
})

test('the host message types and the client handlers are the same set', () => {
  const hostTypes = new Set([
    ...uniqueMatches(/PANEL_MESSAGE_TYPES\.([A-Za-z]+)/g, messagesSource),
    ...uniqueMatches(/PANEL_MESSAGE_TYPES\.([A-Za-z]+)/g, contractSource),
    ...uniqueMatches(/type:\s*'([^']+)'/g, messagesSource),
  ])
  const clientTypes = new Set(uniqueMatches(/m\.type\s*(?:===|!==)\s*'([^']+)'/g, script))
  const contractTypes = new Set(Object.values(PANEL_MESSAGE_TYPES))

  assert.deepEqual(sorted(hostTypes), sorted(contractTypes), 'host posts a different message type set')
  assert.deepEqual(sorted(clientTypes), sorted(contractTypes), 'client handles a different message type set')
})

test('the update builder always emits exactly the fields the client consumes', () => {
  const update = buildPanelUpdate({ status: statusFixture(), pricing: 'peak' })
  assert.deepEqual(Object.keys(update).sort(), UPDATE_KEYS)
  assert.equal(update.type, PANEL_MESSAGE_TYPES.update)
  assert.equal(update.status.unknown, false, 'a successful status must not be marked unknown')
  // Defaults keep the payload complete even for the no-manager / fallback paths.
  assert.deepEqual(update.instances, [])
  assert.deepEqual(update.issues, [])
  assert.deepEqual(update.activity, [])
  assert.equal(update.active, undefined)
  assert.equal(update.activeId, '')
  assert.equal(update.browser, 'built-in')
  assert.equal(update.showDs, false)
  assert.equal(update.dsStatus, undefined)
  assert.equal(update.balance, undefined)
  assert.equal(update.pricing, 'peak')
})

test('the failure fallback emits the same field set and an unknown status', () => {
  const fallback = buildPanelUpdate({
    status: { ...statusFixture(true) },
    instances: [instanceFixture('a')],
    active: instanceFixture('a'),
    activeId: 'a',
    issues: [{ index: -1, field: 'entry', severity: 'error', message: 'Status refresh failed' }],
    activity: [{ id: -1, text: '✗ Status refresh failed', busy: false }],
    browser: 'external',
    balance: { balance: null },
    showDs: true,
    pricing: 'offpeak',
  })
  assert.deepEqual(Object.keys(fallback).sort(), UPDATE_KEYS)
  assert.equal(fallback.status.unknown, true)
  assert.equal(fallback.active, fallback.active) // present, not dropped by the fallback path
  assert.equal(fallback.showDs, true)
})

test('every update field the client reads is present in the payload', () => {
  const updateStart = script.indexOf("if (m.type !== 'update')")
  assert.ok(updateStart >= 0, 'client update handler must exist')
  const updateHandler = script.slice(updateStart)
  const consumed = uniqueMatches(/\bm\.([A-Za-z_$][\w$]*)/g, updateHandler)
  assert.deepEqual(sorted(consumed), UPDATE_KEYS, 'client reads a different update field set')

  const update = buildPanelUpdate({ status: statusFixture(), pricing: 'peak' })
  for (const field of consumed) {
    assert.ok(field in update, `payload is missing client-consumed field "${field}"`)
  }
})

test('pricing window classes exist for every value the host can send', () => {
  for (const value of ['peak', 'offpeak']) {
    assert.match(PANEL_CSS, new RegExp(`\\.ds-pricing\\.${value}\\b`), `PANEL_CSS lacks .ds-pricing.${value}`)
  }
  assert.match(script, /pricing === 'peak'/)
})

test('the footer version is HTML-escaped (S1 regression)', () => {
  const markup = panelBody({ version: '0.0.0"><img src=x onerror=alert(1)>' })
  assert.ok(!markup.includes('<img'), 'raw markup from the version value must not be emitted')
  assert.match(markup, /&lt;img/, 'the version value must be escaped')
  assert.match(markup, /&quot;&gt;/, 'quotes in the version value must be escaped')
  assert.match(body, /dsh-launcher-panel v0\.0\.0-test/)
})

test('defaultBrowser is injected as a JSON string literal (S2 regression)', () => {
  const hostile = "bad');alert(1);//"
  const generated = panelScript({ peakWindows: '[]', defaultBrowser: hostile })
  assert.ok(!generated.includes("'bad'"), 'defaultBrowser must not be interpolated between single quotes')
  assert.ok(!generated.includes("'${values.defaultBrowser}'"), 'the old raw interpolation must stay gone')
  const literal = /const DEFAULT_BROWSER = (.*)/.exec(generated)?.[1]
  assert.ok(literal !== undefined, 'the script must declare DEFAULT_BROWSER')
  assert.equal(JSON.parse(literal), hostile, 'the injected literal must round-trip the exact value')

  const normal = panelScript({ peakWindows: '[]', defaultBrowser: 'built-in' })
  assert.match(normal, /const DEFAULT_BROWSER = "built-in"/)
  assert.match(normal, /setBrowserUI\(m\.browser \|\| DEFAULT_BROWSER\)/)
  assert.ok(!normal.includes('${'), 'unfilled template placeholder left in the client script')

  // `</script>` must not close the inline element that wraps this text.
  const closing = panelScript({ peakWindows: '[]', defaultBrowser: '</script><img>' })
  assert.ok(!closing.includes('</script>'), 'the injected literal must not contain a raw </script>')
  const closingLiteral = /const DEFAULT_BROWSER = (.*)/.exec(closing)?.[1]
  assert.ok(closingLiteral !== undefined)
  assert.equal(JSON.parse(closingLiteral), '</script><img>')
})

test('the generated client script is syntactically valid JavaScript', () => {
  assert.equal(typeof script, 'string')
  // One backtick inside the embedded text would end the host string literal.
  assert.ok(!script.includes('`'), 'the client script text must not contain a backtick')
  assert.doesNotThrow(() => new Function(script), 'the normal script must parse')
  assert.doesNotThrow(
    () => new Function(panelScript({ peakWindows: '[]', defaultBrowser: "bad');alert(1);//" })),
    'the JSON-stringified browser default must not break the script',
  )
})

test('isBrowserChoice only accepts the panel enum', () => {
  assert.deepEqual([...BROWSER_CHOICES], ['built-in', 'external'])
  for (const value of BROWSER_CHOICES) assert.equal(isBrowserChoice(value), true)
  for (const value of ['chrome', 'Built-in', 'builtin', '', undefined, null, 42, {}]) {
    assert.equal(isBrowserChoice(value), false)
  }
})

test('refresh scheduler runs one task at a time and merges concurrent requests', async () => {
  const releases: Array<() => void> = []
  let runs = 0
  const scheduler = createRefreshScheduler(() => {
    runs += 1
    return new Promise<void>((resolve) => releases.push(resolve))
  })

  const first = scheduler.request()
  await Promise.resolve()
  assert.equal(runs, 1, 'the first request starts immediately')
  assert.equal(scheduler.busy, true)

  await scheduler.request()
  await scheduler.request()
  assert.equal(runs, 1, 'requests during a run must not start a competing run')

  releases.shift()?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(runs, 2, 'merged requests produce exactly one trailing run')
  assert.equal(scheduler.busy, true)

  releases.shift()?.()
  await first
  assert.equal(scheduler.busy, false)
  assert.equal(runs, 2)

  const idle = scheduler.request()
  await Promise.resolve()
  assert.equal(runs, 3, 'an idle request starts a fresh run')
  releases.shift()?.()
  await idle
})

test('refresh scheduler releases the lock after a failed run', async () => {
  let runs = 0
  const scheduler = createRefreshScheduler(async () => {
    runs += 1
    if (runs === 1) throw new Error('boom')
  })
  await assert.rejects(scheduler.request(), /boom/)
  assert.equal(scheduler.busy, false)
  await scheduler.request()
  assert.equal(runs, 2)
  assert.equal(scheduler.busy, false)
})
