# dsh-launcher-panel — 项目 AGENTS

> 按 meta I1 只写：项目事实、项目值/接口、override、项目专属规则、本地 meta 引用。
> 共享规则在本地 `meta/`（来自 `pyai-meta-repo@ded482a`）；不复制共享规则。
> 本地快照里 A/B 段、`PROJECTS.md`、`github-policy.json`、`scripts/` 是 meta-repo 工具层，不适用；C/D/E/F/G/H/I 适用。
> 硬门禁见本地 [meta/rules/delivery.md](meta/rules/delivery.md) 和 [meta/rules/verification.md](meta/rules/verification.md)；项目值见下。

## 1. 项目事实

本仓库是 VS Code 扩展「DSH Launcher Panel」的源码仓库。源码在 `src/`；`out/`、`releases/` 与 `*.vsix` 不入库。

- `resources/dsh-icon.woff` 是生成物但随版本入库；`src/holidays.ts` 是手工静态数据，不用脚本抓取。
- README 面向用户写安装/使用/配置；CHANGELOG 写可感知变化；行为变化必须同步。
- 功能契约：[docs/instances-spec.md](docs/instances-spec.md)
- 模块边界：[docs/architecture.md](docs/architecture.md)
- 定位与退役：[docs/positioning-and-retirement.md](docs/positioning-and-retirement.md)
- 项目检查登记：[docs/checks.md](docs/checks.md)
- 发布流程：[docs/release.md](docs/release.md)

## 2. 项目值 / 接口

- 集成分支 `dev`；默认分支 `main`；工作分支从 `dev` 切出，PR 回 `dev`，合并后删除。
- `feat/*`、`fix/*` 用于短生命周期改动；`pilot/*` 只用于跨多步试点，不常驻。
- `main` 只接受发布 PR，仅 squash 合并。
- `npm run verify` = `lint → typecheck → test → compile → package`；push/PR 前必须全绿。
- CI required checks：`typecheck` / `test` / `build` / `package`；`typecheck` job 先跑 lint。
- `main` / `dev` 只能通过 PR 更新；策略文件由 `.github/CODEOWNERS` 指定 owner 审阅；Agent 不能自己合并。
- `v*` tag 只能由 owner 创建、移动、删除；Agent 不得推送发布 tag。
- 可分发产物输出到 `releases/`，不进入 Git/VSIX。
- 用户文档与 CHANGELOG 保持中英双份并互链。

## 3. Overrides

无。分支、发布目录、双语文档、verify 和 tag 规则沿用 meta 的 `overridable` 默认值，未放宽任何 `final`。

## 4. 项目专属规则（scope: project）

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

## 5. 本地 meta

- 来源与范围：[meta/SOURCE.md](meta/SOURCE.md)
- 规则：[meta/rules/README.md](meta/rules/README.md)
- 判断原则：[meta/principles/README.md](meta/principles/README.md)
- 技能：[meta/skills/README.md](meta/skills/README.md)
- 任务步骤：[meta/playbooks/README.md](meta/playbooks/README.md)

按任务从本地 `meta/` 读取；共享规则不复制进本文件。
