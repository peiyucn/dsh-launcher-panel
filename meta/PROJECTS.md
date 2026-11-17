# 项目清单

> 事实层。只登记项目、分支、管线、发布形态和 GitHub 期望值，不写规则。
> 规则见 [rules/](rules/README.md)；默认契约见 [AGENTS.md](../AGENTS.md)。
> 机器可读期望值见 [github-policy.json](github-policy.json)；校验：`node meta/scripts/check-github-policy.mjs`。
> 目前只登记了 `dsh-launcher-panel`；其他项目核验后再加入，未登记不代表已通过。
> 来源：原 `AGENTS.md` 的项目清单与管线段。

## 项目清单

只登记项目信息，不写密钥、口令或任何私密内容。

| 目录 | 仓库 | 是什么 | 可见性 | 档位 | 开发分支 |
|---|---|---|---|---|---|
| `projects/dsh-launcher-panel` | peiyucn/dsh-launcher-panel | VS Code 扩展，启动 DSH 并打开 Web UI | 公开 | 全量 | dev |
| `projects/dsh-sparrow` | peiyucn/dsh-sparrow | DSH Web 插件合集，每插件独立发 npm | 公开 | 全量 | dev |
| `projects/dsh-superagent-playground` | peiyucn/dsh-superagent-playground | DSH Superagent 实验沙盒（给 agent 干活的测试仓库） | 私有 | 不套用 | main |
| `projects/epytor` | peiyucn/epytor | VS Code 所见即所得 Markdown 编辑器 | 公开 | 全量 | dev |
| `projects/pyai.site` | peiyucn/pyai.site | Astro 中英双语静态博客，跑 GitHub Pages | 公开 | 全量 | main |
| `projects/peiyucn-skills` | peiyucn/peiyucn-skills | Agent 技能市场 | 公开 | 精简 | dev |
| `projects/peiyucn-private` | peiyucn/peiyucn-private | 个人私有内容合集（`ai_note` 笔记、`ai_learn`、`ai_slide`，平铺） | 私有 | 不套用 | main |

## 项目管线

登记各项目实际运行的流程。这是信息登记，不是通用规则；管线变更时同步更新。

| 项目 | CI | 发布 | 部署 / 同步 |
|---|---|---|---|
| dsh-launcher-panel | `typecheck` → `test` → `build` → `package` | `publish`（vsce + GitHub Release） | — |
| epytor | `typecheck` → `test` → `build` → `package` | `publish`（vsce + GitHub Release） | — |
| dsh-sparrow | `typecheck` → `build` → `test` → `package` | `publish`（npm；不建 Release） | `deploy`（`market.yml`，发布 `dsh.pyai.site`） |
| pyai.site | `typecheck` | `deploy`（build + Pages，push main 即部署） | `sync`（`daily-sync.yml`，cron） |

有测试的仓库，test job 须输出报告。发布工作流统一命名 `publish.yml`。无 CI 的仓库不列入本表。
