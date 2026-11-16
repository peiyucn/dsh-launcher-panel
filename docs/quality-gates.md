# 质量门禁与纠错沉淀

> 本文件是 `dsh-launcher-panel` 的可执行规则目录。规则是否生效以 `npm run verify` 的退出码为准。
> 维护原则：**先有失败样例，再有一条检查，最后才考虑写说明。** 规则变更必须同步本文件、负例测试和 CI。

## 1. 入口

```text
npm run lint             # ESLint 代码规则 + 本文件登记的仓库策略检查
npm run lint:code        # 仅 ESLint
npm run lint:policy      # 仅 scripts/check-policy.mjs
npm run verify           # lint → typecheck → test → compile → package
```

CI 的 `typecheck` job 先跑 lint，再跑 typecheck；因此保护分支上要求的 `typecheck` status 同时覆盖静态检查和类型检查。

## 2. 规则分层

从强到弱；能落在上层的，不要留在下层。

| 层 | 形式 | 适用 |
|---|---|---|
| 1 | 类型、API、数据结构 | 让非法状态无法表达 |
| 2 | ESLint / 静态检查 | 源码模式、禁用 API、依赖方向 |
| 3 | 仓库策略检查 | 文档、workflow、配置、发布门禁 |
| 4 | 测试 | 行为、状态迁移、失败路径 |
| 5 | CI / 发布门禁 | 跨仓库、跨环境、不可提交绕过 |
| 6 | AGENTS.md 文字 | 判断、授权、取舍、为什么 |

第 6 层不是失败：它承担工具无法判断的部分（例如是否允许一次不可逆操作、方案是否合理）。但**可由自动检查判定的规则不应只停留在第 6 层**。

## 3. 已登记检查

### 3.1 仓库策略检查（`scripts/check-policy.mjs`）

每条检查都在 `test/policy-lint.test.ts` 有至少一个负例；正例由真实仓库与干净 fixture 覆盖。

| ID | 检查内容 | 来源 / 防止的错误 |
|---|---|---|
| QG001 | 必读文档存在：AGENTS、双语 README / CHANGELOG、SECURITY、架构 / 规格 / 定位 / 质量门禁 / 发布文档 | 文档遗漏、仓库不可独立维护 |
| QG002 | 双语 README 的 Settings 表键名与顺序 = `package.json` `contributes.configuration.properties` | 面板配置与用户文档漂移 |
| QG003 | `engines.vscode` 为 caret，`@types/vscode` 为精确版本，二者同版 | 类型面漂移到运行时不支持的 API |
| QG004 | 中英 README、中英 CHANGELOG 互相链接 | 双语文档失去入口 |
| QG005 | 两份 CHANGELOG 的最新版本 = `package.json` 版本 | 发布内容不完整 |
| QG006 | `verify` 必须先跑 lint | 检查链被绕过 |
| QG007 | CI job 只使用 E24 名称，顺序为 typecheck → test → build → package | 自创环节、发布链重排 |
| QG008 | publish 使用发布 environment；E18 告警门禁在打包前；tag 提交必须在 main | 绕过安全门禁或从未合并提交发版 |
| QG009 | `releases/`、`*.vsix` 等产物不进 git / VSIX | 产物污染仓库或发布包 |
| QG010 | 测试中不得提交 `.only()` | 只跑一个用例却显示全绿 |

### 3.2 代码规则（`eslint.config.mjs`）

| ID | 规则 | 来源 / 防止的错误 |
|---|---|---|
| E001 | 禁止从 `node:child_process` 导入 `exec` / `execSync` | 拼接命令导致用户路径变成第二条命令（G4） |
| E002 | 禁止 `shell: true` | 参数经 shell 重新解析（G4） |
| E003 | `src/shared/` 不得导入 `vscode` | 纯逻辑层失去可单测性（architecture.md） |
| E004 | 禁止显式 `any` | 外部数据未解析就穿过类型边界（G5） |
| E005 | ESLint recommended + typescript-eslint recommended | 未使用变量、无用赋值、明显错误 |

## 4. 出错后怎么加检查

任何重复错误、或一次代价足够高的错误，按下列顺序沉淀：

1. **留下失败证据**：把出错输入/输出写成最小复现，说明期望行为。
2. **选最高可行层**：能否改类型/API 让错误写不出来？不能，再写检查。
3. **先写负例**：在 `test/policy-lint.test.ts` 或 `test/*.test.ts` 增加“这条检查必须失败”的用例。
4. **实现检查**：代码规则进 `eslint.config.mjs`；仓库规则进 `scripts/check-policy.mjs`；行为规则进 `test/`。
5. **证明正反都成立**：负例必须红；当前正常仓库必须绿。
6. **接入执行链**：`npm run verify`，并确认 CI 的实际 job 会跑到。
7. **登记**：在本文件加一行，写 ID、防的错误、负例位置。
8. **清理文字**：AGENTS.md 中已被检查完整覆盖的描述可以删；判断依据、例外、不可逆操作仍保留。
9. **单独提交**：检查与对应修复可以同一主题提交；不要混入无关功能。

### 什么时候还不该加检查

- 规则只出现一次且没有复发迹象：先修问题，观察；
- 检查会大量误报：先改 API/结构，不要用 lint 硬压；
- 需要业务判断、授权或不可逆操作：留在 AGENTS + 人审；
- 规则本身还在快速变化：先写测试，稳定后再提升为强制检查。

## 5. 分支保护

`main` / `dev` 上启用仓库规则集 `严格 PR 门禁`：

- 只能通过 PR 更新，合并方式仅 squash；
- required checks：`typecheck` / `test` / `build` / `package`，必须是 GitHub Actions（app id 15368）产生，且分支必须与最新目标分支同步；
- bypass 名单为空，管理员同样不能绕过；
- 禁删除、禁强推、禁重写历史；
- 直接 push 到 `dev` 会被 GitHub 拒绝（`Changes must be made through a pull request`）。

边界：仓库 owner 仍可在 GitHub 设置中修改或删除规则集；这是仓库级规则的最终边界，不能靠仓库自身防止 owner 改规则。要让规则本身受约束，需要组织/企业级治理或自托管 Git 的服务端 hook。

## 6. 维护边界

- 规则可以加严；放宽必须说明为什么、并保留历史误报的负例。
- 修改 `eslint.config.mjs`、`scripts/check-policy.mjs` 或保护分支规则，都属于改变“门禁”，应由 owner 审阅。
- 本文件只记录本项目实际执行的检查；通用规则不在本文件复制。
- `AGENTS.md` 负责本项目对 agent 的行为契约；本文件负责自动检查可判定的质量门禁，不取代行为约定。
