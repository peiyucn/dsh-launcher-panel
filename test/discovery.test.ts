import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectedName,
  detectDshServers,
  findDshServerEntry,
  isDshEntryToken,
  newestLaunchToken,
  parseDshServerCommand,
  parsePosixProcessList,
  parseWindowsProcessList,
  type ProcessEntry,
} from '../src/instances/discovery.ts'

test('parses the global dsh shim command', () => {
  assert.deepEqual(
    parseDshServerCommand('node /usr/local/bin/dsh superagent --port 3082 --no-open'),
    { port: 3082, profile: 'superagent' },
  )
})

test('parses the installed package entry point', () => {
  assert.deepEqual(
    parseDshServerCommand('node /home/u/.dsh-launcher-panel/package/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --no-open'),
    { port: 3080, profile: 'web' },
  )
})

test('parses the source entry point and --port= form', () => {
  assert.deepEqual(
    parseDshServerCommand('node --import tsx/esm /src/apps/cli/src/bin.ts exp --port=31001'),
    { port: 31001, profile: 'exp' },
  )
})

test('ignores commands that are not dsh servers', () => {
  assert.equal(parseDshServerCommand('node server.js --port 3082'), undefined)
  assert.equal(parseDshServerCommand('node /usr/local/bin/dsh superagent'), undefined)
  assert.equal(parseDshServerCommand('node /usr/local/bin/dsh --port 0'), undefined)
})

test('handles quoted Windows command lines', () => {
  assert.deepEqual(
    parseDshServerCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port "3080"'),
    { port: 3080, profile: 'web' },
  )
})

test('detected names use the profile, defaulting to the port form', () => {
  assert.equal(detectedName('superagent', 3082), 'superagent')
  assert.equal(detectedName('web', 3080), 'dsh :3080')
  assert.equal(detectedName('', 3080), 'dsh :3080')
})

test('entry tokens cover the shim, installed and source layouts', () => {
  assert.equal(isDshEntryToken('/usr/local/bin/dsh'), true)
  assert.equal(isDshEntryToken('/x/node_modules/@deepseek-ai/dsh/lib/bin.js'), true)
  assert.equal(isDshEntryToken('/src/apps/cli/dist/bin.js'), true)
  assert.equal(isDshEntryToken('/usr/local/bin/node'), false)
})

test('detectDshServers excludes configured ports, duplicate ports and other pids', async () => {
  const entries: ProcessEntry[] = [
    { pid: 10, command: 'node /usr/local/bin/dsh superagent --port 3082 --no-open' },
    { pid: 11, command: 'node /usr/local/bin/dsh web --port 3080 --no-open' },
    { pid: 12, command: 'node /usr/local/bin/dsh dup --port 3082 --no-open' },
    { pid: 13, command: 'node /usr/local/bin/dsh other --port 3099 --no-open' },
    { pid: 14, command: 'node unrelated.js --port 3082' },
    { pid: 15, command: 'node /usr/local/bin/dsh excluded --port 3100 --no-open' },
  ]
  const detected = await detectDshServers(new Set([3080]), new Set([15]), {
    list: async () => entries,
    portOpen: async (port) => port !== 3099,
    homeOf: (pid) => (pid === 10 ? '/home/agent/.dsh-superagent' : ''),
  })
  assert.deepEqual(detected.map((entry) => entry.port), [3082])
  assert.equal(detected[0]?.pid, 10)
  assert.equal(detected[0]?.profile, 'superagent')
  assert.equal(detected[0]?.home, '/home/agent/.dsh-superagent')
})

test('findDshServerEntry locates the process by port', () => {
  const entries: ProcessEntry[] = [{ pid: 7, command: 'node /usr/local/bin/dsh superagent --port 3082' }]
  assert.equal(findDshServerEntry(entries, 3082)?.pid, 7)
  assert.equal(findDshServerEntry(entries, 3083), undefined)
})

test('newestLaunchToken keeps the last token in the text', () => {
  assert.equal(newestLaunchToken('x ?token=OLDOLDOLD\ny ?token=NEWNEWNEW\n'), 'NEWNEWNEW')
  assert.equal(newestLaunchToken('no token here'), undefined)
})

test('platform process list parsers split pid and command line', () => {
  assert.deepEqual(parsePosixProcessList('  123 node /usr/local/bin/dsh web --port 3080\n'), [
    { pid: 123, command: 'node /usr/local/bin/dsh web --port 3080' },
  ])
  assert.deepEqual(parseWindowsProcessList('456\t"C:\\node.exe" "C:\\bin.js" web --port 3080\r\n'), [
    { pid: 456, command: '"C:\\node.exe" "C:\\bin.js" web --port 3080' },
  ])
})
