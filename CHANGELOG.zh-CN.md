# 更新日志

本项目的所有重要变更都将记录在此文件中。

> English version: [CHANGELOG.md](CHANGELOG.md)。

## [0.2.2]

- 适配 dsh 0.1.2-alpha.1 的一次性 token 网页地址，同时兼容旧版：从服务端输出提取 token 并探测两种地址——运行中的 dsh 提供普通地址时优先使用，普通地址返回 401 时回退 token 地址（有效 token 以 303 签发 cookie 的重定向应答，探测到此即止、由浏览器完成）——此前面板会永远停在 Starting、浏览器打不开；token 只用于打开浏览器，绝不出现在状态栏或面板 URL。
- source 模式构建前执行 `pnpm run clean`（checkout 提供该脚本时）：git pull 升级到移除过包的版本后，残留的旧 `lib/` 不再以缺导出错误破坏构建；没有该脚本的旧 checkout 跳过此步，clean 失败只警告、不阻断构建。
- 更新检查失败如实报告为失败而非「已是最新」：registry 查询或 `git fetch` 无法执行时（如网络超时），面板控制台显示「Update check failed」，不再误报 dsh 已最新。

## [0.2.1]

- 状态栏只显示鲸鱼图标（无「DSH」文字），点击弹出快捷命令菜单：运行时 Open Web UI / Open Dashboard / Stop；启动或安装中 Open Dashboard / Stop；停止时 Start & Open Web UI / Open Dashboard；另有 Open Settings。
- 鲸鱼形象采用 Twemoji 喷水鲸（Twitter, Inc.，CC-BY 4.0——见 NOTICE），以单色剪影呈现、眼睛与腹带镂空：活动栏、状态栏图标字体与市场图标保持一致；视图标题为纯文字「DSH WebUI」。
- 启动 / 安装期间，鲸鱼上方喷水柱以 150ms 间隔在两帧动画间脉动（取代盲文圆点）。
- 修复：状态栏项文字不再只涂品牌蓝——蓝色状态栏主题下文字原本不可见。服务运行中改用自身蓝色背景 + 白色前景（主题色 `dsh.statusBar.runningBackground` / `dsh.statusBar.runningForeground`，可按主题覆盖），保证所有主题下对比度可读。

## [0.2.0]

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

- dsh ≥ rc.8 支持 `--no-open`，面板的 `dsh.browser` 选择成为唯一打开方（rc.8 会自行打开系统浏览器）。
- 新增 `dsh.channel`（`latest` / `next`），npx 可跟随预发布渠道——rc.8 发布在 `next`；设为 `next` 即可经 npx 运行 rc.8。
- 更新检查的网络失败在控制台如实报告，不再静默显示「无更新」。

## [0.1.4] - 2026-08-18

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

- 修复：余额查询现在从 dsh 读取 API key 的所有位置取值（环境变量、`.credentials.yaml`、`.env`），dsh 已配置时不再误报「no key」。
- 代码清理：删除死代码，开启更严格的编译选项。

## [0.1.2] - 2026-08-17

- 余额按钮：次要样式 + 即时反馈（置灰 + 「querying…」+ 结果写入控制台日志）。
- 移除未使用的 `dsh.host` 设置；扩展始终指向 127.0.0.1（dsh 的绑定地址）。
- 文档：补充面板截图，修正 source 运行与更新的描述。

## [0.1.1] - 2026-08-16

- 「Starting…」状态文案改为「Starting DeepSeek Harness Web UI…」。
- 移除 DSH Update 的弹窗通知；结果只显示在面板控制台。
- 优化扩展描述与搜索关键词。

## [0.1.0] - 2026-08-16

- 首个版本：从 VS Code 启动 DeepSeek Harness（dsh）并打开其 Web UI。
- Dashboard 面板：实时服务状态、控制台日志、DeepSeek API 状态与账户余额。
- npx / source 运行模式切换：重启运行中的服务前先询问，并与 dsh.mode / dsh.path 设置保持同步。
- dsh 检测支持 npx（npm）或本地 git clone（source），checkout 一键初始化。
- source checkout 支持 DSH Update（git pull）。
- Web UI 可选内置 / 外部浏览器。
- Windows 下隐藏控制台，避免 cmd 窗口闪烁。
