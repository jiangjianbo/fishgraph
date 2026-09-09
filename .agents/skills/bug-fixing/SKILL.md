---
name: bug-fixing
description: Diagnose and fix software bugs, defects, errors, test failures, runtime failures, unexpected behavior, or regressions. Use when investigating why existing code does not behave as expected. Focuses on reproduction, root-cause analysis, minimal corrective changes, regression testing, and avoiding symptom-level patches.
---

# Bug Fixing

用于定位和修复已有代码中的问题。核心原则是**先证明问题和根因，再修改代码**，避免通过局部补丁掩盖问题。

## 1. Reproduce

首先确认：

- 实际表现是什么；
- 期望表现是什么；
- 是否能够稳定复现；
- 触发条件是什么；
- 最近有哪些相关变更。

无法复现时，不要直接猜测原因并修改代码。

## 2. Locate

沿着实际执行路径定位问题：

```text
现象
 ↓
触发条件
 ↓
执行路径
 ↓
异常位置
 ↓
根因
```

优先寻找：

- 错误输入；
- 状态错误；
- 数据错误；
- 控制流错误；
- 接口契约错误；
- 依赖或环境问题；
- 并发或时序问题。

## 3. Fix

修复根因，而不是仅消除当前现象。

避免：

- 增加无依据的特殊判断；
- 捕获后吞掉异常；
- 修改默认值掩盖错误；
- 跳过失败路径；
- 修改测试使其“通过”。

修复范围保持最小，但如果根因位于错误的职责边界，应修正职责归属，而不是继续堆补丁。

## 4. Validate

修复后按以下顺序验证：

```text
复现用例
 ↓
根因相关用例
 ↓
相关功能
 ↓
必要的回归测试
```

确认原问题消失，同时确认没有引入新的回归。

## 5. Complete

最终说明：

- 根因；
- 修改内容；
- 验证结果。

如果无法确定根因，应明确说明不确定性，不把推测作为结论。