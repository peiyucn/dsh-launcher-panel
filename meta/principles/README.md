# 原则索引

> 这是**判断层**。原则不是规则，不规定“必须”，而是遇到取舍时怎么想。
> 被 `playbooks/`、`skills/`、`rules/` 引用；原则本身不依赖它们。

| 原则 | 何时用 |
|---|---|
| [prove-it-works.md](prove-it-works.md) | 声明完成前；需要证据时 |
| [fix-root-causes.md](fix-root-causes.md) | 调试、修 bug、反复失败 |
| [test-behavior-not-implementation.md](test-behavior-not-implementation.md) | 写/改测试时 |
| [sequence-verifiable-units.md](sequence-verifiable-units.md) | 多步工作、迁移、堆 PR |
| [encode-lessons-in-structure.md](encode-lessons-in-structure.md) | 同类错误第二次出现 |
| [laziness-protocol.md](laziness-protocol.md) | 想加抽象/加层/扩大改动时 |
| [model-the-domain.md](model-the-domain.md) | 写状态逻辑、发现重复条件分支时 |
| [boundary-discipline.md](boundary-discipline.md) | 接线验证、错误处理、外部数据时 |

原则是叶子：不引用 playbook、skill 或 rule。
