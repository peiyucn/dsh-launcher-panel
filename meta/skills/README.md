# 技能索引

> 技能是**可复用能力**：有明确触发条件，被 playbook 或 owner 调用。技能不是规则，也不是完整任务流程。
> 目前只有两个；等出现第三个“被多个 playbook 复用的能力”再加。

| 技能 | 触发 | 输出 |
|---|---|---|
| [correct/SKILL.md](correct/SKILL.md) | 同类错误第二次出现；owner 反复纠正 | 结构/检查/规则表的变化 |
| [review/SKILL.md](review/SKILL.md) | 审查 diff / PR / 设计 | findings + verdict + 证据 |

## 和 playbook / principle 的区别

| 层 | 回答 |
|---|---|
| playbook | 这类任务按什么顺序做 |
| skill | 这个能力怎么用，输入/输出是什么 |
| principle | 遇到判断时怎么想 |
| rule | 什么必须成立 |

技能可以被多个 playbook 调用；技能自己不调用 playbook，只引用 principle/rule。

## 说明

这些是 **workspace skills**：普通 Markdown，由 `AGENTS.md` 路由后读取，不是 DSH 插件的 `/` 命令。以后如果需要真正的 `/correct`、`/review`，再打包成 DSH 插件。
