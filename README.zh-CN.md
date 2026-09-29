# 🐳dsh-launcher-panel

[![Version](https://img.shields.io/github/package-json/v/peiyucn/dsh-launcher-panel?color=007ec6)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel) [![CI](https://img.shields.io/github/actions/workflow/status/peiyucn/dsh-launcher-panel/ci.yml?branch=main&label=ci)](https://github.com/peiyucn/dsh-launcher-panel/actions/workflows/ci.yml) [![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-dsh--launcher--panel-blue)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel) [![License](https://img.shields.io/github/license/peiyucn/dsh-launcher-panel)](https://github.com/peiyucn/dsh-launcher-panel/blob/main/LICENSE)

简体中文 | [English](README.md) | [GitHub](https://github.com/peiyucn/dsh-launcher-panel)

在 VS Code 内启动 **DeepSeek Harness**（dsh），并在内置浏览器中打开它的 Web UI。

![DSH Launcher Panel](https://raw.githubusercontent.com/peiyucn/dsh-launcher-panel/main/resources/dsh-launcher-panel.png "ratio:0.31")

> 本扩展**不**附带任何 LLM 模型、DeepSeek Harness 本身，或 DeepSeek API Key。

## 设计原则

* **松耦合** — 扩展只通过 dsh 的公开入口启动它（launcher 自管的 pnpm 安装或源码检出），只读稳定的 `~/.dsh` 数据，不依赖 dsh 内部实现。所以你配的 dsh 插件照常生效，dsh 升级后启动器也能继续用。

## 功能

* **启动 / 停止** — 首次运行把 dsh 装进 launcher 自管目录，之后运行它并在就绪后打开 Web UI。
* **源码运行** — 把 deepseek-harness clone 到自管目录并运行（`dsh.srcPath` 可指定别处；该路径下已有检出则直接复用）。依赖缺失/过期、或检出切过了上次构建时会先装依赖并构建；构建前跑 `pnpm run clean` 清理旧产物，并使用 dsh 官方 profile，使 Web UI 品牌与 pkg 模式一致。
* **仪表盘面板** — 服务状态、实时控制台（日志文件可点击）、带峰谷标志的 DeepSeek 官方 API 状态（周末与法定节假日全天按低谷计费），以及账户余额。
* **DSH 更新** — 点 ⟳ 检查，有新版本时显示 Update（pkg 重装该通道最新版；source 检出最新的官方 `dsh-v…` tag，不拉 upstream master）。检查只列 tag 并比对 commit，不下载任何东西；源码模式真正更新时会先拉取该 tag，检出落后较多时可能耗时较长。
* **浏览器选择** — 内置浏览器或系统浏览器。

## 使用方法

点击活动栏中的 🐳DSH WebUI 小鲸鱼图标，然后点击 **Start**。状态栏的鲸鱼图标反映启动器状态（运行中为蓝底白字、启动中喷水跳动）——点击它可弹出快捷菜单：Open Web UI / Open Dashboard / Stop / Open Settings。

## 设置

设置 → 搜索 "dsh"：

| 键               | 默认值       | 说明                                                          |
| --------------- | --------- | ----------------------------------------------------------- |
| dsh.runMode     | pnpm      | `pnpm` 把 dsh 装进 launcher 自管目录并运行；`source` 通过 tsx 运行本地检出 |
| dsh.npmChannel  | latest    | pkg 模式安装所用的 npm dist-tag，也是 Update 的目标：`latest`、`next`（rc）或 `alpha`。已安装的 dsh 始终按原样启动，通道不会降级或自动升级它。source 模式忽略此项，跟踪最新的官方 `dsh-v…` tag。 |
| dsh.pkgPath      | 空         | 可选：pkg 模式安装 dsh 的自定义目录；留空用自管默认位置 |
| dsh.srcPath     | 空         | 可选：source 模式已有的 deepseek-harness 克隆路径；留空则自动 clone |
| dsh.nodePath    | 空         | node.exe 路径；留空用 PATH 上的 node |
| dsh.port        | 3080      | Web UI 端口 |
| dsh.autoOpenBrowser | true      | Start 后自动打开浏览器；关掉则保留当前标签页（Start 的「New Tab」点击仍按 `dsh.browser` 打开） |
| dsh.browser     | built-in  | `built-in` 用 VS Code 内置浏览器（不可用时回退系统浏览器）；`external` 打开系统浏览器 |
| dsh.hideConsole | true      | 在 Windows 上隐藏控制台窗口（也让 dsh 自己的工具子进程不闪窗） |
| dsh.clearServerLogOnStart | true  | 每次启动前清空服务端日志，使其只含本次运行内容 |
| dsh.sourceDebug | false     | source 模式打印模块加载进度（`NODE_DEBUG=module`）。输出很多：console 只显示周期性计数，完整明细在服务端日志。 |

## 说明

* pkg 模式用 pnpm（dsh 仓库自己用的工具）安装并直接运行 dsh。不提供 `npx`：npm 的 peer 解析器在 dsh 的依赖图上可能无限挂起。首次安装的位置会写入 `dsh.pkgPath` / `dsh.srcPath`，在设置里可见并保持固定。
* 面板上的模式 pill 用简写：`pkg` 即 pnpm 模式，`src` 即 source 模式。当 `dsh.srcPath` 不是已有检出时，启动器会询问 clone 位置。
* 面板显示 dsh 本体位置（`package` 或 `source`）和 `data`（`~/.dsh`）路径；dsh 行带 Update 与 Check updates。
* 启动与停止都是幂等的：启动会先探测端口，不会重复启动。
* 关闭 VS Code 不会停止服务；请从面板或命令面板停止。
* **API Status** 卡片目前只支持 DeepSeek，且仅当 dsh 里配置了 DeepSeek 模型时才显示。
* 日志文件：`~/.dsh-launcher-panel/logs/client.log`（启动器活动）与 `server.log`（服务端输出），与自管的 package/source 目录并列，面板中都可点击打开。这些目录直接位于用户主目录下（Windows 为 `%USERPROFILE%`）。
* 🐳 图形（活动栏图标与状态栏图标字体）为 Twemoji 的喷水鲸鱼（Twitter, Inc.，CC-BY 4.0），以单色剪影呈现，详见 NOTICE。

## 已知限制

* **内置浏览器里语音输入不可用。** 若启用了 dsh 的语音输入插件，在 VS Code 内置浏览器中录音后点停止会报 *Unable to decode audio data*，文字插不进输入框；麦克风本身是好的（说话时电平波形正常跳动）。这是内置浏览器的音频解码限制，与本扩展和 dsh 的语音识别都无关——已在 VS Code 1.139.1（Windows x64）复现，同一份 dsh 在系统浏览器里语音输入正常。上游修好之前，可把 `dsh.browser` 设为 `external` 绕开。

## 环境

* **Node.js** — 22.x（22.19 及以上）或 >= 24（不支持 23.x）
* **pnpm** — 默认 pnpm 模式需要；未安装时，扩展会在首次启动时自动帮你安装（`npm install -g pnpm`）
* **VS Code** — 1.85+
* **PowerShell 7** — 可选；Windows 下推荐安装（dsh 的工具子进程会用到 `pwsh`）。启动器本身不调用任何 shell。
* **C 工具链** — 仅源码模式（macOS/Linux）：dsh 的构建会编译一个原生辅助组件，需要 `cc` 与 Node 开发头文件（`include/node`，官方 Node 安装包自带）。Windows 构建会跳过该步骤，pkg 模式完全不需要编译器。

## License

MIT
