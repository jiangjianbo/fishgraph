/**
 * 布局策略 —— 算法可替换的接缝。
 *
 * 节点管理（src/graph/store.ts）是稳定底座；布局算法随时在变。
 * 任何布局算法实现 LayoutStrategy 即可接入：通过 registerStrategy 注册，
 * 用户以 `new ForceLayout(graph, { algorithm: name })` 选用，
 * 或运行时 `layout.setStrategy(name)` 热切换（图数据保留，重新布局）。
 *
 * 策略约定：
 *   - 只通过 GraphStore 读图、写坐标；不拥有图数据；
 *   - step() 预留逐帧推进（纯网格策略恒返回 false）；
 *   - run() 完成布局（纯网格策略构造期即已完成）；
 *   - refresh() 在参数变化后被调用（重算布局）；
 *   - rebuild() 在图结构变化（增删节点/边）后被调用（重新布局）。
 */

import type { GraphStore } from '../graph/store.js';
import type { LayoutOptions, RunOptions, RunResult } from '../types.js';

/** 已解析完备的布局参数（DEFAULTS 合并后）。 */
export type ResolvedLayoutOptions = Required<LayoutOptions>;

export interface LayoutStrategy {
  /** 注册名（即 LayoutOptions.algorithm 的取值）。 */
  readonly name: string;

  /** 单步弛豫。返回 true 表示有被接受的移动（驱动动画帧）。 */
  step(): boolean;

  /** 迭代到收敛或预算用尽。 */
  run(opts?: RunOptions): RunResult;

  /** 参数更新（保留当前坐标继续弛豫）。 */
  refresh(options: ResolvedLayoutOptions): void;

  /** 外部改动坐标（拖拽/固定/移动节点）后调用，强制重算力场。 */
  invalidate(): void;

  /** 图结构变化（增删节点/边）后调用：对新节点重新初始化。 */
  rebuild(): void;

  /** 是否已收敛。 */
  readonly converged: boolean;

  /** 当前总能量（无能量概念的策略返回 0）。 */
  readonly energy: number;

  /** 已消耗的迭代数。 */
  readonly iterations: number;

  /** 每个被接受步进后的总能量记录（无则空数组）。 */
  readonly energyHistory: number[];
}

export type StrategyFactory = (store: GraphStore, options: ResolvedLayoutOptions) => LayoutStrategy;

const registry = new Map<string, StrategyFactory>();

/** 注册布局策略（同名覆盖）。在模块加载时调用。 */
export function registerStrategy(name: string, factory: StrategyFactory): void {
  registry.set(name, factory);
}

/** 按名创建策略实例；未知名字抛错并列出可用项。 */
export function createStrategy(
  name: string,
  store: GraphStore,
  options: ResolvedLayoutOptions,
): LayoutStrategy {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown layout algorithm: ${String(name)}（可用：${listStrategies().join(', ')}）`);
  }
  return factory(store, options);
}

/** 当前已注册的策略名。 */
export function listStrategies(): string[] {
  return [...registry.keys()];
}
