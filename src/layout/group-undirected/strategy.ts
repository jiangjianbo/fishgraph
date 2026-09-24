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
 *   - 子组内部布局完成即把单元真实形状刷新为成员实占（外接矩形 + 包裹
 *     边距，refreshGroupUnitShape 统一口径）—— 粗布局压实与弛豫碰撞都以
 *     该形状的力学外接矩形解算，把组当作"巨大号的节点"，组内成员被完全
 *     覆盖，跨层级无重叠由同一套力学不变量保证；
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
import { coarsePlacement } from '../force-undirected/coarse.js';
import { deriveParams, type DerivedParams, type ForceContext } from '../force-undirected/forces.js';
import { RelaxationSolver, type SolverOptions } from '../force-undirected/solver.js';
import { buildHopScale } from '../force-undirected/hops.js';
import {
  createCoordinateSystem,
  type CoordinateNode,
  type CoordinateSystem,
  type RefineZone,
} from '../coordinates.js';
import { registerStrategy } from '../strategy.js';
import type { LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';
import { buildGroupForest, buildLevelView, refreshGroupUnitShape, measureBlockCenter, type GroupTreeNode, type LevelView } from './compound.js';

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

    // 终局包含口径：容器矩形以容器节点（格点）为中心按成员实占贴合
    // —— settle 取整平移的残差（≤ 半格）使块中心与节点不严格重合，
    // AABB 中心口径会把矩形画偏导致成员出界；节点中心贴合使包含性
    // 回到构造保证。子容器先贴合，父容器量测才能读到子容器的新实占。
    const fitContainers = (g: GroupTreeNode): void => {
      for (const c of g.children) fitContainers(c);
      g.container?.fitShapeToMembersAtNode(this.store.elements);
    };
    for (const root of forest) fitContainers(root);
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
    //    随即把子组单元的真实形状刷新为成员实占（统一形状口径）——
    //    父层的压实与弛豫直接读单元的力学外接矩形 ──
    for (const g of childGroups) {
      this.layoutLevel(g.memberIndices, g.children, false);
      refreshGroupUnitShape(this.store, g);
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
    this.refineLevel(view, childGroups);

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
  private refineLevel(view: LevelView, childGroups: readonly GroupTreeNode[]): void {
    if (view.elements.length === 0) return;
    const nodes: CoordinateNode[] = view.elements.map((el) => ({
      id: el.id,
      x: el.x,
      y: el.y,
      r: el.r,
      fixed: el.fixed,
    }));
    const lattice = this.latticeOf();
    // 质量感知吸附：本层提升边供穿越否决（无向算法不传方向约束）；
    // 子组声明矩形为保留区 —— 非成员单元的落格避让容器内部，容器
    // 矩形内只保留成员（成员由 settle 平移映射归位，不在本层吸附）。
    const zones: RefineZone[] = [];
    for (const g of childGroups) {
      const rect = g.container?.declaredShape;
      if (rect?.kind === 'rect') {
        zones.push({ anchorId: g.unit.id, hw: rect.w / 2, hh: rect.h / 2 });
      }
    }
    const edges = view.edges.map((e) => ({
      source: view.elements[e.sourceIndex]!.id,
      target: view.elements[e.targetIndex]!.id,
    }));
    this.cs.refine(nodes, { lattice, edges, zones });
    for (let i = 0; i < nodes.length; i++) {
      view.elements[i]!.x = nodes[i]!.x;
      view.elements[i]!.y = nodes[i]!.y;
    }
  }

  /** 全局统一的吸附格距（各层与平移映射必须同距，网格一致才成立）。 */
  private latticeOf(): number {
    return this.options.gridSize > 0 ? this.options.gridSize : this.options.naturalLength;
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
   * 平移映射（自底向上）：先深层——把子组的内部块对齐到子组单元位置；
   * 后本层——把整块（含子组子树与子组容器）平移到本组单元的最终位置。
   *
   * 平移量取整到 lattice 倍数：成员在各层内部帧中已吸附到统一网格，
   * 纯平移只有保持格距倍数才能把网格一致性带到最终坐标系（块中心与
   * 单元位置的偏差 ≤ 半格，布局语义不变）。
   *
   * 顺序是正确性的关键：深层成员（如 hidden 伪单元的成员）在内部帧中
   * 从未跟随子组单元移动，必须先被映射到子组单元锚点上，本层的整块
   * 平移才能以"正确的相对构型"一次对齐到单元位置（整体平移不改变块
   * 中心与成员的相对关系，父子两级对齐同时成立）。若自顶向下，本层对齐
   * 会被深层映射的净平移破坏 —— 成员块中心漂移出容器矩形（矩形口径下
   * 直接表现为成员出界，旧圆口径被半径富余吸收而未暴露）。
   *
   * hidden 子组的伪单元不在 store.elements 中、父组平移带不到它：本层
   * 平移后显式随父组平移，深层映射才能以它为锚。
   */
  private settleGroup(g: GroupTreeNode): void {
    for (const c of g.children) this.settleGroup(c);
    const center = measureBlockCenter(this.store, g);
    if (center) {
      const lattice = this.latticeOf();
      const dx = Math.round((g.unit.x - center.cx) / lattice) * lattice;
      const dy = Math.round((g.unit.y - center.cy) / lattice) * lattice;
      for (const idx of g.subtreeIndices) {
        const el = this.store.elements[idx];
        if (!el) continue;
        el.x += dx;
        el.y += dy;
      }
      for (const c of g.children) {
        if (!c.container) {
          c.unit.x += dx;
          c.unit.y += dy;
        }
      }
    }
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

registerStrategy('group-undirected', (store, options) => new GroupUndirectedStrategy(store, options));
