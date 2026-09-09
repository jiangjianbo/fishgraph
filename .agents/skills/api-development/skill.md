---
name: api-development
description: Design, implement, modify, debug, or review APIs, REST endpoints, RPC interfaces, GraphQL interfaces, request and response models, API contracts, validation, error handling, authentication, and service interfaces.
---

# API Development

用于 API、RPC 和服务接口的设计与实现。

## 1. Define Contract

先明确：

- 接口职责；
- 请求参数；
- 返回结构；
- 错误语义；
- 认证授权要求；
- 幂等性和状态变化；
- 兼容性要求。

接口首先是契约，不是函数的简单暴露。

## 2. Implement

保持：

- 请求校验与业务逻辑分离；
- API 层负责协议适配；
- 业务规则进入业务层；
- 数据访问进入数据访问层；
- 错误统一且语义明确。

避免将业务逻辑堆积在 Controller/Handler 中。

## 3. Compatibility

修改已有接口时检查：

- 调用方；
- 参数兼容性；
- 返回结构；
- 错误码；
- 版本兼容；
- 前后端影响。

未经要求不得破坏已有契约。

## 4. Validate

至少验证：

```text
正常请求
参数错误
权限错误
资源不存在
业务失败
重复请求
异常情况
```