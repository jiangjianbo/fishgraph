/**
 * GridUndirectedStrategy —— grid-first 网格布局策略（纯网格流水线，唯一
 * 主引擎）。
 *
 * 按 doc/布局核心原则.md 的「纯网格布局算法流程」组织，全程在离散网格
 * 中运行（连续坐标只是网格解的物理化表达）：
 *   [质点拓扑粗布局] → [节点中心对称膨胀物化为 AABB] → [通道约束压实] →
 *   [网格 A* 避障走线]
 *  - 阶段 1 用 coarse.ts 的质点网格放置（波纹连通生长 + 死锁插行列）。
 *    direction = 'none'（默认）用无向放置美学（张力 − 环周长 + 环内方位
 *    分类 + 扫描序平局）；'TB'/'LR' 用有向层级放置（解环 + 最长路径
 *    分层，节点钉在自己的层级行/列上，顺流无逆边）；
 *  - 阶段 2/3 由 ExpansionGrid 承担：节点按文字/形状物化为逻辑格 AABB，
 *    中心对称扩张让位，压实把相邻行列空隙压到 channelMargin（走线走廊）；
 *  - 阶段 4 用 GridSpaceContext.routeEdge（A* 正交寻路 + 拐点惩罚）为
 *    每条边计算走线拐点，写入 edgeViews 的 waypoints；
 *  - 节点位置一旦物化不再被走线反向推开（连线不占空间，走线只在
 *    自由通道格中流转）。
 *
 * 网格解即最终解：确定性、成行成列、构造保证无重叠。坐标修正
 * （coordinateSystem）不适用——网格解本身就是格点。
 *
 * 第一期边界（后续工作）：连线文字不占格（虚拟文本节点待第二期）；
 * subgraph 容器按声明形状参与网格；平行走线的通道内等距分布待做。
 */

import type { GraphStore } from '../../graph/store.js';
import { isSubgraphNode } from '../../graph/store.js';
import type { Box } from './space-types.js';
import { GridSpaceContext } from './grid-context.js';
import { registerStrategy } from '../strategy.js';
import type { LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';
import { coarseGridPlacement, undirectedHeuristics } from './coarse.js';
import { computeLevels } from './levels.js';
import { directedHeuristics } from './directed-placement.js';
import { ExpansionGrid } from './expansion.js';
import {
  buildFoldPlan,
  chainGridLayout,
  unfoldChain,
  type FoldItem,
  type FoldPlan,
  type FoldScope,
} from './fold.js';

/** 默认走线通道宽（格）：相邻节点 AABB 之间保留的最小空行/列数。 */
const DEFAULT_CHANNEL_MARGIN = 1;
/** 默认链折叠的最小长度：低于该长度的链不折叠。 */
const DEFAULT_FOLD_CHAIN_MIN = 3;

/** 作用域布局产物：视图项 AABB（相对坐标）+ 包裹尺寸（格）。 */
interface ScopeLayout {
  boxes: Box[];
  width: number;
  height: number;
}

/** 折叠单元的代表元素下标（coarse 输入占位；placed 被忽略，仅占位）。 */
function representativeOf(item: FoldItem): number {
  return item.kind === 'chain' ? item.members[0]! : item.index;
}

export class GridUndirectedStrategy implements LayoutStrategy {
  readonly name: string = 'grid-undirected';

  /** 构造期即完成整条流水线（纯网格计算，无迭代）。 */
  private finished = false;

  constructor(
    private store: GraphStore,
    private options: ResolvedLayoutOptions,
  ) {
    this.recompute();
  }

  /** 整条网格流水线：放置 → 膨胀 → 压实 → 物理化 → 走线。 */
  private recompute(): void {
    const { elements, adj } = this.store;
    if (elements.length === 0) {
      this.finished = true;
      return;
    }
    this.store.refreshLabelBoxes();
    this.store.applyNodeLabelSizes(true);

    if (this.options.folding) {
      this.recomputeFolded();
      return;
    }

    // 阶段 1：质点拓扑粗布局。'none'（默认）用无向放置美学（张力 − 环
    // 周长 + 环内方位分类：张力同分的候选优先十字方位，45° 次之）；
    // 'TB'/'LR' 用有向层级放置（解环 + 最长路径分层，钉层级行/列）。
    // naturalLength 为格数，粗布局格胞 = 格数 × 比例尺（px 中间量）。
    const direction = this.options.direction;
    const heuristics =
      direction === 'none'
        ? undirectedHeuristics(adj, { directionClass: true })
        : directedHeuristics(
            adj,
            this.store.edges,
            computeLevels(elements.length, this.store.edges).level,
            direction,
          );
    const { grid, posOf, cell, order } = coarseGridPlacement(
      elements,
      adj,
      this.options.naturalLength * this.store.cellScale,
      heuristics,
    );
    void grid; // 占用语义由 ExpansionGrid 接管

    // 阶段 2：节点与文字轴向膨胀 —— 物理尺寸换算逻辑格宽高后逐个扩张。
    const expansion = new ExpansionGrid(elements.length);
    for (const i of order) {
      const p = posOf[i]!;
      expansion.place(i, p.gx, p.gy);
    }
    for (const i of order) {
      const box = this.store.nodeBoxSize(elements[i]!);
      const gw = Math.max(1, Math.ceil((box.w - 1e-9) / cell));
      const gh = Math.max(1, Math.ceil((box.h - 1e-9) / cell));
      expansion.expand(i, gw, gh);
    }

    // 阶段 3：通道约束压实（Channel Safety Margin）。
    const margin = Math.max(0, Math.floor(this.options.channelMargin ?? DEFAULT_CHANNEL_MARGIN));
    expansion.compact(margin);

    // 物理化 + 走线。
    this.finalizeLayout(expansion.boxes(), cell);
  }

  /**
   * 折叠流水线：折叠 → 质点布局 → 扩展容器（不加 padding）→ 调整布局
   * （最后一次布局动作）→ 布线准备（节点间插入空行/空列，保序不改布局）
   * → 物理化 + 走线。
   *
   * 容器不占布局位：质点布局定容器宏观方位后，扩展/展开只落位真实节点；
   * 容器框 = 成员实占包裹，随布线空间自然出现（核心布局不消费 padding）。
   */
  private recomputeFolded(): void {
    const plan: FoldPlan = buildFoldPlan(this.store, this.options.foldChainMin ?? DEFAULT_FOLD_CHAIN_MIN);
    const cell = Math.max(this.options.naturalLength * this.store.cellScale, 1e-3);
    const subLayouts = new Map<FoldScope, ScopeLayout>();
    const rootLayout = this.layoutScope(plan.root, cell, subLayouts, false);

    // 展开：真实节点的初始格位（容器不占位，成员跟随子布局落位）
    const nodeBoxes: Box[] = new Array(this.store.elements.length);
    this.unfoldScope(plan.root, rootLayout.boxes, nodeBoxes, cell, subLayouts);

    // 调整布局（最后一次布局）：以展开锚点让位消重叠，保持相对方位
    const adjusted = this.adjustLayout(nodeBoxes);

    // 容器大小调整（布线之前）：基于调整后的布局，框 = 成员实占包裹
    let boxes = this.attachContainers(adjusted.boxes(), plan);

    // 布线准备：节点之间插入空行/空列（保序，整体布局不变）
    adjusted.compact(Math.max(0, Math.floor(this.options.channelMargin ?? DEFAULT_CHANNEL_MARGIN)));

    // 容器跟随布线空间重算（成员平移后仍包含全部成员）
    boxes = this.attachContainers(adjusted.boxes(), plan);
    this.finalizeLayout(boxes, cell);
    // 物理化写回后，同步容器实占 shape（物化格包裹 + padding）
    this.syncContainerShapes(plan, boxes, cell);
  }

  /**
   * 调整布局：展开后的真实节点按「AABB 中心为锚」进膨胀网格逐个让位
   * （左上→右下确定序），消除展开期可能的贴邻/重叠，同时保持粗布局给
   * 出的相对方位。输出无重叠的节点格 AABB。
   */
  private adjustLayout(nodeBoxes: Box[]): ExpansionGrid {
    const expansion = new ExpansionGrid(this.store.elements.length);
    const order = nodeBoxes
      .map((b, i) => ({ b, i }))
      .filter(({ b, i }) => !!b && !isSubgraphNode(this.store.elements[i]!))
      .sort((p, q) => p.b!.x - q.b!.x || p.b!.y - q.b!.y || p.i - q.i);
    for (const { b, i } of order) {
      const box = b!;
      expansion.place(i, box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2));
      expansion.expand(i, box.width, box.height);
    }
    return expansion;
  }

  /**
   * 容器框附加：容器 AABB = 全部成员实占 AABB 的并集（深度序：嵌套容器
   * 先算）。布局不消费 padding —— 容器外的空隙是布线空间，渲染时自然
   * 呈现为容器的留白。
   */
  private attachContainers(nodeBoxes: Box[], plan: FoldPlan): Box[] {
    const boxes = nodeBoxes.slice();
    for (const scope of [...plan.scopes].reverse()) {
      if (scope.containerIndex < 0) continue;
      const container = this.store.elements[scope.containerIndex]!;
      if (!isSubgraphNode(container)) continue;
      const memberBoxes = container.memberIndices.map((mi) => boxes[mi]).filter((b): b is Box => !!b);
      if (memberBoxes.length === 0) {
        boxes[scope.containerIndex] = { x: 0, y: 0, width: 1, height: 1 };
        continue;
      }
      const minX = Math.min(...memberBoxes.map((b) => b.x));
      const minY = Math.min(...memberBoxes.map((b) => b.y));
      const maxX = Math.max(...memberBoxes.map((b) => b.x + b.width));
      const maxY = Math.max(...memberBoxes.map((b) => b.y + b.height));
      boxes[scope.containerIndex] = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return boxes;
  }

  /**
   * 作用域布局（递归）：折叠视图上跑质点粗布局 → 逐项扩展（单元素 /
   * 链蛇形网格 / 容器递归子布局包裹，不加 padding）。compactAfter 控制
   * 是否在本作用域内压实（子作用域 true —— 容器内部成员间保留走线通道；
   * root false —— 由展开后的「调整布局 + 布线准备」接管）。
   */
  private layoutScope(scope: FoldScope, cell: number, subLayouts: Map<FoldScope, ScopeLayout>, compactAfter: boolean): ScopeLayout {
    const n = scope.items.length;
    if (n === 0) return { boxes: [], width: 0, height: 0 };
    const direction = this.options.direction;
    // 视图边（item 下标对）供有向分层。
    const viewEdges = scope.elementEdges
      .map(([a, b]) => ({ sourceIndex: scope.itemOfElement.get(a)!, targetIndex: scope.itemOfElement.get(b)! }))
      .filter((e) => e.sourceIndex !== e.targetIndex);
    const heuristics =
      direction === 'none'
        ? undirectedHeuristics(scope.adjacency, { directionClass: true })
        : directedHeuristics(
            scope.adjacency,
            viewEdges as never,
            computeLevels(n, viewEdges as never).level,
            direction,
          );
    // 视图代表元素：coarse 只用 placed/x/y（ignorePlaced 后不读坐标）。
    const reps = scope.items.map((item) =>
      item.kind === 'element' ? this.store.elements[item.index]! : this.store.elements[representativeOf(item)]!,
    );
    const { posOf, order } = coarseGridPlacement(
      reps,
      scope.adjacency,
      this.options.naturalLength * this.store.cellScale,
      heuristics,
      { ignorePlaced: true },
    );

    const margin = Math.max(0, Math.floor(this.options.channelMargin ?? DEFAULT_CHANNEL_MARGIN));
    const expansion = new ExpansionGrid(n);
    for (const i of order) {
      const p = posOf[i]!;
      expansion.place(i, p.gx, p.gy);
    }
    for (const i of order) {
      const item = scope.items[i]!;
      let gw = 1;
      let gh = 1;
      if (item.kind === 'element') {
        const box = this.store.nodeBoxSize(this.store.elements[item.index]!);
        gw = Math.max(1, Math.ceil((box.w - 1e-9) / cell));
        gh = Math.max(1, Math.ceil((box.h - 1e-9) / cell));
      } else if (item.kind === 'chain') {
        // 透明 group 展开：蛇形网格（面积最小 → 周长最小，与容器展开
        // 同一紧凑准则），链内 1 格间隙走线。
        const { width, height } = chainGridLayout(
          item.members.map((m) => this.gridSizeOf(m, cell)),
        );
        gw = Math.max(1, width);
        gh = Math.max(1, height);
      } else {
        // 容器：递归子布局评估尺寸（成员包裹，不加 padding）。
        const sub = this.layoutScope(item.scope, cell, subLayouts, true);
        subLayouts.set(item.scope, sub);
        gw = Math.max(1, sub.width);
        gh = Math.max(1, sub.height);
      }
      expansion.expand(i, gw, gh);
    }
    if (compactAfter) expansion.compact(margin);

    // 包围盒归一（左上角 → 0,0），得到作用域内相对布局。
    const boxes = expansion.boxes();
    let minX = Infinity;
    let minY = Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
    }
    for (const b of boxes) {
      b.x -= minX;
      b.y -= minY;
    }
    const width = Math.max(...boxes.map((b) => b.x + b.width), 0);
    const height = Math.max(...boxes.map((b) => b.y + b.height), 0);
    return { boxes, width, height };
  }

  /** 展开作用域：视图项 AABB → 真实元素 AABB（递归容器与链）。 */
  private unfoldScope(
    scope: FoldScope,
    itemBoxes: Box[],
    out: Box[],
    cell: number,
    subLayouts: Map<FoldScope, ScopeLayout>,
  ): void {
    scope.items.forEach((item, i) => {
      const box = itemBoxes[i]!;
      if (item.kind === 'element') {
        out[item.index] = box;
        return;
      }
      if (item.kind === 'chain') {
        // 透明 group 还原为长蛇：成员按蛇形网格排开（微调 = 网格化落位）。
        unfoldChain(item.members, box, (m) => this.gridSizeOf(m, cell), out);
        return;
      }
      // 容器：成员子布局整体平移进容器包裹（容器自身不占布局位）。
      const sub = subLayouts.get(item.scope);
      if (!sub) return;
      const shifted = sub.boxes.map((b) => ({ ...b, x: b.x + box.x, y: b.y + box.y }));
      this.unfoldScope(item.scope, shifted, out, cell, subLayouts);
    });
  }

  /**
   * 容器 shape 同步（深度序：嵌套容器先算）：shape = 布局包裹（物化格
   * × 格距）+ 每侧 padding。布局与走线不消费 padding，渲染框按此包含
   * 全部成员并呈现布线空间带来的留白。
   */
  private syncContainerShapes(plan: FoldPlan, boxes: Box[], cell: number): void {
    for (const scope of [...plan.scopes].reverse()) {
      if (scope.containerIndex < 0) continue;
      const container = this.store.elements[scope.containerIndex]!;
      if (!isSubgraphNode(container)) continue;
      const b = boxes[scope.containerIndex];
      if (!b) continue;
      const pad = isSubgraphNode(container) ? container.padding : 0;
      container.shape = {
        kind: 'rect',
        w: b.width * cell + pad * 2,
        h: b.height * cell + pad * 2,
      };
    }
  }

  /** 元素的逻辑格宽高（nodeBoxSize px ÷ 格距，向上取整，至少 1×1）。 */
  private gridSizeOf(index: number, cell: number): { w: number; h: number } {
    const box = this.store.nodeBoxSize(this.store.elements[index]!);
    return {
      w: Math.max(1, Math.ceil((box.w - 1e-9) / cell)),
      h: Math.max(1, Math.ceil((box.h - 1e-9) / cell)),
    };
  }

  /** 物理化：AABB 中心写回坐标（质心居中）+ A* 避障走线。 */
  private finalizeLayout(boxes: Box[], cell: number): void {
    const elements = this.store.elements;
    const centers = boxes.map((b) => ({
      x: (b.x + b.width / 2) * cell,
      y: (b.y + b.height / 2) * cell,
    }));
    let sx = 0;
    let sy = 0;
    for (const c of centers) {
      sx += c.x;
      sy += c.y;
    }
    const ox = -sx / centers.length;
    const oy = -sy / centers.length;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      el.x = centers[i]!.x + ox;
      el.y = centers[i]!.y + oy;
      el.w = boxes[i]!.width * cell;
      el.h = boxes[i]!.height * cell;
    }
    this.routeAll(boxes, cell, ox, oy);
    this.finished = true;
  }

  /** 为每条边计算 A* 正交走线并写入 waypoints（物理坐标）。 */
  private routeAll(boxes: Box[], cell: number, ox: number, oy: number): void {
    const ctx = new GridSpaceContext();
    // A* 端点 = AABB 中心格；障碍 = 其余全部节点 AABB（两端自身豁免，
    // 否则多格 AABB 会挡住自己的出口）。
    const centers = boxes.map((b) => ({
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    }));
    const toPhys = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: (p.x + 0.5) * cell + ox,
      y: (p.y + 0.5) * cell + oy,
    });
    const elements = this.store.elements;
    for (const e of this.store.edges) {
      // 容器不是实体障碍（成员才是）——容器 AABB 不入障碍集，跨容器边
      // 才可能从容器包裹内正常走线。
      const obstacles = boxes.filter(
        (_, i) => i !== e.sourceIndex && i !== e.targetIndex && !isSubgraphNode(elements[i]!),
      );
      const path = ctx.routeEdge(centers[e.sourceIndex]!, centers[e.targetIndex]!, obstacles);
      const a = this.store.elements[e.sourceIndex]!;
      const b = this.store.elements[e.targetIndex]!;
      // 无可行正交路径（贴邻节点顶死）时降级直线：可通行性由压实保证的
      // 通道承担，输出仍需首尾两点供渲染。
      e.waypoints = path
        ? [{ x: a.x, y: a.y }, ...path.slice(1, -1).map(toPhys), { x: b.x, y: b.y }]
        : [
            { x: a.x, y: a.y },
            { x: b.x, y: b.y },
          ];
    }
  }

  // ── LayoutStrategy（无迭代力学：流水线构造期一次完成）─────

  step(): boolean {
    return false;
  }

  run(_opts: RunOptions = {}): RunResult {
    return { iterations: 0, converged: true, energy: 0 };
  }

  /** 参数变化：整条流水线重算（网格布局确定性重放）。 */
  refresh(options: ResolvedLayoutOptions): void {
    this.options = options;
    this.recompute();
  }

  /** 外部改动坐标：无力学可失效，下次 refresh/rebuild 时重放。 */
  invalidate(): void {
    // 网格解是构造期产物，外部拖拽的坐标在下一次 recompute 前不参与计算。
  }

  /** 图结构变化：整条流水线重算。 */
  rebuild(): void {
    this.recompute();
  }

  get converged(): boolean {
    return this.finished;
  }

  get energy(): number {
    return 0;
  }

  get iterations(): number {
    return 0;
  }

  get energyHistory(): number[] {
    return [];
  }

  get stage(): 3 {
    return 3;
  }
}

registerStrategy('grid-undirected', (store, options) => new GridUndirectedStrategy(store, options));
