# 软件工程升级：从说明到可执行门禁

> 面向团队的实施说明。目标不是“多写一些规范”，而是把 Agent 的行为约束落到自动检查、分支保护和可审计的变更流程里。
>
> 参考实现：`dsh-launcher-panel`。当前状态以第 5 节为准；未合并、未接受邀请、未实测的事项不得标为完成。

## 1. 一句话方案

**能由工具判定的规则，写成检查；不能由工具判定的规则，才留在 AGENTS；两者都不能绕过 owner 控制的变更流程。**

这套升级解决三个问题：

1. Agent 写了违规代码，只靠提示词不一定能拦住；
2. 每个项目复制一份长 AGENTS，规则容易漂移、上下文成本高；
3. 规则改了、检查没跟上，最后只剩“文档上写过”。

## 2. 设计原则

| 原则 | 含义 |
|---|---|
| 检查优先 | 能用 ESLint、测试、策略脚本、CI 判定的，不写成长篇说明 |
| 负例优先 | 新规则必须先有一个“违反它必须失败”的样例 |
| 分级而非平铺 | 规则分为人工判断、可执行检查、项目填写值、一次性接入 |
| 策略文件受保护 | AGENTS、检查脚本、workflow、依赖清单的改动必须 owner 审阅 |
| Agent 与人身份分离 | Agent 能开 PR，不能自己合并策略变更 |
| 渐进落地 | 先在一个仓库跑通，再复制结构，不复制所有具体规则 |

## 3. 从零开始的仓库结构

```text
repo/
├─ AGENTS.md                    # 只保留工具无法判断的规则
├─ docs/
│  ├─ quality-gates.md          # 可执行规则目录、级别、负例、纠错流程
│  └─ release.md                # 低频发布流程
├─ eslint.config.mjs            # 代码级检查
├─ scripts/
│  ├─ check-policy.mjs          # 仓库/文档/CI 策略检查
│  └─ check-security-alerts.sh  # 发布安全门禁（按项目）
├─ test/
│  ├─ policy-lint.test.ts       # 策略检查的负例
│  └─ *.test.ts                 # 行为测试
├─ .github/
│  ├─ workflows/ci.yml          # lint → typecheck → test → build → package
│  ├─ CODEOWNERS                # 策略文件指定 owner 审阅
│  └─ pull_request_template.md
└─ package.json                 # verify / lint 入口
```

### 3.1 三层分工

| 层 | 内容 | 谁判断 |
|---|---|---|
| 自动检查 | 代码模式、仓库一致性、发布门禁、测试 | ESLint / 脚本 / 测试 / CI |
| 人工判断 | 需求边界、架构取舍、安全威胁、不可逆操作、例外 | Agent + owner |
| 规则治理 | 谁能改规则、如何验收、如何审计 | owner + 分支保护 / CODEOWNERS |

### 3.2 规则记录字段

每条规则至少记录：

```text
ID        稳定编号，不因章节移动而重编
级别      final / overridable / interface / constructor
内容      规则本身
执行      检查命令、测试位置或“人工审阅”
负例      能证明检查有效的失败样例
变更      谁能修改这条规则
```

编号形式可以保留，但不要复用旧编号；新建项目使用自己的稳定 ID。自动检查用 `QG/E`，人工规则用 `R`，项目特定值用 `P`。

## 4. 实施步骤

### Step 0：准备环境

- GitHub 仓库；建议公开仓库，或确认付费计划支持私有仓库的分支保护/ruleset；
- GitHub Actions 可运行；
- Node.js 与包管理器版本固定；
- owner 账号、独立的 Agent 账号（例如 `peiyucn-agent`）；
- Agent 账号只给 write，不给 admin；
- owner 保留最终合并权。

### Step 1：写薄 AGENTS

只保留：

- 项目事实源：spec、architecture、release 等文档入口；
- 命令：`verify`、`lint`、`test`；
- 分支、提交、发布边界；
- 工具无法判断的规则；
- 重复错误的沉淀流程；
- 协作约定。

不要复制大段共享规范；自动检查覆盖的内容在 `quality-gates` 中维护。

### Step 2：建立自动检查

1. 代码检查：ESLint + TypeScript 规则；
2. 仓库检查：无依赖 Node 脚本，检查文档、配置、CI、发布门禁、产物、测试焦点；
3. 行为检查：现有测试与新增回归测试；
4. 把所有入口接到 `verify`：

```json
{
  "scripts": {
    "lint": "npm run lint:code && npm run lint:policy",
    "lint:code": "eslint src test",
    "lint:policy": "node scripts/check-policy.mjs",
    "verify": "npm run lint && npm run typecheck && npm test && npm run compile && npm run package"
  }
}
```

### Step 3：负例先行

每条自动检查必须有至少一个失败样例：

- 改错 README 配置表 → 对应策略检查失败；
- 提交 `.only` → 测试焦点检查失败；
- 把发布安全门禁移到打包之后 → 发布流程检查失败；
- 违反 ESLint 禁用规则 → lint 失败。

验收标准：**负例必红，正常仓库必绿。** 只有规则配置、没有失败样例的检查，视为未完成。

### Step 4：CI 与 required checks

- `ci.yml` 依次运行 `lint`、`typecheck`、`test`、`build`、`package`；
- 每个 job 名称保持稳定，作为 required status check；
- 分支保护只把这些检查作为合并门槛，不允许只靠人工核对；
- 如果项目没有 package 产物，不要虚设 package job。

### Step 5：分支保护

对 `main` / `dev` 启用：

- 只能通过 PR 更新；
- 仅 squash；
- required checks 全绿，分支必须与目标分支同步；
- 禁删除、禁强推、禁重写历史；
- 策略文件由 `.github/CODEOWNERS` 指定 owner；
- Agent 不能自己合并策略 PR。

单人仓库的现实取舍：

- owner 可以保留“自己的 PR 合并绕过”，否则无法合并自己的策略 PR；
- 直推仍然禁止；
- 如果要 owner 也被独立审阅，需要第二个可信账号或组织级治理，个人仓库无法完全做到。

### Step 6：Agent 身份分离

- Agent 使用独立账号，write 权限即可；
- 不要用 owner 的 `gh` 凭据运行自动化；
- Agent 只能推功能分支、开 PR；
- owner 审批并合并；
- 策略文件和 AGENTS 的改动走单独 PR，不和业务改动混在一起。

### Step 7：建立纠错沉淀流程

每次发现重复错误：

1. 留最小复现；
2. 选择最强可行层：类型/API → lint/策略 → test → CI/发布门禁 → 文字；
3. 先写负例；
4. 实现检查；
5. 证明负例红、正常仓库绿；
6. 接入 `verify` 和 CI；
7. 登记到 `quality-gates`；
8. 删除 AGENTS 中已被检查覆盖的描述；
9. 单独提交。

**只加文字、不加检查，不算修复。**

### Step 8：推广到其他项目

不要复制 launcher 的全部规则：

- 先复制目录结构与门禁原则；
- 每个项目保留自己的 `verify`、规则 ID、负例；
- 公共判断规则保持短小，项目只写差异；
- 每接入一个项目，先跑通“CI 全绿 + 直推被拒 + Agent PR 需要 owner 审阅”三项验收。

## 5. 当前参考实现状态

### 5.1 已配置完成

| 项 | 状态 | 证据 |
|---|---|---|
| 薄 AGENTS | 已完成（当前分支 / PR #5） | `dsh-launcher-panel/AGENTS.md` 105 行，只保留边界、授权与判断规则 |
| 自动检查 | 已完成（PR #5，CI 全绿） | ESLint + `QG001–QG010` + 负例测试；`npm run verify` 通过 298 tests |
| 本地验证入口 | 已完成（PR #5） | `npm run verify` = lint → typecheck → test → compile → package |
| CI lint | 已完成（PR #5） | `typecheck` job 先跑 `npm run lint` |
| 仓库策略检查 | 已完成（PR #5） | `scripts/check-policy.mjs` + `test/policy-lint.test.ts` |
| 严格分支保护 | 已配置 | `main` / `dev` 禁止直推，required checks 四个，禁强推/删除；实测 owner 直推被拒 |
| 策略文件保护 | 已写入 PR #5，待合并生效 | `.github/CODEOWNERS`；ruleset 已要求 code owner review |
| Agent 账号邀请 | 已发出邀请，待接受 | `peiyucn-agent` 以 write 权限受邀，尚未出现在 collaborators 列表 |

### 5.2 待办

| 项 | 待办内容 | 完成标准 |
|---|---|---|
| 合并参考实现 | 合并 PR #5 到 `dev`，让 CODEOWNERS 在默认分支生效 | `dev` 上存在 CODEOWNERS，后续策略 PR 需要 owner review |
| 接受 Agent 邀请 | 用 `peiyucn-agent` 接受 GitHub 邀请 | `collaborators` 中出现 `peiyucn-agent`，write 权限 |
| 实测 Agent 拦截 | Agent 修改 `AGENTS.md` 开 PR，尝试自己合并 | PR 被 owner review 要求拦住，Agent 无法合并 |
| 规则编号与级别 | 给人工规则分配 `R1…`、给项目值分配 `P1…`，在 quality-gates 增加级别/执行/负例字段 | 规则可被稳定引用，`final` 有执行和变更控制 |
| final 完整性测试 | 测试断言必需的 `final` 规则仍在配置中、未被禁用 | 删除或改弱规则时 CI 失败 |
| 根 AGENTS 替换 | 用这套结构替换 meta-repo 的通用规则 | 根仓库只保留入口、判断规则和门禁清单 |
| 其他项目推广 | 逐个接入 lint / 策略检查 / 分支保护 | 每个项目独立验收通过 |

## 6. 从零验收清单

在一个新仓库上按顺序验证：

- [ ] 干净 clone 后 `npm ci` 与 `npm run verify` 通过；
- [ ] 故意改错 README 配置表，策略检查失败；
- [ ] 故意提交 `.only`，策略检查失败；
- [ ] 故意关闭一条 required lint，检查失败（或 final 完整性测试失败）；
- [ ] 直接 `git push` 到 `dev` / `main` 被 GitHub 拒绝；
- [ ] Agent 修改 `AGENTS.md` 开 PR，不能自行合并，必须 owner review；
- [ ] 业务改动 PR 通过四项 required checks 后可合并；
- [ ] owner 自己的策略 PR 有明确的合并路径（第二审阅者或 owner bypass）；
- [ ] 规则变更与业务改动分开提交、分开 PR；
- [ ] 失败样例、规则 ID、AGENTS 引用三者一致。

## 7. 边界与风险

- GitHub 云端不能对“任意分支的任意 push”做任意内容拦截；能保证的是受保护分支只能通过 PR 和 checks 更新；
- required checks 只约束 PR 合并，不替代分支保护；
- CODEOWNERS 只在默认分支存在时生效；
- owner 可以修改规则集；`final` 约束的是 Agent / 协作者 / 误操作，不是绝对约束 owner；
- Agent 与 owner 共用凭据时，平台无法区分操作者；必须使用独立账号；
- 私有仓库的分支保护/ruleset 取决于 GitHub 计划；
- 没有负例的检查不可信；没有 owner 审阅的策略文件不可信。

## 8. 团队落地建议

1. 选一个真实仓库做参考实现，不先写“通用平台”；
2. 先把现有 AGENTS 拆成“自动检查 / 判断规则 / 低频流程”三类；
3. 只选 3–5 条高价值规则先做成检查和负例；
4. 接 CI 和分支保护，让门禁真实生效；
5. 再补 Agent 独立身份和 CODEOWNERS；
6. 最后复制模板到其他项目，不复制具体规则值。

完成标志不是“文档写完了”，而是：**新 Agent 违规改动会被 CI 或 review 拦住，且 owner 能用一条命令复现全部门禁。**

## 9. meta-repo 与项目 AGENTS 的继承

### 9.1 先明确：Git 没有真正的“继承”

多个仓库之间没有运行时的父类/子类关系。所谓继承，实际是三件事：

1. **复制**共享规则的受控副本到项目；
2. **锁定**它来自哪个 meta-repo 版本；
3. 用 **CI 检查 + CODEOWNERS** 保证副本没有被静默修改。

不要依赖“Agent 会去读另一个仓库”；单独 clone 项目时，它读不到 meta-repo。项目必须有本地策略副本或本地检查。

### 9.2 meta-repo 的 AGENTS 写什么

meta-repo 的 `AGENTS.md` 只负责全局约定，不复制项目实现：

```text
# 工作区总规范

## 0 阅读顺序
AGENTS → PROJECTS → POLICY → 项目 AGENTS

## 1 项目清单
见 PROJECTS.md（目录、仓库、可见性、档位、开发分支）

## 2 全局硬规则（final）
M1 未知须明示
M2 结论须有依据
M3 不可逆操作先经 owner 同意
M4 策略文件变更须 owner 审批
M5 Agent 使用独立身份，不得用 owner 凭据
...

## 3 规则级别与继承
final / overridable / interface / constructor 的定义

## 4 策略分发与版本锁
policy_source、policy.lock、同步和校验方式

## 5 变更权限
谁能改 meta policy、项目和规则文件

## 6 文档索引
```

以下内容不放 meta AGENTS：

- 各项目的架构、功能契约、测试矩阵；
- 完整的 Lint 规则和命令；
- 低频发布步骤、恢复步骤、环境安装步骤；
- 项目专属的取值和例外。

### 9.3 项目 AGENTS 写什么

```text
# 项目指令

> policy_source: pyai-meta-repo@<commit>
> policy_hash: <hash>
> 本文只写项目差异；共享规则见 docs/policy/global.md

## 1 事实源
spec / architecture / release / quality-gates

## 2 命令与门禁
verify / lint / test / required checks

## 3 项目规则
R1...（人工判断）、P1...（项目填写值）

## 4 final 规则副本（只读）
从 meta policy 生成，不许在项目内改

## 5 错误沉淀
复现 → 负例 → 检查 → 登记
```

项目 AGENTS 的目标长度应保持在百行左右；超过时先问：**这条内容能否变成检查、能否移到事实源文档、是否只是项目值。**

### 9.4 继承与权限标签的硬控制

| 标签 | 项目里怎么落 | 怎么硬控制 |
|---|---|---|
| `final` | 只读副本；不能项目内覆盖 | meta 侧 owner 审批；项目 CODEOWNERS 保护副本；`policy_hash` 不一致 CI 失败；Agent 无合并权 |
| `overridable` | 项目配置/AGENTS 中声明值 | 允许列表 + schema；策略检查拒绝未知键或越权值 |
| `interface` | 项目必须实现 `verify` / required check | 分支保护要求对应 checks；缺失即不能合并 |
| `constructor` | 只在 setup 文档/脚本 | 低频，不进 AGENTS；不参与运行时继承 |

“硬控制”的关键不是标签本身，而是：

1. `final` 规则有执行检查或明确人审点；
2. 规则副本和门禁文件在 CODEOWNERS 保护路径中；
3. Agent 使用独立身份，不能自己合并；
4. meta 侧 owner 才能改 `final`，项目侧只能消费；
5. `policy_hash` 不一致时 CI 失败（检测漂移，不替代权限控制）。

## 10. 哪些内容单独拆出 md，为什么

| 内容 | 位置 | 为什么 |
|---|---|---|
| 全局行为契约 | meta `AGENTS.md` | 每个会话都需要；保持短小 |
| 项目清单 | meta `PROJECTS.md` | 变化频率高，不是 agent 行为规则 |
| 共享规则目录（带 ID/级别） | meta `POLICY.md` | 可审计、可版本锁，不需要每次加载全文 |
| 规则同步/发布说明 | meta `docs/` | 低频、面向维护者 |
| 项目专属判断规则 | 项目 `AGENTS.md` | 离开项目就没有意义 |
| 自动检查规则 | 项目 `docs/quality-gates.md` + 代码 | 高频变化，必须和检查/负例同步 |
| 发布流程 | 项目 `docs/release.md` | 低频、高风险，只在发版时读 |
| 架构/边界 | 项目 `docs/architecture.md` | 面向开发者，内容长且随代码变化 |
| 功能契约/验收矩阵 | 项目 `docs/spec.md` | 面向产品行为，不是 agent 规则 |
| 用户文档/安全策略 | 项目 README / CHANGELOG / SECURITY.md | 面向用户/平台，不是 agent 行为 |
| 一次性接入/恢复 | setup 文档或脚本 | 低频；没有独有知识时直接删除 |

判断标准：

- **每次会话都要看** → AGENTS；
- **机器能判定** → 检查代码/脚本；
- **低频、面向操作** → 独立 runbook；
- **只描述项目事实** → 项目 docs；
- **只是项目值** → 配置，不复制规则正文。

## 11. 哪些规则做成 lint，为什么

### 11.1 适合自动检查

| 特征 | 原因 |
|---|---|
| 结果确定 | 同样输入每次结果相同，不依赖理解 |
| 错误可定位 | 能给文件/行/规则 ID |
| 高频或高风险 | 值得长期维护一条检查 |
| 有稳定反例 | 能证明检查有效 |
| 不依赖业务判断 | 不需要 owner 解释取舍 |

当前参考实现的检查：

**代码级（ESLint）**

| ID | 规则 | 原因 |
|---|---|---|
| E001 | 禁止 `exec` / `execSync` | 防止命令拼接和注入 |
| E002 | 禁止 `shell: true` | 防止参数被 shell 重新解析 |
| E003 | `src/shared/` 禁止 import `vscode` | 保持纯逻辑可单测 |
| E004 | 禁止显式 `any` | 外部数据必须显式解析 |
| E005 | ESLint / typescript-eslint recommended | 未使用变量、无用赋值等通用错误 |

**仓库级（`check-policy.mjs`）**

| ID | 检查 | 原因 |
|---|---|---|
| QG001 | 必读文档存在 | 防止仓库不可独立维护 |
| QG002 | README Settings 与 package.json 一致 | 防止用户文档漂移 |
| QG003 | `engines.vscode` 与 `@types/vscode` 对齐 | 防止类型面高于运行时 |
| QG004 | 双语 README / CHANGELOG 互链 | 防止入口丢失 |
| QG005 | CHANGELOG 版本 = package.json | 防止发布内容不完整 |
| QG006 | `verify` 必须先跑 lint | 防止检查链被绕过 |
| QG007 | CI 环节名称/顺序 | 防止自创环节和发布链漂移 |
| QG008 | 发布环境/安全门禁/tag 在 main | 防止绕过发布门禁 |
| QG009 | 发布产物不进仓库/VSIX | 防止产物污染 |
| QG010 | 测试不得提交 `.only` | 防止假全绿 |

### 11.2 不适合自动检查

- 需求是否清晰、架构是否合理；
- 安全威胁模型、业务取舍；
- 是否允许一次不可逆操作；
- 发布时机和发布范围；
- 命名是否有语义、测试是否真正有意义。

这些留在 AGENTS，由 owner 或人审负责；测试可以覆盖行为，但不能替代判断。

## 12. 仓库权限怎么设置，为什么

### 12.1 角色

| 角色/对象 | 权限 | 为什么 |
|---|---|---|
| owner（`peiyucn`） | admin；最终合并与发布审批 | 保留最终责任；直推仍被规则集禁止 |
| Agent（`peiyucn-agent`） | **write**，不给 admin | 能开分支/PR，不能改仓库设置、不能改规则集 |
| 其他协作者 | 只读或按需 write，不给 admin | 最小权限 |
| 外部贡献者 | 通过 fork/PR；不直接给写权限 | 代码审查边界清晰 |

Agent 不应使用 owner 的 gh 凭据；否则平台看到的是 owner，所有身份分离失效。

### 12.2 分支规则

`main` / `dev`：

- 只能通过 PR；
- 仅 squash；
- required checks：`typecheck`、`test`、`build`、`package`；
- required approvals ≥ 1；
- require code owner review；
- require last push approval；
- 禁删除、禁强推、禁重写历史；
- bypass 只给 owner 的 PR 合并；直推仍然禁止。

### 12.3 策略文件

`.github/CODEOWNERS` 保护：

```text
AGENTS.md
docs/quality-gates.md
docs/release.md
docs/engineering-upgrade.md
eslint.config.mjs
scripts/check-policy.mjs
scripts/check-security-alerts.sh
test/policy-lint.test.ts
package.json
package-lock.json
.github/
```

为什么：Agent 可以改业务代码，但不能靠改检查、改规则、改 workflow 让自己变绿。策略文件必须由 owner 审阅。

### 12.4 Actions 与凭据

- CI 默认 `contents: read`；
- 发布 job 才给 `contents: write` / `security-events: read`；
- `VSCE_PAT`、`SECURITY_ALERTS_TOKEN` 放 `marketplace-publish` 环境级 secret；
- 仓库级 secret 不保留；
- 不在日志、README、聊天中输出 token。

### 12.5 当前状态说明

- `peiyucn-agent` 已收到 write 邀请，尚未接受；接受后才真正具备独立身份；
- `.github/CODEOWNERS` 已在 PR #5 中，尚未合并到默认分支，因此还不能视为已生效；
- ruleset 已要求 code owner review / 最后推送审批；
- owner 的 PR 合并保留 bypass，直推仍被拒绝；
- 私有仓库在 GitHub Free 下无法使用同等保护，需要 Pro/Team 或明确接受降级。

### 12.6 贡献图与身份分离的取舍

GitHub 的 contribution graph 主要按**提交作者邮箱**归属，而不是仓库 owner。因此：

- Agent 用自己的账号提交，绿格记在 Agent 账号上；
- owner 只合并 PR，不会自动获得这些提交的贡献；
- owner 自己提交、提交 review、创建 issue/PR 才会记入自己的贡献图。

这是身份分离的代价，不是配置错误。可选的处理方式：

| 方式 | 结果 | 建议 |
|---|---|---|
| 接受贡献图减少 | 审计清晰，Agent 行为可区分 | **推荐**，尤其团队仓库 |
| owner 实际参与 review / 修复 / 文档提交 | owner 仍有真实贡献记录 | 推荐 |
| 对确有共同创作的提交加 `Co-authored-by` | 双方都获得贡献归属 | 仅在 owner 真正参与时使用 |
| 把所有 Agent 提交伪造成 owner 作者 | 点阵好看，但审计身份失效 | **不推荐** |

GitHub 的官方规则：提交作者邮箱必须关联账号；共同作者提交也按同样条件计入贡献图（[Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)）。不要为了绿格伪造 co-author；安全审计比贡献图重要。

## 13. meta-repo 替换的迁移顺序

不要先改根 AGENTS，再补项目：

1. 在一个项目验证 AGENTS / quality-gates / CODEOWNERS / Agent 身份；
2. 生成 `POLICY.md` 和 `PROJECTS.md`，只迁移已验证的全局规则；
3. 项目保留 `policy_source` + `policy.lock`，接入同步检查；
4. 用 CODEOWNERS 和分支保护保护策略文件；
5. 逐个接入项目，先跑“CI 全绿 + 直推拒绝 + Agent PR 需审阅”三项；
6. 最后替换 meta-repo AGENTS，删除已由自动检查覆盖的共享段落；
7. 保留旧规则 ID 到新 ID 的迁移表，避免文档和 commit 引用断链。

## 14. 一句话总结

**meta-repo 负责定义和分发规则，项目负责本地执行；继承不是读取父文件，而是受控复制 + 版本锁 + CI 校验；final 不是标签，而是检查、CODEOWNERS、独立身份和 owner 审批四件事的组合。**
