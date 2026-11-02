import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExternalToken, type TokenRunner } from '../src/instances/external-token.ts'

const TOKEN = 'AbCdEfGh12345678'

function runner(stdout: string, ok = true, error?: string): TokenRunner {
  return async () => ({ ok, stdout, ...(error === undefined ? {} : { error }) })
}

test('a file source reads the newest launch token from the tail', async () => {
  const result = await resolveExternalToken({ kind: 'file', path: '/tmp/dsh.log' }, {
    readFileTail: () => `old ?token=OldToken12345678\nnew ?token=${TOKEN}`,
  })
  assert.deepEqual(result, { token: TOKEN })
})

test('an unreadable token file reports a concrete error', async () => {
  const result = await resolveExternalToken({ kind: 'file', path: '/tmp/missing.log' }, { readFileTail: () => undefined })
  assert.match(result.error ?? '', /could not be read/)
})

test('a token file without a launch token reports a concrete error', async () => {
  const result = await resolveExternalToken({ kind: 'file', path: '/tmp/dsh.log' }, { readFileTail: () => 'no token here' })
  assert.match(result.error ?? '', /does not contain a dsh launch token/)
})

test('a journal source reads journalctl for the unit and extracts the token', async () => {
  const calls: string[][] = []
  const result = await resolveExternalToken({ kind: 'journal', unit: 'dsh-superagent' }, {
    platform: 'linux',
    run: async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: `... ?token=${TOKEN}` } },
  })
  assert.deepEqual(result, { token: TOKEN })
  assert.equal(calls[0]?.[0], 'journalctl')
  assert.ok(calls[0]?.includes('dsh-superagent'))
})

test('a docker source reads docker logs for the container', async () => {
  const calls: string[][] = []
  const result = await resolveExternalToken({ kind: 'docker', container: 'dsh' }, {
    platform: 'linux',
    run: async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: `?token=${TOKEN}` } },
  })
  assert.deepEqual(result, { token: TOKEN })
  assert.equal(calls[0]?.[0], 'docker')
  assert.ok(calls[0]?.includes('logs'))
})

test('journal is rejected on Windows with actionable advice', async () => {
  const result = await resolveExternalToken({ kind: 'journal', unit: 'dsh' }, { platform: 'win32' })
  assert.match(result.error ?? '', /needs systemd \(Linux\)/)
})

test('a failed supervisor command surfaces its error', async () => {
  const result = await resolveExternalToken({ kind: 'journal', unit: 'dsh' }, {
    platform: 'linux',
    run: runner('', false, 'Failed to connect to bus'),
  })
  assert.match(result.error ?? '', /Failed to connect to bus/)
})

test('a missing tokenSource is reported instead of guessing', async () => {
  const result = await resolveExternalToken(undefined)
  assert.match(result.error ?? '', /no tokenSource is configured/)
})
