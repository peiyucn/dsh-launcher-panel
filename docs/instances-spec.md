# DSH 多实例管理规格

> 状态：**已实现**（0.3.x 起；2026-10-27 按当前 `dev` 实现复核，本文件随实现更新）· 原草案 v0.1 2026-10-24
> 范围：`dsh-launcher-panel` 的实例管理功能。
> 一句话：把扩展从「管理一个 DSH 服务」升级为「管理 N 个独立的 DSH 实例」；每个实例只描述 `DSH_HOME`、profile、port 等运行坐标。

## 一、背景

升级前（0.2.x 及以前）是单实例模型：

- 一个 `dsh.port`；
- 一个默认 `~/.dsh` home；
- 一个 `web` profile；
- 一个子进程、一个 `server.log`、一个状态栏、一个 Dashboard。

需要同时运行多个互不干扰的 DSH 时，用户只能自己开终端、记端口、切目录。实例管理把这件事收进扩展：创建、编辑、删除、启停、打开、看日志，每个实例独立。

**launcher 只管理「运行坐标」，不管理实例的用途。** 使用者拿实例去做什么——不同项目、不同账号、不同模型、不同权限——由使用者自己规划 `DSH_HOME` 下的 profile 内容；launcher 不提供用途模板，不判断实例之间是否应该隔离，也不校验 provider / model / preset / 权限配置。

## 二、目标与非目标

### 目标

1. 用实例对象统一表达 `DSH_HOME` + profile + port。
2. 从面板和命令创建、编辑、删除实例。
3. 每个实例独立启动、停止、打开 Web UI、看日志、看状态。
4. 多个实例可同时运行；一个实例的启停不影响另一个。
5. 兼容现有单实例用户的配置，升级后不丢 `dsh.port` 和启动能力。
6. 不改变扩展的既有定位：只走 DSH 公开入口，不读 DSH 内部实现，不复制 DSH 模板。

### 非目标

- **不做实例用途策略。** 不提供任何用途模板，不判断两个实例是否应该隔离，不检查 profile 里的模型、provider、preset、权限或工作区。
- **不管理用户 profile 内容。** 不注入 API key，不复制 credentials / sessions / workspaces，不导入导出实例，不改写用户自己的 `cordis.patch.yml`。**例外**：`dsh.instanceBrand`（默认开启）会在实例 profile 内维护 launcher 自有的 client bundle（`<home>/profiles/<profile>/node_modules/@dsh-launcher/instance-brand/`，其中含生成的 `cordis.patch.yml`，并在 profile `package.json` 的 `dsh.profile.bundles` 里登记该 bundle；关闭时移除）。见「十三、安全与归属」。
- **不管理 DSH 工作区。** 实例只决定启动哪个 home/profile；具体工作区仍由 DSH Web UI 选择。
- **不管理 DSH 安装。** 仍是一份共享安装；不做每实例独立版本、独立二进制或独立更新。
- **不删除 DSH 数据。** 删除实例只从 launcher 列表移除，不删 home、sessions、日志。
- **不做进程守护。** 不自动重启、不做崩溃恢复、不做开机自启、不做 Windows 服务。
- **不做跨机器同步。** 实例是机器本地配置，不通过 Settings Sync 同步；v1 不支持 workspace 级实例。
- **不支持同一 home 同时跑两个实例。** 这是 DSH 数据目录的技术约束，不是用途判断；详见「校验规则」。

## 三、术语

| 术语 | 含义 |
|---|---|
| 实例（Instance） | 一条运行配置：`{ id, name, home, profile, port, ... }` |
| home | `DSH_HOME`，DSH 的数据根：profiles、sessions、storages、credentials 都在这里 |
| profile | home 下的一套 DSH 插件/配置组合，默认 `web` |
| port | 该实例 Web UI 的监听端口 |
| 运行时（Runtime） | 一个实例对应的子进程、PID、状态、日志、URL/token、启停锁 |
| 活动实例（Active） | 状态栏和 `dsh.start` / `dsh.stop` 默认操作的实例 |

## 四、实例模型

```ts
interface DshInstance {
  /** 稳定 ID，UUID；日志目录和运行时状态用它，重命名不变 */
  id: string
  /** 显示名；唯一（大小写不敏感）；只影响 UI */
  name: string
  /** DSH_HOME；空字符串 = 默认 home（resolveDshHome()） */
  home: string
  /** home 下的 profile 名；默认 'web' */
  profile: string
  /** Web UI 端口；1–65535；实例间唯一 */
  port: number
  /** 可选；缺省时继承 dsh.autoOpenBrowser */
  autoOpenBrowser?: boolean
  /** 可选；缺省时继承 dsh.browser */
  browser?: 'built-in' | 'external'
}
```

约束：

- 实例对象**不包含** model、provider、preset、API key、权限、工作区、环境变量值。
- `dsh.runMode`（pkg/src）是**全局**运行来源，不是实例字段：所有实例共用同一份 dsh 树，切换模式前必须停止全部实例。
- `id` 不可编辑；`name`、`home`、auto-open 与浏览器覆盖可编辑。`profile` 只在创建/迁移时写入（新建固定 `web`，迁移也固定 `web`），界面不提供编辑入口——编辑保存时保留 `dsh.instances` 中的当前值，手改 settings 写入的自定义 profile 不会被表单覆盖。`port` 由 launcher 分配：`Default` 沿用 3080，新实例从 `dsh.instancePortBase` + 1 开始；面板不直接编辑端口。
- `home` 的修改不移动、不复制任何数据，只改变下次启动指向。
- 实例对象可以安全地出现在 `settings.json` 里：没有秘密。

## 五、设置与迁移

### 新增设置

| 键 | 类型 | scope | 默认 | 说明 |
|---|---|---|---|---|
| `dsh.instances` | `DshInstance[]` | `machine` | `[]` | 实例列表；面板写入全局用户设置 |
| `dsh.activeInstance` | `string` | `machine` | `''` | 活动实例 ID；空/无效时回退到第一个实例 |
| `dsh.instancePortBase` | `number` | `machine` | `31000` | 新实例端口根；5 位，范围 10000–65535；新实例取 base+1、base+2…… |
| `dsh.instanceBrand` | `boolean` | `machine` | `true` | 在实例 profile 内维护 launcher 自有的 client bundle，在 Web UI wordmark 下方显示实例名；关闭时移除该 bundle（已在 0.3.0 发布，本节补充记录） |

`dsh.instances` 的 schema 至少包含 `id`、`name`、`home`、`profile`、`port`，并允许 `autoOpenBrowser`、`browser`；`additionalProperties: false`，避免拼写错误静默进入配置。

### 保留的全局设置

以下仍为全局，所有实例共享：

- `dsh.runMode`、`dsh.npmChannel`、`dsh.pkgPath`、`dsh.srcPath`、`dsh.nodePath`
- `dsh.hideConsole`、`dsh.clearServerLogOnStart`、`dsh.sourceDebug`

以下作为**默认值**保留，实例可覆盖：

- `dsh.autoOpenBrowser` → 实例 `autoOpenBrowser` 的缺省值
- `dsh.browser` → 实例 `browser` 的缺省值

### 首次运行 / 旧设置迁移

- `dsh.port` 标记为 legacy，升级后只用于合成 `Default`；新实例的端口来自 `dsh.instancePortBase`。
- 首次激活时，如果尚未迁移过，且 `dsh.instances` 为空：
  - 用 `dsh.port`、`resolveDshHome()`、`profile: 'web'` 合成一个 `Default` 实例；
  - **先在内存里得到这个实例，再尽力写入** `dsh.instances`、设置 `dsh.activeInstance`；
  - 写入成功后才用 `context.globalState` 标记记录「列表已落地」，避免用户删光实例后又被自动重建（用户删空列表时也写该标记）；
  - 写入失败不得让初始化失败：实例留在内存里照常可用，面板显示一条黄色警告说明「设置没保存成功、重载窗口后会保存」。见下条。
- **写 `dsh.instances` 可能失败**：刚安装 / 更新扩展、窗口还没 reload 时，运行中的窗口配置注册表里可能还没有这个键，`update()` 会报 `Unable to write to User Settings because dsh.instances is not a registered configuration.`。这不是错误配置，重载窗口即可。启动路径必须容忍它：
  - 合成实例、创建/编辑/删除实例都**先落盘、成功后再改内存**；写失败就报错并回滚，绝不留下「面板看不见但校验时存在」的幽灵实例（否则重试会报 `name "…" is already used`）。
  - 面板必须把设置/初始化问题渲染出来（`issues`），不能只显示空的实例列表。
  - 首次安装时 `dsh.pkgPath` / `dsh.srcPath` 的写入失败同样只警告、不阻断 Start。
- 如果 `dsh.instances` 已有内容，不覆盖。
- `dsh.port` 保留在 schema 中并标注 deprecated；迁移后不再读取。
- README / CHANGELOG 已写明这次迁移和 `dsh.port` 的变化（0.3.0）。

### 读取与校验

- 设置读取后先做一次规范化：`home` 展开 `~`、`path.resolve`；`profile` 去空白；`port` 转整数。
- 非法条目不要静默丢弃：面板应显示一条可见的错误（索引 + 原因），并禁止对该条目执行启停；不要自动改写用户的 settings。
- 重复 `id`：保留第一条并告警。
- 重复 `port`：配置允许存在，但启动时拒绝并提示冲突；新建/编辑表单在写入前就阻止重复。
- 重复 `home`：允许配置，但同一 home 同时只能跑一个实例；面板显示「共享 home」标记。

## 六、创建实例

### 表单字段

两个入口，字段与校验规则一致：

- **面板内 modal**：`+` / Edit 按钮打开（`panel.ts` 的 `openInstanceForm`，webview 侧 `instanceForm` 消息渲染 modal）。
- **命令面板原生输入**：`dsh.instance.new` / `dsh.instance.edit` 走 VS Code 原生 `showInputBox` / `showQuickPick` 序列（`actions.ts`）。

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| 名称 | 是 | 面板 `Instance <N>`（N=现有实例数+1）；命令面板 `Instance` | 唯一，大小写不敏感，去首尾空白，≤64 字符 |
| home | 是 | `~/.dsh-<slug>` | 默认跟随名称；手动改过后不再自动跟随；可留空表示默认 home |
| 自动打开浏览器 | 否 | 继承全局 | 覆盖 `dsh.autoOpenBrowser` |
| 浏览器 | 否 | 继承全局 | `built-in` / `external`，覆盖 `dsh.browser` |

- 第一个实例（迁移场景）默认 home 是 `~/.dsh`；新建实例默认 `~/.dsh-<slug>`（slug 由名称生成，面板表单里名称变化时 home 跟着变，手动改 home 后停止跟随）。
- 表单没有「浏览…」目录选择按钮：home 用文本输入，可填不存在的路径（Start 时创建）或已有目录。
- profile 固定为 `web`，不在表单里显示；`dsh.instances` 里手改的自定义 profile 在编辑保存时保留。
- 端口由 launcher 在创建时按 `dsh.instancePortBase` 自动分配（`suggestPort()`：base+1、base+2……，跳过已配置与已占用端口，越过 65535 时回绕到 10000）；两个表单都不显示端口输入框。

### 创建步骤

1. **提交**：面板 modal 把字段序列化成 `saveInstanceForm` 消息交给扩展；命令面板路径直接调用 `manager.create()`。扩展侧解析/校验，错误经 modal 错误区或错误提示返回；不信任 webview。
2. **校验**：名称唯一性（大小写不敏感）、home 合法（见「十、校验规则」）、auto-open/browser 枚举；profile 固定 `web`，端口由 launcher 分配。
3. **准备 home**：
   - 路径不存在：`create()` 里创建目录（只创建目标目录，不递归删除任何东西）。
   - 路径存在且是文件：拒绝。
   - 路径存在且非空：直接使用，不额外确认，也不删除/覆盖其中内容（profile 内容由 DSH 自己管理）。
4. **profile 可以先不存在**：
   - 已存在：直接使用，不重置。
   - 不存在：创建阶段不阻塞；Start 时再让 DSH 自己初始化（shipped `web` 用 `dsh web --dump-config`，自定义 profile 用 `--profile <p> --from-default-profile web --dump-config`）。不要手工复制模板。
5. **写实例**：校验通过即写入 `dsh.instances`，并设为活动实例；home 目录可以本次创建；profile 缺失不是创建失败。写失败则报错、不改内存（见「五、首次运行 / 旧设置迁移」）。
6. **不自动启动**：创建完成即停；用户再点 Start。不提供「Create & Start」。

### 首次安装 / 空机器

这是必须单独保证的起始状态：用户刚装好扩展，电脑上没有 dsh 安装、没有 `~/.dsh`、也没有任何实例。

- 首次激活且尚未迁移时，仍然合成一个 `Default` 实例（`home: ''`、`profile: 'web'`、端口取 `dsh.port` 或 3080），写入 `dsh.instances`。**不要求 `~/.dsh` 或 dsh 安装已经存在。**
- 面板显示 `Default` tab，状态 `stopped`；dsh 缺失时 Start 按钮显示「Install & Start」，`+` 仍然可用。
- Start 的顺序：
  1. 走现有全局安装流程装 dsh（pkg/source）；
  2. 用目标 `DSH_HOME` 确认 profile 存在；缺失时让 DSH 自己初始化（shipped `web` 用首次 `dsh web --dump-config`，自定义 profile 用 `--from-default-profile web`，不手工复制模板）；
  3. 再 spawn `dsh web --port <port>`。
- 创建实例不要求 dsh 已安装：表单只写实例坐标，允许 home/profile 尚不存在；Start 时再安装并初始化 profile。
- 初始化失败时保留实例和 settings，显示错误与日志路径；不要删除用户数据，也不要悄悄回退到别的 home。
- 如果用户删光所有实例，面板显示空状态 + `+`；不要用迁移逻辑自动重新创建 Default。
- 现有用户升级：`dsh.port` 迁移成 Default；已有 `~/.dsh` / dsh 安装继续可用。

### 创建失败

- 任何一步失败：显示具体原因；不自动删除已创建的 home（不逆操作用户数据）。
- 如果 home 是本次新建的空目录，可以提示用户「目录已创建，可重试或手动删除」。
- 全局安装 / pnpm / 网络失败：保留实例，Start 显示错误与重试入口；不要丢失 settings。

## 七、编辑与删除

### 编辑

- `name`：随时可改；只影响显示。
- `home`：只在实例停止时可改；运行中先提示停止（`manager.update()` 对 running/starting/stopping/installing 直接拒绝）。
- **`profile` 与端口不可在界面编辑**：面板 modal 与命令面板都只提交 name/home/auto-open/browser，保存时保留 `dsh.instances` 中的当前 `profile` 与 `port`（`panel.ts` 的 `saveInstanceForm` edit 分支取 `current.port` / `current.profile`；`actions.ts` 同理）。手改 settings 才能换 profile。
- 修改 home **不移动、不复制**任何数据；面板表单提示「changing it does not move data」。
- 端口由 launcher 分配，不在编辑表单里；改 home 不触发端口重编。
- `id` 不可改。
- 改成的 home 与另一个实例相同：保存只产生「home is shared…」警告（配置层允许共享），真正启动第二个时被 `isHomeRunning()` 拒绝并提示先停另一个；home 互相嵌套时同样只警告。

### 删除

1. 如果实例在运行，先确认停止。
2. 从 `dsh.instances` 移除；如果是活动实例，选择下一个实例或清空。
3. dispose 该实例的运行时、日志 tail、活动缓冲。
4. **不删除 home、sessions、workspace、credentials、服务端日志。**
5. 删除确认文案必须写明：「只从 launcher 移除；`<home>` 下的 DSH 数据不会删除。」

日志目录可以保留（便于事后排查）；如需清理，后续提供单独的「删除日志」动作，不与删除实例绑定。

## 八、生命周期与运行时

### 状态机

每个实例独立维护：

```
stopped ──start──▶ starting ──port/url ready──▶ running
   ▲                  │                          │
   │                  └──failure──▶ error        │
   │                                             │
   └────────────── stopping ◀────stop────────────┘
```

- `starting` 必须有超时；超时/进程早退/端口未开都必须进入 `error`，不能卡在 `starting`。
- `error` 携带可读原因和日志路径；面板可重试。
- `stopping` 直到端口关闭或超时才落到 `stopped` / `error`。
- 状态不持久化；重启扩展后通过端口探测重新判定。

### Start

1. 端口已开：尝试接管（`adopt()`：先探 `http://127.0.0.1:<port>/`，旧版 dsh 需要 token 时从实例日志读 token 再探 token URL）；不是 DSH 的进程则报错「port … is already in use by another process」，**不杀占用者**。
2. 同一规范化 home 已有实例在运行：拒绝，提示先停另一个。
3. 有全局 dsh 更新在进行：拒绝并提示等待。
4. 创建 home 目录（不存在时），再走共享安装/检测流程（`prepare()`）；dsh 缺失时该实例显示安装态，不并发安装。
5. 确认 profile 存在；缺失时让 DSH 自己初始化（`web` 用 `dsh web --dump-config`，自定义 profile 用 `--profile <p> --from-default-profile web --dump-config`），不手工复制模板。
6. 启动子进程：
   - 子进程环境加 `DSH_HOME=<实例 home>`；
   - 参数为 `[<profile>, '--port', '<port>']`，dsh 版本足够新时追加 `--no-open`；
   - pkg 模式经 `pnpm exec dsh` 启动，source 模式经 `node --import tsx/esm apps/cli/src/bin.ts` 启动；
   - `hideConsole` → `windowsHide`；source 模式且 `sourceDebug` 时加 `NODE_DEBUG=module`。
7. 每个实例独立日志：`~/.dsh-launcher-panel/logs/instances/<id>/server.log`；`clearServerLogOnStart` 只清该实例的日志。
8. 等待端口/URL 就绪；标记 `running`；按实例的浏览器设置打开。
9. 并发 Start 同一实例：合并/幂等；已在运行则直接打开或提示。
10. 并发 Start 不同实例：允许，但不能并发跑全局安装/更新。

### Stop

- 优先杀 tracked child（Windows 用 `taskkill /T`，见 `killPid`）。
- 没有 tracked child 时（例如扩展重启后接管的实例，或端口被陌生进程占用）：默认**不杀**（`manager.stop()` 默认 `killUntracked=false`）。`Stop` 先弹 VS Code 原生确认 modal（实例名 + 端口 + 「只在该进程是本实例的 DSH 服务器时才继续」），确认后才按端口 owner 杀。
- 轮询端口关闭；超时进入 `error`，不要假装已停止；没停下时给出可见警告。
- Stop 一个实例不影响其他实例。

### 意外退出

- 子进程 `close` 且不是主动 Stop：标记 `stopped`，并记录 `error = "dsh exited unexpectedly (exit code N) — see <logPath>"`（面板错误行与活动流都能看到原因与日志路径）；清除 PID/URL；不自动重启。
- 面板显示「已退出」和日志路径。

### 扩展重启 / 接管

- 现状是扩展 deactivate 时**故意不杀服务**，VS Code 关闭后 Web UI 继续可用。多实例保持这个契约：deactivate 只停日志 tail，不杀实例。
- 重新激活时，对每个实例探测端口：
  - 端口开：标记 `running`（接管），尽量从该实例日志恢复 URL/token；
  - 端口关：`stopped`。
- 接管实例的 Stop 走上面的「确认后杀端口 owner」路径。
- 接管成功时状态标记为 `running (external)`；端口被非 DSH 进程占用时标记 `untrackedPort`（状态栏菜单显示 `port held by an untracked process`），Stop 需确认后才杀（见上）。

## 九、UI 与命令

### 面板（v1：实例 tab）

**替换范围**：面板改为统一的带边框区块，每个区块有内标题：**Runtime / Instances / Console / DeepSeek API**；Settings 是无边框竖排区。实例的 Start/Stop 放进 Instances 区。

```text
┌ Runtime ───────────────────────────┐
│ [pkg src]                          │
│ deepseek harness  v0.2.1  [Update] [⟳]│
└────────────────────────────────────┘
┌ Instances      2 instances · 1 running   + ┐
│ [ Default ● ][ Work ○ ]             │  ← active tab = background, no underline
│ Work                         ✎  🗑  │  ← edit/delete after the status
│ home     C:\Users\...\.dsh-work    │
│ package  C:\...\package            │
│ [ Start / New Tab ]        [ Stop ]│
└────────────────────────────────────┘
┌ Console ───────────────────────────┐
│ [Clear] [debug off]                │
│ log ...                            │
└────────────────────────────────────┘
┌ DeepSeek API · Off-peak          ▸ ┐  ← collapsed by default
└────────────────────────────────────┘
  expanded:
  Model APIs      │ Other APIs
  ● deepseek...   │ ● search
  ● deepseek...   │ ● fetch
  Account ... [Balance] [↗]

Settings (no frame)
[Global Settings]              [Browser]
node · launcher
```

- **统一 section 规范**：0.5px 线框 + r14 + 8/10 padding；内标题 12px/600；label 10px fg2；值 11px fg；路径 10px 等宽 fg2；主按钮 12px、mini 按钮 10px。所有功能区共用同一套。面板为视口内 flex 列，console 是弹性区域，不写死高度；其他 section 固定内容。
- **tab 条**：在 Instances 区内部；每个实例一个 tab，显示名称 + 状态点。`+` 在 Instances 标题行右侧，不在 tab 条里；标题行同时显示 `N instances · M running` 摘要。**选中态只用 tab 底色区分，不再加下划线/主色线。** 只有一个内容面板；切换 tab 重渲染当前实例，不复制 N 份 DOM。
- **状态点**：running 绿、starting/installing 动画、error 红、stopped 灰；与状态栏一致。卡片里不再重复一个状态点。
- **tab tooltip**：名称、home、完整状态；名称过长省略。
- **溢出**：单行横向滚动；当前 tab 自动滚入视野；后续可加溢出菜单。
- **空列表**：只显示「No instances」提示；`+` 仍在标题行；legacy 迁移后至少有一个 Default。
- **`+`**：打开创建表单（modal）；成功后 append tab 并选中。
- **Instances 内容**：
  - 状态/URL；**Start / New Tab / Stop 都在这个区内**（Start 在 running 时变成 New Tab）。
  - **Edit/Delete** 放在状态行右侧，用竖线隔开，图标按钮 + tooltip；运行中禁用，停止后 Delete 确认；只移除列表，不删数据。
  - **home/package** 归为一组；profile 不在 Instances 区显示，也不在 Edit 表单里编辑（新建固定 `web`；手改 settings 才能换 profile）。**不显示端口**，运行中的 URL 已经带端口。端口由 launcher 分配（`dsh.instancePortBase`），面板不编辑。
  - 编辑表单只改名称、home、auto-open、browser；名称变化时，若 home 仍是自动格式，会同步改成 `.dsh-{new name}`；改 home 不移动数据。profile 固定 web，不在表单里。
- **Runtime（最上方）**：`deepseek harness` 版本、mode（pkg/src）、Update/⟳；这些是共享的。
- **Console/日志**：独立 section，跟随当前 tab；日志 tail 和 server log 路径切换；`Clear`/`debug` 默认跟随当前 tab。
- **DeepSeek API 状态**：独立 section，**默认收起**，只显示标题、Peak/Off-peak 和展开箭头；点标题展开后显示模型 API / 其他 API 两栏（中间短分割线）、余额、状态链接。**Balance** 跟随当前 tab 的 home（账户/余额读取用当前实例 home）。
- **Settings**：页面底部，无边框、无标题；放 Global Settings、浏览器选择和 node/launcher 版本。
- **同步**：tab 选择 = `dsh.activeInstance`；状态栏/快速选择/命令切换时 tab 跟随。
- **键盘/可访问性**：`role="tablist"` / `role="tab"` / `role="tabpanel"`；左右方向键移动，Home/End，Enter/Space 激活；`+` 是普通 button；切换后焦点回到选中 tab；错误/状态变化用 `aria-live`（避免刷屏）。
- **共享 home 警告**：在 tab 名旁显示警告标记，tooltip 说明「与 <name> 共用 DSH 数据，不能同时运行」。
- **创建/编辑表单**：面板内 modal（`+` / Edit）；字段为名称、home、auto-open、browser，无 profile/端口字段。提交后由扩展侧校验，错误回填到 modal 内错误行；Create/Save 在提交期间禁用，失败后恢复。删除用 VS Code 原生确认弹窗（`showWarningMessage(..., { modal: true })`），文案写明「只从 launcher 移除；`<home>` 下的 DSH 数据不删除」。命令面板的 `dsh.instance.new` / `dsh.instance.edit` 走原生 InputBox 序列，不弹面板 modal。

### 状态栏

- 显示活动实例的名称（`DSH Launcher Panel · <name>`）与状态；运行中沿用现有背景色（`dsh.statusBar.runningBackground` / `dsh.statusBar.runningForeground`），启动/安装/更新时喷水动画。
- tooltip 显示状态、运行中 URL、活动实例名；多个实例运行时附带「N instances running」。
- 点击打开快捷菜单（`dsh.statusMenu`）：
  - 首行是运行摘要（实例名 · 状态 · pkg/src mode · dsh 版本 · 运行中 URL）；
  - 下面列出**全部实例**：名称 + `:port` + 状态（active 的标 `· active`，接管显示 `running (external)`，陌生端口显示 `port held by an untracked process`），detail 显示 home；
  - 选中实例后弹出该实例可用的动作子菜单（Open / Start / Restart / Stop / Make Active，按状态过滤）；
  - 底部是全局动作（Start/Open Web UI / Open Dashboard / Stop，按当前状态）+ Open Global Settings。
- 命令面板另有 `dsh.instance.select` 快速选择活动实例。

### 命令

| 命令 | 注册/贡献 | 行为 |
|---|---|---|
| `dsh.start` / `dsh.stop` | 已注册 + contributes | 作用于**活动实例** |
| `dsh.instance.start` / `dsh.instance.stop` / `dsh.instance.restart` | 已注册 + contributes（0.3.x 重构批次补上） | 带实例 ID 的精确操作；无参数（命令面板调用）时作用于活动实例。面板按钮通过 webview 消息直接调用 `action*` 并传实例 ID |
| `dsh.instance.new` | 已注册 + contributes | 创建实例（命令面板路径为原生 InputBox 序列，面板路径为 modal） |
| `dsh.instance.edit` | 已注册 + contributes | 编辑实例；可选参数为实例 ID，缺省用活动实例 |
| `dsh.instance.delete` | 已注册 + contributes | 删除实例（原生确认弹窗）；可选参数为实例 ID |
| `dsh.instance.select` | 已注册 + contributes | 快速选择活动实例 |
| `dsh.instance.open` | 已注册 + contributes | 打开实例 Web UI；可选参数为实例 ID，缺省用活动实例 |
| `dsh.statusMenu` | 已注册（内部，不贡献） | 状态栏快捷菜单入口 |

- 面板按钮必须传实例 ID，不能依赖「当前活动」的隐式状态，避免切换竞态。
- 命令参数统一经 `instanceIdArg()` 归一化：命令面板调用不带参数 → 落到活动实例；面板/菜单调用带 ID。

### 日志与账户

- 服务端日志按实例分开；客户端 `client.log` 仍为全局扩展日志。
- 面板的账户/余额/API key 读取必须使用**当前实例的 home**（`<home>/.credentials.yaml`），不能固定读 `~/.dsh`。
- 当前实例没有凭据时显示「未配置」，不要回退显示另一个实例的账户。

## 十、校验规则

### 名称

- 去首尾空白后非空；≤ 64 字符（`MAX_INSTANCE_NAME_LENGTH`）；不允许控制字符。
- 大小写不敏感唯一。

### ID

- 默认 `crypto.randomUUID()`；不可编辑；不允许重复；读取 settings 时要求是路径安全字符串（≤80，`INSTANCE_ID_PATTERN`），因为日志目录用它。

### home

- 支持 `~` 展开；`path.resolve` 后必须是绝对路径；空字符串表示默认 home（`resolveDshHome()`）。
- 不允许控制字符。
- 不能位于 launcher 自己的目录内：`~/.dsh-launcher-panel`、托管 pkg 安装目录、托管 source 检出目录（含嵌套子目录）。
- 创建时：路径不存在则创建目录；路径是文件则拒绝；不可写会在创建目录 / 启动时报错（没有预检）。
- 允许空格、非 ASCII、UNC 路径（按平台能力）。
- 精确重复的 home：允许配置，创建/编辑时给出「home is shared with …」警告；同一 home 同时只能跑一个实例（启动时拒绝）。
- 嵌套 home：允许，创建/编辑时给出「home overlaps with …」警告（两个数据根互相包含，备份/清理容易混淆）；读取 settings 的规范化只对共享 home 告警，嵌套不告警。

### profile

- `^[A-Za-z0-9][A-Za-z0-9._-]*$`，长度 ≤64（`MAX_PROFILE_LENGTH`）；拒绝 `.`、`..`、路径分隔符；默认 `web`。
- 必须存在于 `<home>/profiles/<profile>`，或在创建时初始化。
- 不校验 profile 内容。

### port

- 整数，1–65535；拒绝 0。
- 实例间唯一（配置层）：读取 settings 时重复端口是 warning，创建/编辑时是 error。
- 启动前在 `127.0.0.1` 上探测：被非 DSH 进程占用则 error 且不杀占用者；已被 DSH 占用则尝试接管。
- 自动分配：从 `dsh.instancePortBase + 1` 开始，跳过已配置端口和已占用端口；base 在范围顶端时回绕到 10000。

### 同一 home 并发

- 规范化（realpath/大小写）后相同 home 的实例，同一时间只允许一个运行。
- 启动第二个时返回明确错误，并在 UI 指向占用者。
- 这是技术约束：DSH 的 sessions/workspaces/credentials 都在 home 下，两个服务器同时写不安全；不代表 launcher 对实例用途做判断。

## 十一、全局操作

- **安装/更新**：共享一份 DSH 安装。执行前要求所有实例停止（或弹窗确认停止全部）；更新完成后保持停止，由用户逐个启动。不要自动重启。
- **runMode 切换**（pnpm/source）：同样要求全部停止。
- **版本检测**：共享；所有实例显示同一个 DSH 版本。
- **并发锁**：全局安装/更新/切 mode 一把锁；实例启停是每实例一把锁。
- **端口释放**：实例停止后端口才能被其他实例使用；配置层仍要求端口唯一，避免「停着的实例占着端口」的惊喜。

## 十二、错误处理

| 场景 | 行为 |
|---|---|
| 创建时 home 创建失败/不可写 | 报错，不写实例 |
| 启动时 profile 初始化失败 | `error`；实例保留，显示原因与重试入口（创建阶段不初始化 profile，见 §六） |
| 创建时端口被占 | 报错，建议换端口 |
| 启动时 home/profile 缺失 | `error`，提示编辑实例或初始化 profile |
| 启动时端口被占 | `error`，不杀占用者 |
| 启动超时/进程早退 | `error`，显示日志路径 |
| 停止超时 | `error`，不要显示 stopped |
| 接管时端口是陌生进程 | 标记 `untrackedPort`（菜单显示 `port held by an untracked process`）；Stop 需确认后才杀 |
| 设置条目非法 | 面板显示错误行；不自动改写 settings |
| 并发 Start/Stop | 每实例合并/幂等；不出现双进程或假 stopped |
| 全局更新时仍有实例运行 | 阻止并提示先停止 |

## 十三、安全与归属

- 实例对象和 settings 里**不存 API key、token、密码**；凭据留在各 home 的 DSH vault 或环境变量。
- 表单不要求输入密钥；创建流程不读取、不复制 `.credentials.yaml`。
- 子进程一律 `spawn` + 参数数组，不拼 shell；home 通过环境变量传递；profile 名先校验。
- 日志/面板不打印密钥；launch token 的现有处理保持不变。
- 删除实例不删 home；任何删除目录的动作都必须单独确认并校验归属。
- 不自动改写用户自己的 `cordis.patch.yml`、sessions、workspaces；`dsh.instanceBrand` 例外：launcher 只写自己的 bundle 目录（含其生成的 patch 文件）并在 profile `package.json` 的 `dsh.profile.bundles` 中登记/移除该 bundle。
- 实例列表是机器本地配置；不要写入 workspace settings（避免同步/跨机器路径问题）。

## 十四、测试

### 单元（`test/*.test.ts`，不依赖 vscode；随实现更新）

- 实例正常化：`~` 展开、相对路径拒绝、空 home 回退默认、profile 去空白。
- 名称/ID/端口/profile 校验；重复检测；共享/嵌套 home 警告。
- 端口自动建议：跳过已配置、跳过已占用、无可用端口报错。
- 同一 home 并发守卫；共享 home 检测。
- 旧设置迁移：`dsh.port` → Default 实例；已有实例不覆盖；迁移标记。
- 活动实例回退：无效 ID → 第一个；空列表 → 无。
- 启动参数/环境构建：`DSH_HOME`、`--port`、profile、`--no-open` 版本门槛。
- 状态机纯函数：start/fail/stop/exit 的合法迁移；不允许 `starting` 直接回 `stopped` 而不清理。
- 日志路径：按 id 分目录；`clearServerLogOnStart` 只清当前实例。
- 面板/契约回归：payload 键覆盖客户端消费字段、命令集合、转义。

### 手工矩阵

1. 旧用户升级：有 `dsh.port`、无 `dsh.instances` → Default 实例，Start/Stop/Open 正常。
2. 新建实例：新 home、`web` profile、新端口 → 初始化、启动、打开、停止。
3. 两个实例同时运行：各自端口、日志、sessions 独立；停一个不影响另一个。
4. 已有 home + 已有 profile：直接挂载，不初始化、不重置。
5. 自定义 profile（手改 `dsh.instances` 的场景）：从 `web` 模板创建；已存在时不覆盖。
6. 端口冲突：配置重复、外部占用、启动时冲突，三种都报错。
7. 共享 home：两个实例配置允许；同时启动第二个被拒绝。
8. 编辑：运行中改 home 要求先停；改 home 不移动数据；profile/端口不可通过面板编辑。
9. 删除：运行中先停；只移除列表；home 仍在。
10. 扩展重启：实例仍在运行 → 激活后接管，状态 running；Stop 正常。
11. 更新：有实例运行时阻止；停止全部后更新；不自动重启。
12. VS Code 内置浏览器同时打开两个实例的 UI，token 各自正确。
13. 面板切换实例：日志、活动、账户/余额跟随当前实例。
14. 非法 settings：不崩、不静默改文件、有可见错误。
15. tab 条：切换、状态点、溢出滚动、`+` 固定；`+` 新建后追加并选中；删除后选中相邻 tab；运行中编辑/删除被阻止；外部命令切换 active 时 tab 跟随；键盘左右/Home/End。

### 验证

- `npm run verify`（typecheck + test + compile + package）通过。
- `git diff --check` 干净。
- 手工矩阵记录在 PR/commit 描述或测试清单。

## 十五、文档与发布

- `README.md` / `README.zh-CN.md`：已含 Features/Usage/Settings 中的实例说明；`DSH_HOME`、profile、port、机器本地、删除不删数据、共享 home 不能同时运行均有说明。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`：0.3.0 已写功能条目，含旧 `dsh.port` 迁移；后续实例相关改动按用户可感知变化补条目。
- 本文 `docs/instances-spec.md` 是开发文档，不进 README / CHANGELOG / VSIX。
- 发布走项目既有流程：`dev` → `verify` → `main` → owner 当次确认 → tag。本规格只定义功能，不构成发布许可。

## 十六、分期（历史记录：四个 Stage 均已于 0.3.0 前完成）

1. **Stage 1：纯模型** — 实例类型、设置 schema、迁移、校验、端口建议、单元测试；不碰 UI。
2. **Stage 2：运行时** — InstanceManager / InstanceRuntime、每实例进程/日志/状态/接管；保持单实例命令可用。
3. **Stage 3：UI 与命令** — 面板实例 tab 条 + 内容面板、创建/编辑/删除表单、状态栏、快速选择、命令。
4. **Stage 4：全局收尾** — 安装/更新与多实例的交互、README/CHANGELOG、手工矩阵、`verify`。

（历史决策）每阶段独立 commit；Stage 2 完成前不改用户可见 UI，降低回滚成本。

## 十七、验收标准

- 升级现有用户后，无需重新配置即可看到并启动 Default 实例；`dsh.port` 值被正确继承。
- 创建新 home + 新端口的实例：profile 可先不存在（Start 时由 DSH 从 `web` 模板初始化），能启动、打开、停止；日志在独立目录。
- 两个实例可同时运行，互不影响；端口冲突、共享 home 并发、缺失 profile 都有明确错误。
- 面板以 tab 条呈现实例；`+` 可新建；切换 tab 同步活动实例、日志、状态栏；tab 溢出可横向滚动且 `+` 始终可见。
- 每个 tab 可 Start/New Tab/Open、Delete（停止时）；端口与 profile 不可在界面编辑；运行中编辑/删除有明确提示。
- 编辑运行中实例会要求先停止；改 home 不移动数据；删除只移除列表。
- 扩展重启后能接管仍在运行的实例；Stop 行为安全（陌生端口需确认）。
- 设置中无秘密；删除不删 home；非法设置不导致崩溃或静默改写。
- `npm run verify` 全绿；README/CHANGELOG 双语更新。

## 十八、开放问题

| # | 问题 | 建议 |
|---|---|---|
| 1 | 实例列表放 `dsh.instances` 还是独立 `instances.json` | v1 用 settings（`machine` scope），可发现、可手改；复杂后再迁移 |
| 2 | 实例多了 tab 条怎么溢出 | 单行横向滚动 + `+` 固定；当前 tab 自动滚入；后续加溢出菜单，不做多行换行 |
| 3 | 共享 home 是否在配置层直接禁止 | 不禁止，只禁止同时运行 + UI 警告；不替用户决定用途 |
| 4 | profile 初始化命令能否跨支持版本非交互完成 | 实现时用当前支持版本验证；不能则失败并给手工提示 |
| 5 | 接管的陌生端口 Stop 是否允许杀 | 默认不杀；用户明确确认后才杀 |
| 6 | 删除实例是否同时删 launcher 日志 | 不删；后续单独「清理日志」 |
| 7 | 是否做「Create & Start」 | v1 不做；创建后手动 Start |
| 8 | `dsh.start` / `dsh.stop` 在多实例下是否弹选择 | 作用域活动实例；快速选择提供其他实例 |
| 9 | 是否支持 workspace 级实例 | v1 不支持；机器本地 |
| 10 | 是否做实例复制/导入导出 | 后续；v1 只做新建/编辑/删除 |
| 11 | 端口/名称内联改，home/profile 用 modal？ | **已定（已实现）**：端口由 `dsh.instancePortBase` 自动分配、面板不编辑；名称/home/auto-open/browser 用 Edit modal；profile 不在界面编辑，手改 settings 才能换 |
| 12 | tab 顺序是否可拖拽 | v1 按 `dsh.instances` 顺序，不支持拖拽；后续 |
