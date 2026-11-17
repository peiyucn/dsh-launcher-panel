#!/usr/bin/env node
/**
 * Check that the GitHub configuration of registered projects matches
 * github-policy.json. Read-only; uses the `gh` CLI.
 *
 * Usage:
 *   node scripts/check-github-policy.mjs
 *   node scripts/check-github-policy.mjs --project dsh-launcher-panel
 *
 * Fail closed: a missing policy, missing gh, auth failure, query failure, or
 * mismatch exits non-zero. It never changes GitHub settings.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'github-policy.json')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

function gh(args) {
  const result = spawnSync('gh', ['api', ...args], { encoding: 'utf8' })
  if (result.error) throw new Error(`无法执行 gh: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`gh api ${args.join(' ')} 失败: ${(result.stderr || result.stdout).trim()}`)
  }
  return JSON.parse(result.stdout)
}

function hasRule(ruleset, type) {
  return (ruleset.rules ?? []).some((rule) => rule.type === type)
}

function rule(ruleset, type) {
  return (ruleset.rules ?? []).find((item) => item.type === type)
}

function includeRefs(ruleset) {
  return ruleset.conditions?.ref_name?.include ?? []
}

function ownerBypass(ruleset, actorId, mode) {
  const actor = (ruleset.bypass_actors ?? []).find((item) => item.actor_id === actorId)
  return actor?.bypass_mode === mode
}

function checkProject(name, policy, ownerActorId) {
  const repo = policy.repo
  const errors = []
  const pass = (message) => console.log(`  ✓ ${message}`)
  const expect = (condition, message) => {
    if (condition) pass(message)
    else errors.push(message)
  }

  console.log(`\n== ${name} (${repo}) ==`)

  for (const branch of [policy.defaultBranch, policy.integrationBranch].filter(Boolean)) {
    try {
      gh([`repos/${repo}/branches/${branch}`])
      pass(`分支存在: ${branch}`)
    } catch (error) {
      errors.push(`分支不存在或不可读: ${branch} (${error.message})`)
    }
  }

  let rulesets = []
  try {
    rulesets = gh([`repos/${repo}/rulesets`])
    pass(`ruleset 可读: ${rulesets.length} 个`)
  } catch (error) {
    errors.push(`ruleset 查询失败: ${error.message}`)
    return errors
  }

  const strictSummary = rulesets.find((item) => item.name === policy.branchRuleset)
  if (!strictSummary) {
    errors.push(`缺少分支 ruleset: ${policy.branchRuleset}`)
  } else {
    try {
      const strict = gh([`repos/${repo}/rulesets/${strictSummary.id}`])
      expect(strict.target === 'branch', '严格 ruleset target = branch')
      expect(strict.enforcement === 'active', '严格 ruleset active')
      for (const ref of ['refs/heads/main', 'refs/heads/dev']) {
        expect(includeRefs(strict).includes(ref), `严格 ruleset 覆盖 ${ref}`)
      }
      for (const type of ['deletion', 'non_fast_forward', 'required_status_checks', 'pull_request']) {
        expect(hasRule(strict, type), `严格 ruleset 含 ${type}`)
      }

      const checks = rule(strict, 'required_status_checks')?.parameters
      const contexts = (checks?.required_status_checks ?? []).map((item) => item.context).sort()
      expect(
        JSON.stringify(contexts) === JSON.stringify([...policy.requiredChecks].sort()),
        `required checks = ${policy.requiredChecks.join(', ')}`,
      )
      expect(
        (checks?.required_status_checks ?? []).every((item) => item.integration_id === policy.checksIntegrationId),
        `required checks integration_id = ${policy.checksIntegrationId}`,
      )
      expect(checks?.strict_required_status_checks_policy === policy.strictStatusChecks, 'required checks 必须基于最新分支')

      const pr = rule(strict, 'pull_request')?.parameters
      expect(pr?.required_approving_review_count === policy.requiredApprovals, `批准数 = ${policy.requiredApprovals}`)
      expect(pr?.require_code_owner_review === policy.codeOwnerReview, 'code owner review 已开启')
      expect(pr?.require_last_push_approval === policy.lastPushApproval, 'last push approval 已开启')
      expect(pr?.required_review_thread_resolution === policy.reviewThreadResolution, 'review thread resolution 已开启')
      expect(
        JSON.stringify(pr?.allowed_merge_methods ?? []) === JSON.stringify(policy.squashOnly ? ['squash'] : []),
        '只允许 squash merge',
      )
      expect(ownerBypass(strict, ownerActorId, 'pull_request'), 'owner bypass = pull_request')
    } catch (error) {
      errors.push(`严格 ruleset 读取失败: ${error.message}`)
    }
  }

  for (const light of policy.lightBranchRulesets ?? []) {
    const summary = rulesets.find((item) => item.name === light.name)
    if (!summary) {
      errors.push(`缺少轻保护 ruleset: ${light.name}`)
      continue
    }
    try {
      const detail = gh([`repos/${repo}/rulesets/${summary.id}`])
      expect(detail.target === 'branch', `${light.name}: target = branch`)
      expect(includeRefs(detail).includes(light.ref), `${light.name}: 覆盖 ${light.ref}`)
      for (const type of ['deletion', 'non_fast_forward', 'creation']) {
        expect(hasRule(detail, type), `${light.name}: 含 ${type}`)
      }
      expect((detail.bypass_actors ?? []).length === 0, `${light.name}: 无 bypass`)
    } catch (error) {
      errors.push(`${light.name} 读取失败: ${error.message}`)
    }
  }

  const tagSummary = rulesets.find((item) => item.name === policy.tagRuleset)
  if (!tagSummary) {
    errors.push(`缺少 tag ruleset: ${policy.tagRuleset}`)
  } else {
    try {
      const tag = gh([`repos/${repo}/rulesets/${tagSummary.id}`])
      expect(tag.target === 'tag', 'tag ruleset target = tag')
      expect(includeRefs(tag).includes(policy.tagPattern), `tag ruleset 覆盖 ${policy.tagPattern}`)
      for (const type of ['creation', 'update', 'deletion']) {
        expect(hasRule(tag, type), `tag ruleset 含 ${type}`)
      }
      expect(ownerBypass(tag, ownerActorId, policy.tagOwnerBypassMode), 'tag owner bypass = always')
    } catch (error) {
      errors.push(`tag ruleset 读取失败: ${error.message}`)
    }
  }

  try {
    const repoInfo = gh([`repos/${repo}`])
    expect(repoInfo.allow_squash_merge === true, '仓库允许 squash')
    expect(repoInfo.allow_merge_commit === false, '仓库关闭 merge commit')
    expect(repoInfo.allow_rebase_merge === false, '仓库关闭 rebase')
    if (policy.deleteBranchOnMerge !== undefined) {
      expect(repoInfo.delete_branch_on_merge === policy.deleteBranchOnMerge, '合并后自动删除分支')
    }
  } catch (error) {
    errors.push(`仓库设置查询失败: ${error.message}`)
  }

  for (const ref of [policy.defaultBranch, policy.integrationBranch].filter(Boolean)) {
    if (!policy.codeowners) continue
    try {
      gh([`repos/${repo}/contents/${policy.codeowners}?ref=${ref}`])
      pass(`CODEOWNERS 存在: ${ref}`)
    } catch (error) {
      errors.push(`CODEOWNERS 缺失于 ${ref}: ${policy.codeowners} (${error.message})`)
    }
  }

  if (policy.publishWorkflow) {
    try {
      gh([`repos/${repo}/contents/${policy.publishWorkflow}`])
      pass(`publish workflow 存在: ${policy.publishWorkflow}`)
    } catch (error) {
      errors.push(`publish workflow 缺失: ${policy.publishWorkflow} (${error.message})`)
    }
  }

  return errors
}

function main() {
  let policy
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
  } catch (error) {
    console.error(`✗ 无法读取 ${POLICY_PATH}: ${error.message}`)
    process.exit(2)
  }

  const projectArgIndex = process.argv.indexOf('--project')
  const selected = projectArgIndex >= 0 ? process.argv[projectArgIndex + 1] : ''
  const names = selected ? [selected] : Object.keys(policy.projects ?? {})
  if (names.length === 0) {
    console.error('✗ github-policy.json 没有注册任何项目')
    process.exit(2)
  }

  let failed = 0
  for (const name of names) {
    const spec = policy.projects?.[name]
    if (!spec) {
      fail(`未知项目: ${name}`)
      failed += 1
      continue
    }
    const errors = checkProject(name, spec, policy.ownerActorId)
    if (errors.length > 0) {
      failed += 1
      for (const error of errors) console.error(`  ✗ ${error}`)
    } else {
      console.log(`  ✓ ${name}: GitHub 配置与 policy 一致`)
    }
  }

  if (failed > 0) {
    console.error(`\nGitHub policy check: FAILED (${failed}/${names.length})`)
    process.exit(1)
  }
  console.log(`\nGitHub policy check: OK (${names.length} project${names.length === 1 ? '' : 's'})`)
}

main()
