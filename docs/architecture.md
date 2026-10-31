# 架构与模块边界

> 面向开发 agent：本文件写「代码放在哪、依赖朝哪个方向、为什么这么分」，规则与流程见 `AGENTS.md`。
> 维护要求：新增/移动模块时同步本文件；目录结构变更后先跑 `npm run verify`。

## 1. 目录与职责

```text
src/
  extension.ts          VS Code 入口：activate/deactivate 接线（manager、panel、status bar、commands、设置监听）
  actions.ts            应用服务：命令面板与 Dashboard 共用的用户动作（start/stop/create/edit/delete…）
  app/                  VS Code 集成外壳
    commands.ts         命令注册 + 状态栏 quick-pick 菜单
    status-bar.ts       状态栏 item / 动画 / 15s 刷新
    status-menu.ts      菜单模型的纯函数（items/summary）
  panel/                Dashboard 特性（宿主 + 内联前端资源）
    panel.ts            WebviewViewProvider：CSP/HTML、可见性↔轮询、refresh 单飞与快照
    messages.ts         client→host 消息分派与命令处理器
    form.ts             实例表单 payload 的纯解析
    deepseek.ts         DeepSeek 状态页 / 余额 / 凭据读取（仅面板消费）
    pricing.ts          峰谷时段判定
    holidays.ts         法定节假日静态表
    webview/            body / styles / script（内联前端三段）、contract（消息与 payload 契约）、refresh（单飞调度）
  instances/            实例域
    model.ts            实例模型、规范化、校验、默认 home
    state.ts            状态迁移表、home 占用、Stop 决策（纯函数）
    bootstrap.ts        首次运行/迁移后的实例列表引导
    store.ts            实例设置的持久化（VS Code settings）
    manager.ts          实例集合编排：CRUD、启停、活动记录、runtime 持有
    dashboard.ts        面板快照构造（manager.dashboard() 委托）
    shared-dsh.ts       共享 dsh 安装/检测/更新：prepare、detect、update 检查与缓存
    runtime/            单实例运行时
      runtime.ts        状态机编排与公开 API
      spawn.ts          子进程 spawn / kill / close
      health.ts         端口/URL 探测、接管（adopt）、就绪等待
      profile.ts        profile 初始化（--dump-config）
      log-pump.ts       实例日志实时 tail
      process.ts        杀进程树、按命令行识别本实例的 DSH 服务器
      brand.ts          profile 内 launcher 自有品牌 bundle
      types.ts          RuntimeHost / InstanceRuntimeStatus / PreparedDsh
  dsh/                  dsh 工具链集成（安装、检测、版本、更新、配置、路径）
    config.ts detect.ts install.ts checkout.ts update.ts release-tags.ts
    versions.ts paths.ts pnpm.ts git.ts node-check.ts probes.ts start-spec.ts terminal.ts
  shared/               跨特性基础设施（无 vscode 依赖）
    env.ts timing.ts proc.ts activity.ts logs.ts
```

## 2. 依赖方向

允许的依赖（箭头 = 可以 import）：

```text
extension.ts ──► app/, panel/, instances/, dsh/, shared/, actions.ts
app/ ──────────► actions.ts, instances/, shared/
panel/ ────────► actions.ts, instances/, dsh/（只读契约）, shared/, panel/webview
instances/ ────► dsh/, shared/
actions.ts ────► instances/, shared/
dsh/ ──────────► shared/
shared/ ───────► 仅 node 内建
```

硬规则：

* `shared/` 不 import 任何上层或 `vscode`；`dsh/` 不 import `instances/`、`panel/`、`app/`、`actions.ts`。
* `panel/` 不 import `app/`（Dashboard 与命令外壳互不依赖）；`app/` 不 import `panel/`（由 `extension.ts` 接线）。
* `actions.ts` 位于根，是命令面板与 Dashboard 共用的应用服务层；不要把它移回 `app/`，否则会重新引入 `panel → app` 反向依赖。
* 不出现 import 环（`node TEMP/domain-graph.mjs` 或等价检查；项目内目前为零环）。

## 3. 为什么这样分（历史与取舍）

* 旧结构是「L0 根目录 / L1 `src/server/` / L2 根目录」。多实例重构后 `src/server/` 名不副实：里面混着 dsh 工具链、实例运行时和共用基础设施，实例域又横跨根目录与 `server/`。按当前功能域重排后，目录名与职责一致，`server/` 已删除。
* `instance-manager.ts` 曾同时做「实例集合 / 共享 dsh 安装更新 / 面板快照 / host 装配」四件事；现拆为 `manager.ts`（集合与生命周期）、`shared-dsh.ts`（共享 dsh）、`dashboard.ts`（UI 快照）。新增共享 dsh 能力放 `shared-dsh.ts`，不要塞回 manager。
* `instance-runtime.ts` 曾同时做进程、健康探测、profile 初始化与日志泵；现按副作用类型拆到 `runtime/` 子模块，`runtime.ts` 只做状态编排。新增子进程/探测/日志逻辑放对应子模块。
* Webview 前端是内联字符串资产（CSP 只允许 nonce 脚本），刻意不拆成多个运行时文件；`panel/webview/` 内按 body/styles/script/contract/refresh 分文件即可。
* 测试保持平铺 `test/*.test.ts`（文件名与模块 1:1，便于 `npm test` 与 CI 单条命令），不按 src 目录镜像。

## 4. 文件大小与拆分原则

* 单文件 300 行左右为宜，超过 400 行先检查是否混了多个职责。
* 拆「上帝文件」时按**副作用种类**拆（状态编排 / 子进程 / 探测 / IO / UI 渲染），不要为了行数把顺序代码切碎。
* 新模块优先放进现有功能域；确实跨域复用的放入 `shared/`。
* 移动/改名文件后必须：全量改 import、跑 `npm run verify`、同步本文件与 `AGENTS.md` 的模块地图。

## 5. 已知边界与待办

* `panel/webview/panel-script.ts` 仍是单个内联脚本字符串，属刻意取舍（见上）。
* 测试代码尚未纳入 `tsc` 类型检查（历史缺口，见 `AGENTS.md` 代码审计章）。
* `AGENTS.md` 的模块地图与「L0/L1/L2」表述按现状更新后，以本文件为准；`AGENTS.md` 只保留规则。
