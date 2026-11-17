# dsh-launcher-panel — 项目契约

> 默认只加载本文件。共享规则在本地 `meta/`（来自 `pyai-meta-repo@61c4312`），按任务路由，不默认展开。
> 本地 `meta/` 是完整快照；其中 A/B/I 段、`PROJECTS.md`、`github-policy.json`、`scripts/` 是 meta-repo 自身的仓库/项目/检查工具，不作为本项目规则。冲突时本文件与 `docs/` 优先。
> 可执行检查：[docs/quality-gates.md](docs/quality-gates.md)；发布步骤：[docs/release.md](docs/release.md)。

## 1. 项目是什么

本仓库是 VS Code 扩展「DSH Launcher Panel」的源码仓库。源码在 `src/`；`out/`、`releases/` 与 `*.vsix` 不入库。

- `resources/dsh-icon.woff` 是生成物但随版本入库；`src/holidays.ts` 是手工静态数据，不用脚本抓取。
- README 面向用户写安装/使用/配置；CHANGELOG 写可感知变化；行为变化必须同步。
- 功能契约：[docs/instances-spec.md](docs/instances-spec.md)
- 模块边界：[docs/architecture.md](docs/architecture.md)
- 定位与退役：[docs/positioning-and-retirement.md](docs/positioning-and-retirement.md)
- 可执行规则：[docs/quality-gates.md](docs/quality-gates.md)
- 发布流程：[docs/release.md](docs/release.md)

## 2. 一条主规则

不能证明改动真的工作，就不算完成。

- 结论来自命令输出、文件内容或实际运行结果；
- 未查到写“未查到”，未验证写“未验证”；
- 不可逆操作先取得 owner 同意；
- 状态区分：已实现 / 已提交 / 已推送 / 已发布 / 已上线验证。

## 3. 项目值与接口

- 集成分支 `dev`；默认分支 `main`；工作分支从 `dev` 切出，PR 回 `dev`，合并后删除。
- `feat/*`、`fix/*` 用于短生命周期改动；`pilot/*` 只用于跨多步试点，不常驻。
- `main` 只接受发布 PR，仅 squash 合并。
- `npm run verify` = `lint → typecheck → test → compile → package`；push/PR 前必须全绿。
- CI required checks：`typecheck` / `test` / `build` / `package`；`typecheck` job 先跑 lint。
- `main` / `dev` 只能通过 PR 更新；策略文件由 `.github/CODEOWNERS` 指定 owner 审阅；Agent 不能自己合并。
- `v*` tag 只能由 owner 创建、移动、删除；Agent 不得推送发布 tag。
- 可分发产物输出到 `releases/`，不进入 Git/VSIX。
- 用户文档与 CHANGELOG 保持中英双份并互链。

## 4. 项目规则

- 功能改动先对照 spec 与 architecture；实现、测试、文档与规格一致。
- 先定义边界、验收与失败路径，再写功能；不把未定义行为交给实现猜。
- 单一职责；状态经函数封装；命名达意；死代码、未使用导出不留在仓库。
- `shared/` 保持可单测；模块边界以 architecture 为准；不导入 VS Code 内部模块。
- 活动流 busy 用 `withBusy` 成对收尾；timer/watch/子进程/AbortController 在成功和失败路径都释放。
- 部分失败必须可观察；权限、状态迁移和并发入口要能被打断且保持一致。
- 覆写或删除前确认文件归属；不是本扩展自己的产物不动。
- 纯逻辑改动补 `test/*.test.ts`；测试覆盖失败路径，不能只追求全绿。
- API key/token 不进日志、面板、HTML、提交；外部请求带超时、URL 走白名单。
- 发布前确认版本、CHANGELOG、审计和 owner 当次确认；已发布版本与 tag 不移动。

## 5. 共享规则路由

| 任务 | 打开 |
|---|---|
| 只查不改 / 调查 | [meta/playbooks/investigate.md](meta/playbooks/investigate.md) |
| 修 bug | [meta/playbooks/fix.md](meta/playbooks/fix.md) |
| 新功能 / 行为变更 | [meta/playbooks/feature.md](meta/playbooks/feature.md) |
| 只改结构、不改行为 | [meta/playbooks/refactoring.md](meta/playbooks/refactoring.md) |
| 发布 | [meta/playbooks/release.md](meta/playbooks/release.md) |
| 用户可见验收 | [meta/playbooks/acceptance.md](meta/playbooks/acceptance.md) |
| 审查 diff / PR / 设计 | [meta/skills/review/SKILL.md](meta/skills/review/SKILL.md) |
| 同类错误第二次 / owner 反复纠正 | [meta/skills/correct/SKILL.md](meta/skills/correct/SKILL.md) |
| 工作方式 / 工具 / 文档规范 | [meta/rules/behavior.md](meta/rules/behavior.md) |
| 分支 / 提交 / 发布 / 安全基线 | [meta/rules/delivery.md](meta/rules/delivery.md) |
| 验证 / 代码审计 | [meta/rules/verification.md](meta/rules/verification.md) |
| 判断原则 | [meta/principles/README.md](meta/principles/README.md) |
| 本地 meta 来源与范围 | [meta/SOURCE.md](meta/SOURCE.md) |

项目专属检查与负例在 [docs/quality-gates.md](docs/quality-gates.md)；共享规则不重复写进本文件。

## 6. 硬门禁

| 触发 | 必须做 | 失败时 |
|---|---|---|
| 提交 / 推送 / PR 前 | 跑 `npm run verify` | 停止 |
| 合并前 | required checks 全绿 + owner 批准 | 不合并 |
| 发布前 | `verify` + 告警清零 + owner 当次确认 | 不发布 |
| 改 AGENTS / meta / 检查脚本 / CI | owner 审阅；Agent 不自合并 | 不合并 |
| 用户可见改动 | 实际运行 + 证据 | 不算完成 |

## 7. 错误沉淀

1. 留最小复现/反例；
2. 选择最强可行层：类型/API → lint/策略检查 → 测试 → CI/发布门禁 → 文字；
3. 负例必须红、正常仓库必须绿；
4. 登记 [docs/quality-gates.md](docs/quality-gates.md) 并接入 `npm run verify`；
5. 同类错误第二次出现时，按 [meta/skills/correct/SKILL.md](meta/skills/correct/SKILL.md) 升级。

## 8. 协作与身份

- 用中文交流；commit 描述中文，保留英文类型前缀；代码注释以英文为主并解释“为什么”。
- 结论、状态、失败必须如实；不隐瞒、不编造。
- 改 `AGENTS.md`、`meta/` 或任何门禁须经 owner 明确许可。
- Agent 使用独立身份；不得用 owner 凭据运行自动化。
- 新功能跑通后先讨论重构方案，确认后执行；重构与功能分开提交。
- GitHub 操作统一 `gh`；代理与宿主配置不写进仓库。
