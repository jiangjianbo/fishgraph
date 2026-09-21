/**
 * GridUndirectedStrategy —— grid-first 无向图布局策略（纯网格流水线）。
 *
 * 按 doc/布局核心原则.md 的「纯网格布局算法流程」组织，全程在离散网格
 * 中运行（连续坐标只是网格解的物理化表达）：
 *   [质点拓扑粗布局] → [节点轴向膨胀物化为 AABB] → [通道约束压实] →
 *   [网格 A* 避障走线]
 *  - 阶段 1 复用 coarse.ts 的质点网格放置（度数优先连通生长 + 死锁插行列）；
 *  - 阶段 2/3 由 ExpansionGrid 承担：节点按文字/形状物化为逻辑格 AABB，
 *    插行列让位扩张，压实把相邻行列空隙压到 channelMargin（走线走廊）；
 *  - 阶段 4 用泛型化的 GridSpaceContext.routeEdge（A* 正交寻路 + 拐点
 *    惩罚）为每条边计算走线拐点，写入 edgeViews 的 waypoints；
 *  - 节点位置一旦物化不再被走线反向推开（连线不占空间，走线只在
 *    自由通道格中流转）。
 *
 * 与 force-undirected 的关系：共享质点粗布局（阶段 1 完全同源），但
 * 不经过力场弛豫 —— 网格解即最终解（确定性、成行成列、O(n·(w+h)) 级
 * 膨胀开销）。坐标修正（coordinateSystem）不适用：网格解本身就是格点。
 *
 * 第一期边界（后续工作）：连线文字不占格（虚拟文本节点待第二期）；
 * subgraph 容器按声明形状参与网格；无连续模式短弛豫（网格解直接输出）；
 * 平行走线的通道内等距分布待做。
 */

import type { GraphStore } from '../../graph/store.js';
import type { Box } from '../space/types.js';
import { GridSpaceContext } from '../space/grid-context.js';
import { registerStrategy } from '../strategy.js';
import type { LayoutStrategy, ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';
import { coarseGridPlacement } from '../force-undirected/coarse.js';
import { ExpansionGrid } from './expansion.js';

/** 默认走线通道宽（格）：相邻节点 AABB 之间保留的最小空行/列数。 */
const DEFAULT_CHANNEL_MARGIN = 1;

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

    // 阶段 1：质点拓扑粗布局（与 force-undirected 同源）。
    const { grid, posOf, cell, order } = coarseGridPlacement(
      elements,
      adj,
      this.options.naturalLength,
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

    // 物理化：AABB 中心写回坐标，整体平移使质心位于原点。
    const boxes = expansion.boxes();
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

    // 阶段 4：网格 A* 避障走线（节点位置锁定，连线只在自由通道格流转）。
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
    for (const e of this.store.edges) {
      const obstacles = boxes.filter((_, i) => i !== e.sourceIndex && i !== e.targetIndex);
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
