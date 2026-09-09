---
name: backend-development
description: Develop, modify, debug, or review backend applications, services, business logic, domain models, service layers, controllers, workers, jobs, middleware, configuration, and backend runtime behavior.
---

# Backend Development

用于后端服务和业务逻辑开发。

## 1. Understand

先确定：

- 请求入口；
- 业务流程；
- 领域对象；
- 服务职责；
- 数据访问；
- 外部依赖；
- 事务和状态边界。

## 2. Implement

保持：

```text
Interface
 ↓
Application / Service
 ↓
Domain / Business Logic
 ↓
Infrastructure / Data Access
```

具体层次根据项目现有架构调整，不机械套用。

业务规则不得无必要地散落在 Controller、DAO 或工具类中。

## 3. Error and State

明确处理：

- 输入错误；
- 业务错误；
- 外部依赖失败；
- 超时；
- 重试；
- 并发；
- 事务；
- 资源释放。

避免通过默认值或异常吞掉错误。

## 4. Validate

至少验证核心正常路径和关键失败路径，并检查是否影响现有接口和业务。