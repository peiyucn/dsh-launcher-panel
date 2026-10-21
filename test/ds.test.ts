import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dsComponentLabel, parseDsStatus, readCredentialFromFile, readDefaultModel } from '../src/ds.ts'

function withTempFile(content: string, fn: (file: string) => unknown): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
  const file = join(dir, 'file.yaml')
  writeFileSync(file, content)
  try {
    return fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readCredentialFromFile reads block style', () => {
  const v = withTempFile('DEEPSEEK_API_KEY: sk-block\nOTHER: x\n', (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(v, 'sk-block')
})

test('readCredentialFromFile reads flow style written by dsh', () => {
  const v = withTempFile('{ DEEPSEEK_API_KEY: sk-flow }', (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(v, 'sk-flow')
})

test('readCredentialFromFile reads the first key under a valueless parent (dsh refs block)', () => {
  // The real ~/.dsh/.credentials.yaml structure: a nested refs block whose
  // first entry is DEEPSEEK_API_KEY. The valueless `refs:` line must not
  // swallow the next line's key as its value.
  const content = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-refs-first',
    '  ZAI_API_KEY: zai-key',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: some-secret',
    '',
  ].join('\n')
  const first = withTempFile(content, (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(first, 'sk-refs-first')
  const sibling = withTempFile(content, (f) => readCredentialFromFile('ZAI_API_KEY', f))
  assert.equal(sibling, 'zai-key')
})

test('readCredentialFromFile does not treat a valueless parent key as a mapping entry', () => {
  const v = withTempFile('refs:\n  DEEPSEEK_API_KEY: sk-refs-first\n', (f) => readCredentialFromFile('refs', f))
  assert.equal(v, undefined)
})

test('readCredentialFromFile reads quoted and equals-style values', () => {
  const quoted = withTempFile('KEY: "sk quoted value"', (f) => readCredentialFromFile('KEY', f))
  assert.equal(quoted, 'sk quoted value')
  const eq = withTempFile('KEY=sk-eq', (f) => readCredentialFromFile('KEY', f))
  assert.equal(eq, 'sk-eq')
})

test('readCredentialFromFile returns undefined for a missing key or file', () => {
  const miss = withTempFile('OTHER: x', (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(miss, undefined)
  assert.equal(readCredentialFromFile('KEY', 'C:\\nonexistent\\file.yaml'), undefined)
})

test('readCredentialFromFile ignores commented-out keys', () => {
  const v = withTempFile('# DEEPSEEK_API_KEY: sk-commented\nDEEPSEEK_API_KEY: sk-active\n', (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(v, 'sk-active')
  const onlyCommented = withTempFile('# DEEPSEEK_API_KEY: sk-commented\n', (f) => readCredentialFromFile('DEEPSEEK_API_KEY', f))
  assert.equal(onlyCommented, undefined)
})

test('dsComponentLabel keeps the service name when only the Chinese half has an ASCII acronym', () => {
  // Live status-page names: toEnglish drops the parenthetical and leaves "API",
  // so both search and fetch used to show up as "api".
  assert.equal(dsComponentLabel('搜索API服务(Search API Service)'), 'search')
  assert.equal(dsComponentLabel('抓取API服务(Fetch API Service)'), 'fetch')
  // The model services keep the Chinese half's English and ignore the generic
  // "(API Service)" parenthetical.
  assert.equal(dsComponentLabel('DeepSeek V4 Pro API服务(API Service)'), 'deepseek-v4-pro')
  assert.equal(dsComponentLabel('DeepSeek V4.1 Flash API服务(API Service)'), 'deepseek-v4.1-flash')
  // English-only names go through the same tail stripping.
  assert.equal(dsComponentLabel('Search API Service'), 'search')
  assert.equal(dsComponentLabel('DeepSeek V3 Chat API'), 'deepseek-v3-chat')
})

test('parseDsStatus lists the new search and fetch API services distinctly', () => {
  const json = {
    data: {
      page: {
        components: [
          { component_id: '1', name: 'DeepSeek V4 Pro API服务(API Service)', order_id: 1 },
          { component_id: '2', name: 'DeepSeek V4.1 Flash API服务(API Service)', order_id: 2 },
          { component_id: '3', name: '对话服务(Chatservice)', order_id: 1 },
          { component_id: '4', name: '搜索服务(Search Service)', order_id: 3 },
          { component_id: '5', name: '搜索API服务(Search API Service)', order_id: 3 },
          { component_id: '6', name: '抓取API服务(Fetch API Service)', order_id: 4 },
        ],
      },
      active_changes: [],
    },
  }
  const st = parseDsStatus(json)
  // Chat Service modes are still skipped; the two API services are distinct.
  assert.deepEqual(
    st.components.map((c) => c.name),
    ['deepseek-v4-pro', 'deepseek-v4.1-flash', 'search', 'fetch'],
  )
  assert.equal(st.state, 'ok')
})

test('parseDsStatus maps components, incidents and worst severity', () => {
  const json = {
    data: {
      page: {
        components: [
          { component_id: '1', name: 'DeepSeek V3 Chat API', order_id: 1 },
          { component_id: '2', name: 'DeepSeek V3 Reasoner API', order_id: 2 },
        ],
      },
      active_changes: [
        {
          change_id: 'c1',
          title: 'Service disruption',
          status: 'investigating',
          affected_components: [{ component_id: '1', name: 'DeepSeek V3 Chat API', status: 'partial_outage' }],
        },
      ],
    },
  }
  const st = parseDsStatus(json)
  assert.equal(st.state, 'down')
  assert.equal(st.components.length, 2)
  assert.equal(st.components[0].name, 'deepseek-v3-chat')
  assert.equal(st.components[0].status, 'partial_outage')
  assert.equal(st.components[1].status, 'operational')
  assert.equal(st.incidents.length, 1)
  assert.equal(st.incidents[0].status, 'investigating')
})

test('parseDsStatus skips non-api components and unrelated incidents', () => {
  const json = {
    data: {
      page: {
        components: [{ component_id: '1', name: 'Chat Service', order_id: 1 }],
      },
      active_changes: [
        {
          change_id: 'c2',
          title: 'Something else',
          status: 'investigating',
          affected_components: [{ component_id: '9', name: 'Chat Service', status: 'full_outage' }],
        },
      ],
    },
  }
  const st = parseDsStatus(json)
  assert.equal(st.components.length, 0)
  assert.equal(st.incidents.length, 0)
  assert.equal(st.state, 'ok')
})

test('parseDsStatus tolerates malformed input without throwing', () => {
  const st = parseDsStatus(null)
  assert.equal(st.components.length, 0)
  assert.equal(st.incidents.length, 0)
})

test('readDefaultModel parses the agent-default-model section of settings.yaml', () => {
  const prev = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = dir
  writeFileSync(join(dir, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek\n  model: deepseek-chat\nother:\n  provider: ignored\n')
  try {
    assert.deepEqual(readDefaultModel(), { provider: 'deepseek', model: 'deepseek-chat' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('readDefaultModel returns undefined when the section is absent', () => {
  const prev = process.env.DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = dir
  writeFileSync(join(dir, 'settings.yaml'), 'other:\n  provider: x\n')
  try {
    assert.equal(readDefaultModel(), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})
