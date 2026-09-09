---
name: frontend-development
description: Develop, modify, debug, or review frontend applications, pages, views, components, layouts, state management, routing, forms, API integration, UI behavior, and frontend architecture using frameworks such as Vue, React, or similar technologies.
---

# Frontend Development

用于前端页面、组件、状态、交互和 API 集成开发。

## 1. Understand

先明确：

- 页面职责；
- 用户操作流程；
- 数据来源；
- 页面状态；
- API 依赖；
- 路由关系；
- 项目已有组件和设计规范。

优先复用已有组件和业务能力。

## 2. Structure

保持：

```text
Page
 ↓
Business Component
 ↓
UI Component
```

页面负责组织流程，组件负责自身职责，不将大量业务逻辑堆积在页面或模板中。

## 3. State

明确区分：

- 服务端数据；
- 页面状态；
- 表单状态；
- 临时 UI 状态；
- 全局状态。

避免不必要的全局状态。

## 4. API

API 调用、数据转换、错误处理应保持清晰边界。

页面不得为了使用 API 而承担大量协议细节。

## 5. Validate

检查：

- 正常状态；
- Loading；
- Empty；
- Error；
- Permission；
- 表单校验；
- 重复操作；
- 异步状态变化。

确认桌面和项目要求的其他屏幕尺寸下没有明显布局问题。