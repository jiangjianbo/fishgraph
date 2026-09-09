---
name: feature-development
description: Develop a new feature or capability in an existing software project. Use when adding functionality, implementing requirements, introducing new APIs, components, services, commands, or business capabilities. Covers requirement analysis, existing-code discovery, design, implementation, testing, and validation.
---

# Feature Development

用于在现有项目中新增功能。重点是正确理解需求、复用现有能力、确定职责归属，并以最小合理改动完成实现。

## 1. Understand

开始编码前确认：

- 功能目标和成功标准；
- 涉及的业务流程和数据；
- 现有相关模块、接口和实现；
- 可复用的已有能力；
- 新功能应该属于哪个模块。

需求存在关键歧义时先澄清，不用代码掩盖需求问题。

## 2. Design

先确定最小实现路径：

```text
需求
 ↓
现有能力
 ↓
职责归属
 ↓
最小设计
 ↓
实现
```

优先扩展已有结构，不为未知需求提前建立复杂抽象。

明确：

- 新增哪些组件；
- 修改哪些组件；
- 组件之间如何调用；
- 数据和控制流如何变化。

## 3. Implement

遵循以下顺序：

1. 优先复用已有能力；
2. 在正确职责边界增加新逻辑；
3. 保持调用层语义化；
4. 避免将实现细节堆入现有流程；
5. 只修改完成需求所必需的范围。

不要顺手重构无关代码。

## 4. Validate

完成后验证：

- 核心功能是否满足需求；
- 正常路径是否正确；
- 关键异常路径是否处理；
- 是否产生重复实现；
- 是否破坏现有功能；
- 是否引入无必要复杂度。

根据项目实际情况补充或更新测试。

## 5. Complete

确认成功标准全部满足后结束。

发现与当前功能无关的问题时，记录或提出建议，不顺手修改。