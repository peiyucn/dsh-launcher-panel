# 任务步骤索引

> Playbook 是**任务步骤**：这类任务按什么顺序做、每步要什么证据、什么时候停。
> 被 `AGENTS.md` 路由；playbook 可以引用 `skills/`、`principles/`、`rules/`，不反向被引用。

| 任务 | Playbook | 不适用时 |
|---|---|---|
| 只查不改 / 调查 | [investigate.md](investigate.md) | 要改代码 → fix/feature/refactoring |
| 修 bug | [fix.md](fix.md) | 行为本来就要变 → feature |
| 新功能 / 行为变更 | [feature.md](feature.md) | 行为不能变 → refactoring |
| 只改结构、不改行为 | [refactoring.md](refactoring.md) | 要加行为 → feature |
| 发布 | [release.md](release.md) | 还没到发布 → 对应任务 playbook |
| 用户可见验收 | [acceptance.md](acceptance.md) | 纯代码审查 → review skill |

## 怎么用

1. 按 `AGENTS.md` 的路由打开对应 playbook；
2. 把步骤原样拷进 todo；
3. 不跳步；确实不适用的步骤保留，写 `skip: 原因`；
4. 每步完成时写证据，不是只打勾；
5. 结束时按 playbook 的输出格式汇报。

## 和 skill / principle / rule 的区别

| 层 | 回答 |
|---|---|
| playbook | 这类任务按什么顺序做 |
| skill | 某个能力怎么用 |
| principle | 判断时怎么想 |
| rule | 什么必须成立 |

Playbook 是流程，不重复规则正文；需要时引用 `rules/` 和 `principles/`。
