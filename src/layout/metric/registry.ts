/**
 * 尺寸映射策略的注册表（仿布局策略接缝：registerStrategy/createStrategy）。
 * 用户以 `new ForceLayout(graph, { metric: name })` 选用；缺省 'default'。
 */

import type { MetricStrategy } from './types.js';

const registry = new Map<string, MetricStrategy>();

/** 注册尺寸映射策略（同名覆盖）。在模块加载时调用。 */
export function registerMetricStrategy(name: string, strategy: MetricStrategy): void {
  registry.set(name, strategy);
}

/** 按名创建（取用）映射策略；未知名字抛错并列出可用项。 */
export function createMetricStrategy(name: string): MetricStrategy {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`unknown metric strategy: ${String(name)}（可用：${listMetricStrategies().join(', ')}）`);
  }
  return strategy;
}

/** 当前已注册的映射策略名。 */
export function listMetricStrategies(): string[] {
  return [...registry.keys()];
}
