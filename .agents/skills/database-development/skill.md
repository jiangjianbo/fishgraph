---
name: database-development
description: Design, modify, migrate, query, optimize, or review databases, schemas, tables, indexes, SQL, ORM models, transactions, data access, and database migrations.
---

# Database Development

用于数据库结构、SQL、ORM、数据访问和迁移相关任务。

## 1. Model

先明确：

- 数据实体；
- 属性；
- 主键；
- 唯一约束；
- 外键和关系；
- 生命周期；
- 数据量与访问方式。

数据库结构应服务于业务模型，而不是简单复制代码对象。

## 2. Change

修改数据库前确认：

- 现有数据；
- 现有查询；
- 依赖该结构的代码；
- 迁移兼容性；
- 回滚可能性。

生产数据变更属于高风险操作，遵循全局确认规则。

## 3. Query

检查：

- 查询正确性；
- NULL 和边界条件；
- 索引使用；
- N+1 查询；
- 事务边界；
- 并发一致性。

不要为了性能盲目增加索引或缓存。

## 4. Validate

验证：

```text
数据正确性
约束完整性
迁移可执行
关键查询性能
事务行为
异常回滚
```