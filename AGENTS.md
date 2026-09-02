# 项目指令 — dsh-launcher-panel

## 项目概况

VS Code 扩展「DSH Launcher Panel」：启动 DeepSeek Harness（dsh），并在 VS Code 内置浏览器中打开它的 Web UI。

* TypeScript 实现，源码 `src/`；`out/` 与 `*.vsix` 不入库
* 本地验证 = `npm run verify`（编译 + 测试 + 打包，打包由 @vscode/vsce 完成）
* 测试：`npm test`（tsx 直跑 node:test），用例 `test/*.test.ts`，覆盖不依赖 vscode 的纯逻辑模块（common、ds）；依赖 vscode 的链路暂由集成测试覆盖（后续版本）
* 模块：`extension.ts`（激活与状态栏）、`server.ts`（服务生命周期与检测）、`actions.ts`（启动/停止/浏览器）、`panel.ts`（Dashboard webview）、`ds.ts`（DeepSeek 状态与余额）、`common.ts`（常量与工具）

## 工程管线（本仓库自含）

* **开发**：日常改动在 `dev` 分支；`master` 只接受发布合并
* **验证**：本地一键 `npm run verify`（= typecheck + test + build + package 串联）；push 前必须通过
* **提交**：逐项提交，中文描述 + 英文类型前缀（feat:/fix:/refactor:/chore:/docs:）；禁止多任务混一个 commit；不确定的事直接说"不确定"，禁止编造事实性信息
* **推送**：日常目标 `dev`；`git push/fetch` 需要代理 127.0.0.1:7897
* **合并**：dev → master（fast-forward）

**发布（tag 触发）**

1. **发布前审计**：按下方《代码审计》条目全面检查
2. **定版编辑**：CHANGELOG 双份（`CHANGELOG.md` 英文 + `CHANGELOG.zh-CN.md` 中文，顶部互链）新版本条目放最顶、覆盖本版全部用户可感知改动 → `package.json` 版本号 → README 如有功能变更同步
3. **再验证**：`npm run verify` 全绿 + `git diff --check` 干净
4. **合并**：dev → master 并 push
5. **打 tag 触发发布**：`git tag -a vX.Y.Z -m "vX.Y.Z: <简述>"`（一律 annotated）并 push tag → 自动：打包 VSIX → 发布市场 → 建 GitHub Release（说明由 publish.yml 拼两份 CHANGELOG 当前版本条目，附 VSIX）
6. **收尾**：切回 `dev`

* publish job 挂 `environment: marketplace-publish`：Deployments 留发布记录；**不设审批门禁**（tag 即发布）；**无 release-control**（通道/标签变更一律发新版本号）
* **发布红线**：已发布版本与 tag 不可覆盖、不可挪动；市场同版本重发会被拒，错误只能发新版本修正（重新走一遍本流程）

* **运维**：依赖升级统一手动（security updates 与 dependabot.yml 关闭）；收到警报 → 判断影响面（运行时/产物依赖才影响用户）→ 手动升级 → 影响用户的按发布流程发版

## 代码审计（发布前 / 用户要求全面检查时）

* **文档对齐**：README 中英 Settings 表与 `package.json` contributes.configuration 一一对应；文件路径、日志文件、行为描述与实现一致；CHANGELOG 双份当前版本条目覆盖本版全部用户可感知改动
* **死代码**：grep 每个导出符号与常量确认调用方；删除未使用的 import/导出/变量/类型字段/CSS 类
* **高危 BUG**：状态一致性（散落布尔标志互相覆盖是主要 bug 源；异步动作由显式状态驱动，动作开始瞬间即置状态）；竞态（Start/Stop/切模式并发不撞车，中断后残留标志不影响下次，定时器动作结束后清理）；路径与引号（Windows 参数转义含空格路径；临时/缓存目录与持久数据目录区分）；资源泄漏（timer/watcher/AbortController/子进程在成功与失败路径都释放）；部分失败（批量操作中途失败状态诚实并校验结果）；环境边界（首装/离线/断网/权限不足降级不挂死、有提示）
* **安全热点**：子进程优先 execFile 参数数组，`shell: true` 仅在必要时，用户输入不直接拼命令；用户配置路径先校验再使用、展示用 `maskPath`、删除操作确认 + 校验；API key 不写日志、不进面板 HTML；Webview CSP 已设置、动态注入 `esc` 转义；fetch 带超时 + AbortController；打开的外部 URL 白名单内
* **代码异味**：单一职责（生命周期/检测/UI/状态各归其位）；可变状态经函数封装；命名表达意图；同类代码结构对称；无超长函数/重复逻辑/魔术字符串
* **魔法数字**：有语义数字（超时/轮询间隔/阈值/步长/缓存时长）命名常量（`*_MS`）；字面量只在无复用语义场合
* **并发与防御**：UI 入口连点防护（锁/debounce/disabled/幂等）；Start/Stop/切模式竞态可被打断且状态一致；杀进程 `taskkill /T`
* **测试与验证**：纯逻辑改动补 `test/*.test.ts`；`npm run verify` 通过 + `git diff --check` 干净

## 安全基线（本仓库自含要点）

* 已开启：Dependabot alerts（仅报警）、CodeQL default setup、secret scanning + push protection、Private vulnerability reporting、根 `SECURITY.md`；检查命令 `gh api repos/peiyucn/dsh-launcher-panel --jq .security_and_analysis`
* 分支保护：master 禁强推/删/重建、Squash-only、owner 保留 fast-forward 直推；dev rulesets 轻保护（禁强推+禁删+禁重建）；**CI 会跑但不设硬门禁**——合并外部 PR 前 owner 自己确认 CI 绿
* 外部 PR / Issue 一律开放、不设交互限制，owner 审核合并（Squash-only），不想收的直接关闭

## GitHub 与网络

* 一律 `gh` CLI（已登录 peiyucn，token 含 repo + workflow）；常用：`gh api`、`gh pr create/view/merge --squash`、`gh release create`
* `gh api` 直连 api.github.com；`git push/fetch` 需要代理 127.0.0.1:7897

## CI 自动化

| Workflow | 触发 | 作用 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR 到 master、dev | `typecheck` → `test`（node:test + JUnit artifact）→ `build` → `package` |
| `publish.yml` | push `v*.*.*` tag | 打包 + 发布市场 + GitHub Release（说明拼两份 CHANGELOG） |

* 发布需要仓库 `VSCE_PAT` Secret（市场管理页 → Personal Access Tokens → `Marketplace: Manage` 权限）
