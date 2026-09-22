/**
 * GroupUndirectedStrategy —— 无向分组布局策略（深度优先递归的复合布局）。
 *
 * 基础算法 force-undirected 的引擎（coarsePlacement 质点网格粗布局 + 压实、
 * RelaxationSolver 弛豫微调、坐标系修正）在任一"层级视图"上都可直接运行 ——
 * 引擎全部接口都是数组化的（elements/adj/edges 切片），组内成员子图切片即
 * 一张独立的图（tests/group-undirected.test.ts 的前提验证用例固化该结论）。
 *
 * 本策略把分组语义组织为「每个阶段都是一个深度优先的递归」：
 *   - 任一层级的视图 = 自由元素 + 子组单元（折叠：跨组连线提升到单元上，
 *     见 compound.ts）；
 *   - 布局一条流水线：[递归布局每个子组的内部] → [质点网格粗布局 + 膨胀压实]
 *     → [力场弛豫微调] → [坐标系修正] → [量测子组内部块]；
 *   - 单元半径 = 组内部块的包围圆半径 + 包裹边距 —— 粗布局压实与弛豫斥力
 *     都以 getBoundRadius() 为口径，把组当作"巨大号的节点"解算，组内成员
 *     被该包围圆完全覆盖，因此跨层级无重叠由同一套力学不变量保证；
 *   - 全部层级完成后做一次自顶向下的平移映射：把组内部块平移到单元的
 *     最终位置（纯平移，不缩放 —— 内部块占用与单元预留口径一致）。
 *
 * 与 force-group（旧算法，待按力场派生重写）的区别：本算法不向基础力场
 * 注入包含墙/向心束缚，而是"先内后外"的折叠递归 —— 组内外没有力场耦合，
 * 天然没有容器-成员振荡问题；代价是成员不跟随外部连线方向（纯折叠的
 * 已知边界）。
 *
 * 流水线在构造期一次完成（grid-undirected 先例）：run() 返回收敛结果，
 * refresh()/rebuild() 整体重算。组内层级忽略成员的 placed 语义（组的整体
 * 位置由外层决定，成员的外层显式坐标在内部帧中不成立）；组内 fixed 成员
 * 仍不参与弛豫移动，但随组平移。
 */

import type { GraphStore } from '../../graph/store.js';
import type { LayoutElement } from '../../graph/store.js';
import { coarsePlacement } from '../force-undirected/coarse.js';
import { deriveParams, type DerivedParams, type ForceContext } from '../force-undirected/forces.js';
import { RelaxationSolver, type SolverOptions } from '../force-undirected/solver.js';
import { buildHopScale } from '../force-undirected/hops.js';
import { createCoordinateSystem, type CoordinateNode, type CoordinateSystem } from '../coordinates.js';
import { registerStrategy } from '../strategy.js';
import type { LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';
import { buildGroupForest, buildLevelView, type GroupTreeNode, type LevelView } from './compound.js';

/** 每层级弛豫的迭代预算安全网（与 force-undirected 同口径）。 */
const DEFAULT_MAX_ITERATIONS = 4000;

export class GroupUndirectedStrategy implements LayoutStrategy {
  readonly name: string = 'group-undirected';

  private readonly store: GraphStore;
  private options: ResolvedLayoutOptions;
  private cs: CoordinateSystem;
  /** 顶层弛豫求解器（能量/迭代观测口径；空图为 undefined）。 */
  private topSolver: RelaxationSolver | null = null;
  readonly energyHistory: number[] = [];

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.cs = createCoordinateSystem(options.coordinateSystem);
    this.recompute();
  }

  /** 整条递归流水线：组森林 → 自底向上逐层布局 → 自顶向下平移映射。 */
  private recompute(): void {
    this.energyHistory.length = 0;
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(true);
    const forest = buildGroupForest(this.store);
    const all = this.store.elements.map((_, i) => i);
    this.topSolver = null;
    this.layoutLevel(all, forest, true);

    // 自顶向下平移映射：组内部块 → 单元最终位置（子组容器随父组平移后，
    // 再以它为锚继续向深层映射）。
    for (const root of forest) this.settleGroup(root);

    // 容器有效半径按成员几何刷新（渲染口径；≤ 布局期的保守单元半径）。
    for (const sg of this.store.subgraphNodes) {
      sg.updateBoundsFromChildren(this.store.elements);
    }
  }

  /**
   * 一条层级的流水线（递归）。
   *
   * memberPool：本层可见成员的物理下标（含子组子树）；childGroups：本层的
   * 子组（折叠为单元）。isTop 区分 placed 语义（仅顶层尊重用户显式定位）。
   */
  private layoutLevel(
    memberPool: readonly number[],
    childGroups: readonly GroupTreeNode[],
    isTop: boolean,
  ): void {
    // ── 深度优先：先布局每个子组的内部（成员坐标在其内部帧最终确定），
    //    随即量测内部块并设置单元半径（父层的压实与弛豫按该半径解算）──
    for (const g of childGroups) {
      this.layoutLevel(g.memberIndices, g.children, false);
      const block = measureBlock(this.store, g);
      g.block = block;
      if (block) {
        g.unit.r = Math.max(g.unit.baseR, block.r + g.padding);
      }
    }

    const view = buildLevelView(this.store, memberPool, childGroups);
    if (view.elements.length === 0) return;

    // ── 阶段 1：质点网格粗布局 + 膨胀压实（单元占 1 格，压实按单元半径
    //    变距 —— 组的内部块被单元包围圆完全覆盖，跨层无重叠由构造保证）──
    coarsePlacement(view.elements, view.adj, this.options.naturalLength, undefined, {
      ignorePlaced: !isTop,
    });

    // ── 阶段 2：力场弛豫微调（本层局部上下文：提升邻接 + 每层独立参数）──
    const solver = this.relaxLevel(view, isTop);

    // ── 阶段 3：坐标系修正（free 恒等；grid 网格化吸附按层执行，
    //    保证组内成员吸附不出自己的层级帧）──
    this.refineLevel(view);

    if (isTop) this.topSolver = solver;
  }

  /** 本层的力场弛豫：局部 ForceContext + 独立求解器，预算内弛豫到收敛。 */
  private relaxLevel(view: LevelView, isTop: boolean): RelaxationSolver {
    const params = this.paramsOf(view);
    const ctx: ForceContext = {
      elements: view.elements,
      edges: view.edges,
      adj: view.adj,
      params,
      gravity: this.options.gravity,
      accuracy: this.options.accuracy,
      theta: this.options.theta,
      labelCollision: this.options.labelCollision,
      edgeKaMul: new Array<number>(view.edges.length).fill(1),
      edgeCrossCounts: new Array<number>(view.edges.length).fill(0),
      crossPenaltyEnergy: 0,
      hopScale: buildHopScale(
        view.adj,
        this.options.hopRepulsionDecay,
        this.options.unrelatedRepulsion,
      ),
      extensions: {},
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    const solver = new RelaxationSolver(ctx, this.solverOptions(params));
    const budget = DEFAULT_MAX_ITERATIONS;
    let used = 0;
    let guard = budget * 2 + 64;
    while (!solver.converged && used < budget && guard-- > 0) {
      if (solver.step()) {
        used++;
        if (isTop) {
          // 能量曲线只记录顶层弛豫（与 energy 观测口径一致）。
          this.energyHistory.push(ctx.energy);
          if (this.energyHistory.length > 4000) this.energyHistory.shift();
        }
      }
    }
    return solver;
  }

  /** 本层坐标系修正（布局完成后以最优布局为基础做一次坐标修正）。 */
  private refineLevel(view: LevelView): void {
    if (view.elements.length === 0) return;
    const nodes: CoordinateNode[] = view.elements.map((el) => ({
      id: el.id,
      x: el.x,
      y: el.y,
      r: el.r,
      fixed: el.fixed,
    }));
    const lattice =
      this.options.gridSize > 0 ? this.options.gridSize : this.options.naturalLength;
    this.cs.refine(nodes, { lattice });
    for (let i = 0; i < nodes.length; i++) {
      view.elements[i]!.x = nodes[i]!.x;
      view.elements[i]!.y = nodes[i]!.y;
    }
  }

  /** 每层独立派生力学参数（nodeCount 只影响按层归一化的 centroid 束缚）。 */
  private paramsOf(view: LevelView): DerivedParams {
    return deriveParams(this.options, view.elements.length);
  }

  private solverOptions(params: DerivedParams): SolverOptions {
    const L = params.L;
    return {
      maxStep: Math.max(1e-3, this.options.maxStepRatio * L),
      initStep: L * 0.05,
      minStep: 1e-3,
      forceEps: Math.min(0.02, Math.max(1.5e-3, 0.5 / L)),
      calmNeeded: 5,
      driftForceEps: 1e-6,
      driftRatio: 0.1,
    };
  }

  /**
   * 自顶向下平移映射：把 g 的内部块平移到单元的最终位置（单元本身是
   * 映射锚点，不平移）。块中心用当前坐标重新量测 —— 子组的成员与容器
   * 已被父组的平移带动，父子平移在差值中自然抵消，恰好只施加一次净平移；
   * hidden 子组的伪单元不在 store 中、父组平移带不到它，显式随父组平移。
   */
  private settleGroup(g: GroupTreeNode): void {
    const center = measureBlockCenter(this.store, g);
    if (center) {
      const dx = g.unit.x - center.cx;
      const dy = g.unit.y - center.cy;
      for (const idx of g.subtreeIndices) {
        const el = this.store.elements[idx];
        if (!el) continue;
        el.x += dx;
        el.y += dy;
      }
      // hidden 子组的伪单元不在 store.elements 中，父组平移带不到它：
      // 显式随父组平移，深层映射才能以它为锚。
      for (const c of g.children) {
        if (!c.container) {
          c.unit.x += dx;
          c.unit.y += dy;
        }
      }
    }
    for (const c of g.children) this.settleGroup(c);
  }

  // ── LayoutStrategy（流水线构造期一次完成，grid-undirected 先例）─────

  step(): boolean {
    return false;
  }

  run(_opts: RunOptions = {}): RunResult {
    return {
      iterations: this.topSolver?.iterations ?? 0,
      converged: true,
      energy: this.energy,
    };
  }

  /** 参数变化：整条递归流水线重算。 */
  refresh(options: ResolvedLayoutOptions): void {
    const csChanged = options.coordinateSystem !== this.options.coordinateSystem;
    this.options = options;
    if (csChanged) this.cs = createCoordinateSystem(options.coordinateSystem);
    this.recompute();
  }

  /** 外部改动坐标：无力学可失效，下次 refresh/rebuild 时重放。 */
  invalidate(): void {
    // 构造期流水线产物，外部拖拽坐标在下一次 recompute 前不参与计算。
  }

  /** 图结构变化：整条递归流水线重算。 */
  rebuild(): void {
    this.recompute();
  }

  get converged(): boolean {
    return true;
  }

  get energy(): number {
    return this.topSolver?.energy ?? 0;
  }

  get iterations(): number {
    return this.topSolver?.iterations ?? 0;
  }

  get stage(): 3 {
    return 3;
  }
}

/** 量测组内部块：子树成员当前坐标（内部帧）的包围盒 → 包围圆。 */
function measureBlock(
  store: GraphStore,
  g: GroupTreeNode,
): { cx: number; cy: number; r: number } | null {
  if (g.subtreeIndices.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const idx of g.subtreeIndices) {
    const el: LayoutElement | undefined = store.elements[idx];
    if (!el) continue;
    minX = Math.min(minX, el.x - el.r);
    minY = Math.min(minY, el.y - el.r);
    maxX = Math.max(maxX, el.x + el.r);
    maxY = Math.max(maxY, el.y + el.r);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const r = Math.hypot(maxX - minX, maxY - minY) / 2;
  return { cx, cy, r };
}

/** 量测组内部块的当前中心（映射期用：成员已被父组平移，中心需现算）。 */
function measureBlockCenter(
  store: GraphStore,
  g: GroupTreeNode,
): { cx: number; cy: number } | null {
  const block = measureBlock(store, g);
  return block ? { cx: block.cx, cy: block.cy } : null;
}

registerStrategy('group-undirected', (store, options) => new GroupUndirectedStrategy(store, options));
