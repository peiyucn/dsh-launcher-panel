# 本地 meta 快照

来源：`pyai-meta-repo` 的 `meta/` 目录，快照提交 `ded482a`。

用途：让本项目在单独 clone 时也能读到共享规则、原则、技能和 playbook；默认不进入上下文，由 [AGENTS.md](../AGENTS.md) 按任务路由。

同步：先改 `pyai-meta-repo`，再整体覆盖本目录；不要只改这里。

范围：`rules/`、`principles/`、`skills/`、`playbooks/` 是共享层；其中 A/B/I 段、`PROJECTS.md`、`github-policy.json` 和 `scripts/` 是 meta-repo 自身的仓库/项目/检查工具，不作为本项目规则。本项目以 `AGENTS.md` 和 `docs/` 为准。
