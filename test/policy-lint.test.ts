import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkRepository } from '../scripts/check-policy.mjs'

const BASE_PACKAGE = {
  name: 'fixture',
  version: '1.2.3',
  engines: { vscode: '^1.85.0' },
  contributes: {
    configuration: {
      properties: {
        'dsh.alpha': { type: 'string' },
        'dsh.beta': { type: 'boolean' },
      },
    },
  },
  scripts: {
    lint: 'eslint src test && node scripts/check-policy.mjs',
    verify: 'npm run lint && npm test',
  },
  devDependencies: { '@types/vscode': '1.85.0' },
}

const BASE_FILES: Record<string, string> = {
  'AGENTS.md': '# fixture\n',
  'SECURITY.md': '# security\n',
  'docs/architecture.md': '# architecture\n',
  'docs/instances-spec.md': '# spec\n',
  'docs/positioning-and-retirement.md': '# positioning\n',
  'docs/quality-gates.md': '# quality gates\n',
  'README.md': [
    '# fixture',
    '中文见 [README.zh-CN.md](README.zh-CN.md)',
    '## Settings',
    '| Key | Default | Description |',
    '|---|---|---|',
    '| dsh.alpha | x | alpha |',
    '| dsh.beta | true | beta |',
    '',
  ].join('\n'),
  'README.zh-CN.md': [
    '# fixture',
    'English: [README.md](README.md)',
    '## 设置',
    '| 键 | 默认值 | 说明 |',
    '|---|---|---|',
    '| dsh.alpha | x | alpha |',
    '| dsh.beta | true | beta |',
    '',
  ].join('\n'),
  'CHANGELOG.md': '# Changelog\n\nEnglish: [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)\n\n## [1.2.3] - 2026-01-01\n\n- fixture\n',
  'CHANGELOG.zh-CN.md': '# 变更日志\n\n中文: [CHANGELOG.md](CHANGELOG.md)\n\n## [1.2.3] - 2026-01-01\n\n- fixture\n',
  '.github/workflows/ci.yml': [
    'name: ci',
    'jobs:',
    '  typecheck:',
    '    runs-on: ubuntu-latest',
    '  test:',
    '    runs-on: ubuntu-latest',
    '  build:',
    '    runs-on: ubuntu-latest',
    '  package:',
    '    runs-on: ubuntu-latest',
    '',
  ].join('\n'),
  '.github/workflows/publish.yml': [
    'name: Publish',
    'jobs:',
    '  publish:',
    '    environment: marketplace-publish',
    '    steps:',
    '      - run: bash scripts/check-security-alerts.sh',
    '      - run: git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    '      - run: npm run package',
    '',
  ].join('\n'),
  '.gitignore': 'node_modules/\nout/\nreleases/\n*.vsix\n',
  '.vscodeignore': 'src/**\ndocs/**\nscripts/**\neslint.config.mjs\ntest/**\nAGENTS.md\nreleases/**\n*.vsix\n',
  'test/example.test.ts': "import { test } from 'node:test'\ntest('ok', () => {})\n",
}

function makeRepo(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
  const files: Record<string, string> = {
    ...BASE_FILES,
    'package.json': JSON.stringify(BASE_PACKAGE, null, 2),
    ...overrides,
  }
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

test('the real repository passes all policy checks', () => {
  assert.deepEqual(checkRepository(process.cwd()), [])
})

test('QG001 fails when a required document is missing', () => {
  const root = makeRepo()
  try {
    rmSync(join(root, 'SECURITY.md'))
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG001')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG002 fails when a README settings table drifts from package.json', () => {
  const root = makeRepo({
    'README.md': BASE_FILES['README.md'].replace('| dsh.beta | true | beta |', '| dsh.gamma | true | beta |'),
  })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG002')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG003 fails when @types/vscode drifts from engines.vscode', () => {
  const pkg = { ...BASE_PACKAGE, devDependencies: { '@types/vscode': '1.86.0' } }
  const root = makeRepo({ 'package.json': JSON.stringify(pkg, null, 2) })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG003')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG004 fails when the bilingual documents stop cross-linking', () => {
  const root = makeRepo({ 'README.zh-CN.md': BASE_FILES['README.zh-CN.md'].replace('[README.md](README.md)', '') })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG004')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG005 fails when CHANGELOG misses the package version', () => {
  const root = makeRepo({ 'CHANGELOG.zh-CN.md': BASE_FILES['CHANGELOG.zh-CN.md'].replace('1.2.3', '1.2.2') })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG005')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG006 fails when verify omits lint', () => {
  const pkg = { ...BASE_PACKAGE, scripts: { ...BASE_PACKAGE.scripts, verify: 'npm test' } }
  const root = makeRepo({ 'package.json': JSON.stringify(pkg, null, 2) })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG006')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG007 fails on an unknown or reordered CI job', () => {
  const root = makeRepo({
    '.github/workflows/ci.yml': BASE_FILES['.github/workflows/ci.yml'].replace('  test:', '  checks:'),
  })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG007')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG008 fails when the alert gate moves after packaging', () => {
  const root = makeRepo({
    '.github/workflows/publish.yml': [
      'name: Publish',
      'jobs:',
      '  publish:',
      '    environment: marketplace-publish',
      '    steps:',
      '      - run: npm run package',
      '      - run: bash scripts/check-security-alerts.sh',
      '      - run: git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
      '',
    ].join('\n'),
  })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG008')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG009 fails when a packaging artifact becomes publishable', () => {
  const root = makeRepo({ '.vscodeignore': 'src/**\ndocs/**\nscripts/**\ntest/**\nAGENTS.md\nreleases/**\n' })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG009')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('QG010 fails when a focused test is committed', () => {
  const focused = 'test' + '.only'
  const root = makeRepo({ 'test/example.test.ts': `import { test } from 'node:test'\n${focused}('focused', () => {})\n` })
  try {
    assert.ok(checkRepository(root).some((line) => line.startsWith('QG010')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a clean fixture passes every policy check', () => {
  const root = makeRepo()
  try {
    assert.deepEqual(checkRepository(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
