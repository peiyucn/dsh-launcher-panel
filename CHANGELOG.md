# Changelog

All notable changes to this project will be documented in this file.
每个版本条目：英文在上、中文在下（Each version entry: English first, Chinese below）。

## [0.2.2]

- The launcher follows dsh 0.1.2-alpha.1's one-time-token web URL without breaking older versions: it extracts the token from the server output and probes both URLs, preferring the plain URL when the running dsh serves it and falling back to the token URL when the plain one answers 401 (a valid token answers with a 303 cookie-minting redirect, which the probe stops at and the browser completes) — previously the panel stayed on Starting forever and the browser never opened; the token is only used to open the browser and never shown in the status bar or panel URL.
- Source mode runs `pnpm run clean` before building (when the checkout provides the script): after a git pull upgrades a checkout to a version that removed packages, stale `lib/` leftovers no longer break the build with missing-export errors; the clean step is skipped for older checkouts without the script and a failed clean warns but does not block the build.
- A failed update check is reported as failed instead of "up to date": when the registry lookup or `git fetch` cannot run (for example a network timeout), the panel console now says "Update check failed" rather than wrongly claiming dsh is current.

### 中文

- 适配 dsh 0.1.2-alpha.1 的一次性 token 网页地址，同时兼容旧版：从服务端输出提取 token 并探测两种地址——运行中的 dsh 提供普通地址时优先使用，普通地址返回 401 时回退 token 地址（有效 token 以 303 签发 cookie 的重定向应答，探测到此即止、由浏览器完成）——此前面板会永远停在 Starting、浏览器打不开；token 只用于打开浏览器，绝不出现在状态栏或面板 URL。
- source 模式构建前执行 `pnpm run clean`（checkout 提供该脚本时）：git pull 升级到移除过包的版本后，残留的旧 `lib/` 不再以缺导出错误破坏构建；没有该脚本的旧 checkout 跳过此步，clean 失败只警告、不阻断构建。
- 更新检查失败如实报告为失败而非「已是最新」：registry 查询或 `git fetch` 无法执行时（如网络超时），面板控制台显示「Update check failed」，不再误报 dsh 已最新。

## [0.2.1]

- The status bar shows the whale icon only (no "DSH" text) and opens a quick-pick command menu on click: Open Web UI / Open Dashboard / Stop while running, Open Dashboard / Stop while starting or installing, Start & Open Web UI / Open Dashboard when stopped, plus Open Settings.
- The whale artwork is Twemoji's spouting whale (Twitter, Inc., CC-BY 4.0 — see NOTICE) shown as a monochrome silhouette with the eye and a belly band punched through: consistent in the activity bar, the status bar icon font and the marketplace icon; the view title is plain "DSH WebUI" text.
- While starting or installing, the spout above the whale pulses between two animation frames every 150 ms (replacing the braille dots).
- Fixed: the status bar item no longer paints its text in the brand blue only — on themes with a blue status bar the text was invisible. When the server is running it now uses its own blue background with white foreground (theme colors `dsh.statusBar.runningBackground` / `dsh.statusBar.runningForeground`, overridable per theme), keeping readable contrast on every theme.

### 中文

- 状态栏只显示鲸鱼图标（无「DSH」文字），点击弹出快捷命令菜单：运行时 Open Web UI / Open Dashboard / Stop；启动或安装中 Open Dashboard / Stop；停止时 Start & Open Web UI / Open Dashboard；另有 Open Settings。
- 鲸鱼形象采用 Twemoji 喷水鲸（Twitter, Inc.，CC-BY 4.0——见 NOTICE），以单色剪影呈现、眼睛与腹带镂空：活动栏、状态栏图标字体与市场图标保持一致；视图标题为纯文字「DSH WebUI」。
- 启动 / 安装期间，鲸鱼上方喷水柱以 150ms 间隔在两帧动画间脉动（取代盲文圆点）。
- 修复：状态栏项文字不再只涂品牌蓝——蓝色状态栏主题下文字原本不可见。服务运行中改用自身蓝色背景 + 白色前景（主题色 `dsh.statusBar.runningBackground` / `dsh.statusBar.runningForeground`，可按主题覆盖），保证所有主题下对比度可读。

## [0.2.0]

- Source mode: a freshly cloned checkout is set up (`pnpm install` + build) automatically — the extra "Setup now?" prompt right after the clone is gone (existing checkouts still ask before being set up).
- Source mode builds the web UI with dsh's official client profile, so the top-left shows the same DeepSeek Harness brand as the packaged dsh instead of "DSH Local Build <commit>"; a checkout built before this change is rebuilt once automatically.
- The managed dirs (package/source/logs) now default to `<home>/.dsh-launcher-panel` (`%USERPROFILE%\.dsh-launcher-panel` on Windows) instead of the platform data dir (`%LOCALAPPDATA%` / Library/Application Support / XDG data home), where enterprise policies can block writes; the pkg install folder is named `package`, mirroring the `source` checkout.
- Choosing the install location on first install now writes it into `dsh.pkgPath` / `dsh.path` even when the default location is chosen, so the actual path is visible in Settings and stays pinned if the managed default ever changes.
- The DeepSeek pricing pill follows the updated peak/off-peak rule: weekends (Beijing time) are billed at the off-peak rate all day, effective 2026-08-23 00:00 Beijing time.
- Stop now terminates in-flight setup commands (clone / install / build); stopping during a start no longer deadlocks later starts or briefly reports the server as running.
- Added a `DSH Launcher Panel: Stop` command so the server can also be stopped from the command palette.
- Source mode reuses an existing deepseek-harness checkout when the chosen install location already is one, instead of trying to clone into it; a non-empty, non-checkout folder now fails with a clear message.
- pkg mode refuses to install dsh into a folder that already contains other files, so pointing `dsh.pkgPath` at an existing project can no longer overwrite its manifest.
- The panel now distinguishes Installing (first-run setup) / Starting / Stopping states, driven by an explicit server lifecycle state machine (the internal `starting`/`stopRequested` flags are gone).
- pkg run mode (default) installs dsh into a launcher-managed directory via `pnpm install` and runs `pnpm exec dsh web`, approving build scripts non-interactively (the same thing npm does by default). npx was dropped because npm's peer resolver hangs on dsh's dependency graph.
- Source mode clones deepseek-harness automatically into a managed directory (`dsh.path` is an optional override) and runs it via tsx.
- On the first install with no location configured, the user can pick the default or a custom folder (`dsh.pkgPath` / `dsh.path`); the install path is only shown once a location is chosen.
- The panel shows status + dsh version (with Update and Check update buttons) + the install location (labeled `package` or `source` by mode) + data together at the top (the separate Requirements card is gone); node and launcher versions sit at the bottom.
- The Start button reads "Install & Start" when dsh isn't installed yet.
- Update is unified across modes (pkg reinstalls the latest, source pulls the checkout).
- Log files live in the managed `logs` folder alongside the package/source dirs (previously under %TEMP%).
- When pnpm is missing, Start installs it automatically without prompting; the DeepSeek API Status card shows model names without the trailing "api".
- Fixed: source-mode setup counts as "starting"; Stop during setup is honoured; `--no-open` is decided from the exact version being run.
- Tests are TypeScript (run via tsx against the source directly).

### 中文

- source 模式：新克隆的 checkout 自动完成初始化（`pnpm install` + 构建）——克隆后额外的「Setup now?」提示已移除（已有 checkout 初始化前仍会询问）。
- source 模式改用 dsh 官方 client profile 构建 Web UI，左上角与打包版 dsh 显示同样的 DeepSeek Harness 品牌，而非「DSH Local Build <commit>」；此改动前构建过的 checkout 自动重建一次。
- 托管目录（package/source/logs）默认改为 `<home>/.dsh-launcher-panel`（Windows 上 `%USERPROFILE%\.dsh-launcher-panel`），不再放平台数据目录（`%LOCALAPPDATA%` / Library/Application Support / XDG data home——企业策略可能禁止写入）；pkg 安装目录命名为 `package`，与 `source` checkout 对应。
- 首次安装选择安装位置时，即使选默认位置也写入 `dsh.pkgPath` / `dsh.path`——实际路径在设置中可见，且托管默认值将来变更时保持固定。
- DeepSeek 价格胶囊按更新后的峰谷规则显示：周末（北京时间）全天按谷时计费，自 2026-08-23 00:00（北京时间）生效。
- Stop 现在会终止进行中的初始化命令（clone / install / build）；启动过程中停止不再让后续启动死锁或短暂误报服务运行中。
- 新增命令 `DSH Launcher Panel: Stop`，可从命令面板停止服务。
- source 模式：所选安装位置已是 deepseek-harness checkout 时直接复用，不再尝试克隆；非空且非 checkout 的目录以明确报错拒绝。
- pkg 模式拒绝把 dsh 装进已有其它文件的目录——把 `dsh.pkgPath` 指向已有项目不再覆盖其 manifest。
- 面板现在区分 Installing（首次初始化）/ Starting / Stopping 状态，由显式的服务生命周期状态机驱动（内部 `starting`/`stopRequested` 标志已移除）。
- pkg 运行模式（默认）用 `pnpm install` 把 dsh 装进启动器托管目录，以 `pnpm exec dsh web` 运行，构建脚本非交互式批准（与 npm 默认一致）。弃用 npx：npm 的 peer 解析器会卡死在 dsh 的依赖图上。
- source 模式自动把 deepseek-harness 克隆到托管目录（`dsh.path` 可覆盖）并经 tsx 运行。
- 首次安装未配置位置时，用户可选默认或自定义目录（`dsh.pkgPath` / `dsh.path`）；选定位置后才显示安装路径。
- 面板顶部集中显示状态 + dsh 版本（含 Update 与 Check update 按钮）+ 安装位置（按模式标注 `package` 或 `source`）+ 数据（独立的 Requirements 卡片已移除）；node 与启动器版本在底部。
- dsh 尚未安装时，Start 按钮显示「Install & Start」。
- Update 跨模式统一：pkg 重装最新版，source 拉取 checkout。
- 日志文件改到托管 `logs` 目录，与 package/source 目录并列（此前在 %TEMP% 下）。
- 缺少 pnpm 时 Start 自动安装、不再询问；DeepSeek API Status 卡片显示不带尾部「api」的模型名。
- 修复：source 模式初始化计入「starting」；初始化期间的 Stop 生效；`--no-open` 按实际运行版本判定。
- 测试用 TypeScript（经 tsx 直接跑源码）。

## [0.1.5]

- dsh ≥ rc.8 passes `--no-open`, keeping the panel's `dsh.browser` choice as the only opener (rc.8 opens the system browser on its own).
- Added `dsh.channel` (`latest` / `next`) so npx can follow the prerelease channel — rc.8 is published to `next`; set it to `next` to run rc.8 via npx.
- Update checks report network failures in the console instead of silently showing "no update".

### 中文

- dsh ≥ rc.8 支持 `--no-open`，面板的 `dsh.browser` 选择成为唯一打开方（rc.8 会自行打开系统浏览器）。
- 新增 `dsh.channel`（`latest` / `next`），npx 可跟随预发布渠道——rc.8 发布在 `next`；设为 `next` 即可经 npx 运行 rc.8。
- 更新检查的网络失败在控制台如实报告，不再静默显示「无更新」。

## [0.1.4] - 2026-08-18

- Dashboard: both log files (launcher activity + server output) now appear as masked, clickable paths with their sizes, and the Clear button clears both.
- Added a `debug on/off` pill next to the Console title (source mode only) that toggles `dsh.sourceDebug` (`NODE_DEBUG=module`); module-loading noise is filtered out of the console and shown as a periodic count, with full detail kept in the server log.
- Added `dsh.clearServerLogOnStart` (default on) so each launch starts with a fresh server log instead of accumulating across runs.
- Requirements card now shows Node and DSH only (npm version removed — it always ships with Node).
- DeepSeek API Status card shows a Peak / Off-peak pricing pill (computed in UTC; tooltip shows local times).
- Start waits for the web server to actually serve a page before opening the browser, avoiding a blank tab, and reports how long it took once ready.
- Network-unreachable installs fail fast with a clear message; npx uses `--loglevel=http` so downloads stream into the console.
- Unified all spinners to the same braille dot-matrix style; activity entries are structured (busy flag) instead of string-matching icon characters.
- Log files now live in `%TEMP%\dsh-launcher-panel\` as `client.log` (launcher activity) and `server.log` (server output), keeping the lock-prone server log separate and shortening the paths shown in the panel.
- Panel title is now "🐳DSH WebUI: Dashboard".
- Fixed: the balance query parses `.credentials.yaml` in flow style (`{ KEY: value }`) as well as block style, so it no longer reports "no key" after model settings are re-saved.
- Fixed: Stop now interrupts an in-flight start (it was previously ignored while starting), and stopping kills the whole process tree on Windows so the server cannot restart on its own.
- Added a unit test suite (`npm test`, Node's built-in test runner) covering the path-masking, credential-parsing and status-parsing helpers.

### 中文

- Dashboard：两个日志文件（启动器活动 + 服务输出）均以遮蔽后的可点击路径显示并带大小，Clear 按钮同时清空两者。
- Console 标题旁新增 `debug on/off` 胶囊（仅 source 模式），切换 `dsh.sourceDebug`（`NODE_DEBUG=module`）；模块加载噪声从控制台滤除、以周期计数显示，完整细节保留在服务日志。
- 新增 `dsh.clearServerLogOnStart`（默认开启），每次启动从干净的服务日志开始，不再跨次累积。
- Requirements 卡片只显示 Node 与 DSH（移除 npm 版本——它随 Node 附带）。
- DeepSeek API Status 卡片显示 Peak / Off-peak 计费胶囊（按 UTC 计算；tooltip 显示本地时间）。
- Start 等 Web 服务真正可以出页后再开浏览器，避免白页标签；就绪后报告耗时。
- 网络不可达时安装快速失败并给出明确提示；npx 使用 `--loglevel=http` 让下载过程流入控制台。
- 所有 spinner 统一为同一盲文点阵样式；活动条目结构化（busy 标志），不再字符串匹配图标字符。
- 日志文件改到 `%TEMP%\dsh-launcher-panel\`：`client.log`（启动器活动）与 `server.log`（服务输出），易锁的服务日志独立存放，面板显示路径更短。
- 面板标题改为「🐳DSH WebUI: Dashboard」。
- 修复：余额查询同时解析 flow 风格（`{ KEY: value }`）与 block 风格的 `.credentials.yaml`——模型设置重新保存后不再误报「no key」。
- 修复：Stop 现在可打断进行中的启动（此前启动期间被忽略）；Windows 上停止会杀掉整个进程树，服务无法自行重启。
- 新增单元测试套件（`npm test`，Node 内置 test runner），覆盖路径遮蔽、凭据解析与状态解析辅助函数。

## [0.1.3] - 2026-08-17

- Fixed: the balance query now reads the DeepSeek API key from every location dsh does (env, `.credentials.yaml`, `.env`), so it no longer reports "no key" when dsh is already configured.
- Code cleanup: removed dead code and enabled stricter compiler flags.

### 中文

- 修复：余额查询现在从 dsh 读取 API key 的所有位置取值（环境变量、`.credentials.yaml`、`.env`），dsh 已配置时不再误报「no key」。
- 代码清理：删除死代码，开启更严格的编译选项。

## [0.1.2] - 2026-08-17

- Balance button: secondary style and instant feedback (disabled + "querying…" + a console log with the result).
- Removed the unused `dsh.host` setting; the extension always targets 127.0.0.1, where dsh binds.
- Docs: added a panel screenshot and corrected the source-run and update descriptions.

### 中文

- 余额按钮：次要样式 + 即时反馈（置灰 + 「querying…」+ 结果写入控制台日志）。
- 移除未使用的 `dsh.host` 设置；扩展始终指向 127.0.0.1（dsh 的绑定地址）。
- 文档：补充面板截图，修正 source 运行与更新的描述。

## [0.1.1] - 2026-08-16

- The "Starting…" status now reads "Starting DeepSeek Harness Web UI…".
- Removed pop-up notifications for the DSH Update action; results now appear only in the panel console.
- Improved the extension description and search keywords.

### 中文

- 「Starting…」状态文案改为「Starting DeepSeek Harness Web UI…」。
- 移除 DSH Update 的弹窗通知；结果只显示在面板控制台。
- 优化扩展描述与搜索关键词。

## [0.1.0] - 2026-08-16

- Initial release: start DeepSeek Harness (dsh) from VS Code and open its web UI.
- Dashboard panel with live server status, console log, DeepSeek API status, and account balance.
- npx / source run-mode toggle: asks before restarting a running server, and stays in sync with the dsh.mode / dsh.path settings.
- dsh detection via npx (npm) or a local git clone (source), with one-click checkout setup.
- DSH Update (git pull) for source checkouts.
- Built-in / external browser choice for the web UI.
- Hidden console on Windows to avoid cmd window flashes.

### 中文

- 首个版本：从 VS Code 启动 DeepSeek Harness（dsh）并打开其 Web UI。
- Dashboard 面板：实时服务状态、控制台日志、DeepSeek API 状态与账户余额。
- npx / source 运行模式切换：重启运行中的服务前先询问，并与 dsh.mode / dsh.path 设置保持同步。
- dsh 检测支持 npx（npm）或本地 git clone（source），checkout 一键初始化。
- source checkout 支持 DSH Update（git pull）。
- Web UI 可选内置 / 外部浏览器。
- Windows 下隐藏控制台，避免 cmd 窗口闪烁。
