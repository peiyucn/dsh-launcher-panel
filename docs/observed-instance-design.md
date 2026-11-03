# 探测接管（Observed Instance）设计与方案演进记录

> 记录日期：2026-11-03
> 状态：设计记录，供内部技术分享使用；对应功能规格见 `docs/instances-spec.md` 第十九节（草案，待确认）。
> 一句话结论：**launcher 只做“观察 + 打开”，把“完整接管”交给 agent 完成；用户主动探测一次，得到只读的 observed 实例。**

## 一、问题背景

场景：一台 ECS 上已经有一份 dsh 在跑（全局 npm 安装、systemd 托管），DSH home、端口、profile 都已存在；用户通过 VS Code Remote-SSH 连上，希望 launcher 能把它显示出来并打开 Web UI。

实测发现 launcher 当时做不到：

- 端口能探到，但访问 `127.0.0.1:3082` 返回 **401**——Web UI 需要启动 token；
- token 由 dsh 启动时打印，只存在于 systemd journal 里，launcher 自己的 `server.log` 里没有；
- 实例配置当时是外部写进 settings 的，用户不知道它从哪来；
- Stop 会走“杀 launcher 自己启动的进程”的路径，对全局安装的 dsh 识别失败（命令行匹配不到自管入口），报错但杀不掉。

目标因此收敛为一句话：**连上 ECS 后，launcher 能发现正在运行的 dsh，并能打开 New Tab。** 不要求接管 systemd/docker 的生命周期，也不要求 launcher 适配所有安装方式。

## 二、约束与设计原则

1. **launcher 是 dashboard/控制台，不是服务管理器**（见 `docs/positioning-and-retirement.md`）：观察、打开、诊断是本职；7×24 的可用性由外部管理器或用户自己负责。
2. **不猜测、不魔法**：不后台轮询、不自动导入、不识别 supervisor 并替用户做决定。
3. **不破坏现状**：不移动/复制 DSH home，不修改外部安装与配置，不覆盖端口/profile/token。
4. **不暴露实现细节**：journal、unit、token 这些词不应该出现在用户配置里。
5. **长尾交给 agent**：安装方式（全局 npm、pnpm、源码、docker、systemd、其他）无法穷尽，launcher 写死适配必然 bug 多；让 agent 帮助用户完成接管更现实。
6. **spec-first、可回退**：先写规格再写代码；每个方案都要能明确说“不做什么”。

## 三、方案演进

### 方案 A：external 生命周期 + `tokenSource` 配置

**做法**：实例增加 `lifecycle: "external"` 与 `tokenSource`（journal/file/docker），external 实例只读；用户配置 token 从哪里读。

**优点**：语义显式；launcher 不需要猜测；实现直接。

**缺点（放弃原因）**：

- 把 journal/unit/token 这些系统细节暴露成用户配置，普通用户不可能理解；
- “只读”与用户直觉冲突：既然在面板里看到了，为什么不能 Stop/Update；
- 实现出来之后，光让用户在 ECS 上填对配置就绕了很久；
- 没有解决“发现”问题，用户仍然要知道自己有什么。

### 方案 B：识别 supervisor 并路由管理动作

**做法**：端口 → PID → cgroup，识别 systemd unit / docker 容器；Stop/Start/Restart 调 `systemctl` / `docker`；Update 只对 launcher 自管安装生效，其余提示不可升级。

**优点**：动作语义正确；不会和 `Restart=always` 打架；用户零配置。

**缺点（放弃原因）**：

- 与“launcher 不关心 supervisor”冲突，代码里到处是分支和特例；
- 需要维护 systemd、docker、launchd、Windows 服务等多套识别与调用逻辑，边缘情况无法穷尽；
- 用户已经明确表示“被外部拉起、无法停止导致升级失败，launcher 不用管”——过度设计。

### 方案 C：后台自动发现 + 自动导入

**做法**：常驻扫描本机进程/端口，发现 dsh 就自动显示或自动写入实例列表。

**优点**：用户完全零操作。

**缺点（放弃原因）**：

- 常驻扫描本身就是持续开销，面板/状态栏刷新频率下不划算；
- 容易产生“幽灵条目”（进程已退出、条目还在）；
- 自动写配置不可解释，尤其在多主机/配置同步场景下容易制造混乱；
- 用户点评：**“用户自己主动操作一个‘探测接管’更优雅。”**

### 方案 D：安装实体化（`dsh.installs` + `installId`）

**做法**：安装与实例分成两个对象，实例引用 `installId`；同安装共享 runtime，不同安装隔离。

**优点**：架构干净；解决“多实例共享 runtime 是写死的”这一深层问题；未来可按安装管理版本/升级。

**缺点（本轮放弃，保留为后续候选）**：

- 架构级改动：`shared-dsh` 单例要拆成安装维度，dashboard/状态栏/Update/锁全部要改；
- 升级迁移需要写新的 settings 键，而扩展刚更新、窗口未 reload 时新键可能不可写，需要额外 bootstrap；
- 当前实际需求只是“发现并打开”，用不上这一层；
- 体积、目录布局、源码是否重复下载等问题会引入一轮新的讨论。

### 方案 E：实例内联 `install` + 导入已有 home

**做法**：不建注册表，实例内联 `{ mode, path }`；`+` 增加“新建/导入已有 home”。

**优点**：迁移零写入（读取时按旧全局设置推导）；仍是澄清“共享/隔离”的正确方向。

**缺点（暂缓）**：

- 仍然需要用户手工配置，解决不了“发现即打开”；
- 安装接管依赖 `pkgPath`/`srcPath` 与目录布局，用户的已有安装未必匹配 launcher 布局；
- 一旦引入就绕不开“是否创建新安装/新 home”的争论。

### 方案 F（最终）：手动探测接管 → observed 只读实例 + agent 接管信息卡

**做法**：

1. 命令面板 `dsh.detect` 或面板 `+` 菜单 **Detect running dsh…**，用户主动触发一次扫描；
2. 扫描本机 dsh 进程（任意安装方式），列出 `name · profile :port — home`，多选（QuickPick `canPickMany`）；
3. 选中后创建 `observed: true` 的**只读实例**：home/profile/port 只读、token 不落盘、Start/Stop/Restart/Update 全部禁用；可改名、可删除；
4. 端口在听且 token 可自动解析（PID → cgroup → journal/docker/stdout 文件）时提供 Open（新标签页），**不自动打开**；
5. 需要完整接管时，用户点 **Copy takeover info**，得到一张信息卡（事实 + 目标 + 验收 + 约束，绝不含 token），交给 dsh 内或 VS Code 里的 agent 去执行；launcher 本身不写死接管逻辑。

**优点**：

- 用户零配置、零学习成本；显式操作，行为可解释；
- 不常驻扫描，不自动写配置，不制造幽灵条目；
- launcher 不承担“适配所有安装方式”的无限责任，长尾交给 agent；
- 只读语义清晰，不会破坏用户现有的 systemd/docker/手动部署；
- 与产品定位一致：dashboard 做观察和打开，接管是另一个动作。

**缺点与已知限制**：

- 用户不能从 launcher 直接 Stop/Update observed 实例（这是有意为之）；
- token 自动解析在 Linux/systemd 上完整可用；Windows/macOS 手动启动的进程可能读不到输出，Open 会置灰并说明原因；
- 实例列表仍写 `dsh.instances`，跨主机同步问题（Windows 的实例配置串到远端 Linux）尚未彻底解决，需要“本机覆盖/显式空列表”兜底；
- agent 接管要求用户有可用的 agent，且 agent 修改安装/配置前需要用户确认。

## 四、关键决策一览

| 决策 | 选择 | 理由 |
|---|---|---|
| 触发方式 | **用户手动探测** | 无后台开销；行为可解释；避免幽灵条目 |
| 实例形态 | **observed 只读实例**（持久化） | 用户改名/删除后仍保留；明确“不拥有” |
| 启停/升级 | **禁用** | 不猜 supervisor、不和 `Restart=always` 打架、不误导用户 |
| token | **自动解析、不落盘** | 用户不该看到 journal/tokenSource 这些词 |
| 打开方式 | **用户点 New Tab，不自动打开** | 多实例场景下避免弹一堆标签页 |
| 多条目交互 | **多选 QuickPick** | 与 VS Code 一致、实现最小，不新增临时面板 UI |
| 命名 | **profile/端口推断 + 可改名 + 重名加端口后缀** | 无需用户先起名；名字稳定不被打断 |
| 完整接管 | **Agent 信息卡（复制）** | 安装方式无法穷尽，launcher 写死必然 bug 多 |
| 安装/实例分离 | **本轮不做** | 架构级改动，与当前需求不匹配，保留后续 |

## 五、失败经验（为什么走了这些弯路）

1. **pnpm + 目录 rename 是陷阱**：pnpm 在 Windows 上使用绝对路径 junction；把安装树从 `package.next` 改名到 `package` 后链接悬空，dsh 启动报 `MODULE_NOT_FOUND`。因此“旁路构建后原子切换”在 Windows 上不可行，安装目录只能原地更新，且失败后按“删除安装目录重新 Start”恢复。
2. **原地 `--force` 重装可能被旧状态撑大**：旧 lockfile/`pnpm-workspace.yaml` 会让跨平台包进入安装（实测 1.55GB）；后来通过移开陈旧 workspace 文件 + 隔离实测（482MB 稳定）解决。
3. **“在面板里看到”不等于“launcher 能管理”**：launcher 启动的进程有 tracked child、有日志 token；外部进程两者都没有。把两者混在同一个 Start/Stop 语义里，就会出现“点了 Stop 报错、Open 打不开”。
4. **把实现细节暴露成配置是设计错误**：`tokenSource` 的失败不是实现 bug，而是抽象层级错误。
5. **spec-first 不是形式**：中途“先写代码后补 spec”直接导致返工和一次功能 revert（0.4.0 草案 `3ffa61e` 被回滚）。先写规格、确认边界，再动代码，返工成本最低。

## 六、未决问题

1. **实例配置的主机本地化**：`dsh.instances` 存在 settings 里，本机 User 配置会参与远端窗口的配置合并，导致 Windows 的实例出现在 Linux 远端窗口（路径非法被跳过）。候选方案：显式空列表覆盖、或改为主机本地文件（如 `~/.dsh-launcher-panel/instances.json`）。需单独立项。
2. **observed 实例的版本/更新信息**：当前不显示 dsh 版本；是否从进程推断安装版本，待定。
3. **agent 接管信息卡的格式与验收标准**是否需要版本化（避免 agent 执行过时步骤），待定。
4. **Windows/macOS 的 token 自动解析**能覆盖到什么程度（stdout 重定向、Windows 服务日志），待实测。

## 七、可分享的要点（Takeaways）

- **观察与拥有要分开**：dashboard 的核心价值是观察和打开；生命周期所有权是另一个维度，混在一起会制造无穷特例。
- **显式操作优于背景魔法**：一次手动探测，比常驻扫描更容易解释、更难出错。
- **不要为长尾写死适配**：安装方式不可穷尽时，launcher 提供“信息 + 入口”，由 agent 完成定制接管，是更可持续的分工。
- **用户看不见的配置，最终都会变成事故**：tokenSource 这种概念不应该出现在用户侧。
- **失败要留下决策记录**：目录 rename、token 来源、共享 runtime 这些坑，记录下来才能避免下一版重蹈覆辙。

## 附录：相关文件

- `docs/instances-spec.md` 第十九节（探测接管规格草案）
- `docs/positioning-and-retirement.md`（控制台定位与生命周期归属）
- `src/instances/runtime/`（实例状态机、接管、进程识别）
- `src/instances/model.ts`（实例模型与校验）
