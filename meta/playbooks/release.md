# Release

> 何时用：准备发布版本、打 tag、发市场/registry/Pages。
> 何时不用：还在开发/验证阶段；发布是不可逆动作，不确定就停。

> 依赖：[rules/delivery.md](../rules/delivery.md)（E/F 段）、[rules/verification.md](../rules/verification.md)、[skills/review/SKILL.md](../skills/review/SKILL.md)、[playbooks/acceptance.md](acceptance.md)

## 步骤

1. **发布前验证**
   - 项目 `verify` 全绿；
   - 用户可见改动有验收证据；
   - 工作区无未提交改动。

2. **准备内容**
   - 中英 CHANGELOG 新版本条目；
   - 版本号文件；
   - README 有行为变化则同步；
   - 依赖不进产物时写明“无用户可感知的变化”。

3. **安全门禁**
   - 查询未处理告警：Dependabot / CodeQL / secret scanning；
   - 任一非零 → 停止；
   - CodeQL 必须扫过本轮默认分支提交，不用上一轮代替；
   - 查询失败也停止，不能 fail-open。

4. **owner 当次确认**
   - 发布不可逆，每次都要 owner 明确同意；
   - 之前的批准不适用于本次；
   - 确认发布通道、版本、tag。

5. **打 tag / 发布**
   - tag 从默认分支提交打，annotated tag；
   - 单次推送不超过 3 个 tag；
   - 发布 workflow 挂 environment；凭据用环境级 secret；
   - 确认 workflow 真的启动。

6. **发布后**
   - 已发布版本/tag 不覆盖、不移动；
   - 坏版本用 deprecate 或新版本修正，不 unpublish（npm 24h 窗口例外）；
   - 切回开发分支；
   - 记录发布结果和告警状态。

## 硬门禁

- `verify` 失败：不发布；
- 告警非零/查询失败：不发布；
- 没有 owner 当次确认：不发布；
- tag 不在默认分支：不发布；
- 发布凭据不是环境级 secret：不发布。

## 输出

```text
版本：
tag：
发布通道：
verify：
告警：
owner 确认：
发布结果：
回滚/后续：
```

## 停止 / 询问

- 任何不可逆步骤前；
- 告警无法清零；
- 发布 workflow 失败且原因不明；
- 版本内容与 CHANGELOG 不一致。
