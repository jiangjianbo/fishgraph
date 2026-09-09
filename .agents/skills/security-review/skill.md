---
name: security-review
description: Review or improve software security, including authentication, authorization, input validation, secrets, injection, access control, sensitive data handling, API security, dependency risks, logging, and common application security vulnerabilities.
---

# Security Review

用于代码、接口、配置和架构的安全检查。

## 1. Identify

根据实际技术栈和攻击面检查：

- 身份认证；
- 权限控制；
- 输入校验；
- 注入；
- 敏感数据；
- 密钥；
- 文件和路径；
- API；
- 日志；
- 第三方依赖。

不为了“安全检查完整”而人为制造问题。

## 2. Validate

重点确认：

```text
不可信输入
 ↓
校验
 ↓
业务处理
 ↓
敏感操作
 ↓
权限检查
```

权限必须在可信边界执行，不能只依赖前端控制。

## 3. Fix

优先修复根因和边界问题，不通过隐藏错误、降低功能或增加无依据限制解决安全问题。

## 4. Report

安全问题说明：

```text
问题
→ 影响
→ 触发条件
→ 风险
→ 修复建议
```

严重问题优先处理。