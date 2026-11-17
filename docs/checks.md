# 项目检查登记

> 这是 `dsh-launcher-panel` **项目专属**的可执行检查表。格式来自 [meta/checks.md](../meta/checks.md)（meta `0e0a5dc`），保留表头和列名。
> 通用分层、登记要求、加检查顺序见 [local meta/rules/verification.md](../meta/rules/verification.md)；重复错误升级见 [local meta/skills/correct/SKILL.md](../meta/skills/correct/SKILL.md)。

## 1. 入口

```text
npm run lint             # ESLint 代码规则 + 本文件登记的仓库策略检查
npm run lint:code        # 仅 ESLint
npm run lint:policy      # 仅 scripts/check-policy.mjs
npm run verify           # lint → typecheck → test → compile → package
```

CI 的 `typecheck` job 先跑 lint，再跑 typecheck；因此保护分支上要求的 `typecheck` status 同时覆盖静态检查和类型检查。

## 2. 检查表

| ID | 检查 | 防止的错误 | 负例 | 执行入口 |
|---|---|---|---|---|
| QG001 | 必读文档存在：AGENTS、双语 README / CHANGELOG、SECURITY、架构 / 规格 / 定位 / 检查 / 发布 | 文档遗漏、仓库不可独立维护 | `test/policy-lint.test.ts` QG001 | `npm run lint:policy` |
| QG002 | 双语 README 的 Settings 表键名与顺序 = `package.json` `contributes.configuration.properties` | 面板配置与用户文档漂移 | `test/policy-lint.test.ts` QG002 | `npm run lint:policy` |
| QG003 | `engines.vscode` 为 caret，`@types/vscode` 为精确版本，二者同版 | 类型面漂移到运行时不支持的 API | `test/policy-lint.test.ts` QG003 | `npm run lint:policy` |
| QG004 | 中英 README、中英 CHANGELOG 互相链接 | 双语文档失去入口 | `test/policy-lint.test.ts` QG004 | `npm run lint:policy` |
| QG005 | 两份 CHANGELOG 的最新版本 = `package.json` 版本 | 发布内容不完整 | `test/policy-lint.test.ts` QG005 | `npm run lint:policy` |
| QG006 | `verify` 必须先跑 lint | 检查链被绕过 | `test/policy-lint.test.ts` QG006 | `npm run lint:policy` |
| QG007 | CI job 只使用规定的环节名称，顺序为 typecheck → test → build → package | 自创环节、发布链重排 | `test/policy-lint.test.ts` QG007 | `npm run lint:policy` |
| QG008 | publish 使用发布 environment；发布安全门禁在打包前；tag 提交必须在 main | 绕过安全门禁或从未合并提交发版 | `test/policy-lint.test.ts` QG008 | `npm run lint:policy` |
| QG009 | `releases/`、`*.vsix` 等产物不进 git / VSIX | 产物污染仓库或发布包 | `test/policy-lint.test.ts` QG009 | `npm run lint:policy` |
| QG010 | 测试中不得提交 `.only()` | 只跑一个用例却显示全绿 | `test/policy-lint.test.ts` QG010 | `npm run lint:policy` |
| E001 | 禁止从 `node:child_process` 导入 `exec` / `execSync` | 拼接命令导致用户路径变成第二条命令 | 无独立负例（ESLint 规则） | `npm run lint:code` |
| E002 | 禁止 `shell: true` | 参数经 shell 重新解析 | 无独立负例（ESLint 规则） | `npm run lint:code` |
| E003 | `src/shared/` 不得导入 `vscode` | 纯逻辑层失去可单测性（architecture.md） | 无独立负例（ESLint 规则） | `npm run lint:code` |
| E004 | 禁止显式 `any` | 外部数据未解析就穿过类型边界 | 无独立负例（ESLint 规则） | `npm run lint:code` |
| E005 | ESLint recommended + typescript-eslint recommended | 未使用变量、无用赋值、明显错误 | 无独立负例（ESLint 规则） | `npm run lint:code` |

E001–E005 由 ESLint 规则执行，目前没有单独负例；这是已知缺口，不假装有。补负例时优先用 ESLint API 对坏样例跑一次。

## 3. 分支保护（项目值）

`main` / `dev` 上启用仓库规则集 `严格 PR 门禁`：

- 只能通过 PR 更新，合并方式仅 squash；
- required checks：`typecheck` / `test` / `build` / `package`，必须是 GitHub Actions（app id 15368）产生，且分支必须与最新目标分支同步；
- `AGENTS.md`、`meta/`、检查登记、发布文档、ESLint / policy 脚本、CI workflow 和依赖清单由 `.github/CODEOWNERS` 指定 owner 审阅；
- Agent 的 PR 需要 owner 批准；`require_last_push_approval` 防止批准后又推入新改动；
- `v*` tag 单独保护：只有 owner 能创建、移动或删除；Agent 不能推送发布 tag；
- 禁删除、禁强推、禁重写历史；
- 直接 push 到 `dev` 会被 GitHub 拒绝（`Changes must be made through a pull request`）。

边界：owner 对自己的 PR 保留合并绕过；直推仍被禁止。仓库 owner 仍可在 GitHub 设置中修改或删除规则集；这是仓库级规则的最终边界。

## 4. 新增项目检查

1. 在 `test/policy-lint.test.ts` 或 `test/*.test.ts` 先写负例；
2. 代码规则进 `eslint.config.mjs`；仓库规则进 `scripts/check-policy.mjs`；行为规则进 `test/`；
3. 跑 `npm run verify`，确认负例红、正常仓库绿；
4. 在本文件登记 ID、防的错误、负例位置、执行入口；
5. 修改门禁后由 owner 审阅；Agent 不自合并。

## 5. 维护边界

- 规则可以加严；放宽必须说明为什么、并保留历史误报的负例。
- 修改 `eslint.config.mjs`、`scripts/check-policy.mjs` 或保护分支规则，都属于改变“门禁”，应由 owner 审阅。
- `meta/` 是 `pyai-meta-repo` 的共享规则快照；改规则先改 meta，再整体覆盖本目录，不单独改快照。
- 本文件只记录本项目实际执行的检查；通用方法不在本文件复制。
