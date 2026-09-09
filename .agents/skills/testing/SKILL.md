---
name: testing
description: Create, modify, execute, diagnose, or improve software tests. Use when writing unit tests, integration tests, end-to-end tests, test scripts, test cases, test fixtures, test environments, or investigating test failures. Covers test design, isolation, failure diagnosis, and incremental validation.
---

# Testing

用于设计、编写、修改和执行测试，以及定位测试失败。

## 1. Define

明确：

- 测试验证什么；
- 成功标准是什么；
- 必要前置条件是什么；
- 测试属于哪个层级。

优先验证一个明确的行为或功能点。

## 2. Isolate

采用分而治之：

```text
最小单元
 ↓
局部功能
 ↓
组件组合
 ↓
完整流程
```

不同关注点尽可能独立，避免一个测试同时承担大量无关验证。

测试前置条件、环境检查和测试执行应保持职责分离。

## 3. Execute

先运行最小范围测试，再根据结果扩大范围。

测试失败时：

```text
失败
 ↓
确认失败是否真实
 ↓
缩小范围
 ↓
定位根因
 ↓
修复
 ↓
重新验证
```

不得通过降低断言、跳过测试或修改测试以适配错误实现。

## 4. Diagnose

区分：

- 测试本身错误；
- 被测代码错误；
- 环境问题；
- 依赖问题；
- 数据问题；
- 时序或并发问题。

不要看到测试失败就直接修改业务代码。

## 5. Complete

最终确认：

- 测试真正验证了目标行为；
- 关键失败路径得到覆盖；
- 测试具有稳定、可重复的结果；
- 测试本身没有引入不必要的复杂度。