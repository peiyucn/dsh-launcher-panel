# 项目指令 — dsh-launcher-panel

> **薄契约试点（2026-11-16）**：本文件暂不遵循根 `pyai-meta-repo/AGENTS.md` 的 I1–I3；试点确认后将反向替换根 AGENTS，并推广到其他项目。
>
> 原则：**能由机器判定的规则不写进本文件。** 代码规则、仓库策略、发布门禁、文档与版本一致性统一登记在 [docs/quality-gates.md](docs/quality-gates.md)，以 `npm run verify` 的退出码为准。本文件只保留机器无法判断的取舍、边界、授权与协作约定。

## 项目与事实源

本仓库是 VS Code 扩展「DSH Launcher Panel」的源码仓库。源码在 `src/`，`out/`、`releases/` 与 `*.vsix` 不入库。

- `resources/dsh-icon.woff` 是生成物但随版本入库；`src/holidays.ts` 是手工静态数据，不用脚本抓取。
- 功能契约与验收矩阵：[docs/instances-spec.md](docs/instances-spec.md)
- 模块边界与依赖方向：[docs/architecture.md](docs/architecture.md)
- 定位、退役判据：[docs/positioning-and-retirement.md](docs/positioning-and-retirement.md)
- 可执行规则、错误编号与加检查流程：[docs/quality-gates.md](docs/quality-gates.md)
- 发版步骤、凭据与红线：[docs/release.md](docs/release.md)

## 命令与门禁

```text
npm run verify   # lint → typecheck → test → compile → package
npm run lint     # ESLint + 仓库策略检查
npm test         # node:test，不依赖 VS Code 的纯逻辑用例
```

- 任何 push / PR 前必须 `npm run verify` 全绿；工作区保持干净。
- `main` / `dev` 只能通过 PR 更新，squash only；required checks 为 `typecheck` / `test` / `build` / `package`，bypass 名单为空，**owner 也不能直推**。
- CI 的 `typecheck` job 在 tsc 前执行 lint；任何一条 lint 失败都视为门禁失败。

## 机器规则不重复写

以下内容已由检查覆盖，不在本文件展开：

- 源码禁用模式、子进程安全、`src/shared/` 依赖方向、显式 `any`，以及 ESLint 基础规则；
- README Settings 表与 `package.json` 配置一致性；
- `engines.vscode` 与 `@types/vscode` 对齐；
- 双语 README / CHANGELOG 入口、CHANGELOG 版本与 `package.json` 一致；
- CI 环节名称与顺序、E18 发布门禁位置、tag 必须在 main；
- 发布产物忽略、测试 `.only`、必读文档存在性。

需要知道具体规则或增加规则时，只读 [docs/quality-gates.md](docs/quality-gates.md)；不要在本文件复制规则正文。

## 分支、提交与发布

- 日常改动在 `dev`；`main` 只接受发布 PR（squash）。
- 一个 commit 只做一件事；描述用中文，保留英文类型前缀。
- 发版流程见 [docs/release.md](docs/release.md)；打 tag 和市场发布前必须取得 owner **当次**明确确认。
- 不可逆动作（删除用户数据、发布、改已发布版本、强制改历史）执行前必须取得 owner 同意；能无损回滚的普通改动直接做。
- 已发布版本与 tag 不覆盖、不移动；出错只能发新版本并重新确认。

## 需要人判断的规则

### 需求与改动边界

- 涉及功能的改动先对照 `instances-spec` 和 `architecture`；实现、测试、README / CHANGELOG 与规格必须一致。
- 先定义边界、验收与失败路径，再写功能；不要把未定义的行为交给实现去猜。
- 只有在明确了收益、影响范围与回滚方式后，才扩大改动面。

### 代码与架构

- 单一职责；状态经函数封装；命名达意；同类对称；不写超长函数与重复逻辑。
- `shared/` 保持无 VS Code 依赖、可单测；模块边界以 `architecture.md` 为准。
- 不导入 VS Code 内部模块；dsh 版本差异只按公开契约读取，不认的输出走降级路径。
- 活动流 busy 必须用 `withBusy` 成对收尾，不手写 `addActivity(..., true)` / `finishBusy`。
- 资源 / 内存有界：timer、watcher、AbortController、子进程在成功与失败路径都释放；缓存与活动流有上限。
- 部分失败必须诚实可观察；状态迁移与并发入口要能被打断且保持一致。
- 覆写或删除文件前先确认归属；不是本扩展自己的产物就不动。

### 测试

- 纯逻辑改动必须补 `test/*.test.ts` 用例。
- 测试必须覆盖真实行为与失败路径，不能只追求全绿；一个永远通过的测试不算测试。
- 测试不应依赖外部网络、真实用户目录或固定端口。

### 安全

- API key、launch token 不进日志、面板、HTML 或提交内容；发往 webview 的 payload 不带 token URL。
- 子进程使用参数数组，不拼命令行；外部请求带超时；外部 URL 走白名单。
- Webview 保持 CSP 与转义；用户配置的路径先规范化、再校验、展示时遮蔽。
- 安全基线按 F4 逐项核验；配置变更后重新核验，不能只凭“应该没变”。

## 重复错误怎么沉淀

1. 留下能失败的最小复现或反例；
2. 选择最强可行层：类型 / API → ESLint / 策略检查 → 测试 → CI / 发布门禁 → 文字；
3. 负例必须红、正常仓库必须绿；
4. 登记到 [docs/quality-gates.md](docs/quality-gates.md)，接入 `npm run verify`；
5. 只有判断性内容才补进本文件，并删除已由检查覆盖的旧描述。

重复错误只加文字、不加检查，视为没有修复。

## 协作约定

- 用中文交流；commit 描述中文，代码注释以英文为主并解释“为什么”。
- 未查到就写未查到，未验证就写未验证；不以确定语气描述未执行的操作。
- 结论必须来自命令输出或文件内容；推断只能用于提出假设。
- 不用取巧写法让检查变绿；检查失败时如实说明，不隐瞒。
- 进度区分已实现、已提交、已推送、已发布、已上线验证；不笼统说“完成”。
- 改 `AGENTS.md` 或放宽任何门禁须经 owner 明确许可。
- 新功能跑通后先讨论重构方案，确认后执行；重构与功能分开提交。
- GitHub 操作统一用 `gh`；代理与宿主环境配置不写入仓库。
