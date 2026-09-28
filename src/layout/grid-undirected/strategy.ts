/**
 * GridUndirectedStrategy —— grid-first 网格布局策略（纯网格流水线，唯一
 * 主引擎）。
 *
 * 按 doc/布局核心原则.md §4「流水线骨架」组织，全程在离散网格
 * 中运行（世界坐标由尺寸映射策略物理化，渲染端自由缩放）：
 *   [质点拓扑粗布局] → [节点中心对称膨胀物化为 AABB] → [膨胀后调整
 *   （消压线）] → [行列整理（扫描合并 → 走廊插入 → 通道压实 → 行列
 *   居中对齐）] → [网格 A* 避障走线] → [映射策略：格解 → 可渲染图]
 *  - 阶段 2 用 coarse.ts 的质点网格放置（波纹连通生长 + 死锁插行列）。
 *    direction = 'none'（默认）用无向放置美学（张力 − 环周长 + 环内方位
 *    分类 + 扫描序平局）；'TB'/'LR' 用有向层级放置（解环 + 最长路径
 *    分层，节点钉在自己的层级行/列上，顺流无逆边）；
 *  - 阶段 3~7 由 ExpansionGrid 承担：节点按映射策略分级的宽高格数
 *    （gw/gh = px 盒 ÷ 矩形基准格）中心对称扩张（阶段 3）→ 消压线
 *    （阶段 4：deflectEdgeCrossings）→ 行列扫描合并（阶段 5：tighten）
 *    → 走廊插入（阶段 6：ensureCorridor）→ 通道压实（阶段 7：compact，
 *    相邻行列空隙统一到 channelMargin 走线走廊）→ 行列居中对齐（阶段
 *    7.5：alignCenters，同带元素中心共线）；
 *  - 阶段 8 用 GridSpaceContext.routeEdge（A* 正交寻路 + 拐点惩罚）在
 *    逻辑格上走线；物理化与可渲染图装配委托尺寸映射策略
 *    （LayoutOptions.metric，缺省 DefaultMetricStrategy：1 格 = 矩形
 *    基准格，x 轴 cellW、y 轴 cellH）；
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
import { ExpansionGrid, deflectEdgeCrossings } from './expansion.js';
import type { LayoutRoute, RenderGraph } from '../metric/types.js';
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

    // 阶段 2：质点拓扑粗布局。'none'（默认）用无向放置美学（张力 − 环
    // 周长 + 环内方位分类：张力同分的候选优先十字方位，45° 次之）；
    // 'TB'/'LR' 用有向层级放置（解环 + 最长路径分层，钉层级行/列）。
    // 格距 = 矩形基准格（applyNodeLabelSizes 已分级：gradeCellW/H 与
    // 各元素 gw/gh 就绪）。
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
    const { grid, posOf, order } = coarseGridPlacement(
      elements,
      adj,
      this.options.naturalLength,
      heuristics,
      { cellW: this.store.gradeCellW, cellH: this.store.gradeCellH },
    );
    void grid; // 占用语义由 ExpansionGrid 接管

    // 阶段 3：节点与文字轴向膨胀 —— 消费映射策略分级的宽高格数
    // （gw/gh = px 盒 ÷ 矩形基准格向上取整），不再自算。
    const expansion = new ExpansionGrid(elements.length);
    for (const i of order) {
      const p = posOf[i]!;
      expansion.place(i, p.gx, p.gy);
    }
    for (const i of order) {
      const el = elements[i]!;
      expansion.expand(i, Math.max(1, el.gw), Math.max(1, el.gh));
    }

    // 阶段 4：膨胀后调整（消压线）——质点口径判定的零压线在元素加宽后
    // 可能失效，以真实格 AABB 迭代推离压线元素（容器不入判定，与走线
    // 障碍同口径）。阶段 5~7：行列扫描合并 → 走廊插入 → 通道压实。
    const containers = new Set<number>();
    this.store.elements.forEach((el, i) => {
      if (isSubgraphNode(el)) containers.add(i);
    });
    const edgePairs = this.store.edges.map((e) => ({ u: e.sourceIndex, v: e.targetIndex }));
    deflectEdgeCrossings(expansion, edgePairs, containers);
    expansion.tighten();
    // 阶段 5/7.5 的吸附平移带 R6 防线（同起点连线零共线为硬约束：
    // 卫星被吸到 hub 同列同向后，直线连线完全重合）。
    expansion.mergeLines(edgePairs);
    expansion.ensureCorridor(this.marginCells);
    // 阶段 7：通道约束压实（Channel Safety Margin）；阶段 7.5：行列
    // 居中对齐（同带元素中心共线，同行列连线严格水平/垂直）。
    expansion.compact(this.marginCells);
    expansion.alignCenters(edgePairs);

    // 物理化 + 走线（映射策略出口：可渲染图）。
    this.finalizeLayout(expansion.boxes());
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
    const subLayouts = new Map<FoldScope, ScopeLayout>();
    const rootLayout = this.layoutScope(plan.root, subLayouts, [], []);

    // 展开 = 刚性整体平移（唯一落位动作，此后不再有全局重排）
    const nodeBoxes: Box[] = new Array(this.store.elements.length);
    this.unfoldScope(plan.root, rootLayout.boxes, nodeBoxes, subLayouts);

    // 容器框 = 全部成员实占 AABB 的并集（刚性展开下与容器 item 包裹一致）
    const boxes = this.attachContainers(nodeBoxes, plan);
    // 容器实占 shape（格包裹 + padding）由映射策略在物理化时产出
    const containerPaddings = this.store.elements.map((el) => (isSubgraphNode(el) ? el.padding : null));
    this.finalizeLayout(boxes, containerPaddings);
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
    const coarseCell = { cellW: this.store.gradeCellW, cellH: this.store.gradeCellH };
    let { posOf, order } = coarseGridPlacement(reps, scope.adjacency, this.options.naturalLength, heuristics, {
      ignorePlaced: true,
      ...coarseCell,
    });
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
      ({ posOf, order } = coarseGridPlacement(reps, scope.adjacency, this.options.naturalLength, heuristics, {
        ignorePlaced: true,
        ...coarseCell,
        anchors: shifted,
      }));
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
        const el = this.store.elements[item.index]!;
        gw = Math.max(1, el.gw);
        gh = Math.max(1, el.gh);
      } else if (item.kind === 'chain') {
        // 透明 group 展开：蛇形网格（面积最小 → 周长最小，gap=0 判据），
        // 链内 margin 格走廊物化 —— 走廊随链整体平移，不被外部改写。
        const { width, height } = chainFootprint(item.members.map((m) => this.gridSizeOf(m)), margin);
        gw = Math.max(1, width);
        gh = Math.max(1, height);
      } else {
        // 容器：递归子布局评估尺寸（成员包裹，不加 padding）。子作用域
        // 的投影锚点由本作用域的放置帧 + 边界边构建。
        const childFrames: readonly ScopeFrame[] = [...frames, { scope, posOf }];
        const childAnchors = this.collectAnchors(item.scope, childFrames);
        const sub = this.layoutScope(item.scope, subLayouts, childFrames, childAnchors);
        subLayouts.set(item.scope, sub);
        gw = Math.max(1, sub.width);
        gh = Math.max(1, sub.height);
      }
      expansion.expand(i, gw, gh);
    }
    // 阶段 4~7（作用域内执行，展开为纯平移不受影响）：消压线以视图项
    // 为判定实体，容器 item 不入判定（展开后容器框 = 成员实占并集）。
    const containerItems = new Set<number>();
    scope.items.forEach((it, i) => {
      if (it.kind === 'subgraph') containerItems.add(i);
    });
    const viewEdgePairs = viewEdges.map((e) => ({ u: e.sourceIndex, v: e.targetIndex }));
    deflectEdgeCrossings(expansion, viewEdgePairs, containerItems);
    expansion.tighten();
    // R6 防线同非折叠路径（视图项下标与 expansion 下标一致）。
    expansion.mergeLines(viewEdgePairs);
    expansion.ensureCorridor(margin);
    expansion.compact(margin);
    expansion.alignCenters(viewEdgePairs);

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
        unfoldChain(item.members, box, (m) => this.gridSizeOf(m), out, this.marginCells);
        return;
      }
      // 容器：成员子布局整体平移进容器包裹（容器自身不占布局位）。
      const sub = subLayouts.get(item.scope);
      if (!sub) return;
      const shifted = sub.boxes.map((b) => ({ ...b, x: b.x + box.x, y: b.y + box.y }));
      this.unfoldScope(item.scope, shifted, out, subLayouts);
    });
  }

  /** 元素的逻辑格宽高（映射策略分级产物：px 盒 ÷ 矩形基准格，至少 1×1）。 */
  private gridSizeOf(index: number): { w: number; h: number } {
    const el = this.store.elements[index]!;
    return { w: Math.max(1, el.gw), h: Math.max(1, el.gh) };
  }

  /** 最近一次物理化的可渲染图（出口：带自由坐标，渲染端自行缩放绘制）。 */
  private renderGraphOut: RenderGraph | null = null;

  get renderGraph(): RenderGraph | null {
    return this.renderGraphOut;
  }

  /**
   * 物理化：格解交给尺寸映射策略产出可渲染图（世界坐标），再写回
   * store —— 元素中心/AABB、边 waypoints、容器实占 shape（渲染框 =
   * 格包裹 + padding；布局与走线不消费 padding）。
   */
  private finalizeLayout(boxes: Box[], containerPaddings: Array<number | null> = boxes.map(() => null)): void {
    const elements = this.store.elements;
    const basis = { cellW: this.store.gradeCellW, cellH: this.store.gradeCellH };
    const routes = this.routeInCells(boxes);
    const graph = this.store.metricStrategy.render({ boxes, routes, containerPaddings }, basis);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      const nd = graph.nodes[i]!;
      el.x = nd.x + nd.w / 2;
      el.y = nd.y + nd.h / 2;
      el.w = nd.w;
      el.h = nd.h;
      const shape = graph.containerShapes[i];
      if (shape) el.shape = shape;
    }
    this.store.edges.forEach((e, i) => {
      e.waypoints = graph.edges[i]!.waypoints;
    });
    this.renderGraphOut = graph;
    this.finished = true;
  }

  /**
   * 格上走线：端口锚点（两端口径同渲染 dominantSide）+ A* 正交避障，
   * 产出逻辑格走线（物理化由映射策略完成）。无可行正交路径（贴邻节点
   * 顶死）时降级直线：cells 给两端中心格、exact 给元素几何中心的精确格
   * 坐标 —— 物理化直接乘格距，不做格心偏移。
   */
  private routeInCells(boxes: Box[]): LayoutRoute[] {
    const elements = this.store.elements;
    const ctx = new GridSpaceContext();
    const centers = boxes.map((b) => ({
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    }));
    // 边中点沿边方向的锚点格：奇数尺寸 = 中心格（格心即边中点）；偶数
    // 尺寸边中点落在两格交界，取靠对端侧的格 —— 锚点格心与渲染端口
    // （边界中点）的半格偏差恒朝对端方向，渲染缝合的切向滑动段与连线
    // 主方向一致，不出现反向段（折线单调性原则）。
    const midCell = (lo: number, size: number, towardDelta: number): number => {
      const k = Math.floor(size / 2);
      if (size % 2 === 1) return lo + k;
      return towardDelta >= 0 ? lo + k : lo + k - 1;
    };
    // 端口锚点 = 两端「对端主导侧」的边界格 + 外法向 —— 与渲染端口同一
    // dominantSide 口径。
    const portAnchor = (
      i: number,
      toward: { x: number; y: number },
    ): { point: Point; normal: Point } => {
      const b = boxes[i]!;
      const c = centers[i]!;
      switch (dominantSide(toward.x - c.x, toward.y - c.y)) {
        case 'right':
          return { point: { x: b.x + b.width - 1, y: midCell(b.y, b.height, toward.y - c.y) }, normal: { x: 1, y: 0 } };
        case 'left':
          return { point: { x: b.x, y: midCell(b.y, b.height, toward.y - c.y) }, normal: { x: -1, y: 0 } };
        case 'bottom':
          return { point: { x: midCell(b.x, b.width, toward.x - c.x), y: b.y + b.height - 1 }, normal: { x: 0, y: 1 } };
        case 'top':
          return { point: { x: midCell(b.x, b.width, toward.x - c.x), y: b.y }, normal: { x: 0, y: -1 } };
      }
    };
    // 障碍 = 全部非容器节点 AABB（含两端自身：A* 端点在盒外一格，首末段
    // 因此必然沿端口法向穿出/进入，不会折回节点内部）。
    const obstacles = boxes.filter((_, i) => !isSubgraphNode(elements[i]!));
    return this.store.edges.map((e) => {
      const sa = portAnchor(e.sourceIndex, centers[e.targetIndex]!);
      const ta = portAnchor(e.targetIndex, centers[e.sourceIndex]!);
      // A* 端点 = 锚点沿外法向外移一格（盒外）：骨架首末步强制沿端口
      // 法向，渲染端 portToward 从骨架首末段推断的端口侧与锚点侧恒一致
      // —— 消除"从侧面进入锚点格导致端口跑到另一侧 + 缝合碎拐"。
      const startOut = { x: sa.point.x + sa.normal.x, y: sa.point.y + sa.normal.y };
      const goalOut = { x: ta.point.x + ta.normal.x, y: ta.point.y + ta.normal.y };
      const path = ctx.routeEdge(startOut, goalOut, obstacles);
      if (path) {
        // 正对位直线升级：两锚点同列/同行且 A* 解为无拐点直线（通道畅通
        // 由 A* 自证）时，改走经两端端口边界中点的精确直线 —— 偶数格尺寸
        // 盒的锚点格心与端口边中点错开半格（正对位时「靠对端侧」无方向
        // 可依），格列直线在渲染端需要两端缝合反向横滑，折成 C 形；中线
        // 直线让骨架与端口同轴，零拐弯直连。
        const vertical = sa.point.x === ta.point.x;
        const horizontal = !vertical && sa.point.y === ta.point.y;
        // 正对位升级要求两端**中心格**同列/同行（同轴）：仅锚点同列时
        // 异宽盒的中心错开整格，exact 中线直线会斜穿第三方盒（回归：
        // 星形 hub 2 格宽 → s8 1 格宽锚点同列、中心错 1 格，斜线穿 s0）。
        const straight =
          (vertical &&
            centers[e.sourceIndex]!.x === centers[e.targetIndex]!.x &&
            path.every((p) => p.x === startOut.x)) ||
          (horizontal &&
            centers[e.sourceIndex]!.y === centers[e.targetIndex]!.y &&
            path.every((p) => p.y === startOut.y));
        if (straight) {
          const sb = boxes[e.sourceIndex]!;
          const tb = boxes[e.targetIndex]!;
          // 端口在盒边界线上（格坐标）：法向正侧 = 盒底/右边界线，负侧 =
          // 盒顶/左边界线。边界中点取中心格格心口径（与物理化吸附后的
          // 渲染端口 = AABB 边界中点严格同点）——同行列元素的格心共线，
          // 直线两端 y/x 逐位相等，渲染为严格水平/垂直线。
          const se = {
            x: vertical ? sb.x + Math.floor(sb.width / 2) + 0.5 : sa.normal.x > 0 ? sb.x + sb.width : sb.x,
            y: vertical ? (sa.normal.y > 0 ? sb.y + sb.height : sb.y) : sb.y + Math.floor(sb.height / 2) + 0.5,
          };
          const te = {
            x: vertical ? tb.x + Math.floor(tb.width / 2) + 0.5 : ta.normal.x > 0 ? tb.x + tb.width : tb.x,
            y: vertical ? (ta.normal.y > 0 ? tb.y + tb.height : tb.y) : tb.y + Math.floor(tb.height / 2) + 0.5,
          };
          return {
            source: e.sourceIndex,
            target: e.targetIndex,
            cells: [sa.point, ta.point],
            exact: [se, te],
          };
        }
        const cells = [sa.point, ...path, ta.point];
        // 贴邻对位：两端外一格重合（A* 单点路径），锚点三点可能成 V 形
        // —— 入端前补一个拐点保正交，末段仍沿目标法向贴边。
        if (path.length === 1) {
          const v = startOut;
          if (v.x !== ta.point.x && v.y !== ta.point.y) {
            const corner =
              ta.normal.x !== 0 ? { x: v.x, y: ta.point.y } : { x: ta.point.x, y: v.y };
            cells.splice(cells.length - 1, 0, corner);
          }
        }
        return { source: e.sourceIndex, target: e.targetIndex, cells };
      }
      const a = boxes[e.sourceIndex]!;
      const b = boxes[e.targetIndex]!;
      return {
        source: e.sourceIndex,
        target: e.targetIndex,
        cells: [centers[e.sourceIndex]!, centers[e.targetIndex]!],
        exact: [
          // 降级直线端点同为中心格格心（与物理化吸附后的元素中心同点）。
          { x: a.x + Math.floor(a.width / 2) + 0.5, y: a.y + Math.floor(a.height / 2) + 0.5 },
          { x: b.x + Math.floor(b.width / 2) + 0.5, y: b.y + Math.floor(b.height / 2) + 0.5 },
        ],
      };
    });
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
