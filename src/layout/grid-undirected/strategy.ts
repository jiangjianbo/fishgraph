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
 * 折叠模式（options.folding）：折叠 → 各作用域内独立布局 → 纯平移
 * 展开。让位与插空行列只发生在作用域内部、以视图项为原子单元（容器
 * = 单个 item）—— 子图内部坐标只由子作用域布局决定，外部操作只整体
 * 平移容器，两者坐标系相互隔离。有外部连线的子图在内部布局时以「外
 * 部质点的投影」参与：投影固定在外部质点相对容器质点的位置，只牵引
 * 所连内部项（决定子图朝向与包裹尺寸），自身坐标永不改变。
 *
 * 网格解即最终解：确定性、成行成列、构造保证无重叠。坐标修正
 * （coordinateSystem）不适用——网格解本身就是格点。
 *
 * 第一期边界（后续工作）：连线文字不占格（虚拟文本节点待第二期）；
 * subgraph 容器按声明形状参与网格；平行走线的通道内等距分布待做。
 */

import type { GraphStore } from '../../graph/store.js';
import { isSubgraphNode } from '../../graph/store.js';
import type { Box, Point } from './space-types.js';
import { GridSpaceContext } from './grid-context.js';
import { dominantSide } from '../../edge/ports.js';
import { registerStrategy } from '../strategy.js';
import type { LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';
import { coarseGridPlacement, undirectedHeuristics } from './coarse.js';
import type { GridPos, ProjectionAnchor } from './coarse.js';
import { computeLevels } from './levels.js';
import { directedHeuristics } from './directed-placement.js';
import { ExpansionGrid } from './expansion.js';
import {
  buildFoldPlan,
  chainFootprint,
  commonAncestor,
  isWithinScope,
  liftElementToScope,
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

/** 祖先作用域的已完成放置帧：后代作用域构建投影锚点时查外部质点位置。 */
interface ScopeFrame {
  scope: FoldScope;
  /** 该作用域的质点放置结果（下标 = 视图项下标）。 */
  posOf: GridPos;
}

/** 折叠单元的代表元素下标（coarse 输入占位；placed 被忽略，仅占位）。 */
function representativeOf(item: FoldItem): number {
  return item.kind === 'chain' ? item.members[0]! : item.index;
}

export class GridUndirectedStrategy implements LayoutStrategy {
  readonly name: string = 'grid-undirected';

  /** 构造期即完成整条流水线（纯网格计算，无迭代）。 */
  private finished = false;

  /** 当前折叠计划（recomputeFolded 期间有效，供投影锚点查询作用域归属）。 */
  private foldPlan: FoldPlan | null = null;

  constructor(
    private store: GraphStore,
    private options: ResolvedLayoutOptions,
  ) {
    this.recompute();
  }

  /** 走线通道宽（格）：向下取整、非负。 */
  private get marginCells(): number {
    return Math.max(0, Math.floor(this.options.channelMargin ?? DEFAULT_CHANNEL_MARGIN));
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
    expansion.compact(this.marginCells);

    // 物理化 + 走线。
    this.finalizeLayout(expansion.boxes(), cell);
  }

  /**
   * 折叠流水线：折叠 → 作用域内布局（质点放置 → 膨胀 → 作用域内压实，
   * 以视图项为原子单元）→ 纯平移展开 → 物理化 + 走线。
   *
   * 让位与插空行列只发生在各作用域内部：子图内部坐标只由子作用域布局
   * 决定，跨作用域的操作（父作用域压实）以容器为原子单元，只整体平移
   * 容器，不改写成员相对位置 —— 子图坐标系与外部隔离。
   * 容器不占布局位：质点布局定容器宏观方位后，展开只落位真实节点；
   * 容器框 = 成员实占包裹。
   */
  private recomputeFolded(): void {
    const plan: FoldPlan = buildFoldPlan(this.store, this.options.foldChainMin ?? DEFAULT_FOLD_CHAIN_MIN);
    this.foldPlan = plan;
    const cell = Math.max(this.options.naturalLength * this.store.cellScale, 1e-3);
    const subLayouts = new Map<FoldScope, ScopeLayout>();
    const rootLayout = this.layoutScope(plan.root, cell, subLayouts, [], []);

    // 展开 = 刚性整体平移（唯一落位动作，此后不再有全局重排）
    const nodeBoxes: Box[] = new Array(this.store.elements.length);
    this.unfoldScope(plan.root, rootLayout.boxes, nodeBoxes, cell, subLayouts);

    // 容器框 = 全部成员实占 AABB 的并集（刚性展开下与容器 item 包裹一致）
    const boxes = this.attachContainers(nodeBoxes, plan);
    this.finalizeLayout(boxes, cell);
    // 物理化写回后，同步容器实占 shape（物化格包裹 + padding）
    this.syncContainerShapes(plan, boxes, cell);
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
   * 作用域布局（递归）：折叠视图上跑质点粗布局（带外部投影锚点牵引）
   * → 逐项扩展（单元素 / 链蛇形网格 + 走廊物化 / 容器递归子布局包裹，
   * 不加 padding）→ 作用域内压实 —— 以视图项为原子单元：容器整体参与
   * 插空行列，成员坐标不受扰动（容器内部通道由子作用域自己的压实负
   * 责）。包围盒归一（左上角 → 0,0）后输出作用域内相对布局。
   *
   * frames 为祖先作用域的放置帧（供子作用域构建投影锚点）；anchors 为
   * 本作用域的投影锚点（由调用方按边界边构建，root 为空）。
   */
  private layoutScope(
    scope: FoldScope,
    cell: number,
    subLayouts: Map<FoldScope, ScopeLayout>,
    frames: readonly ScopeFrame[],
    anchors: readonly ProjectionAnchor[],
  ): ScopeLayout {
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
    let { posOf, order } = coarseGridPlacement(
      reps,
      scope.adjacency,
      this.options.naturalLength * this.store.cellScale,
      heuristics,
      { ignorePlaced: true },
    );
    if (anchors.length > 0) {
      // 两遍放置校正投影原点：锚点偏移以「容器质点」为原点，而膨胀阶段
      // 容器质点 ↔ 内容 AABB 中心格 —— 第一遍放置求质点包围盒中心，把
      // 锚点平移到内容中心坐标系后放置第二遍。
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of posOf) {
        if (!p) continue;
        minX = Math.min(minX, p.gx);
        maxX = Math.max(maxX, p.gx);
        minY = Math.min(minY, p.gy);
        maxY = Math.max(maxY, p.gy);
      }
      const cx = Math.round((minX + maxX) / 2);
      const cy = Math.round((minY + maxY) / 2);
      const shifted = anchors.map((a) => ({ item: a.item, at: { gx: a.at.gx + cx, gy: a.at.gy + cy } }));
      ({ posOf, order } = coarseGridPlacement(
        reps,
        scope.adjacency,
        this.options.naturalLength * this.store.cellScale,
        heuristics,
        { ignorePlaced: true, anchors: shifted },
      ));
    }

    const margin = this.marginCells;
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
        // 透明 group 展开：蛇形网格（面积最小 → 周长最小，gap=0 判据），
        // 链内 margin 格走廊物化 —— 走廊随链整体平移，不被外部改写。
        const { width, height } = chainFootprint(
          item.members.map((m) => this.gridSizeOf(m, cell)),
          margin,
        );
        gw = Math.max(1, width);
        gh = Math.max(1, height);
      } else {
        // 容器：递归子布局评估尺寸（成员包裹，不加 padding）。子作用域
        // 的投影锚点由本作用域的放置帧 + 边界边构建。
        const childFrames: readonly ScopeFrame[] = [...frames, { scope, posOf }];
        const childAnchors = this.collectAnchors(item.scope, childFrames);
        const sub = this.layoutScope(item.scope, cell, subLayouts, childFrames, childAnchors);
        subLayouts.set(item.scope, sub);
        gw = Math.max(1, sub.width);
        gh = Math.max(1, sub.height);
      }
      expansion.expand(i, gw, gh);
    }
    expansion.compact(margin);

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

  /**
   * 收集子作用域 child 的投影锚点：每条跨 child 边界的边（一端在 child
   * 内、另一端在外，按 store 原始边与作用域归属判定）生成一个固定投影
   * —— 位置 = 外部质点在 LCA 作用域放置帧中相对容器质点的偏移，牵引
   * child 内所连视图项（深层成员经容器链归到其可见项）。投影只牵引不
   * 占位，自身坐标在 child 布局过程中永不改变。
   */
  private collectAnchors(child: FoldScope, frames: readonly ScopeFrame[]): ProjectionAnchor[] {
    const plan = this.foldPlan;
    if (!plan) return [];
    const anchors: ProjectionAnchor[] = [];
    const seen = new Set<string>();
    for (const e of this.store.edges) {
      const su = plan.scopeOfElement.get(e.sourceIndex);
      const sv = plan.scopeOfElement.get(e.targetIndex);
      if (!su || !sv) continue;
      const uIn = isWithinScope(su, child);
      const vIn = isWithinScope(sv, child);
      if (uIn === vIn) continue; // 内部边或与 child 无关
      const insideEl = uIn ? e.sourceIndex : e.targetIndex;
      const outsideEl = uIn ? e.targetIndex : e.sourceIndex;
      const lca = commonAncestor(su, sv);
      const frame = frames.find((f) => f.scope === lca);
      if (!frame) continue; // LCA 必为 child 的真祖先（防御：帧缺失即跳过）
      const insideAtL = liftElementToScope(plan.scopeOfElement, insideEl, lca);
      const outsideAtL = liftElementToScope(plan.scopeOfElement, outsideEl, lca);
      const itemInChild = liftElementToScope(plan.scopeOfElement, insideEl, child);
      if (insideAtL === null || outsideAtL === null || itemInChild === null) continue;
      const innerItem = frame.scope.itemOfElement.get(insideAtL);
      const outerItem = frame.scope.itemOfElement.get(outsideAtL);
      const posInner = innerItem !== undefined ? frame.posOf[innerItem] : undefined;
      const posOuter = outerItem !== undefined ? frame.posOf[outerItem] : undefined;
      const target = child.itemOfElement.get(itemInChild);
      if (!posInner || !posOuter || target === undefined) continue;
      const offset = { gx: posOuter.gx - posInner.gx, gy: posOuter.gy - posInner.gy };
      const key = `${target}:${offset.gx},${offset.gy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ item: target, at: offset });
    }
    return anchors;
  }

  /**
   * 展开作用域：视图项 AABB → 真实元素 AABB（递归容器与链）。纯刚性
   * 平移：成员相对坐标 = 子作用域布局产物，父作用域只提供整体偏移。
   */
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
        // 透明 group 还原为长蛇：蛇形网格 + 链内走廊物化（网格化落位）。
        unfoldChain(item.members, box, (m) => this.gridSizeOf(m, cell), out, this.marginCells);
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
    const centers = boxes.map((b) => ({
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    }));
    // A* 端点 = 两端「对端主导侧」的边界中点格 —— 与渲染端口同一
    // dominantSide 口径，骨架天然贴端口方向出入；两端对位时退化为直线，
    // 消除"绕到容器内部再折回端口"的多余折段。
    const portAnchor = (i: number, toward: { x: number; y: number }): Point => {
      const b = boxes[i]!;
      const c = centers[i]!;
      switch (dominantSide(toward.x - c.x, toward.y - c.y)) {
        case 'right':
          return { x: b.x + b.width - 1, y: c.y };
        case 'left':
          return { x: b.x, y: c.y };
        case 'bottom':
          return { x: c.x, y: b.y + b.height - 1 };
        case 'top':
          return { x: c.x, y: b.y };
      }
    };
    const toPhys = (p: { x: number; y: number }): { x: number; y: number } => ({
      x: (p.x + 0.5) * cell + ox,
      y: (p.y + 0.5) * cell + oy,
    });
    const elements = this.store.elements;
    for (const e of this.store.edges) {
      // 障碍 = 全部非容器节点 AABB（含两端自身：仅起终点格豁免，首末段
      // 因此必然沿端口法向穿出/进入，不会折回节点内部）。
      const obstacles = boxes.filter((_, i) => !isSubgraphNode(elements[i]!));
      const start = portAnchor(e.sourceIndex, centers[e.targetIndex]!);
      const goal = portAnchor(e.targetIndex, centers[e.sourceIndex]!);
      const path = ctx.routeEdge(start, goal, obstacles);
      const a = this.store.elements[e.sourceIndex]!;
      const b = this.store.elements[e.targetIndex]!;
      // 无可行正交路径（贴邻节点顶死）时降级直线：可通行性由压实保证的
      // 通道承担，输出仍需首尾两点供渲染。
      e.waypoints = path
        ? [toPhys(start), ...path.slice(1, -1).map(toPhys), toPhys(goal)]
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
