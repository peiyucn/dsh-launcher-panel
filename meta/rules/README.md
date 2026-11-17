# 规则索引

> 这是**规范层**的索引。规则正文在 [behavior.md](behavior.md)、[delivery.md](delivery.md)、[verification.md](verification.md)；本文件不重复规则。
> 规则被 `AGENTS.md`、`playbooks/`、`skills/` 引用；规则本身不反向依赖它们。

## 1. 文件

| 文件 | 范围 |
|---|---|
| [behavior.md](behavior.md) | A 仓库约定、B2 目录命名、C 工作约定、D 工具、H 文档规范、I 章节标准 |
| [delivery.md](delivery.md) | E 工程管线、F 安全基线、GitHub 控制映射 |
| [verification.md](verification.md) | E8 本地验证、G 代码审计 |

项目事实（项目清单、项目管线）不在规则层，见 [PROJECTS.md](../PROJECTS.md)。

## 2. 级别

规则标题末尾的〔…〕是约束级别：

| 级别 | 含义 |
|---|---|
| `constructor` | 接入时的一次性动作 |
| `final` | 只能加严，不能放松 |
| `overridable` | 项目填值，但必须在项目 AGENTS 显式声明 |
| `interface` | 项目必须实现，验收方式写在该项目 AGENTS 的工程管线章 |

沿用原规范的定义，不新增级别，也不新增全局规则编号。

`rules/` 中的 A1/C1/E1 等是**原规范章节锚点**，只用于追溯和交叉引用，不是新的编号体系；`AGENTS.md` 和 `PROJECTS.md` 不使用规则编号。

## 3. 原章节落点

| 原章节 | 现在的位置 |
|---|---|
| A1–A3 | [behavior.md](behavior.md) |
| B1 | [PROJECTS.md](../PROJECTS.md) 的项目清单 |
| B2 | [behavior.md](behavior.md) |
| C1–C10 | [behavior.md](behavior.md) |
| D1–D3 | [behavior.md](behavior.md) |
| E1–E7、E9–E24 | [delivery.md](delivery.md) |
| E8 | [verification.md](verification.md) |
| E25 | [PROJECTS.md](../PROJECTS.md) 的项目管线 |
| F1–F6 | [delivery.md](delivery.md) |
| G1–G8 | [verification.md](verification.md) |
| H1–H3 | [behavior.md](behavior.md) |
| I1–I4 | [behavior.md](behavior.md) |

## 4. 规则 ↔ 执行方式

这张表是“完整性”的载体：每条规则都要能在这里找到执行方式。

| 控制 | 规则 | 执行方式 | 证据 |
|---|---|---|---|
| 本地验证 | E8、G8 | 项目 `verify` | `verify` 退出码 |
| 项目检查登记 | E8、G | [checks.md](../checks.md) 复制到项目 `docs/checks.md` + `verify` | 负例/退出码 |
| 提交粒度 | E10 | review | 提交记录 |
| 分支只能 PR | E7、F5 | GitHub ruleset | ruleset 查询 |
| required checks | E24、F5 | 分支保护 / ruleset | checks 列表 |
| 策略文件 owner 审批 | C9、I3 | `.github/CODEOWNERS` | PR review |
| 发布 tag 只能 owner | E19、E21 | tag ruleset | tag 保护 |
| 发布告警清零 | E18 | publish workflow | 告警查询记录 |
| 发布凭据/环境 | E20 | environment + secrets | publish workflow |
| 发布前 owner 同意 | E17 | 人工确认 | 发布记录 |
| 用户可见验收 | G、AGENTS 第 5 节 | playbook + 证据 | 截图/DOM/控制台/网络 |
| 重复错误升级 | skills/correct | 架构/类型/lint/测试 | 规则表更新 |

具体项目的分支、checks、ruleset、发布通道见 [PROJECTS.md](../PROJECTS.md)；这里只定义通用控制。

机器可读期望值在 [github-policy.json](../github-policy.json)；校验命令：

```text
node meta/scripts/check-github-policy.mjs
```

它只读地查询实际 ruleset、required checks、CODEOWNERS、publish workflow 和仓库合并设置；查询失败或不一致都返回非零。失败时先对齐配置，不能把 policy 改松。

## 5. GitHub 控制映射

| 控制 | GitHub 配置 | 说明 |
|---|---|---|
| 分支更新 | ruleset：禁止直推、强推、删除 | 默认分支与集成分支各一条 |
| 合并方式 | 仓库合并设置：仅 squash | 关 merge commit / rebase |
| required checks | ruleset 的 required status checks | 名称取 E24 规定值 |
| 代码归属 | `.github/CODEOWNERS` | 策略文件、检查脚本、CI |
| 发布 tag | tag ruleset：`v*` | 仅 owner 创建/移动/删除 |
| 发布环境 | environment + 环境级 secret | publish job 挂 environment |

这些配置在各子项目仓库，不在 meta；meta 只记录规则和项目事实。

## 6. 依赖方向

```text
AGENTS.md
  → meta/rules/ / meta/principles/ / meta/skills/ / meta/playbooks/ / meta/PROJECTS.md

meta/playbooks/  → meta/skills/ / meta/principles/ / meta/rules/
meta/skills/     → meta/principles/ / meta/rules/
meta/principles/ → 叶子
meta/rules/      → meta/PROJECTS.md（项目值）、GitHub（外部强制）
meta/PROJECTS.md → 只放事实
```

下层不反向引用上层；反向索引只放在各目录的 `README.md`。
