# 规则继承追溯

> 本文件回答“这条项目规则从哪来”。运行契约在 [AGENTS.md](../AGENTS.md)，本文件只做追溯，不新增规则。
> `来源` 的取值：`M#` / `S#` 表示 meta 规则，`local` 表示项目自定；项目规则只能加严，不能放松 meta `final`。

## Meta M 规则

| Meta | 本项目处理 | 说明 |
|---|---|---|
| M0–M8 | 继承 | 在 AGENTS §0 摘要 |
| M9 | 不适用 | meta-repo 工作区规则 |
| M10 | 不适用 | meta-repo 工作区文件命名规则 |
| M11 | P1–P3、I5 | 项目分支/产物值由本项目声明 |
| M12 | I1、I2 | `verify` 与 required checks |
| M13 | playbook | 新项目接入/恢复走低频文档 |
| M14 | 继承 | 用户可见改动必须实际运行并留证据 |

## Meta S 规则

| Meta | 本项目落点 | 关系 |
|---|---|---|
| S1 边界与验收 | R1、R2 | 加严：绑定本项目 spec / architecture |
| S2 代码库干净 | R3 | 继承并具体化 |
| S3 错误沉淀 | R8、§6 | 加严：负例进入 `verify` |
| S4 子进程安全 | R9 | 继承并具体化 |
| S5 凭据/外网/安全 | R9 | 继承并具体化 |
| S6 发布 fail-closed | R10 | 继承 |
| S7 tag 不可移动 | I4、R10 | 继承 |
| S8 项目 `verify` | I1 | 继承 |
| S9 CI required checks | I2 | 继承 |
| S10 策略文件 owner 审批 | I3 | 继承 |
| S11 项目值 | P1–P3、I5 | 项目填值 |
| S12 依赖维护 | R11 | 继承并具体化 |
| S13 文档一致性 | R1、R10、P4 | 继承 |
| S14 新项目接入 | playbook | constructor，不进入 AGENTS |

## 项目本地规则

以下规则没有直接 meta 父规则，属于本项目加严或项目特有：

- R4：模块边界、`shared/` 可单测；
- R5：活动流 busy、资源释放；
- R6：部分失败可观察、并发入口可打断；
- R7：覆写/删除前确认文件归属。

这些规则不能放松任何 meta `final`；如果以后发现它们其实对应某条 S/M，应补上来源，而不是继续留成隐形规则。

## 维护

本文件已纳入 QG001 必读文档检查：[quality-gates.md](quality-gates.md)。

- 修改 `AGENTS.md` 的 P/I/R 时，必须同步 `来源` 和本表；
- 新增 `R` 但无法归到 M/S 时，来源写 `local`，并在本文件说明为什么是项目特有；
- meta 规则重编号或拆分时，同步更新本表，并更新 `policy_source`；
- 本文件不是自动检查结果；最终执行仍以 AGENTS、`quality-gates` 和 CI 为准。
