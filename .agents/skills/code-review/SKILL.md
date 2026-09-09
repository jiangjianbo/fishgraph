---
name: code-review
description: Review existing code for correctness, design quality, maintainability, defects, security risks, regressions, and violations of project engineering principles. Use when reviewing code changes, pull requests, patches, commits, implementations, or completed coding tasks.
---

# Code Review

用于检视代码及代码变更。重点不是重新实现代码，而是发现问题、风险和结构缺陷。

## 1. Understand

先理解：

- 原始需求；
- 变更目的；
- 修改范围；
- 相关调用关系；
- 既有设计。

不要脱离需求单独评价代码。

## 2. Review Correctness

检查：

- 正常路径；
- 异常路径；
- 边界条件；
- 状态变化；
- 数据一致性；
- 错误处理；
- 并发和资源生命周期；
- 回归风险。

## 3. Review Structure

重点检查：

```text
职责是否清晰？
关注点是否分离？
主流程是否表达意图？
实现细节是否正确封装？
是否重复已有能力？
新增逻辑是否放在正确位置？
依赖方向是否合理？
是否引入不必要复杂度？
```

## 4. Review Scope

确认：

- 是否存在无关修改；
- 是否存在未经要求的重构；
- 是否修改了不必要的依赖；
- 是否改变了既有行为；
- 是否存在“为了通过测试而修改实现”的迹象。

## 5. Report

问题按严重程度排序，并说明：

```text
问题
→ 影响
→ 原因
→ 建议
```

只报告实际发现的问题，不为了让 Review 看起来完整而人为制造问题。

Review 的目标是发现真正影响正确性、可维护性和风险的问题，而不是追求形式上的规范数量。