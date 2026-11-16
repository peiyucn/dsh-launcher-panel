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
