# Test Behavior, Not Implementation

> 何时应用：写、改、保留一个测试时。

## 判断

测试要断言**用户/调用方能观察到的行为**：

- 行为坏了，测试必须失败；
- 只改内部结构，测试必须继续通过；
- 失败信息要能指出坏了什么，不是“snapshot mismatch”。

实现细节（私有函数、调用次数、内部字段）不是契约；测它们会让重构变难。

## 反例

- mock 了所有依赖，只验证“调用了某个方法”；
- 测试和实现逐行对应，改个变量名就红；
- 只测成功路径，失败路径没有用例；
- 测试永远通过，或者只跑一个用例却显示全绿。

## 关联

- 规则：[rules/verification.md](../rules/verification.md) G8
- 步骤：[playbooks/fix.md](../playbooks/fix.md)、[playbooks/feature.md](../playbooks/feature.md)
