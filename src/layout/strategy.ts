/**
 * 布局策略 —— 算法可替换的接缝。
 *
 * 节点管理（src/graph/store.ts）是稳定底座；布局算法随时在变。
 * 任何布局算法实现 LayoutStrategy 即可接入：通过 registerStrategy 注册，
 * 用户以 `new ForceLayout(graph, { algorithm: name })` 选用，
 * 或运行时 `layout.setStrategy(name)` 热切换（图数据保留，位置由新策略重新初始化）。
 *
 * 策略约定：
 *   - 只通过 GraphStore 读图、写坐标；不拥有图数据；
 *   - step() 单步推进（供动画帧驱动），run() 弛豫到收敛或预算用尽；
 *   - refresh() 在参数变化后被调用（保留当前坐标继续弛豫）；
 *   - invalidate() 在用户拖拽/固定节点后被调用（外部改了坐标）；
 *   - rebuild() 在图结构变化（增删节点/边）后被调用（重新初始化）。
 */

import type { GraphStore } from '../graph/store.js';
import type { AccuracyMode, LayoutOptions, LayoutStage, RunOptions, RunResult } from '../types.js';

/** 已解析完备的布局参数（DEFAULTS 合并后）。 */
export type ResolvedLayoutOptions = Required<LayoutOptions>;

/** 力场快照（测试/调试钩子：不推进布局，重算一次力与能量）。 */
export interface ForceSnapshot {
  fx: Float64Array;
  fy: Float64Array;
  energy: number;
}

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

  /** 每个被接受步进后的总能量记录（供能量曲线；无则空数组）。 */
  readonly energyHistory: number[];

  /** 策略内部调度进度（如分阶段弛豫的阶段号）。 */
  readonly stage: LayoutStage;

  /** 测试/调试钩子：用指定精度重算一次力场。不支持的策略不实现。 */
  forceSnapshot?(accuracy: AccuracyMode): ForceSnapshot;
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
