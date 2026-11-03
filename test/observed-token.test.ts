import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newestLaunchToken,
  parseCgroupSource,
  tokenForPid,
  type TokenDeps,
} from '../src/instances/observed-token.ts'

const TOKEN = 'AbCdEfGh12345678'

test('parses systemd and docker cgroup sources', () => {
  assert.deepEqual(parseCgroupSource('0::/system.slice/dsh-superagent.service'), { kind: 'systemd', unit: 'dsh-superagent.service' })
  // /proc/<pid>/cgroup ends with a newline in the real world.
  assert.deepEqual(parseCgroupSource('0::/system.slice/dsh-superagent.service\n'), { kind: 'systemd', unit: 'dsh-superagent.service' })
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

test('newestLaunchToken keeps the last token in the text', () => {
  assert.equal(newestLaunchToken('x ?token=OLDOLDOLD\ny ?token=NEWNEWNEW\n'), 'NEWNEWNEW')
  assert.equal(newestLaunchToken('no token here'), undefined)
})
