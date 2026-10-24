# DSH 多实例管理规格

> 状态：草案 v0.1 · 2026-10-24
> 范围：`dsh-launcher-panel` 的实例管理功能。
> 一句话：把扩展从「管理一个 DSH 服务」升级为「管理 N 个独立的 DSH 实例」；每个实例只描述 `DSH_HOME`、profile、port 等运行坐标。

## 一、背景

现状是单实例模型：

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
- **不管理 profile 内容。** 不写 `cordis.patch.yml`，不注入 API key，不复制 credentials / sessions / workspaces，不导入导出实例。
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
- `id` 不可编辑；`name`、`home`、`profile`、浏览器选项可编辑。`port` 由 launcher 分配：`Default` 沿用 3080，新实例从 `dsh.instancePortBase` + 1 开始；面板不直接编辑端口。
- `home`、`profile` 的修改不移动、不复制任何数据，只改变下次启动指向。
- 实例对象可以安全地出现在 `settings.json` 里：没有秘密。

## 五、设置与迁移

### 新增设置

| 键 | 类型 | scope | 默认 | 说明 |
|---|---|---|---|---|
| `dsh.instances` | `DshInstance[]` | `machine` | `[]` | 实例列表；面板写入全局用户设置 |
| `dsh.activeInstance` | `string` | `machine` | `''` | 活动实例 ID；空/无效时回退到第一个实例 |
| `dsh.instancePortBase` | `number` | `machine` | `31000` | 新实例端口根；5 位，范围 10000–65535；新实例取 base+1、base+2…… |

`dsh.instances` 的 schema 至少包含 `id`、`name`、`home`、`profile`、`port`，并允许 `autoOpenBrowser`、`browser`；`additionalProperties: false`，避免拼写错误静默进入配置。

### 保留的全局设置

以下仍为全局，所有实例共享：

- `dsh.runMode`、`dsh.npmChannel`、`dsh.pkgPath`、`dsh.srcPath`、`dsh.nodePath`
- `dsh.hideConsole`、`dsh.clearServerLogOnStart`、`dsh.sourceDebug`

以下作为**默认值**保留，实例可覆盖：

- `dsh.autoOpenBrowser` → 实例 `autoOpenBrowser` 的缺省值
- `dsh.browser` → 实例 `browser` 的缺省值

### 旧设置迁移

- `dsh.port` 标记为 legacy，升级后只用于合成 `Default`；新实例的端口来自 `dsh.instancePortBase`。
- 首次激活时，如果尚未迁移过，且 `dsh.instances` 为空：
  - 用 `dsh.port`、`resolveDshHome()`、`profile: 'web'` 合成一个 `Default` 实例；
  - 写入 `dsh.instances`，设置 `dsh.activeInstance`；
  - 用一个 `context.globalState` 标记记录已迁移，避免用户删光实例后又被自动重建。
- 如果 `dsh.instances` 已有内容，不覆盖，只记录迁移标记。
- `dsh.port` 保留在 schema 中并标注 deprecated；迁移后不再读取。
- README / CHANGELOG 必须写明这次迁移和 `dsh.port` 的变化。

### 读取与校验

- 设置读取后先做一次规范化：`home` 展开 `~`、`path.resolve`；`profile` 去空白；`port` 转整数。
- 非法条目不要静默丢弃：面板应显示一条可见的错误（索引 + 原因），并禁止对该条目执行启停；不要自动改写用户的 settings。
- 重复 `id`：保留第一条并告警。
- 重复 `port`：配置允许存在，但启动时拒绝并提示冲突；新建/编辑表单在写入前就阻止重复。
- 重复 `home`：允许配置，但同一 home 同时只能跑一个实例；面板显示「共享 home」标记。

## 六、创建实例

### 表单字段

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| 名称 | 是 | `Instance N` | 唯一，大小写不敏感，去首尾空白 |
| home | 是 | `~/.dsh-<slug>` | 可输入新路径，或从已有目录选择 |
| profile | 是 | `web` | 可从 home 下已有 profile 选择，或新建 |
| 端口 | 是 | 自动建议 | 从 3080 起找第一个空闲且未被实例占用的端口 |
| 自动打开浏览器 | 否 | 继承全局 | 高级选项 |
| 浏览器 | 否 | 继承全局 | `built-in` / `external`，高级选项 |

- 第一个实例（迁移场景）默认 home 是 `~/.dsh`；新建实例默认 `~/.dsh-<slug>`（slug 由名称生成）。若该路径已存在，建议 `-2`、`-3`，或让用户显式选择「使用已有目录」。
- 表单必须有「浏览…」选择已有目录；新建不存在的 home 走文本输入。
- profile 下拉从 `<home>/profiles/*` 读取；home 变化时刷新。
- 端口由 launcher 在创建时按 `dsh.instancePortBase` 自动分配；表单不显示端口输入框。

### 创建步骤

1. **前端校验**：名称、home、profile 的基本格式；重复检查；给出内联错误。端口不在表单里，由 launcher 分配。
2. **后端复验**：不信任 webview，扩展侧重新跑全部校验。
3. **准备 home**：
   - 路径不存在：创建目录（只创建目标目录，不递归删除任何东西）。
   - 路径存在且是文件：拒绝。
   - 路径存在且非空、但不像 DSH home：提示「这不是空的 DSH 数据目录，继续会把 DSH 数据混进去」，要求显式确认。
4. **profile 可以先不存在**：
   - 已存在：直接使用，不重置。
   - 不存在：创建阶段不阻塞；Start 时再让 DSH 自己初始化（shipped `web` 用首次 `dsh web --dump-config`，自定义 profile 用 `--from-default-profile web`）。不要手工复制模板。
5. **写实例**：校验通过即写入 `dsh.instances`，并设为活动实例；home 目录可以本次创建；profile 缺失不是创建失败。
6. **不自动启动**：创建完成即停；用户再点 Start。可以提供「Create & Start」作为后续增强，v1 不做。

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
- `home`、`profile`：只在实例停止时可改；运行中先提示停止。
- 修改 home/profile **不移动、不复制**任何数据；表单必须显示这句警告。
- 端口由 launcher 分配，不在编辑表单里；改 home/profile 不触发端口重编。
- 修改 home 后重新读取 profile 列表；如果新 home 下没有该 profile，提示创建或换一个。
- `id` 不可改。
- 如果改成的 home 正被另一个运行中实例使用，拒绝保存或要求先停另一个。

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

1. 校验实例：home 存在、profile 存在、port 合法且未被其他运行实例占用。
2. 同一规范化 home 已有运行中实例：拒绝，提示先停另一个。
3. 如 DSH 未安装：走现有全局安装流程；安装期间该实例为 `starting`/安装态，不并发安装。
4. 用与单实例相同的命令解析启动：
   - 子进程环境加 `DSH_HOME=<实例 home>`；
   - 参数带 `--port <实例 port>`；
   - profile 按实例的 `profile` 选择（默认 `web`）；
   - `--no-open` 逻辑、`hideConsole`、`sourceDebug` 等沿用现有实现。
5. 每个实例独立日志：`~/.dsh-launcher-panel/logs/instances/<id>/server.log`；`clearServerLogOnStart` 只清该实例的日志。
6. 等待端口/URL；解析 token；标记 `running`；按实例的浏览器设置打开。
7. 并发 Start 同一实例：合并/幂等；已在运行则直接打开或提示。
8. 并发 Start 不同实例：允许，但不能并发跑全局安装/更新。

### Stop

- 优先杀 tracked child（Windows 用 `taskkill /T`，沿用现有 `killPid`）。
- 没有 tracked child 时（例如扩展重启后接管的实例），只有在用户确认「端口被非本扩展启动的进程占用」后才按端口 owner 杀；不要静默杀掉陌生进程。
- 轮询端口关闭；超时进入 `error`，不要假装已停止。
- Stop 一个实例不影响其他实例。

### 意外退出

- 子进程 `close` 且不是主动 Stop：标记 `stopped`（附退出码）或 `error`；清除 PID；不自动重启。
- 面板显示「已退出」和日志路径。

### 扩展重启 / 接管

- 现状是扩展 deactivate 时**故意不杀服务**，VS Code 关闭后 Web UI 继续可用。多实例保持这个契约：deactivate 只停日志 tail，不杀实例。
- 重新激活时，对每个实例探测端口：
  - 端口开：标记 `running`（接管），尽量从该实例日志恢复 URL/token；
  - 端口关：`stopped`。
- 接管实例的 Stop 走上面的「确认后杀端口 owner」路径。
- 如果端口被其他应用占用但不是 DSH：显示 `running (external)` 或 `error`，Stop 需要明确确认。

## 九、UI 与命令

### 面板（v1：实例 tab）

**替换范围**：面板改为统一的带边框区块，每个区块有内标题：**Runtime / Instances / Console / DeepSeek API**；Settings 是无边框竖排区。实例的 Start/Stop 放进 Instances 区。

```text
┌ Runtime ───────────────────────────┐
│ [pkg src]                          │
│ deepseek harness  v0.2.1  [Update] [⟳]│
└────────────────────────────────────┘
┌ Instances ─────────────────────────┐
│ [ Default ● ][ Work ○ ][ + ]        │  ← active tab = background, no underline
│ Work                         ✎  🗑  │  ← edit/delete after the status
│ home     C:\Users\...\.dsh-work    │
│ profile  ...\.dsh-work/profiles/web│
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

- **统一 section 规范**：0.5px 线框 + r14 + 8/10 padding；内标题 12px/600；label 10px fg2；值 11px fg；路径 10px 等宽 fg2；主按钮 12px、mini 按钮 10px。所有功能区共用同一套。面板不再固定高度，console 也改为 auto + max-height。
- **tab 条**：在 Instances 区内部；每个实例一个 tab，显示名称 + 状态点；`+` 是新建按钮，固定在右端。**选中态只用 tab 底色区分，不再加下划线/主色线。** 只有一个内容面板；切换 tab 重渲染当前实例，不复制 N 份 DOM。
- **状态点**：running 绿、starting/installing 动画、error 红、stopped 灰；与状态栏一致。卡片里不再重复一个状态点。
- **tab tooltip**：名称、port、home、完整状态；名称过长省略。
- **溢出**：单行横向滚动；`+` 不随滚动消失；当前 tab 自动滚入视野；后续可加溢出菜单。
- **空列表**：只显示 `+` 和「New instance」提示；legacy 迁移后至少有一个 Default。
- **`+`**：打开创建表单（modal）；成功后 append tab 并选中。
- **Instances 内容**：
  - 状态/URL；**Start / New Tab / Stop 都在这个区内**（Start 在 running 时变成 New Tab）。
  - **Edit/Delete** 放在状态行右侧，用竖线隔开，图标按钮 + tooltip；运行中禁用，停止后 Delete 确认；只移除列表，不删数据。
  - **home/profile/package** 归为一组；**不显示端口**，运行中的 URL 已经带端口。端口由 launcher 分配（`dsh.instancePortBase`），面板不编辑。
  - 编辑表单只改名称、home、profile、auto-open、browser；改 home/profile 不移动数据，必须显示警告。
- **Runtime（最上方）**：`deepseek harness` 版本、mode（pkg/src）、Update/⟳；这些是共享的。
- **Console/日志**：独立 section，跟随当前 tab；日志 tail 和 server log 路径切换；`Clear`/`debug` 默认跟随当前 tab。
- **DeepSeek API 状态**：独立 section，**默认收起**，只显示标题、Peak/Off-peak 和展开箭头；点标题展开后显示模型 API / 其他 API 两栏（中间短分割线）、余额、状态链接。**Balance** 跟随当前 tab 的 home（账户/余额读取用当前实例 home）。
- **Settings**：页面底部，无边框、无标题；放 Global Settings、浏览器选择和 node/launcher 版本。
- **同步**：tab 选择 = `dsh.activeInstance`；状态栏/快速选择/命令切换时 tab 跟随。
- **键盘/可访问性**：`role="tablist"` / `role="tab"` / `role="tabpanel"`；左右方向键移动，Home/End，Enter/Space 激活；`+` 是普通 button；切换后焦点回到选中 tab；错误/状态变化用 `aria-live`（避免刷屏）。
- **共享 home 警告**：在 tab 名旁显示警告标记，tooltip 说明「与 <name> 共用 DSH 数据，不能同时运行」。
- **创建/编辑表单**：面板内 modal，带内联校验；Create/Save 合法前禁用；删除用确认 modal，明确「不删数据」。

### 状态栏

- 显示活动实例的名称/状态；运行中沿用现有背景色。
- 多个实例运行时，tooltip 汇总运行数量和端口。
- 点击打开快速选择：列出所有实例（名称、端口、home、状态），可选中、启动、停止、打开。
- `dsh.statusMenu` 保留，内容扩展为实例列表 + 现有动作。

### 命令

| 命令 | 行为 |
|---|---|
| `dsh.start` / `dsh.stop` | 现有命令；作用于活动实例 |
| `dsh.instance.new` | 打开创建表单 |
| `dsh.instance.edit` | 编辑活动实例（或从快速选择选一个） |
| `dsh.instance.delete` | 删除活动实例（确认） |
| `dsh.instance.select` | 快速选择活动实例 |
| `dsh.instance.start` / `.stop` | 带实例 ID 的精确操作，供面板按钮调用 |
| `dsh.instance.open` | 打开指定实例的 Web UI |
| `dsh.instance.restart` | stop → start（可选，v1 可只做面板按钮） |

面板按钮必须传实例 ID，不能依赖「当前活动」的隐式状态，避免切换竞态。

### 日志与账户

- 服务端日志按实例分开；客户端 `client.log` 仍为全局扩展日志。
- 面板的账户/余额/API key 读取必须使用**当前实例的 home**（`<home>/.credentials.yaml`），不能固定读 `~/.dsh`。
- 当前实例没有凭据时显示「未配置」，不要回退显示另一个实例的账户。

## 十、校验规则

### 名称

- 去首尾空白后非空；建议 ≤ 64 字符；不允许控制字符。
- 大小写不敏感唯一。

### ID

- `crypto.randomUUID()`；不可编辑；不允许重复。

### home

- 支持 `~` 展开；`path.resolve` 后必须是绝对路径。
- 不能是文件；不存在则创建目录；必须可写。
- 不能位于 launcher 自己的安装/日志目录 `~/.dsh-launcher-panel` 内。
- 不能等于 DSH 安装目录。
- 允许空格、非 ASCII、UNC 路径（按平台能力）。
- 精确重复的 home：允许配置，但同一 home 同时只能跑一个实例；UI 显示共享标记。
- 嵌套 home：允许但警告（两个数据根会互相包含，备份/清理容易混淆）。

### profile

- `^[A-Za-z0-9][A-Za-z0-9._-]*$`，长度有上限；拒绝 `.`、`..`、路径分隔符。
- 必须存在于 `<home>/profiles/<profile>`，或在创建时初始化。
- 不校验 profile 内容。

### port

- 整数，1–65535；拒绝 0。
- 实例间唯一（配置层）。
- 创建/启动时在 `127.0.0.1` 上做 bind 检查；被外部进程占用则报错。
- 自动建议从 3080 开始，跳过已配置端口和已占用端口。

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
| 创建时 profile 初始化失败 | 报错，不写实例；home 保留，提示可重试 |
| 创建时端口被占 | 报错，建议换端口 |
| 启动时 home/profile 缺失 | `error`，提示编辑实例或初始化 profile |
| 启动时端口被占 | `error`，不杀占用者 |
| 启动超时/进程早退 | `error`，显示日志路径 |
| 停止超时 | `error`，不要显示 stopped |
| 接管时端口是陌生进程 | 标记 external；Stop 需确认后才杀 |
| 设置条目非法 | 面板显示错误行；不自动改写 settings |
| 并发 Start/Stop | 每实例合并/幂等；不出现双进程或假 stopped |
| 全局更新时仍有实例运行 | 阻止并提示先停止 |

## 十三、安全与归属

- 实例对象和 settings 里**不存 API key、token、密码**；凭据留在各 home 的 DSH vault 或环境变量。
- 表单不要求输入密钥；创建流程不读取、不复制 `.credentials.yaml`。
- 子进程一律 `spawn` + 参数数组，不拼 shell；home 通过环境变量传递；profile 名先校验。
- 日志/面板不打印密钥；launch token 的现有处理保持不变。
- 删除实例不删 home；任何删除目录的动作都必须单独确认并校验归属。
- 不自动改写 `cordis.patch.yml`、sessions、workspaces。
- 实例列表是机器本地配置；不要写入 workspace settings（避免同步/跨机器路径问题）。

## 十四、测试

### 单元（`test/*.test.ts`，不依赖 vscode）

- 实例正常化：`~` 展开、相对路径拒绝、空 home 回退默认、profile 去空白。
- 名称/ID/端口/profile 校验；重复检测。
- 端口自动建议：跳过已配置、跳过已占用、无可用端口报错。
- 同一 home 并发守卫；共享 home 检测。
- 旧设置迁移：`dsh.port` → Default 实例；已有实例不覆盖；迁移标记。
- 活动实例回退：无效 ID → 第一个；空列表 → 无。
- 启动参数/环境构建：`DSH_HOME`、`--port`、profile。
- 状态机纯函数：start/fail/stop/exit 的合法迁移；不允许 `starting` 直接回 `stopped` 而不清理。
- 日志路径：按 id 分目录；`clearServerLogOnStart` 只清当前实例。

### 手工矩阵

1. 旧用户升级：有 `dsh.port`、无 `dsh.instances` → Default 实例，Start/Stop/Open 正常。
2. 新建实例：新 home、`web` profile、新端口 → 初始化、启动、打开、停止。
3. 两个实例同时运行：各自端口、日志、sessions 独立；停一个不影响另一个。
4. 已有 home + 已有 profile：直接挂载，不初始化、不重置。
5. 自定义 profile：从 `web` 模板创建；已存在时不覆盖。
6. 端口冲突：配置重复、外部占用、启动时冲突，三种都报错。
7. 共享 home：两个实例配置允许；同时启动第二个被拒绝。
8. 编辑：运行中改 home/profile 要求先停；改 home 不移动数据；端口不通过面板编辑。
9. 删除：运行中先停；只移除列表；home 仍在。
10. 扩展重启：实例仍在运行 → 激活后接管，状态 running；Stop 正常。
11. 更新：有实例运行时阻止；停止全部后更新；不自动重启。
12. VS Code 内置浏览器同时打开两个实例的 UI，token 各自正确。
13. 面板切换实例：日志、活动、账户/余额跟随当前实例。
14. 非法 settings：不崩、不静默改文件、有可见错误。
15. tab 条：切换、状态点、溢出滚动、`+` 固定；`+` 新建后追加并选中；删除后选中相邻 tab；运行中改端口/删除被阻止；外部命令切换 active 时 tab 跟随；键盘左右/Home/End。

### 验证

- `npm run verify`（typecheck + test + compile + package）通过。
- `git diff --check` 干净。
- 手工矩阵记录在 PR/commit 描述或测试清单。

## 十五、文档与发布

- `README.md` / `README.zh-CN.md`：新增 Instances 章节和设置表；说明 `DSH_HOME`、profile、port、机器本地、删除不删数据、共享 home 不能同时运行。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`：按用户可感知变化写一条功能条目；旧 `dsh.port` 迁移要写明。
- 本文 `docs/instances-spec.md` 是开发文档，不进 README / CHANGELOG / VSIX。
- 发布走项目既有流程：`dev` → `verify` → `main` → owner 当次确认 → tag。本规格只定义功能，不构成发布许可。

## 十六、分期

1. **Stage 1：纯模型** — 实例类型、设置 schema、迁移、校验、端口建议、单元测试；不碰 UI。
2. **Stage 2：运行时** — InstanceManager / InstanceRuntime、每实例进程/日志/状态/接管；保持单实例命令可用。
3. **Stage 3：UI 与命令** — 面板实例 tab 条 + 内容面板、创建/编辑/删除表单、状态栏、快速选择、命令。
4. **Stage 4：全局收尾** — 安装/更新与多实例的交互、README/CHANGELOG、手工矩阵、`verify`。

每阶段独立 commit；Stage 2 完成前不改用户可见 UI，降低回滚成本。

## 十七、验收标准

- 升级现有用户后，无需重新配置即可看到并启动 Default 实例；`dsh.port` 值被正确继承。
- 创建新 home + 新 profile + 新端口的实例，能初始化、启动、打开、停止；日志在独立目录。
- 两个实例可同时运行，互不影响；端口冲突、共享 home 并发、缺失 profile 都有明确错误。
- 面板以 tab 条呈现实例；`+` 可新建；切换 tab 同步活动实例、日志、状态栏；tab 溢出可横向滚动且 `+` 始终可见。
- 每个 tab 可改端口（停止时）、Start/Stop/Open、Delete（停止时）；运行中编辑端口/删除有明确提示。
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
| 11 | 端口/名称内联改，home/profile 用 modal？ | 已定：端口由 `dsh.instancePortBase` 自动分配、面板不编辑；名称/home/profile 用 Edit modal |
| 12 | tab 顺序是否可拖拽 | v1 按 `dsh.instances` 顺序，不支持拖拽；后续 |
