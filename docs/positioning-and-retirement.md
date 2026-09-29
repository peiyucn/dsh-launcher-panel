# 定位与退役判据

> 本文回答两个问题：**这个扩展靠什么活着**，以及**什么情况下它该退役**。
> `AGENTS.md` 只引用本文、不复述内容，避免指令文件膨胀。
> 本文是开发文档：不进 README / CHANGELOG，也不进 VSIX。

最后复查：2026-09-30（dsh `v0.2.0-rc.2`）

## 一、定位：控制台，不是启动器

扩展对外的名字是「启动器」，但它真正的价值不在启动。

| | 官方桌面端 | 本扩展 |
|---|---|---|
| 干什么 | **用 dsh** | **控制 dsh 本身** |
| 读者 | 使用者 | 开发者 / 插件作者 |
| 具体能力 | 聊天、文件预览、Office 技能、原生对话框、自动更新 | 通道选择（`latest` / `next` / `alpha`）、源码检出与构建校验、更新比对、日志与诊断 |

「启动 DSH 并打开 Web UI」这句话的**入口价值**会被官方客户端蚕食；**控制价值**不会——因为官方客户端恰好把版本与构建权收走了：

* 桌面端把整棵 dsh 树与 primary runtime 打进应用（`apps/desktop/scripts/electron-builder-config.mjs` 的 `files` / `extraResources`）
* 端口与启动参数硬编码（`apps/desktop-host/src/index.ts:28` → `--no-open --port 19387`）
* 走 `electron-updater` 自动更新，并带强制更新策略（`dshMandatoryUpdatePolicy`）

## 二、为什么不做深度 IDE 集成

深度集成的成本 = **跟踪一个不属于自己的 alpha 客户端协议**。协议所有者是官方，只有它能把这份成本内部化——这正是市面上同类扩展清一色官方自研的原因。

实测的 churn（同一 0.1.5 → 0.1.7 窗口内）：

* `0.1.6-alpha.2`：客户端 Session 支持多实例共存，相关 API 及 slot 有变化
* `0.1.7-alpha.1`：Remote 支持双向流；工作区文件读取统一为 `readBytes`，插件需迁移旧接口
* `0.1.7-alpha.1`：Agent 预设改由插件组合包声明；设置改由当前 Profile 的插件配置保存
* `0.1.7-alpha.2`：`spill-policy` 的 `maxInlineBytes` 改为 `maxInlineTokens`

而且 DSH 的客户端扩展点是 **Web 专属的**（`window.__DSH_BOOT__`、`/plugins`、浏览器 lazy CJS 模块表，见 `docs/subsystems/client-modules.zh.md`），VS Code 扩展用不了——要当客户端，只能照 `packages/api` 的 Remote 层与 `packages/typert` 协议另写一套。

本扩展的成本结构与上面相反：只走公开入口（`pnpm exec dsh web` / tsx 跑源码检出）、只读 `~/.dsh`、不碰内部实现。**这是它熬过 0.1.5 → 0.1.7、而协议一路在动的根本原因。**

### 编辑器战场是对的，但武器不是「启动」

外部参考：Claude Code 提供官方 VS Code 扩展（<https://code.claude.com/docs/en/vs-code>）；VS Code 官方发布 "A Unified Experience for all Coding Agents"（<https://code.visualstudio.com/blogs/2025/11/03/unified-agent-experience>）。方向明确：agent 的主场是编辑器。

但这些扩展的价值来自**把产出渲染在编辑器的原生表面上**（diff 编辑器、选区上下文、权限提示），而不是「在 VS Code 里」。本扩展目前是在一个标签页里开浏览器——入口对，武器不对。对个人开发者而言，补这把武器要求跟踪上面的协议 churn，投产比不成立。

## 三、退役判据

### 触发（任一成立即评估退役）

| # | 信号 | 为什么致命 |
|---|---|---|
| **A** | 官方客户端支持指定**外部 dsh 安装目录或版本** | 版本 / 构建控制权回到用户，控制台价值归零。**最该盯的一条。** |
| **B** | DSH 仓库出现 VS Code 扩展脚手架（带 `engines.vscode` 的包、`@types/vscode` 依赖、`vsce` 打包脚本） | 官方进入同一生态位 |
| **C** | 官方转向 IDE 侧集成（ACP 恢复编辑器 UI，或 `open-in-app` 变成官方 IDE 协议桥） | 集成入口被官方接管 |

C 的现状基线：官方 ACP 是**明确仅面向自动化**的，决策记录把编辑器 UI 整个删掉了（`.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md`：「它不会把 ACP 恢复为 UI」）。

### 不构成退役理由

* **官方发布桌面客户端本身。** 桌面端服务「用 dsh」，本扩展服务「控制 dsh 本身」——读者不同。
* **官方扩展只覆盖聊天 / diff / 上下文。** 那是「用 dsh」的形态，控制台那一半仍然没人做。

### 触发后处置（分档，别一刀切）

* **A 触发** → 控制台价值消失：退役，或降级为纯个人自用、不再发布。
* **B / C 触发** → 先判断官方是否覆盖「控制台」那一半：覆盖则退役；不覆盖则砍掉入口部分（Start / 浏览器选择），保留控制台部分。

## 四、现状基线（2026-09-30 实测）

以下结论只代表该日状态，复现命令见第五节。

| 检查 | 结果 |
|---|---|
| npm `@deepseek-ai/dsh-desktop` | 404（包 `private: true`） |
| GitHub Release `dsh-v0.2.0-rc.2` 的 assets | 空（制品走 CDN，不发 Release asset） |
| `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` | **200** —— 内容为 `0.2.0-rc.2` 的 win-x64 exe（289 313 640 B，`releaseDate: 2026-09-29T10:35:27Z`） |
| 同上 `feeds/mac-arm64/nightly-mac.yml` | **200** |
| 同上 `feeds/win-x64/stable.yml` | **404** —— 尚无 stable 通道（与 dsh 自身的 npm 通道状态一致） |
| `https://www.deepseek.com/harness/` | **200**，有公开的「**下载桌面端**」入口，直链 `https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe` 与 `…-macos-arm64.dmg`（两者均 200） |
| DSH 仓库 `packages/`、`apps/` 下带 `engines.vscode` 的包 | 无 |
| DSH 仓库的 `@types/vscode` / `vsce` 依赖 | 无（`vscode` 仅出现在 `@vscode/ripgrep` 依赖与 `packages/host/open-in-app` 的编辑器目录） |

结论：**桌面端已通过公开渠道发布**（0.2.0-rc.2 同日上线，nightly 通道有制品、stable 通道未开）。

**但这不触发退役判据 A**：`apps/desktop-host/src/index.ts:22` 仍把 `installAnchor` 写死在
`runtimeDir/node_modules/@deepseek-ai/dsh/package.json`（即应用自带的整棵 dsh 树），
启动参数仍是 `['--no-open', '--port', '19387']`（`:30`），**没有任何"指向外部 dsh 安装 / 选择
版本或通道"的入口**。`0.2.0-rc.2` 新增的 `apps/desktop/src/command-installation.ts` /
`command-management.ts` 做的是另一件事：把**随包自带的**那个 launcher 以 symlink 方式装进
PATH 并留 receipt 以便卸载 —— 它服务的是"命令行里也能用 dsh"，不是"让用户选 dsh"。
故「官方客户端把版本与构建权收走」这一条依然成立，本扩展的控制台定位不变。
官方亦尚无 VS Code 侧动作（判据 B / C 未触发）。

## 五、复查方式

`$DSH_SRC` = 本扩展自管的 dsh 检出（source 模式默认 `%USERPROFILE%\.dsh-launcher-panel\source`）。

```powershell
# A：桌面端是否放开外部 dsh 安装（看 profile 装载与启动参数；还要确认没有"选版本/选通道"入口）
Select-String -Path "$DSH_SRC\apps\desktop-host\src\index.ts" -Pattern 'loadProfileDirectory|installAnchor|--port'
Select-String -Path "$DSH_SRC\apps\desktop\src\*.ts" -Pattern 'externalInstall|customInstall|chooseVersion|selectChannel|releaseChannel|dshPath'
# ↑ 第二条**无输出**才算 A 未触发

# B：是否出现 VS Code 扩展脚手架（无输出 = 尚未出现）
Get-ChildItem -Recurse -Filter package.json -Path "$DSH_SRC\packages","$DSH_SRC\apps" -Depth 2 |
  ForEach-Object { $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
    if ($j.engines.vscode -or $j.name -match 'vscode') { $j.name } }

# 发布渠道是否已上线（200 = 官方客户端已公开分发；stable.yml 仍未开时是 404，属预期）
foreach ($u in 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
               'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
               'https://download.deepseek.com/dsh-desk/feeds/win-x64/stable.yml') {
  "$((Invoke-WebRequest $u -Method Head -SkipHttpErrorCheck).StatusCode)  $u" }

# 公开下载页是否仍在分发（含具体直链）
$page = (Invoke-WebRequest 'https://www.deepseek.com/harness/').Content
[regex]::Matches($page, 'https://download\.deepseek\.com/desktop/[^"]+') | ForEach-Object { $_.Value } | Select-Object -Unique
```

复查节奏：跟随 dsh 的通道切换（alpha / rc / stable 变动）各跑一次，或至少每季度一次。

## 六、备选方向（记录用，非主线）

`dsh --profile headless --json` 是一条**公开 CLI 契约**（任务来自 stdin、逐行 JSON 事件到 stdout、`--session-id` 续跑、不开端口）。若将来有余力，它是唯一不必赌 alpha 协议就能做「编辑器原生呈现」的接缝。

边界：每次调用只跑一个任务、无交互式后续。
