/**
 * ForceLayout —— 公共 API 门面。
 *
 * 架构（策略模式）：
 *   GraphStore（src/graph/store.ts）—— 图数据底座：物化/邻接/文字度量/增删改查，
 *   不含任何布局算法；
 *   LayoutStrategy（src/layout/strategy.ts）—— 布局算法接缝：注册/按名创建/热切换。
 *
 * 本类只做装配与委派：持有 store + 当前策略，把公共 API 转接过去。
 */

import { GraphStore, type InternalEdge, LayoutSubgraphNode } from './graph/store.js';
import {
  createStrategy,
  type LayoutStrategy,
  type ResolvedLayoutOptions,
} from './layout/strategy.js';
import type {
  EdgeSpec,
  ElementId,
  GraphSpec,
  LayoutOptions,
  NodeSpec,
  NodeView,
  RunOptions,
  RunResult,
  SubgraphView,
} from './types.js';

const DEFAULTS = {
  // 唯一主引擎：纯网格布局（波纹放置 → 中心对称膨胀 → 通道压实 → A* 走线）
  algorithm: 'grid-undirected',
  // 流动方向（'none' 无向放置；'TB'/'LR' 有向层级布局，全部边顺流）
  direction: 'none' as const,
  // 自然边长（格）：粗布局格胞 = 本值 × 比例尺（grade.ts 分级基准）
  naturalLength: 6,
  // 边文字参与占位（文字盒并入节点格宽高）
  labelCollision: true,
  labelFontSize: 12,
  labelPadding: 4,
  // 随机种子（确定性重放）
  seed: 42,
  // 走线通道宽度（格）：相邻节点 AABB 之间的最小空行/列数
  channelMargin: 1,
};

export class ForceLayout {
  private store: GraphStore;
  private strategy: LayoutStrategy;
  private options: ResolvedLayoutOptions;

  constructor(graph: GraphSpec, options: LayoutOptions = {}) {
    this.options = { ...DEFAULTS, ...options } as ResolvedLayoutOptions;
    this.store = new GraphStore(graph);
    this.store.setLabelMetrics(this.options.labelFontSize, this.options.labelPadding);
    this.strategy = createStrategy(this.options.algorithm, this.store, this.options);
  }

  // ── 策略切换 ────────────────────────────────────────────

  /** 当前策略名（LayoutOptions.algorithm）。 */
  get strategyName(): string {
    return this.strategy.name;
  }

  /**
   * 格单位比例尺（px/格）：初始化分级基准盒的几何平均。布局坐标 ÷ 本值
   * = 整数格下标；渲染映射 px = 格 × 本值。
   */
  get cellScale(): number {
    return this.store.cellScale;
  }

  /** 运行时切换布局算法：图数据保留，重新布局。 */
  setStrategy(name: string): void {
    this.options = { ...this.options, algorithm: name };
    // 旧策略的走线拐点与物化尺寸都绑定旧坐标，换算法即失效
    this.store.clearEdgeWaypoints();
    this.store.clearMaterializedSizes();
    this.strategy = createStrategy(name, this.store, this.options);
  }

  /** 更新布局参数（重算布局）。 */
  updateOptions(partial: LayoutOptions): void {
    const next = { ...this.options, ...partial } as ResolvedLayoutOptions;
    if (partial.algorithm !== undefined && partial.algorithm !== this.options.algorithm) {
      this.options = next;
      this.store.clearEdgeWaypoints();
      this.store.clearMaterializedSizes();
      this.strategy = createStrategy(next.algorithm, this.store, next);
      return;
    }
    this.options = next;
    this.store.setLabelMetrics(next.labelFontSize, next.labelPadding);
    this.strategy.refresh(next);
  }

  // ── 节点/边管理（GraphStore 透传）───────────────────────
  // 变更后通知策略 rebuild()（重新布局）。

  addNode(spec: NodeSpec): void {
    this.store.addNode(spec);
    this.store.refreshLabelBoxes();
    this.strategy.rebuild();
  }

  removeNode(id: ElementId): void {
    this.store.removeNode(id);
    this.strategy.rebuild();
  }

  addEdge(spec: EdgeSpec): void {
    this.store.addEdge(spec);
    this.store.refreshLabelBoxes();
    this.strategy.rebuild();
  }

  removeEdge(source: ElementId, target: ElementId): void {
    this.store.removeEdge(source, target);
    this.strategy.rebuild();
  }

  setNodePosition(id: ElementId, x: number, y: number): void {
    this.store.setNodePosition(id, x, y);
  }

  /**
   * 把成员坐标钳制进所属容器（成员落在容器声明形状内）；
   * 非成员原样返回。
   */
  clampToContainer(id: ElementId, x: number, y: number): { x: number; y: number } {
    return this.store.clampToContainer(id, x, y);
  }

  /** 容器的全部成员 id（递归展开嵌套容器，不含容器自身）。 */
  subgraphMemberIds(id: ElementId): ElementId[] {
    return this.store.subgraphMemberIds(id);
  }

  /** id 所属最内层 subgraph 容器（非成员返回 null）。 */
  containerOf(id: ElementId): LayoutSubgraphNode | null {
    return this.store.containerOf(id);
  }

  // ── 迭代 ────────────────────────────────────────────────

  /**
   * 预留逐帧推进（纯网格策略恒返回 false——布局在构造期已完成）。
   */
  step(): boolean {
    return this.strategy.step();
  }

  /** 完成布局（纯网格策略构造期已完成，此处仅返回结果）。 */
  run(opts: RunOptions = {}): RunResult {
    return this.strategy.run(opts);
  }

  // ── 结果访问 ────────────────────────────────────────────

  /** 节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  get nodeViews(): readonly NodeView[] {
    return this.store.nodeViews;
  }

  /** subgraph 容器视图（渲染约定：背景层最先绘制，成员绘制在其上）。 */
  get subgraphViews(): readonly SubgraphView[] {
    return this.store.subgraphViews;
  }

  /**
   * 物理边列表（sourceIndex/targetIndex 为 nodeViews 所在 elements 数组
   * 下标；自环已剔除；grid-undirected 附带走线 waypoints）。
   */
  get edgeViews(): readonly InternalEdge[] {
    return this.store.edgeViews;
  }

  get positions(): Map<ElementId, { x: number; y: number }> {
    return this.store.positions;
  }

  get energy(): number {
    return this.strategy.energy;
  }

  get iterations(): number {
    return this.strategy.iterations;
  }

  get converged(): boolean {
    return this.strategy.converged;
  }

  get currentOptions(): Required<LayoutOptions> {
    return { ...this.options };
  }
}
