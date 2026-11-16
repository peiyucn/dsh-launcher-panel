import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedStaged, commitMessageError, protectedBranchError } from '../scripts/git-hook.mjs'

test('the pre-commit branch guard refuses dev and main', () => {
  assert.match(protectedBranchError('dev'), /protected/)
  assert.match(protectedBranchError('main'), /protected/)
  assert.equal(protectedBranchError('feat/example'), '')
  assert.match(protectedBranchError(''), /cannot determine/)
})

test('the pre-commit guard blocks generated and temporary paths', () => {
  const blocked = blockedStaged([
    'TEMP/evidence.png',
    'releases/panel.vsix',
    'out/extension.js',
    'node_modules/pkg/index.js',
    'artifact.vsix',
    'src/panel/panel-body.ts',
    'docs/quality-gates.md',
  ])
  assert.deepEqual(blocked, [
    'TEMP/evidence.png',
    'releases/panel.vsix',
    'out/extension.js',
    'node_modules/pkg/index.js',
    'artifact.vsix',
  ])
})

test('the commit-msg guard requires a conventional type prefix', () => {
  assert.equal(commitMessageError('feat: add status pills'), '')
  assert.equal(commitMessageError('fix(panel): keep balance on one line'), '')
  assert.equal(commitMessageError('Merge branch dev'), '')
  assert.match(commitMessageError('add status pills'), /type prefix/)
  assert.match(commitMessageError(''), /empty/)
})
