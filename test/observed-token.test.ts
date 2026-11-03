import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearObservedTokenCache,
  findDshPidByPort,
  parseCgroupSource,
  resolveObservedToken,
  tokenForPid,
  type TokenDeps,
} from '../src/instances/observed-token.ts'
import type { ProcessEntry } from '../src/instances/discovery.ts'

const TOKEN = 'AbCdEfGh12345678'

test('parses systemd and docker cgroup sources', () => {
  assert.deepEqual(parseCgroupSource('0::/system.slice/dsh-superagent.service'), { kind: 'systemd', unit: 'dsh-superagent.service' })
  assert.deepEqual(parseCgroupSource('0::/docker/0123456789abcdef0123456789abcdef'), { kind: 'docker', container: '0123456789abcdef0123456789abcdef' })
  assert.equal(parseCgroupSource('0::/user.slice/session.scope'), undefined)
})

test('reads the token from the process systemd journal', async () => {
  const calls: string[] = []
  const deps: TokenDeps = {
    platform: 'linux',
    readCgroup: () => '0::/system.slice/dsh-superagent.service',
    run: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return { ok: true, stdout: `... http://127.0.0.1:3082/?token=${TOKEN}`, stderr: '' }
    },
  }
  assert.deepEqual(await tokenForPid(701, deps), { token: TOKEN })
  assert.ok(calls[0]?.startsWith('journalctl -u dsh-superagent.service'))
})

test('reads the token from docker logs', async () => {
  const deps: TokenDeps = {
    platform: 'linux',
    readCgroup: () => '0::/docker/0123456789abcdef0123456789abcdef',
    run: async () => ({ ok: true, stdout: `?token=${TOKEN}`, stderr: '' }),
  }
  assert.deepEqual(await tokenForPid(701, deps), { token: TOKEN })
})

test('falls back to a stdout log file when the supervisor cannot answer', async () => {
  const deps: TokenDeps = {
    platform: 'linux',
    readCgroup: () => '0::/system.slice/dsh.service',
    readStdoutTarget: () => '/var/log/dsh.log',
    readTail: () => `noise\n?token=${TOKEN}`,
    run: async () => ({ ok: false, stdout: '', stderr: '', error: 'no journal' }),
  }
  assert.deepEqual(await tokenForPid(701, deps), { token: TOKEN })
})

test('reports an actionable error when no token source exists', async () => {
  const result = await tokenForPid(701, {
    platform: 'linux',
    readCgroup: () => '0::/user.slice/session.scope',
    readStdoutTarget: () => 'socket:[123]',
  })
  assert.match(result.error ?? '', /no systemd unit or docker container/)
})

test('a supervisor that returns no token reports the missing token', async () => {
  const result = await tokenForPid(701, {
    platform: 'linux',
    readCgroup: () => '0::/system.slice/dsh.service',
    readStdoutTarget: () => '/tmp/dsh.log',
    readTail: () => 'nothing useful',
    run: async () => ({ ok: true, stdout: 'no token', stderr: '' }),
  })
  assert.match(result.error ?? '', /does not contain a dsh launch token/)
})

test('automatic token lookup is Linux-only and says so', async () => {
  const result = await tokenForPid(701, { platform: 'win32' })
  assert.match(result.error ?? '', /only available on Linux/)
})

test('findDshPidByPort matches the command line port', () => {
  const entries: ProcessEntry[] = [
    { pid: 1, command: 'node /usr/local/bin/dsh web --port 3080' },
    { pid: 2, command: 'node /usr/local/bin/dsh superagent --port 3082 --no-open' },
  ]
  assert.equal(findDshPidByPort(entries, 3082), 2)
  assert.equal(findDshPidByPort(entries, 3099), undefined)
})

test('resolveObservedToken finds the pid and caches the token', async () => {
  clearObservedTokenCache()
  let calls = 0
  const deps: TokenDeps = {
    platform: 'linux',
    list: async () => [{ pid: 42, command: 'node /usr/local/bin/dsh superagent --port 3082' }],
    readCgroup: () => '0::/system.slice/dsh-superagent.service',
    run: async () => {
      calls += 1
      return { ok: true, stdout: `?token=${TOKEN}`, stderr: '' }
    },
  }
  assert.deepEqual(await resolveObservedToken(3082, deps), { token: TOKEN })
  assert.deepEqual(await resolveObservedToken(3082, deps), { token: TOKEN })
  assert.equal(calls, 1, 'the token is resolved once per cache window')
  clearObservedTokenCache()
})

test('resolveObservedToken reports when no process serves the port', async () => {
  clearObservedTokenCache()
  const result = await resolveObservedToken(3999, { platform: 'linux', list: async () => [] })
  assert.match(result.error ?? '', /no dsh process is serving/)
  clearObservedTokenCache()
})
