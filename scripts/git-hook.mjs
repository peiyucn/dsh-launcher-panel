#!/usr/bin/env node
/**
 * Local Git hook logic shared by .githooks/*.
 *
 * These hooks are local guardrails, not a security boundary: Git users can
 * bypass them with --no-verify. Remote branch protection and CI remain the
 * authoritative checks.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PROTECTED_BRANCHES = new Set(['dev', 'main'])
const BLOCKED_STAGED = [
  /^TEMP\//u,
  /^releases\//u,
  /^out\//u,
  /^node_modules\//u,
  /\.vsix$/u,
]
const COMMIT_PREFIX = /^(feat|fix|docs|test|refactor|chore|ci|build|perf|style|revert)(\([^)]+\))?: .+/u

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

export function currentBranch() {
  const result = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.status === 0 ? result.stdout.trim() : ''
}

export function protectedBranchError(branch = currentBranch()) {
  if (!branch) return 'refuse: cannot determine the current branch'
  if (PROTECTED_BRANCHES.has(branch)) {
    return `refuse: "${branch}" is protected; create a feat/* or fix/* branch from dev`
  }
  return ''
}

export function blockedStaged(files) {
  return files.filter((file) => BLOCKED_STAGED.some((pattern) => pattern.test(file)))
}

export function commitMessageError(message) {
  const firstLine = message.split(/\r?\n/u, 1)[0].trim()
  if (!firstLine) return 'refuse: commit message is empty'
  if (firstLine.startsWith('Merge ')) return ''
  if (!COMMIT_PREFIX.test(firstLine)) {
    return 'refuse: commit message must start with a type prefix, e.g. "feat: ..." or "fix(scope): ..."'
  }
  return ''
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function stagedFiles() {
  const result = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  if (result.status !== 0) fail(result.stderr.trim() || 'refuse: could not list staged files')
  return result.stdout.split(/\r?\n/u).filter(Boolean)
}

function runPreCommit() {
  const branchError = protectedBranchError()
  if (branchError) fail(branchError)

  const diffCheck = git(['diff', '--cached', '--check'])
  if (diffCheck.status !== 0) {
    process.stderr.write(diffCheck.stderr || diffCheck.stdout)
    fail('refuse: staged diff has whitespace errors')
  }

  const blocked = blockedStaged(stagedFiles())
  if (blocked.length > 0) {
    fail(`refuse: do not commit generated/ignored paths:\n${blocked.join('\n')}`)
  }
}

function runCommitMsg(file) {
  if (!file) fail('refuse: commit-msg hook did not receive a message file')
  const message = readFileSync(file, 'utf8')
  const error = commitMessageError(message)
  if (error) fail(error)
}

function runPrePush() {
  const branchError = protectedBranchError()
  if (branchError) fail(branchError)
  if (process.env.SKIP_VERIFY === '1') {
    console.warn('warning: SKIP_VERIFY=1, skipping npm run verify')
    return
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['run', 'verify'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) fail('refuse: npm run verify failed')
}

function main() {
  const mode = process.argv[2]
  if (mode === 'pre-commit') return runPreCommit()
  if (mode === 'commit-msg') return runCommitMsg(process.argv[3])
  if (mode === 'pre-push') return runPrePush()
  fail(`unknown hook mode: ${mode ?? '(missing)'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
