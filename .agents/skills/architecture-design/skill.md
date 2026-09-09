---
name: architecture-design
description: Design or modify software architecture, system architecture, module architecture, service boundaries, component structure, dependency relationships, deployment architecture, or technical solutions. Use when a task requires deciding system structure or how major components should interact.
---

# Architecture Design

用于需要进行架构、模块划分、组件关系或技术方案设计的任务。

## 1. Understand

先明确：

- 业务目标；
- 系统边界；
- 核心场景；
- 已有系统和约束；
- 非功能要求；
- 不允许改变的架构和技术选型。

## 2. Model

优先确定：

```text
边界
→ 核心职责
→ 核心组件
→ 组件关系
→ 数据流/控制流
→ 依赖方向
```

先确定职责，再确定技术。

## 3. Design

避免：

- 为不存在的问题设计；
- 无需求地增加服务；
- 无必要的分层；
- 为未来未知需求提前抽象；
- 用技术组件代替业务职责。

优先形成职责清晰、依赖明确、可演进的结构。

## 4. Validate

检查：

- 职责是否重叠；
- 是否存在循环依赖；
- 数据流是否闭合；
- 关键异常路径是否明确；
- 架构是否满足实际约束；
- 是否引入不必要复杂度。

架构设计必须能够解释“为什么这样划分”。