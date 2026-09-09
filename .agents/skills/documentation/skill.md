---
name: documentation
description: Create, update, restructure, or review software documentation, technical specifications, architecture documents, API documentation, deployment guides, README files, design documents, and developer documentation based on the actual project implementation.
---

# Documentation

用于项目技术文档的编写和维护。

## 1. Source

优先依据：

```text
实际代码
→ 实际配置
→ 测试
→ 项目现有文档
→ 用户提供的信息
```

不得为了让文档完整而编造不存在的实现。

## 2. Structure

文档应回答：

- 为什么；
- 是什么；
- 怎么做；
- 如何验证。

架构文档重点表达职责和关系，操作文档重点表达执行步骤。

## 3. Consistency

修改代码或架构后，检查相关文档是否仍然准确。

发现代码与文档不一致时，应明确指出，不默认哪一方正确。

## 4. Maintainability

避免记录容易过期的实现细节，除非这些细节对使用或维护确实必要。