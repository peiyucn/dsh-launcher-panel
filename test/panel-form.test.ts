import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstanceFormPayload } from '../src/panel/form.ts'

function rawForm(fields: Record<string, unknown>): string {
  return JSON.stringify(fields)
}

test('parseInstanceFormPayload accepts a new-instance form', () => {
  const result = parseInstanceFormPayload(rawForm({
    mode: 'new',
    id: 'ignored-for-create',
    name: 'Work',
    home: 'C:\\data\\work',
    autoOpenBrowser: true,
    browser: 'external',
  }))
  assert.deepEqual(result, {
    ok: true,
    form: {
      mode: 'new',
      id: 'ignored-for-create',
      name: 'Work',
      home: 'C:\\data\\work',
      autoOpenBrowser: true,
      browser: 'external',
    },
  })
})

test('parseInstanceFormPayload accepts an edit form with an id', () => {
  const result = parseInstanceFormPayload(rawForm({ mode: 'edit', id: 'abc-123', name: 'Work', home: '/data/work' }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok ? result.form : undefined, {
    mode: 'edit',
    id: 'abc-123',
    name: 'Work',
    home: '/data/work',
    autoOpenBrowser: undefined,
    browser: undefined,
  })
})

test('parseInstanceFormPayload treats a missing or unknown mode as a create', () => {
  for (const mode of [undefined, 'create', 'EDIT', 42]) {
    const result = parseInstanceFormPayload(rawForm({ mode, name: 'N', home: 'H' }))
    assert.equal(result.ok, true)
    assert.equal(result.ok ? result.form.mode : '', 'new')
  }
})

test('parseInstanceFormPayload keeps the create path for an edit form without an id', () => {
  const result = parseInstanceFormPayload(rawForm({ mode: 'edit', name: 'N', home: 'H' }))
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.form.mode : '', 'edit')
  assert.equal(result.ok ? result.form.id : 'missing', '')
})

test('parseInstanceFormPayload rejects non-string and non-JSON input as malformed', () => {
  for (const raw of [undefined, null, 42, {}, '', '{', '{oops}', 'undefined']) {
    assert.deepEqual(parseInstanceFormPayload(raw), { ok: false, message: 'Malformed instance form' })
  }
})

test('parseInstanceFormPayload rejects JSON that is not an object', () => {
  for (const raw of ['null', '[]', '[{"name":"N","home":"H"}]', '42', '"a string"', 'true']) {
    assert.deepEqual(parseInstanceFormPayload(raw), { ok: false, message: 'Malformed instance form' })
  }
})

test('parseInstanceFormPayload requires string name and home', () => {
  const cases: unknown[] = [
    {},
    { name: 'N' },
    { home: 'H' },
    { name: 1, home: 'H' },
    { name: 'N', home: null },
    { name: ['N'], home: 'H' },
  ]
  for (const fields of cases) {
    assert.deepEqual(parseInstanceFormPayload(rawForm(fields as Record<string, unknown>)), {
      ok: false,
      message: 'Name and home are required',
    })
  }
  // Empty strings pass here; the manager owns the real field rules.
  const empty = parseInstanceFormPayload(rawForm({ name: '', home: '' }))
  assert.equal(empty.ok, true)
})

test('parseInstanceFormPayload normalizes optional fields to the known domain', () => {
  const result = parseInstanceFormPayload(rawForm({
    mode: 'new',
    name: 'N',
    home: 'H',
    autoOpenBrowser: 'yes',
    browser: 'chrome',
    extra: { ignored: true },
  }))
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.form.autoOpenBrowser : 'unset', undefined)
  assert.equal(result.ok ? result.form.browser : 'unset', undefined)

  const builtIn = parseInstanceFormPayload(rawForm({ name: 'N', home: 'H', autoOpenBrowser: false, browser: 'built-in' }))
  assert.equal(builtIn.ok, true)
  assert.equal(builtIn.ok ? builtIn.form.autoOpenBrowser : 'unset', false)
  assert.equal(builtIn.ok ? builtIn.form.browser : 'unset', 'built-in')
})
