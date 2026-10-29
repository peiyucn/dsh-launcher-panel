# 项目指令 — dsh-launcher-panel

> 本文件按根 `pyai-meta-repo/AGENTS.md` 的 I1 九章组织并自含（单独 clone 本项目即可执行）；根规范通用章变更时须同步本文件中的副本与引用。标题末尾的〔…〕是约束级别：〔constructor〕接入时的一次性动作；〔final〕只能加严、不能放松；〔overridable〕项目填值、但必须在项目 AGENTS 显式声明；〔interface〕项目必须实现，验收方式写在本文的工程管线章。

## 项目概况

VS Code 扩展「DSH Launcher Panel」：启动 DeepSeek Harness（dsh），并在 VS Code 内置浏览器中打开它的 Web UI；支持多实例（每个实例 = 一套 `DSH_HOME` + profile + 端口）。

* TypeScript 实现，源码 `src/`；`out/` 与 `releases/`（本地打包的 `*.vsix`）不入库
* 模块（依赖单向：L0 纯逻辑 → L1 子系统 → L2 装配）：
  * **L0 纯逻辑（不 import vscode，可直接单测）**：`env.ts`（默认值与小工具）、`versions.ts`（版本比较与更新判定）、`pricing.ts`（峰谷判定）、`holidays.ts`（法定节假日静态表，手工维护）、`paths.ts`（路径与 dsh 落盘产物）、`timing.ts`（公共超时与上界）、`proc.ts`（子进程封装与输出解码）、`git.ts`、`pnpm.ts`、`instances.ts`（实例模型与校验）、`instance-bootstrap.ts`、`instance-state.ts`（状态迁移、home 占用与 Stop 决策纯函数）、`server/log-read.ts`（日志尾部与 token 读取）、`server/start-spec.ts`（启动参数 / env 规格）、`webview/panel-contract.ts`（面板消息与 update payload 契约）、`webview/panel-refresh.ts`（刷新 single-flight）、`panel-form.ts`（表单 payload 解析）
  * **L1 子系统**（`src/server/`）：`activity`（活动流与 client.log）、`probes`、`release-tags`、`install`、`checkout`、`detect`、`update`、`node-check`、`config`、`process`（杀进程 / 端口 owner）、`terminal`、`instance-runtime`（单实例进程与状态机）、`instance-store`（实例设置持久化）、`instance-brand`（实例名注入 Web UI 的本地 bundle）。各模块通过 `*Host` 接口接收生命周期状态，不反向 import 上层模块
  * **L2 装配**：`extension.ts`（激活、状态栏、命令）、`instance-manager.ts`（实例集合、共享安装 / 检测 / 更新、面板快照）、`actions.ts`（命令动作）、`panel.ts`（Dashboard webview）、`statusMenu.ts`、`ds.ts`（DeepSeek 状态 / 余额）；`webview/`（`panel-body` / `panel-styles` / `panel-script`，内联前端三段）
* 测试：`npm test`（Node 原生类型剥离直跑 `node:test`，`--test-isolation=none`），用例 `test/*.test.ts`，只覆盖不依赖 vscode 的纯逻辑模块（含抽出的状态迁移、启动规格、日志读取、面板契约、表单解析）
* 本地验证 = `npm run verify`（typecheck + test + compile + package）；VSIX 落在 `releases/`（`npm run package` 会先建目录再调 vsce）
* **生成物入库**：`resources/dsh-icon.woff`（`npm run build:icon-font`）是生成物，但随版本入库——扩展零运行时依赖、构建要可复现；重新生成后提交 diff 以便评审。节假日表相反：`src/holidays.ts` 是手工静态数据（详见该文件注释），不用脚本抓取
* **定位与退役判据**：见 `docs/positioning-and-retirement.md`——本文件不复述，避免指令文件膨胀
* **实例规格**：见 `docs/instances-spec.md`（已实现功能的契约与验收矩阵）；`docs/` 属开发文档，不进 VSIX

## 文档规范

### H1｜AGENTS.md〔final〕

中文一份。面向开发 agent，只写规则、契约与做法。

### H2｜README〔final〕

中英双份，英文为默认，顶部互链。面向用户，写安装、使用、配置方式。有已知限制或安全隐患时一并写明。

### H3｜CHANGELOG〔final〕

中英双份，英文为默认，顶部互链。面向用户，每条一项可感知变化。

格式遵循 Keep a Changelog：标题 `## [x.y.z] - YYYY-MM-DD`，从新到旧；日期取发版当日。依赖不进入产物时写明「无用户可感知的变化」。

### 本项目实际文档

`README.md` + `README.zh-CN.md`、`CHANGELOG.md` + `CHANGELOG.zh-CN.md`、`SECURITY.md`、`docs/instances-spec.md`（实例规格，已实现状态）、`docs/positioning-and-retirement.md`（定位与退役判据）。`AGENTS.md` 是唯一 agent 指令文件（不留 `CLAUDE.md` 等其它厂商指令文件）；无 CONTRIBUTING。`docs/` 属开发文档，不进 VSIX。

## 工程管线

### E7｜分支约定〔overridable〕

日常改动在 `dev` 分支，默认分支统一为 `main`。例外：B1「开发分支」列为 `main` 的单分支项目直接在 `main` 开发；GitLab 仓库沿用现有分支名。

### E8｜本地一键验证〔interface〕

每个软件项目须提供本地 `verify`，覆盖该项目全部检查项。无构建的仓库以文档自查清单替代，清单写在其 AGENTS。

### E9｜打包产物〔overridable〕

可分发的产物统一放仓库根的 `releases/`，写入 `.gitignore`，确认不进发布包。

输出目录不存在时，打包工具会把目录名当文件名。干净 clone 的仓库没有该目录，须先创建。

不产出可分发包的项目不受本条约束。

### E10｜提交粒度〔final〕

一个 commit 只做一件事。描述用中文，保留英文类型前缀。

### E11｜推送前置条件〔final〕

push 前须 `verify` 通过，推送到开发分支（见 E7）。

### E12｜push 后核查安全告警〔final〕

push 后立即查询一次未处理的 Dependabot 告警，确认清零才继续。存在告警的，先修复再进入发版流程。

### E13｜代码扫描须按扫描周期核查〔final〕

`verify` 通过、CI 全绿，不代表安全扫描无问题。CodeQL 依赖扫描周期，未出结果不得视为通过，须等本轮扫描完成后再查。

依赖类告警按 E22 处理；代码类告警修复后，须等下一轮扫描确认状态变为已修复再发版。

### E14｜发布前审计〔final〕

按 G 段逐条过一遍。

### E15｜准备发布内容〔final〕

两份 CHANGELOG 加新版本条目，改版本号文件，README 有功能变更则同步。多包仓库按包各自维护。

### E16｜合并并推送〔final〕

把开发分支合并到默认分支；单分支项目无需合并。

**tag 触发的项目**：合并后直接推送，进入 E17。

**push 默认分支即部署的项目**：暂不推送，等 E17 批准后再推。

### E17｜发布前须征得 owner 同意〔final〕

发布不可逆，每次执行前都须 owner 明确同意。此前的批准不适用于本次。

### E18｜有告警不得发版（发布硬门禁）〔interface〕

只要存在任一未处理告警（Dependabot / CodeQL / secret scanning），一律不得发版。不得以「告警不在本次改动里」「在测试代码里」「不进发布产物」「与本版无关」为由豁免。

该门禁须由发布工作流 fail-closed 执行（查询告警数，非 0 即中止发布），不得只靠人工核对。告警修复后须等下一轮扫描确认关闭，才算清零。依赖类告警按 E22 处理。

### E19｜打 tag 并推送〔interface〕

一律用 annotated tag 并附说明。push 默认分支即部署、不使用版本号的站点不适用本条。

单次推送不超过 3 个 tag，超过时 GitHub 不生成 push 事件。多包仓库逐个推送，推送后确认 workflow 真的启动。

### E20｜发布凭据〔final〕

发布凭据一律放环境级 secret，仓库级不保留。

### E21｜发布后收尾〔final〕

已发布的版本与 tag 不得覆盖、不得移动。出错只能发新版本修正，且须重新执行 E17 的确认。

发布完成后切回 `dev` 继续开发。单分支项目不适用。

### E22｜依赖维护〔final〕

依赖升级一律手动执行，自动升级按 F3 保持关闭。

运行时依赖或产物依赖单独发补丁版，不与其他改动合并；纯 devDependencies 可并入下个版本。依赖不进产物时 CHANGELOG 写明「无用户可感知的变化」。

### E23｜坏版本处理〔final〕

用 deprecate，不得 unpublish，由 owner 在本机手动执行。无 deprecate 能力的市场只在 README 与 Release 说明里标注已知问题，指向修复版本。

### 本项目取值与动作

* **开发分支**：`dev`；`main` 只接受发布合并（fast-forward）。本项目不是单分支项目
* **验证**：`npm run verify`（typecheck + test + compile + package）全绿；push 前必须通过
* **E18 告警门禁（interface 验收）**：`publish.yml` 的 `publish` job 在 checkout 后、构建前执行 `scripts/check-security-alerts.sh`，查询 Dependabot / CodeQL / secret scanning 未处理告警数；任一非 0、查询失败或凭据缺失即中止发布（fail-closed），不得只靠人工核对。Dependabot / CodeQL 用 `GITHUB_TOKEN` 读，secret scanning 用 `SECURITY_ALERTS_TOKEN`（只读 fine-grained PAT，`marketplace-publish` 环境级 secret）
* **发布（tag 触发）**：
  1. 按 G 段与《项目专属章节 · 发布前检查》审计
  2. 两份 CHANGELOG 加新版本条目（置顶）→ `package.json` 版本号 → README 有功能变更则同步
  3. `npm run verify` 全绿 + `git diff --check` 干净
  4. `dev` → `main`（fast-forward）并 push
  5. E17 门禁：执行 `git tag` / 市场发布等不可逆动作前，须 owner 当次明确确认；停在该动作之前，一句话报出「要发什么、版本号、目标通道、影响范围」，未回话即视为未批准；此前的批准不适用于本次
  6. `git tag -a vX.Y.Z -m "vX.Y.Z: <简述>"` 并 push → workflow 先跑 E18 告警门禁（失败即止）→ 打包 VSIX、发布市场、建 GitHub Release（说明拼两份 CHANGELOG 当版条目）
  7. 发布完成后切回 `dev`
* **本地制品**：`releases/`；`npm run package` 先 `mkdir` 再 `vsce package --out releases`（vsce 只在 `--out` 指向已存在目录时接上文件名）。`releases/`、`*.vsix` 进 `.gitignore` 与 `.vscodeignore`；CI / publish 一律从 `releases/*.vsix` 取件，制品不得散落仓库根
* **依赖维护**：手动升级；security updates 与 `dependabot.yml` 保持关闭；收到告警按 E22 走补丁版；依赖不进产物时 CHANGELOG 如实写「无用户可感知的变化」
* **发布凭据**：`VSCE_PAT`、`SECURITY_ALERTS_TOKEN` 只放 `marketplace-publish` 环境级 secret，仓库级不保留
* **发布红线**：已发布版本与 tag 不可覆盖、不可挪动；市场同版本重发被拒——错误只能发新版本修正

## 代码审计

### G1｜文档对齐〔final〕

文档与实现、声明一一对应。CHANGELOG 覆盖本版本全部可感知改动。

### G2｜死代码〔final〕

导出符号与常量须确认调用方。清理未使用的 import、变量、类型字段、CSS 类。

### G3｜高危缺陷〔final〕

检查状态一致性、竞态、路径与引号处理、资源与内存泄漏、部分失败、环境边界。

「内存泄漏」指：句柄在成功与失败路径均释放；累积状态有界；监听与引用不滞留。

### G4｜安全热点〔final〕

凭据不进日志与 HTML；CSP 与转义；host/client 边界；外部请求带超时；外部 URL 走白名单。

### G5｜代码质量〔final〕

单一职责；状态经函数封装；命名达意；同类对称；不写超长函数与重复逻辑；不散落魔术字符串。

### G6｜容错与性能〔final〕

外部调用带超时与重试；异常输入返回安全默认值；失败路径有用户可见反馈。

重活缓存化或惰性化；热路径不做 O(n²)；大批量渲染分页或虚拟化；高频事件防抖节流；并发扇出有上限。

### G7｜并发与防御〔final〕

UI 入口防连点；请求可被打断且状态保持一致。

### G8｜测试与验证〔final〕

纯逻辑改动须补测试。`verify` 通过，工作区无未提交改动。

### 本项目审计热点

* **文档对齐**：README 中英 Settings 表与 `package.json` `contributes.configuration` 一一对应（键 / 默认值 / 枚举 / scope / 顺序）；文件路径、日志路径、行为描述与实现一致；`docs/instances-spec.md` 与实际行为一致；CHANGELOG 双份覆盖本版全部用户可感知改动
* **死代码**：grep 每个导出符号与常量确认调用方（含 `test/`）；清未使用的 import / 导出 / 变量 / 类型字段 / CSS 类
* **多实例状态一致性**：`starting` 必须有超时、异常不得永久卡住；Stop 对无法确认归属的端口 owner 必须显式确认后才杀；意外退出要清 pid/url 并提示退出码与日志路径；同一 home 同时只允许一个实例运行；`deactivate` 不杀实例、重新激活按端口接管
* **busy 成对收尾**：`addActivity(…, true)` 一律用 `withBusy(label, task)` 包住；`*Host` 只暴露 `withBusy`，不暴露 `finishBusy`——活动流没有回收器，漏收尾会让 spinner 转到会话结束
* **资源 / 内存泄漏**：timer / watcher / AbortController / 子进程在成功与失败路径都释放；缓存与累积状态有界（活动流行数与单行长度、`client.log` 大小、日志尾部读取上限）；Webview 消息引用不滞留
* **部分失败**：中途失败状态诚实并校验结果；「没启动」与「还没启动」必须可区分——启动流程必须如实报告进程有没有真的起来；失败路径必须有活动流 / 面板可见反馈
* **路径**：含空格与非 ASCII 的路径必须能跑；用户配置路径先 `trim` / 规范化再判断；临时 / 缓存目录与持久数据目录区分；`~` 展开与相对路径按实例校验规则处理
* **安全热点**：子进程一律 `spawn`/`execFile` + 参数数组，绝不拼命令行、绝不用 `shell: true`——参数经 shell 解析就可能变成第二条命令（用户配置的路径尤其如此）。Windows 的 `.cmd`/`.bat` 既不能被 `spawn` 直接调用（Node 的 CVE-2024-27980 防护）也不能交给 shell，用 `proc.ts` 的 `resolveCommandEntry`/`runResolved` 读 shim 后跑它的 Node 入口。用户配置路径先校验再用、展示用 `maskPath`；API key / launch token 不进日志 / 面板 / HTML（发往 webview 的 payload 不带 token URL）；Webview CSP + `esc` 转义；fetch 带超时 + AbortController；外部 URL 白名单
* **改写文件前先确认归属**：覆写 / 删除前必须确认那是本扩展自己的产物（如 install manifest 按名字识别、实例品牌 bundle 按包名标识），不是就不动——搞错会静默毁掉用户数据，且不可逆
* **性能**：检测 / 轮询重活缓存化、惰性重算；面板 / 状态栏刷新 single-flight + 防抖；热路径无 O(n²) / 重复计算；长输出与日志有界
* **并发与防御**：UI 入口防连点（in-flight / debounce / disabled / 幂等）；Start / Stop / 切模式 / 更新竞态可被打断且状态一致；杀进程 Windows 用 `taskkill /T`
* **测试与验证**：纯逻辑改动补 `test/*.test.ts`；`npm run verify` 通过 + `git diff --check` 干净

## 安全基线

### F1｜公开仓库全部开启〔final〕

Dependabot alerts（仅报警）、CodeQL default setup、secret scanning 与 push protection、private vulnerability reporting、根目录 `SECURITY.md`。

### F2｜私有仓库仅开启 Dependabot alerts〔final〕

免费计划下其余开关、分支保护与 ruleset 均不可用，记「不可用」不算违规。

### F3｜统一保持关闭〔final〕

secret scanning 的非提供商模式、validity checks、Dependabot 自动升级。

### F4｜逐项核验〔final〕

配置完成与每次变更后逐项核验，结果记录在案；套用 I1 的项目记入其 AGENTS 的安全基线章。

核验项：安全开关各项状态、未处理告警数、CodeQL 状态、私有漏洞报告、`SECURITY.md`、ruleset 清单与规则、合并设置、默认分支的经典保护。私有仓库的分支保护相关项按 F2 记「不可用」。

### F5｜分支保护三层〔final〕

三层指：经典分支保护、ruleset 轻量保护、仓库合并设置。

- **经典保护**：只在此层设「要求对话解决」与「不允许绕过」。不设 required status checks，因会挡住 owner 直推。
- **ruleset**：固定为禁删除、禁强推、禁重建，绕过名单留空。公开仓库的默认分支与 `dev`（如有）各一条。
- **合并设置**：仅开 squash，关闭 merge commit 与 rebase。该项不在 ruleset 也不在安全开关里，最易漏查。

### F6｜直推权限与外部交互〔final〕

owner 保留 fast-forward 直推能力。公开仓库的外部 PR 与 Issue 一律开放，不设交互限制；不接受的直接关闭。

单仓库可按其 AGENTS 登记例外。

### 本项目核验结果（2026-10-29 逐项复核）

* **F1 全部开启**：Dependabot alerts 启用（未处理 0）；CodeQL default setup configured（weekly，actions + JS/TS；最近一次分析 2026-10-27，results_count=0，未处理告警 0）；secret scanning 与 push protection 启用（未处理 0）；private vulnerability reporting 启用；`SECURITY.md` 存在于 main 且 sha 与本地一致（`f44a6d1`）
* **F3 全部关闭**：secret scanning 非提供商模式 disabled、validity checks disabled、Dependabot security updates disabled，且无 `.github/dependabot.yml`
* **F5 三层**：main 经典保护 = 要求对话解决 + 不允许绕过（enforce_admins）+ 无 required status checks；main / dev 各一条 active ruleset（rules：deletion、non_fast_forward、creation；bypass_actors 空）；合并设置仅 squash（merge commit / rebase 关闭）
* **F6**：Issues 开放、无交互限制（Discussions 未开启）；owner 直推由「无 required status checks + 非强推」保障
* **发布环境 / 凭据**：`marketplace-publish` 环境无保护规则（无审批门禁）与分支策略限制；有 Deployment 记录；仓库级 secret 0；环境级 secret = `VSCE_PAT`、`SECURITY_ALERTS_TOKEN`
* **核验命令（自含，只读 GET）**：
  `gh api repos/peiyucn/dsh-launcher-panel --jq '{security_and_analysis,allow_squash_merge,allow_merge_commit,allow_rebase_merge}'`；
  `gh api 'repos/peiyucn/dsh-launcher-panel/dependabot/alerts?state=open&per_page=100' --jq 'length'`；
  `gh api repos/peiyucn/dsh-launcher-panel/code-scanning/default-setup`；
  `gh api 'repos/peiyucn/dsh-launcher-panel/code-scanning/alerts?state=open' --jq 'length'`；
  `gh api 'repos/peiyucn/dsh-launcher-panel/code-scanning/analyses?per_page=1' --jq '.[0].results_count'`；
  `gh api 'repos/peiyucn/dsh-launcher-panel/secret-scanning/alerts?state=open' --jq 'length'`；
  `gh api repos/peiyucn/dsh-launcher-panel/private-vulnerability-reporting`；
  `gh api repos/peiyucn/dsh-launcher-panel/rulesets`（及每条 ruleset 详情）；
  `gh api repos/peiyucn/dsh-launcher-panel/branches/main/protection`；
  `gh api repos/peiyucn/dsh-launcher-panel/environments/marketplace-publish`（保护规则 / 分支策略）；
  `gh api repos/peiyucn/dsh-launcher-panel/environments/marketplace-publish/secrets`；
  `gh api repos/peiyucn/dsh-launcher-panel/actions/secrets --jq '.total_count'`

## CI 与自动发布

### E24｜CI 环节名称〔overridable〕

以下名称是规定，不得自创：

| 环节 | 职责 |
|---|---|
| `typecheck` | 类型检查 |
| `test` | 单元测试 |
| `build` | 构建可运行产物 |
| `package` | 打成发布形态 |
| `publish` | 发布到市场或 registry（不可逆，须 owner 当次确认） |
| `deploy` | 部署上线（对外可见，须 owner 当次确认） |
| `sync` | 数据同步 |

每个项目只放真实存在的环节，同型项目顺序保持一致。

### 本项目 workflow

| Workflow | 触发 | 作用 |
| :--- | :--- | :--- |
| `ci.yml` | push / PR 到 main、dev | `typecheck` → `test`（node:test + JUnit artifact）→ `build` → `package`（VSIX 出 `releases/`） |
| `publish.yml` | push `v*.*.*` tag | E18 告警门禁（Dependabot / CodeQL / secret scanning 任一未处理即中止）→ 打包（VSIX 出 `releases/`）+ 发布市场 + GitHub Release（说明拼两份 CHANGELOG 当版条目） |

* publish job 挂 `environment: marketplace-publish`（Deployments 留记录）；**不设审批门禁**（tag 即发布）；**无 release-control**（通道变更一律发新版本号）
* **E18 门禁位置**：`publish` job 在 checkout 后、构建前执行 `scripts/check-security-alerts.sh`；`GITHUB_TOKEN` 只能读 Dependabot（`vulnerability-alerts: read`）与 CodeQL（`security-events: read`），secret scanning 必须走 `SECURITY_ALERTS_TOKEN`（只读 fine-grained PAT，环境级 secret）——该 secret 未配置或查询失败时 workflow 直接中止（fail-closed）
* **E18 门禁验证（2026-10-29）**：临时探针分支挂 `marketplace-publish` 环境、用真实 `SECURITY_ALERTS_TOKEN` 跑通该脚本（三类未处理告警均 0，job success）；探针分支已删除，Deployments 留 1 条探针记录
* 有测试的仓库，test job 输出报告（JUnit artifact）

## 工具与网络

### D1｜浏览器操作〔final〕

查看自有 GUI、登录态、多步交互、截图，须先在 profile 中挂载 browser use，方可使用浏览器工具。默认未挂载，引擎用本机 Edge。

禁止下载浏览器，本机 Edge 已可用。例外仅限导出 PDF 的脚本自行安装 playwright 依赖。

浏览器产物目录落在调用时的工作目录，已配置全局忽略，无需逐仓库添加。

### D2｜GitHub 操作统一使用 `gh` CLI〔final〕

GitLab 仓库用 `git` 或 `glab`。

### D3｜代理配置〔final〕

git 与 agent 宿主进程均不读取系统代理。需要走代理时须显式指定：git 用一次性参数，宿主进程设环境变量并开启环境代理支持。不写入配置文件。

### 本项目取值

* 仓库：<https://github.com/peiyucn/dsh-launcher-panel>；一律 `gh` CLI，不手拼 git URL、不写明文凭据

## 工作约定

### C1｜用中文表述〔final〕

与 owner 交流、编写 commit 描述一律用中文，commit 保留英文类型前缀。代码注释以英文为主，写明「为什么」而非复述代码。

### C2｜未知须明示，禁止编造〔final〕

未查到的须标明「未查到」，未验证的须标明「未验证」。禁止编造任何具体信息，不得以确定语气描述未执行的操作。

### C3｜结论须有依据〔final〕

关于当前状态的判断必须取自命令输出或文件内容。推断只能用于提出假设。

### C4｜不用取巧写法〔final〕

禁止用取巧手法让代码跑通。找不到正当解法时停下来说明，不硬过。

### C5｜不隐瞒错误与异常〔final〕

禁止为通过检查而造假，禁止隐瞒缺陷或验证失败。无法修复时如实说明，发现此前结论有误时主动更正。

### C6｜如实说明当前状态〔final〕

进展须区分已实现、已提交、已推送、已发布、已上线验证五级。不得用「完成」笼统概括。

「已上线验证」指 owner 已确认线上正常，agent 无法自行判定。

### C7｜不可逆操作须先经 owner 同意〔final〕

判断标准：执行后能否无损回滚。不能的即为不可逆操作。无法判定时按不可逆处理。

可逆操作直接执行，无需报批。

### C8｜完成后须自检〔final〕

挪动代码后确认旧位置真的没了；说「完成」前逐项核对哪些真做了、哪些没做。

### C9｜修改 AGENTS 须经 owner 许可〔final〕

适用范围：本文件与各项目的 `AGENTS.md`。未经 owner 要求或明确许可，不得修改。

发现需要调整时先提建议，等答复后动手，不擅自扩大范围。

规范须具备约束力：被约束方能随时改动它，约束即不存在。

### C10｜新功能完成后先讨论重构方案〔final〕

功能跑通只是可用，不等于完成。新功能可用后立刻整理一轮重构方案（收敛实现、去重、删死代码、重写命名与注释），**先与 owner 讨论、确认后再执行**；重构行为保持不变，`verify` 保持全绿，且与功能分开提交。未重构的新功能不算完成。

## 项目专属章节

### 扩展与宿主兼容（硬约束）

> 本仓库有两个外部契约：**VS Code**（宿主）与 **dsh**（被启动、独立升级的 CLI）。

* **VS Code 版本门走清单**：`engines.vscode`（当前 `^1.85.0`）由 VS Code 在激活前自行判定；`@types/vscode` 必须与 `engines.vscode` **精确对齐**（`1.85.0`，不用 caret，避免类型面漂移到更高版本），用到新 API 时同步抬两者
* **dsh 版本差异降级不崩**：只按公开契约读 dsh 的 CLI 输出与配置目录（旧配置键迁移、启动时探测 Node 能力并给诊断）；不认的字段 / 输出走降级路径
* **运行期不冒泡**：扩展自有入口（webview 消息路由、命令注册、子进程回调、配置变更监听）内部兜住异常——`onMessage` 失败记一条活动流并照常 refresh，面板不会停在旧数据
* **busy 必须成对收尾**：`addActivity(…, true)` 用 `withBusy(label, task)` 包住。各 `*Host` 只暴露 `withBusy`、不暴露 `finishBusy`，所以手写这对调用写不出来——抛错会漏收尾，而活动流没有回收器，spinner 会转到会话结束
* **模块顶层不依赖易变导出**：不 import VS Code 内部模块；L0 模块不 import `vscode`

### 多实例运行时契约

* 一个实例 = 一套运行坐标（`DSH_HOME`、profile、端口）+ 一个 `InstanceRuntime`（child / pid / 状态 / URL / 日志 / 启停锁）；实例不描述用途，不存 API key / 模型 / 权限
* 安装、检测、更新是共享的：所有实例共用一份 dsh，全局操作（安装 / 更新 / 切 runMode）前必须停止全部实例，不得并发安装
* 同一规范化 home 同一时间只允许一个实例运行；端口由 launcher 分配（`dsh.instancePortBase`），面板不直接编辑端口
* 删除实例只从列表移除，不删 home / sessions / 日志
* 状态机：`starting` 必须有独立看门狗兜底；意外退出要清 pid/url、记录退出码与日志路径并可见提示；Stop 只直接杀本窗口 tracked child，没有 tracked child 时（接管 / 陌生端口）必须经用户显式确认才允许杀端口 owner；`adopted` / `untrackedPort` 状态必须如实展示
* `deactivate` 只停日志泵，不杀实例；重新激活按端口探测接管
* 配置变更：`dsh.instances` / `dsh.activeInstance` 的外部修改触发 `reloadSettings()`，按 id 复用已有 runtime，不打断运行中进程
* 实例列表 / 活动实例 / 端口基础值 / 品牌开关是机器本地设置（machine scope，不同步）；运行状态不持久化
* 实例品牌 bundle 只写 launcher 自己生成的包（写前校验归属、临时文件 + rename 原子替换；上游 Web 客户端内部契约变化时静默失效、不崩）
* 命令族：`dsh.start` / `dsh.stop` 作用于活动实例；`dsh.instance.start` / `.stop` / `.restart` 带实例 id；`dsh.instance.new` / `.edit` / `.delete` / `.select` / `.open`（edit / delete / open 可带 id）；面板按钮必须传实例 id，不依赖隐式活动状态

### 测试规范

* `npm test`：Node 原生类型剥离直跑 `node:test`（`--test-isolation=none`），用例 `test/*.test.ts`
* 只覆盖不依赖 vscode 的纯逻辑；依赖 vscode 的装配层（`instance-manager` / `instance-runtime` 等）通过抽出纯函数（状态迁移、启动规格、日志读取、面板契约、表单解析）来测试
* 纯逻辑改动必须补测试；手工矩阵见 `docs/instances-spec.md` 的测试章

### 发布前检查

* **节假日表**：检查 `src/holidays.ts` 是否覆盖当前年份；没有就按该年国务院公告补上（连文件 URL 一起写进注释）。漏了不会报错——只会把那一年的工作日节假日误显示成 Peak
