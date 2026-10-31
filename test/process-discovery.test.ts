import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findDshServerPids,
  isDshServerCommand,
  killPid,
  parsePosixProcessList,
  parseWindowsProcessList,
} from '../src/instances/runtime/process.ts'

const PKG_COMMAND = 'node   "C:\\Users\\me\\.dsh-launcher-panel\\package\\node_modules\\.bin\\\\..\\@deepseek-ai\\dsh\\lib\\bin.js" "web" "--port" "3080" "--no-open"'
const SOURCE_COMMAND = '"C:\\Program Files\\nodejs\\node.exe" --import tsx/esm apps/cli/src/bin.ts web --port 3080 --no-open'
const PNPM_WRAPPER = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Local\\pnpm\\pnpm.cjs '
  + '--config.verify-deps-before-run=false exec dsh web --port 3080 --no-open'
const VITE = '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\node_modules\\vite\\bin\\vite.js --port 3080'

test('a pkg-mode server command line is recognised only for its own port', () => {
  assert.equal(isDshServerCommand(PKG_COMMAND, 3080), true)
  assert.equal(isDshServerCommand(PKG_COMMAND, 31001), false)
  assert.equal(isDshServerCommand(PKG_COMMAND, 30800), false)
})

test('a source-mode server command line is recognised', () => {
  assert.equal(isDshServerCommand(SOURCE_COMMAND, 3080), true)
  assert.equal(isDshServerCommand(SOURCE_COMMAND, 3081), false)
})

test('the port token may use an equals sign or no quotes around the banner', () => {
  const command = 'node /home/me/dsh/apps/cli/src/bin.ts web --port=3080 --no-open'
  assert.equal(isDshServerCommand(command, 3080), true)
})

test('unrelated --port processes are not mistaken for the instance server', () => {
  assert.equal(isDshServerCommand(VITE, 3080), false)
  assert.equal(isDshServerCommand(PNPM_WRAPPER, 3080), false)
})

test('the Windows probe output parses pid/command rows', () => {
  const output = `1234\t${PKG_COMMAND}\r\n5678\t\r\nnot a row\r\n\r\n`
  assert.deepEqual(parseWindowsProcessList(output), [
    { pid: 1234, command: PKG_COMMAND },
    { pid: 5678, command: '' },
  ])
})

test('the ps output parses padded pid rows', () => {
  const output = `    1234 ${SOURCE_COMMAND}\n  31001 node /home/me/dsh/apps/cli/src/bin.ts web --port 31001\n`
  assert.deepEqual(parsePosixProcessList(output), [
    { pid: 1234, command: SOURCE_COMMAND },
    { pid: 31001, command: 'node /home/me/dsh/apps/cli/src/bin.ts web --port 31001' },
  ])
})

test('matching server pids are returned once', () => {
  const entries = [
    { pid: 9744, command: PKG_COMMAND },
    { pid: 9744, command: PKG_COMMAND },
    { pid: 16336, command: PKG_COMMAND.replace('"3080"', '"31001"') },
    { pid: 42, command: 'node some-other-app.js' },
  ]
  assert.deepEqual(findDshServerPids(entries, 3080), [9744])
  assert.deepEqual(findDshServerPids(entries, 31001), [16336])
  assert.deepEqual(findDshServerPids(entries, 39999), [])
})

test('killPid refuses pid 0 and the launcher itself', async () => {
  const logged: string[] = []
  assert.equal(await killPid(0, (line) => logged.push(line)), false)
  assert.equal(await killPid(-12, (line) => logged.push(line)), false)
  assert.equal(await killPid(process.pid, (line) => logged.push(line)), false)
  assert.equal(logged.length, 3)
})
