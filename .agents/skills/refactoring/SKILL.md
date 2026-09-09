---
name: refactoring
description: Refactor existing code to improve structure, readability, maintainability, responsibility boundaries, duplication, dependencies, or complexity without intentionally changing behavior. Use when reorganizing, simplifying, extracting, consolidating, or redesigning existing implementation structure.
---

# Refactoring

用于改善已有代码结构。重构的核心约束是：**改变结构，不无意改变行为。**

## 1. Define

先明确：

- 当前结构存在什么问题；
- 希望改善什么；
- 哪些行为必须保持不变；
- 重构范围在哪里。

没有明确结构问题时，不为了“代码看起来更漂亮”而重构。

## 2. Analyze

识别：

- 重复逻辑；
- 职责混杂；
- 过度复杂的流程；
- 不合理依赖；
- 泄漏的实现细节；
- 不必要的抽象；
- 错误的职责归属。

优先找结构性问题，不从表面格式开始。

## 3. Refactor

采用小步修改：

```text
现状
 ↓
一次结构调整
 ↓
验证
 ↓
下一次结构调整
 ↓
验证
```

优先：

- 提取职责；
- 合并重复知识；
- 简化控制流；
- 调整正确的依赖关系；
- 将逻辑移动到正确的职责边界。

不要同时引入新功能。

## 4. Validate

每次重要结构变化后确认：

- 行为是否保持；
- 测试是否通过；
- 依赖方向是否合理；
- 是否减少而非增加复杂度；
- 是否真正改善了原问题。

## 5. Complete

重构完成后应能够明确回答：

> 重构前存在什么结构问题？重构后为什么更合理？

如果无法回答，不应继续扩大重构范围。