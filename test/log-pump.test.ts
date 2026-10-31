import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogTailPump } from '../src/instances/runtime/log-pump.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function tempLog(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-pump-'))
  return { file: join(dir, 'server.log'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a fresh spawn captures only output written after the captured offset', async () => {
  const { file, cleanup } = tempLog()
  try {
    writeFileSync(file, 'history: old run ready\r\nhistory: old run two\r\n')
    const pump = new LogTailPump(() => file)
    pump.start(statSync(file).size)
    appendFileSync(file, 'this run: ready\r\n')
    await sleep(900)
    pump.stop()
    assert.deepEqual(pump.tail(10), ['this run: ready'], 'the previous runs must not leak into the startup console')
  } finally {
    cleanup()
  }
})

test('starting without an offset skips the history already on disk', async () => {
  const { file, cleanup } = tempLog()
  try {
    writeFileSync(file, 'history: old run ready\r\n')
    const pump = new LogTailPump(() => file)
    pump.start()
    appendFileSync(file, 'this run: ready\r\n')
    await sleep(900)
    pump.stop()
    assert.deepEqual(pump.tail(10), ['this run: ready'], 'the default start point must be the current end of file')
  } finally {
    cleanup()
  }
})
