import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Flat config. Rules here are meant to encode only checks that this project has
// actually needed; recurring defects get a rule and a regression fixture rather
// than another paragraph in AGENTS.md. See docs/quality-gates.md.
export default tseslint.config(
  {
    ignores: ['out/**', 'releases/**', 'node_modules/**', 'test-report.xml'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // Child processes must use an argument array. A shell would re-parse
      // user-configured paths and turn data into a second command (G4).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync'],
              message: 'Use execFile/spawn with an argument array; never run through a shell.',
            },
            {
              name: 'child_process',
              importNames: ['exec', 'execSync'],
              message: 'Use execFile/spawn with an argument array; never run through a shell.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync|exec|execSync)$/] ObjectExpression > Property[key.name='shell'][value.value=true]",
          message: 'Do not pass shell: true. Use an argument array through execFile/spawn (G4).',
        },
      ],
    },
  },
  {
    // shared/ is the dependency-free base layer: it must not import the host
    // API or a feature layer. The module graph is documented in
    // docs/architecture.md.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'shared/ must not depend on vscode; keep it pure and unit-testable.',
            },
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync'],
              message: 'Use execFile/spawn with an argument array; never run through a shell.',
            },
            {
              name: 'child_process',
              importNames: ['exec', 'execSync'],
              message: 'Use execFile/spawn with an argument array; never run through a shell.',
            },
          ],
        },
      ],
    },
  },
)
