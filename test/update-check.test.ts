/**
 * Tests for the in-flight update-check counter in `src/server.ts`.
 *
 * The bug this pins: the panel's Check-updates handler brackets its work with a
 * check marker, and `clearRequirementsCaches` runs a check of its own inside
 * that bracket. With a boolean, the inner check finishing cleared the outer
 * marker, so the panel re-enabled the button (and dropped its spinner) while the
 * handler was still running — and a second click could start a concurrent check.
 *
 * `server.ts` imports `vscode`, so it cannot be loaded here; these tests read the
 * module source to pin the *shape* of the contract. That is a deliberate
 * trade: the defect was a nesting bug in the bracketing discipline, and the
 * counter arithmetic is what makes nesting correct.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')

test('the update-check in-flight state is a counter, not a boolean', () => {
  // A boolean cannot represent "two checks running", which is exactly the state
  // the panel creates when it brackets clearRequirementsCaches.
  assert.match(serverSource, /let checksInFlight = 0/, 'must be a counter')
  assert.doesNotMatch(serverSource, /let checkingUpdates = (true|false)/, 'a flag cannot nest')
})

test('both the outer bracket and the inner check go through the counter', () => {
  // The inner check increments…
  const inner = /export async function clearRequirementsCaches[\s\S]*?\n}/.exec(serverSource)?.[0] ?? ''
  assert.match(inner, /checksInFlight\+\+/, 'clearRequirementsCaches must count itself in')
  assert.match(inner, /finally[\s\S]*?checksInFlight--/, 'and must release on the throw path too')

  // …and the outer bracket does too, so the inner release cannot cancel it.
  assert.match(serverSource, /export function beginUpdateCheck\(\): void \{\s*checksInFlight\+\+/, 'beginUpdateCheck increments')
  assert.match(serverSource, /checksInFlight = Math\.max\(0, checksInFlight - 1\)/, 'endUpdateCheck decrements without going negative')
})

test('the panel brackets its handler and releases in a finally', () => {
  const panel = readFileSync(new URL('../src/panel.ts', import.meta.url), 'utf8')
  const branch = /case 'refreshRequirements':([\s\S]*?)break/.exec(panel)?.[1] ?? ''
  assert.match(branch, /beginUpdateCheck\(\)/, 'the handler must open the bracket')
  // The release has to be in a finally: the branch awaits three things that can
  // throw, and an unwound marker leaves the button greyed for the session.
  assert.match(branch, /finally \{\s*endUpdateCheck\(\)/, 'the bracket must close in a finally')
  assert.doesNotMatch(branch, /setCheckingUpdates\(/, 'the old boolean setter must be gone')
})

test('nothing still exports the removed boolean setter', () => {
  assert.doesNotMatch(serverSource, /export function setCheckingUpdates/, 'the boolean setter is gone')
  assert.match(serverSource, /export function isCheckingUpdates\(\): boolean \{\s*return checksInFlight > 0/, 'reads the counter')
})
