/**
 * ForceDirectedStrategy —— 力导向有向图布局策略（派生算法）。
 *
 * 按 doc/布局核心原则.md 的有向图流水线组织，完全复用基础算法
 * （ForceUndirectedStrategy）的骨架 —— 质点网格粗布局主流程、膨胀压实、
 * 力学引擎（RelaxationSolver + 全栈力场）原样继承 —— 只通过基础算法的
 * 两个接缝注入有向语义：
 *  1. applyCoarsePlacement：软层级引导的放置美学（directedHeuristics）——
 *     解环（computeLevels 忽略反馈边）+ 最长路径层级 + 层级行锚点/
 *     层级偏离罚/方向罚 + 死锁优先插列；
 *  2. configureExtensions：流动势能（extraForces 缝）—— 微调期对每条
 *     正向边施加恒定的源→汇推力，让最终布局呈现自顶向下（TB）或
 *     自左向右（LR）的方向流动感。
 *
 * 方向参数化（LayoutOptions.direction）：TB 流动沿 +y（层级行 = 网格行）、
 * LR 流动沿 +x（层级列 = 网格列）；粗布局与流动力共用同一轴定义。
 *
 * 构造期约束：两个覆写方法都会在基类构造函数内被调用，此时子类字段
 * 初始化器尚未执行 —— 因此覆写实现全部就地计算（computeLevels 每次
 * O(n+E)，相对粗布局与力场求值可忽略），不依赖任何子类实例字段。
 */

import type { GraphStore } from '../../graph/store.js';
import { registerStrategy, type ResolvedLayoutOptions } from '../strategy.js';
import { ForceUndirectedStrategy } from '../force-undirected/strategy.js';
import { coarsePlacement } from '../force-undirected/coarse.js';
import type { ForceContext } from '../force-undirected/forces.js';
import type { RefineEdge } from '../coordinates.js';
import { computeLevels } from './levels.js';
import { directedHeuristics, orderLayers } from './directedCoarse.js';

/** 流动弹簧强度（× 边弹簧刚度 k_a/L²）：层级偏差的回复力系数。
 *  须明显强于主边弹簧（×1）才能在微调期保住粗布局的层级行距 ——
 *  否则无向力场的紧凑化会把层级拉平（实测 0.3 时层级行距被压没）。 */
const FLOW_STRENGTH = 3;

/**
 * 流动势能（弹簧式）：E = w/2·Σ_正向边 (flow_v − flow_u − Δlevel·L)²，
 * w = FLOW_STRENGTH × k_a/L² —— 把每条正向边两端的流向坐标差像橡皮筋一样
 * 拉向"层级差 × 行距"。相比恒定的重力/浮力（线性势能，产生恒定外力、
 * 与"合力趋零"的收敛判据矛盾），弹簧式存在零力平衡态：层级关系在微调期
 * 被主动维持，收敛后全部力自然归零。反馈边不参与（其真实上下游由环上
 * 其余路径决定）。返回附加势能（与基础力场一起参与线搜索比较）。
 */
function applyFlowForces(
  ctx: ForceContext,
  isForwardEdge: Uint8Array,
  level: Int32Array,
  flowAxis: 'x' | 'y',
): number {
  const L = ctx.params.L;
  const w = (FLOW_STRENGTH * ctx.params.ka) / (L * L);
  let energy = 0;
  const edges = ctx.edges;
  const elements = ctx.elements;
  for (let ei = 0; ei < edges.length; ei++) {
    if (!isForwardEdge[ei]) continue;
    const e = edges[ei]!;
    const a = elements[e.sourceIndex]!;
    const b = elements[e.targetIndex]!;
    const gap =
      (flowAxis === 'y' ? b.y - a.y : b.x - a.x) -
      (level[e.targetIndex]! - level[e.sourceIndex]!) * L;
    energy += 0.5 * w * gap * gap;
    if (flowAxis === 'y') {
      a.fy += w * gap;
      b.fy -= w * gap;
    } else {
      a.fx += w * gap;
      b.fx -= w * gap;
    }
  }
  return energy;
}

export class ForceDirectedStrategy extends ForceUndirectedStrategy {
  readonly name: string = 'force-directed';

  /** 接缝实现：解环 + 最长路径层级，注入软层级引导的放置美学 +
   *  层内 barycenter 排序（消解行内交叉）。 */
  protected override applyCoarsePlacement(): void {
    const store: GraphStore = this.store;
    const { level } = computeLevels(store.elements.length, store.edges);
    const heuristics = directedHeuristics(
      store.adj,
      store.edges,
      level,
      this.options.direction,
    );
    coarsePlacement(store.elements, store.adj, this.params.L, heuristics);
    orderLayers(store.elements, store.adj, level, this.options.direction, this.params.L);
  }

  /** 接缝实现：注入流动势能（extraForces），只作用于正向边。 */
  protected override configureExtensions(): void {
    const store: GraphStore = this.store;
    const { level, isForwardEdge } = computeLevels(store.elements.length, store.edges);
    const flowAxis = this.options.direction === 'LR' ? ('x' as const) : ('y' as const);
    this.ctx.extensions = {
      extraForces: (ctx) => applyFlowForces(ctx, isForwardEdge, level, flowAxis),
    };
  }

  /** 接缝实现：有向算法的吸附格点选择按 options.direction 保持行/列序
   *  严格不逆流。只约束正向边 —— 反馈边两端互相矛盾，约束会污染整个
   *  环组件的格点搜索（run 期调用，子类字段已就绪）。 */
  protected override refineFlow(): { direction: 'TB' | 'LR'; edges: RefineEdge[] } | null {
    const store: GraphStore = this.store;
    const { isForwardEdge } = computeLevels(store.elements.length, store.edges);
    const edges: RefineEdge[] = [];
    for (let k = 0; k < store.edges.length; k++) {
      if (!isForwardEdge[k]) continue;
      const e = store.edges[k]!;
      edges.push({
        source: store.elements[e.sourceIndex]!.id,
        target: store.elements[e.targetIndex]!.id,
      });
    }
    return { direction: this.options.direction, edges };
  }

  /** 方向切换（TB↔LR）等价于整体重排：退回 rebuild 流程。 */
  override refresh(options: ResolvedLayoutOptions): void {
    const dirChanged = options.direction !== this.options.direction;
    super.refresh(options);
    if (dirChanged) this.rebuild();
  }
}

registerStrategy('force-directed', (store, options) => new ForceDirectedStrategy(store, options));
