# DSH Launcher Panel

[![Version](https://img.shields.io/github/package-json/v/peiyucn/dsh-launcher-panel?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel)
[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-dsh--launcher--panel-blue?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel)
[![License](https://img.shields.io/github/license/peiyucn/dsh-launcher-panel?style=for-the-badge)](https://github.com/peiyucn/dsh-launcher-panel/blob/master/LICENSE)

简体中文 | [English](README.md) | [GitHub](https://github.com/peiyucn/dsh-launcher-panel)

在 VS Code 内启动 **DeepSeek Harness**（dsh），并在内置浏览器中打开它的 Web UI。

![DSH Launcher Panel](https://raw.githubusercontent.com/peiyucn/dsh-launcher-panel/dev/resources/dsh-launcher-panel.png)

> 本扩展**不**附带任何 LLM 模型、DeepSeek Harness 本身，或 DeepSeek API Key。

## 设计原则

* **松耦合** — 扩展只通过 dsh 的公开入口启动它（launcher 自管的 pnpm 安装或源码检出）、只读稳定的 `~/.dsh` 数据，不依赖 dsh 的内部实现——所以你配的 dsh 插件照常生效，dsh 升级后启动器也能继续工作。

## 功能

* **启动 / 停止** — 把 dsh 装进 launcher 自管的目录（首次运行），之后通过 `pnpm exec dsh web` 运行并在就绪后打开 Web UI。
* **源码运行** — 自动把 deepseek-harness clone 到自管目录并运行（`dsh.path` 可覆盖 clone 位置）；该路径下已有的检出会直接复用。首次启动还会自动执行 `pnpm install` + 构建，构建使用 dsh 官方 profile，Web UI 左上角品牌与 pkg 模式一致。
* **仪表盘面板** — 服务状态、实时控制台（含可点击的日志文件）、带峰谷时段标志的 DeepSeek 官方 API 状态（周末全天按低谷计费）以及你的账户余额。
* **DSH 更新** — 点击刷新按钮（⟳）检查；有新版本时，dsh 版本号旁会出现 Update 按钮（pkg 重装最新版，source 拉取仓库）。
* **浏览器选择** — 内置浏览器或系统浏览器。

## 使用方法

点击活动栏中的 🐳DSH WebUI 小鲸鱼图标，然后点击 **Start**。

## 设置

设置 → 搜索 "dsh"：

| 键               | 默认值       | 说明                                                          |
| --------------- | --------- | ----------------------------------------------------------- |
| dsh.mode        | pnpm      | `pnpm` 把 dsh 装进 launcher 自管的目录并运行 `pnpm exec dsh web`；`source` 通过 tsx 运行本地检出 |
| dsh.channel     | latest    | pnpm 解析的 dist-tag：`latest`（稳定）或 `next`（预发布）                  |
| dsh.browser     | built-in  | `built-in` 使用 VS Code 内置浏览器（不可用时回退到系统浏览器）；`external` 打开系统浏览器 |
| dsh.hideConsole | true      | 在 Windows 上隐藏控制台                                            |
| dsh.path        | 空         | 可选：source 模式已有的 deepseek-harness 克隆路径；留空则扩展自动 clone 仓库         |
| dsh.pkgPath      | 空         | 可选：pkg 模式安装 dsh 的自定义目录；留空则用扩展自管默认位置                    |
| dsh.nodePath    | 空         | node.exe 路径；留空则使用 PATH 上的 node                              |
| dsh.port        | 3080      | Web UI 端口                                                   |
| dsh.sourceDebug | false     | source 模式打印模块加载进度（NODE_DEBUG=module，输出很多；console 显示周期性计数，完整明细在服务端日志） |
| dsh.clearServerLogOnStart | true  | 每次启动前清空服务端日志文件，使其只包含本次运行内容 |

## 说明

* 默认的 pnpm 模式用 pnpm（dsh 仓库自己用的工具）把 dsh 装进自管目录后直接运行；npm 的 peer 解析器在 dsh 的依赖图上可能无限挂起，所以不提供 `npx`。首次安装时选择的位置（默认或自定义）会写入 `dsh.pkgPath` / `dsh.path`，在设置里可见并保持固定。
* 面板上的模式切换 pill 用简写：`pkg` 即 pnpm 模式，`src` 即 source 模式。当 `dsh.path` 指向的不是已有检出时，启动器会询问 clone 位置。
* 面板显示 dsh 本体位置（pkg 模式为 `package`，source 模式为 `source`）和 `data`（`~/.dsh`）两处路径；dsh 行带 Update 和 Check updates 按钮。
* 启动/停止是幂等的：会先探测端口，不会重复启动。
* 关闭 VS Code 不会停止服务；请从面板或命令面板停止。
* 🐳 鲸鱼图形（活动栏图标与状态栏图标字体）为 Twemoji 的喷水鲸鱼（Twitter, Inc.，CC-BY 4.0）并重着色为 DSH 品牌色，详见 NOTICE。
* **API Status** 卡片目前仅支持 DeepSeek — 只有在 dsh 里配置了 DeepSeek 模型时才会显示。
* 日志文件：`~/.dsh-launcher-panel/logs/client.log`（启动器活动）与 `server.log`（服务端输出），与自管的 package/source 同位于 `.dsh-launcher-panel` 下的姊妹目录（logs 子目录）中；面板中均可点击打开。自管目录直接放在用户主目录下（Windows 为 `%USERPROFILE%`）。
* DSH 在 Windows 下暂无法正常运行“极简模式”。

## 环境

* **Node.js** — 22.x（22.19 及以上）或 >= 24（不支持 23.x）
* **pnpm** — 默认 pnpm 模式需要；未安装时，扩展会在首次启动时自动帮你安装（`npm install -g pnpm`）
* **VS Code** — 1.85+
* **PowerShell 7** — 可选；Windows 下推荐安装（dsh 的工具子进程会用到 `pwsh`；启动器本身不依赖它）

## License

MIT
