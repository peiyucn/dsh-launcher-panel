# 项目指令 — dsh-launcher-panel

> policy_source: `pyai-meta-repo/POLICY.md@0a207006e83112ebf46463d555afa157ad5642ee`
> agents_source: `pyai-meta-repo/AGENTS.md@0a207006e83112ebf46463d555afa157ad5642ee`
> contract_source: `pyai-meta-repo/PROJECT-CONTRACT.md@0a207006e83112ebf46463d555afa157ad5642ee`
> 本文件包含可独立运行的全局规则副本和项目专属内容；meta 版本是权威来源。
> 每条 `P/I/R` 的 `来源` 标明继承的 meta 规则或 `local`；完整映射见 [docs/rule-traceability.md](docs/rule-traceability.md)。
> 可执行检查以 [docs/quality-gates.md](docs/quality-gates.md) 为准；低频发布步骤见 [docs/release.md](docs/release.md)。

## 0. 全局规则副本

本文件保留可独立运行的本地副本；meta 是权威版本。

| ID | 级别 | 规则 |
|---|---|---|
| M0 | final | 规则/流程/设计不追求一次写完美；运行中发现不合理，应告知 owner 并给出可执行的修改提案，不得默默绕过或长期将就 |
| M1 | final | 未查到写“未查到”，未验证写“未验证”，禁止编造 |
| M2 | final | 结论来自命令输出或文件内容；推断只能作为假设 |
| M3 | final | 不用取巧写法让检查变绿；不隐瞒错误和失败 |
| M4 | final | 进度区分已实现、已提交、已推送、已发布、已上线验证 |
| M5 | final | 不可逆操作执行前取得 owner 同意 |
| M6 | final | 修改 AGENTS/策略文件/required checks 必须 owner 审阅；Agent 不能自己合并 |
| M7 | final | Agent 使用独立 GitHub 身份；隔离由运行环境保证，不靠 wrapper |
| M8 | final | 能用自动检查判定的规则，必须落到检查；重复错误不能只加文字 |
| M14 | final | 用户可见改动必须实际运行并留下可核对证据；工具不可用时明确标注未验证，不得用“应该可以”代替 |
| M15 | final | 项目 AGENTS 必须可独立运转：保留适用的 M/S 本地副本或本地检查，逐条标来源；项目专属 R 标 local；不得引用低频构造/迁移文档 |
| M16 | final | 新项目必须按 PROJECT-CONTRACT 的模板生成；缺少规定文件、章节、脚本或检查的项目不得开始；项目只能在规定扩展点增加内容 |

> M9/M10 是 meta-repo 工作区规则；M11–M13 分别落到本项目的项目值、接口和 meta constructor。测试验收按 meta `TESTING.md` 执行。

- 每条 `P/I/R` 的 `来源` 和完整落点见 [docs/rule-traceability.md](docs/rule-traceability.md)。
- 构造/迁移/排障类低频文档不进入本项目契约；项目运行只依赖 meta 规则和本地事实。

## 1. 项目事实源

本仓库是 VS Code 扩展「DSH Launcher Panel」的源码仓库。源码在 `src/`，`out/`、`releases/` 与 `*.vsix` 不入库。

- `resources/dsh-icon.woff` 是生成物但随版本入库；`src/holidays.ts` 是手工静态数据，不用脚本抓取。
- README 面向用户写安装 / 使用 / 配置；CHANGELOG 写可感知变化；行为变化必须同步。
- 功能契约：[docs/instances-spec.md](docs/instances-spec.md)
- 模块边界：[docs/architecture.md](docs/architecture.md)
- 定位与退役：[docs/positioning-and-retirement.md](docs/positioning-and-retirement.md)
- 可执行规则：[docs/quality-gates.md](docs/quality-gates.md)
- 发布流程：[docs/release.md](docs/release.md)

## 2. 项目值（P）

| ID | 级别 | 来源 | 值 |
|---|---|---|---|
| P1 | overridable | S11 | 集成分支：`dev`；工作分支从 `dev` 切出后 PR 回 `dev`；默认分支：`main` |
| P2 | overridable | S11 | `main` 只接受发布 PR，使用 squash 合并 |
| P3 | overridable | S11 | 可分发产物输出到 `releases/`，不进入 Git/VSIX |
| P4 | overridable | S13 | 用户文档与 CHANGELOG 保持中英双份并互链 |

## 3. 项目接口（I）

| ID | 级别 | 来源 | 接口 |
|---|---|---|---|
| I1 | interface | S8 | `npm run verify` 覆盖 lint → typecheck → test → compile → package；push/PR 前全绿 |
| I2 | interface | S9 | CI required checks：`typecheck` / `test` / `build` / `package`；`typecheck` job 先跑 lint |
| I3 | interface | S10 | `main` / `dev` 只能 PR 更新；策略文件由 CODEOWNERS 指定 owner 审阅；Agent 不能自己合并 |
| I4 | interface | S7 | `v*` tag 只能由 owner 创建、移动、删除；Agent 不得推送发布 tag |
| I5 | interface | S11 | 功能/修复从 `dev` 切短生命周期工作分支（`feat/*`、`fix/*`），经 PR 合回 `dev`；`pilot/*` 只用于跨多步的试点，合并后不再常驻 |

> `dev` 是集成分支，不是直接提交分支。由于 `dev` 禁止直推，任何改动都必须先切工作分支，再由 PR 合并；PR 合并后删除工作分支。

## 4. 项目规则（R）

| ID | 级别 | 来源 | 规则 |
|---|---|---|---|
| R1 | final | S1, S13 | 功能改动先对照 spec 与 architecture；实现、测试、文档与规格一致 |
| R2 | final | S1 | 先定义边界、验收与失败路径，再写功能；不把未定义行为交给实现猜 |
| R3 | final | S2 | 单一职责；状态经函数封装；命名达意；死代码、未使用导出不留在仓库 |
| R4 | final | local | `shared/` 保持可单测；模块边界以 architecture 为准；不导入 VS Code 内部模块 |
| R5 | final | local | 活动流 busy 用 `withBusy` 成对收尾；timer/watch/子进程/AbortController 在成功和失败路径都释放 |
| R6 | final | local | 部分失败必须可观察；权限、状态迁移和并发入口要能被打断且保持一致 |
| R7 | final | local | 覆写或删除前确认文件归属；不是本扩展自己的产物不动 |
| R8 | final | S3 | 纯逻辑改动补 `test/*.test.ts`；测试覆盖失败路径，不能只追求全绿 |
| R9 | final | S4, S5 | 本项目安全实现：API key/token 不进日志、面板、HTML、提交；外部请求带超时、URL 走白名单；子进程使用参数数组，禁止拼接命令行或 `shell: true` |
| R10 | final | S6, S7, S13 | 发布前确认版本、CHANGELOG、审计和 owner 当次确认；已发布版本与 tag 不移动 |
| R11 | final | S12 | 运行时依赖升级手动执行；是否拆补丁版按发布规则，不把依赖变更混入无关改动 |

## 5. 自动检查

机器规则不在本文件重复。代码规则、仓库策略、负例和纠错协议见 [docs/quality-gates.md](docs/quality-gates.md)。

## 6. 错误沉淀

1. 留最小复现/反例；
2. 选择最强可行层：类型/API → lint/策略检查 → 测试 → CI/发布门禁 → 文字；
3. 负例必须红、正常仓库必须绿；
4. 登记 `docs/quality-gates.md` 并接入 `npm run verify`；
5. 只有判断性内容才补本文件，并删除已由检查覆盖的描述。

## 7. 协作约定

- 用中文交流；commit 描述中文，代码注释以英文为主并解释“为什么”。
- 新功能跑通后先讨论重构方案，确认后执行；重构与功能分开提交。
- GitHub 操作统一 `gh`；代理与宿主配置不写进仓库。
