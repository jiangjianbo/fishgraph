---
name: integration-development
description: Integrate applications with external systems, third-party APIs, SDKs, services, message brokers, authentication systems, storage systems, or existing enterprise platforms. Use when implementing or modifying system-to-system integration.
---

# Integration Development

用于外部系统和第三方能力集成。

## 1. Understand

确认：

- 对方接口或协议；
- 数据格式；
- 认证方式；
- 超时；
- 重试；
- 限流；
- 错误语义；
- 依赖可用性。

未知接口不得自行编造。

## 2. Isolate

外部系统调用应通过明确的适配边界隔离：

```text
Business Logic
      ↓
Integration Interface
      ↓
Adapter / Client
      ↓
External System
```

避免业务代码直接散落第三方 SDK 调用。

## 3. Failure

明确处理：

- 网络失败；
- 超时；
- 对方错误；
- 返回数据异常；
- 重试；
- 重复调用；
- 服务不可用。

必须考虑外部系统并不可靠。

## 4. Validate

使用真实协议或可靠测试替身验证，不通过假设外部系统行为完成实现。