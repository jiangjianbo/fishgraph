---
name: deployment
description: Deploy, configure, operate, or troubleshoot software environments, containers, Kubernetes workloads, services, environment variables, configuration, startup scripts, health checks, and deployment automation.
---

# Deployment

用于应用部署、运行环境、容器和部署配置。

## 1. Separate

明确区分：

```text
代码
配置
环境
部署资源
运行数据
```

环境差异通过配置表达，不将环境信息硬编码进代码。

## 2. Configure

配置修改前确认：

- 生效范围；
- 默认值；
- 环境差异；
- 密钥和敏感信息；
- 启动顺序；
- 依赖服务。

不得将密钥直接写入代码或提交到版本库。

## 3. Validate

验证：

- 启动；
- 健康检查；
- 关键依赖；
- 日志；
- 网络连接；
- 配置加载；
- 正常关闭。

## 4. Failure

部署失败时区分：

```text
代码问题
配置问题
环境问题
依赖问题
资源问题
网络问题
```

不要看到启动失败就直接修改代码。