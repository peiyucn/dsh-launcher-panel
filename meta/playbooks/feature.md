# Feature

> 何时用：新增或改变用户可观察行为；需求会持续迭代。
> 何时不用：只修 bug → fix；行为不能变 → refactoring；只调查 → investigate。

> 依赖：[principles/model-the-domain.md](../principles/model-the-domain.md)、[principles/prove-it-works.md](../principles/prove-it-works.md)、[principles/sequence-verifiable-units.md](../principles/sequence-verifiable-units.md)、[skills/review/SKILL.md](../skills/review/SKILL.md)、[rules/verification.md](../rules/verification.md)

## 步骤

1. **对齐**
   - 读项目 AGENTS、spec、architecture；
   - 用自己的话复述：目标 / 非目标 / 假设；
   - 写一句“看到什么算完成”；
   - 列验收用例：正常、错误、空/加载、权限、重启/重载。

2. **定数据形状与边界**
   - 核心类型、状态、所有权；
   - 改哪些模块，明确不改哪些；
   - 跨函数/模块边界先定调用方和接口。

3. **切最小垂直切片**
   - 一次只做一个能独立验证的切片；
   - 不做“以后可能需要”的抽象；
   - 需要 prototype 时，prototype 不混入正式实现。

4. **实现 + 行为测试**
   - 测用户可观察行为，不测实现；
   - 覆盖失败路径；
   - 不留死代码、调试脚手架。

5. **在真实表面验证**
   - UI：实际运行，截图/DOM/控制台/网络；
   - CLI：真实命令、输出、退出码；
   - 后端：集成路径；必要时前后数字；
   - 证据按 [rules/verification.md](../rules/verification.md) 记录。

6. **文档与变更**
   - README / CHANGELOG（用户可感知）；
   - spec / architecture（行为或边界变了）；
   - 删除被替代的旧路径。

7. **审查 + PR**
   - 走 [skills/review/SKILL.md](../skills/review/SKILL.md)；
   - 小提交序列，一个切片一个主题；
   - PR：why / changed / not changed / evidence / risks。

8. **下一片**
   - 每个切片结束都验证，不攒大 PR；
   - 新发现的边界/错误 → 加验收用例；
   - 同类错误第二次 → 升级检查。

## 输出

```text
做了什么：
关键设计选择：
验收证据：
未验证/风险：
下一片：
```

## 停止 / 询问

- 需求需要猜产品决策；
- 认证/支付/权限/用户数据；
- 不可逆操作；
- 同一方法失败两次；
- 切片大到无法一次验证 → 再切小。
