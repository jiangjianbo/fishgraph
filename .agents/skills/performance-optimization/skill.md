---
name: performance-optimization
description: Diagnose and optimize software performance, including CPU, memory, latency, throughput, database queries, network calls, concurrency, frontend rendering, caching, and resource usage.
---

# Performance Optimization

用于性能问题分析和优化。

## 1. Measure

先建立：

- 性能指标；
- 当前基线；
- 目标；
- 复现条件。

没有测量依据时，不凭感觉进行性能优化。

## 2. Locate

定位真正瓶颈：

```text
现象
 ↓
指标
 ↓
Profiling / Monitoring
 ↓
瓶颈
 ↓
原因
```

区分 CPU、内存、IO、数据库、网络、锁竞争和算法复杂度等问题。

## 3. Optimize

优先优化实际瓶颈。

不要为了理论性能：

- 提前缓存；
- 增加并发；
- 引入复杂架构；
- 增加大量索引；
- 改变整体设计。

## 4. Validate

优化后必须重新测量，并确认：

- 性能确实改善；
- 功能保持正确；
- 资源消耗没有异常增加；
- 没有引入新的稳定性问题。