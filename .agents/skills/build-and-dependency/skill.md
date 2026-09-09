---
name: build-and-dependency
description: Configure or modify project builds, package dependencies, package managers, compilation, bundling, artifact repositories, lock files, build scripts, plugins, and dependency versions.
---

# Build and Dependency

用于项目构建、依赖和制品相关任务。

## 1. Inspect

修改前确认：

- 当前构建工具；
- 包管理器；
- lock 文件；
- 依赖版本；
- 构建脚本；
- 制品来源；
- 项目已有约定。

## 2. Change

优先：

- 使用已有依赖；
- 保持版本兼容；
- 最小化新增依赖；
- 保持 lock 文件一致；
- 保持可重复构建。

未经要求不得随意升级大量依赖。

## 3. Validate

验证：

```text
依赖解析
→ 编译
→ 单元测试
→ 打包
→ 制品生成
```

构建失败时先确认根因，不通过删除 lock、升级全部依赖等方式绕过问题。