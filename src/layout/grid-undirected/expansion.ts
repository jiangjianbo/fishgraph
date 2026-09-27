/**
 * 膨胀网格（Expansion Grid）—— grid-first 流水线的阶段 3 载体。
 *
 * 在质点网格放置（coarseGridPlacement）的产物之上，把每个 1×1 质点
 * 逐个「中心对称膨胀」为 W×H 格的 AABB 包围盒：质点格保持为 AABB 的
 * 中心格（奇数尺寸精确居中，偶数尺寸固定向左/上配平半格）。扩张让位
 * 是**带内推挤**而非整行/整列插入：向右扩张只推动目标行带（本元素扩
 * 张后将占据的那几行）内位于右侧的元素，向左/向上/向下同理（垂直方
 * 向只推目标列带内的元素）—— 其他行/列上的元素不受扰动，消除扩张时
 * 的全局连带平移。被推元素整体平移同一增量：组内相对位置不变（保序、
 * 保 AABB 连续）；被推元素在带外的延展部分（高/宽元素）扫掠撞到的元
 * 素级联入组，横跨锚点列/行的元素由正交方向的推挤整体让位 —— 元素
 * AABB 全程完整，无重叠由构造保证。
 *
 * 物化后整理（布局核心原则 §4.4~§4.7）按阶段拆分，全部为单轴保序重
 * 映射或扫掠级联整体平移，无重叠由构造保证：
 *  - `deflectEdgeCrossings`（阶段 4 膨胀后调整）：质点口径判定的连线
 *    零压线在元素加宽后可能失效——两端中心格直线落进第三方 AABB。以
 *    真实格 AABB 迭代校验，压线的第三方元素沿背离连线的方向推离 1 格
 *    （级联让位），有界迭代；
 *  - `tighten`（阶段 5 行列扫描合并·收紧）：相邻占用行/列间隔 >1 的
 *    全部收紧为贴邻（回收空隙，尽量合并）；
 *  - `mergeLines`（阶段 5 行列扫描合并·对齐）：把独居元素吸附到邻近
 *    主线（锚点数 ≥2 的列/行线），可并线的散落元素对齐成列/成行；
 *  - `ensureCorridor`（阶段 6 走廊插入）：相邻占用行/列之间确保至少
 *    margin 格空隙（不足插出、超出保留）；
 *  - `compact`（阶段 7 通道压实）：空隙统一为恰好 margin 格（回收
 *    超出 + 补足不足）。tighten + ensureCorridor 与 compact 最终状态
 *    一致（同一重映射的三段分解）。
 */

import type { Box } from './space-types.js';

/** 元素格 AABB（闭合区间口径：maxX/maxY 为格下标而非排他边界）。 */
interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 闭合坐标区间（推挤作用的目标行带/列带）。 */
interface Span {
  min: number;
  max: number;
}

export class ExpansionGrid {
  /** 元素锚点（AABB 左上格，下标 = elements 下标）。 */
  readonly anchorOf: Array<{ gx: number; gy: number }>;
  /** 元素 AABB 格尺寸（初始 1×1 质点）。 */
  readonly sizeOf: Array<{ w: number; h: number }>;

  constructor(n: number) {
    this.anchorOf = new Array(n);
    this.sizeOf = Array.from({ length: n }, () => ({ w: 1, h: 1 }));
  }

  /** 锚定质点（放置产物，1×1）。 */
  place(i: number, gx: number, gy: number): void {
    this.anchorOf[i] = { gx, gy };
  }

  /**
   * 把元素 i 从 1×1 质点膨胀为 w×h 格 AABB：先做四向带内推挤让位 ——
   * 水平推挤的行带 = 扩张后的目标行区间（只推带内的左/右元素），垂直
   * 推挤的列带 = 目标列区间（只推带内的上/下元素）—— 再把锚点改写为
   * AABB 左上格并记录尺寸。质点格始终是 AABB 的「中心格」：奇数尺寸
   * 向两侧各扩 (w−1)/2 格，质点恰为 AABB 几何中心；偶数尺寸格上无精
   * 确中心，固定向左/上多配一格（半格差），且 b.x+⌊w/2⌋ 恒等于质点格，
   * A* 中心格口径不变。锚点格是四向推挤的支点，全程不动。
   */
  expand(i: number, w: number, h: number): void {
    const a = this.anchorOf[i]!;
    const left = Math.floor(w / 2);
    const up = Math.floor(h / 2);
    const right = w - 1 - left;
    const down = h - 1 - up;
    // 目标行带/列带：本元素扩张后将占据的行/列区间，推挤只作用于带内。
    const rowBand: Span = { min: a.gy - up, max: a.gy + down };
    const colBand: Span = { min: a.gx - left, max: a.gx + right };
    if (left > 0) this.pushSide('x', -1, i, left, rowBand);
    if (right > 0) this.pushSide('x', 1, i, right, rowBand);
    if (up > 0) this.pushSide('y', -1, i, up, colBand);
    if (down > 0) this.pushSide('y', 1, i, down, colBand);
    this.sizeOf[i] = { w, h };
    a.gx -= left;
    a.gy -= up;
  }

  /**
   * 阶段 5 行列扫描合并：扫描全部占用行/列，把可以合并的合并 —— 相邻
   * 占用坐标的空隙全部回收（间隔 >1 收紧为贴邻）。保序重映射，元素
   * AABB 连续性不变；同轴投影原本分离的元素收紧后仍分离（新间距 ≥ 1），
   * 无重叠由构造保证。
   */
  tighten(): void {
    this.remapAxis('x', () => 1);
    this.remapAxis('y', () => 1);
  }

  /**
   * 阶段 6 走廊插入：相邻占用行/列之间确保至少 margin 格空隙作为走线
   * 走廊（不足插出、超出保留）。作用于 tighten 之后时，全部间距恰被
   * 抬到 1 + margin。
   */
  ensureCorridor(margin: number): void {
    this.remapAxis('x', (_prev, gap) => Math.max(gap, 1 + margin));
    this.remapAxis('y', (_prev, gap) => Math.max(gap, 1 + margin));
  }

  /**
   * 阶段 5 行列对齐合并：把「独居」（所在列/行线上没有其他元素锚点）的
   * 元素吸附到邻近主线（锚点数 ≥ 2 的列/行线），使可并线的散落元素
   * 对齐成列/成行。候选主线按距离升序尝试，平局取更靠近包围盒中心的
   * 一条；约束：平移后与任何元素 AABB 无重叠、且不扩大全局包围盒，
   * 全部候选不可行则保持原位。迭代至不动点（有界）。异宽元素对齐的是
   * 格线（左缘对齐）；同宽元素即中心对齐。
   */
  mergeLines(): void {
    this.mergeAxis('x');
    this.mergeAxis('y');
  }

  /** 单轴对齐合并：主线频次统计 → 独居元素按距离序试吸附 → 不动点迭代。 */
  private mergeAxis(axis: 'x' | 'y'): void {
    const n = this.anchorOf.length;
    if (n === 0) return;
    const coordOf = (i: number): number => (axis === 'x' ? this.anchorOf[i]!.gx : this.anchorOf[i]!.gy);
    const projOf = (r: Rect): { lo: number; hi: number } =>
      axis === 'x' ? { lo: r.minX, hi: r.maxX } : { lo: r.minY, hi: r.maxY };
    for (let round = 0; round < n; round++) {
      let moved = false;
      const counts = new Map<number, number>();
      for (let i = 0; i < n; i++) counts.set(coordOf(i), (counts.get(coordOf(i)) ?? 0) + 1);
      const lines = [...counts.entries()]
        .filter(([, c]) => c >= 2)
        .map(([c]) => c)
        .sort((a, b) => a - b);
      if (lines.length === 0) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = projOf(this.rectOf(i));
        lo = Math.min(lo, p.lo);
        hi = Math.max(hi, p.hi);
      }
      const mid = (lo + hi) / 2;
      for (let i = 0; i < n; i++) {
        const cur = coordOf(i);
        if ((counts.get(cur) ?? 0) >= 2) continue; // 已在主线
        const candidates = [...lines].sort(
          (a, b) => Math.abs(a - cur) - Math.abs(b - cur) || Math.abs(a - mid) - Math.abs(b - mid) || a - b,
        );
        for (const t of candidates) {
          if (t === cur) continue;
          const delta = t - cur;
          const p = projOf(this.rectOf(i));
          if (p.lo + delta < lo || p.hi + delta > hi) continue; // 包围盒不扩大
          const r = this.rectOf(i);
          const shifted = axis === 'x' ? { ...r, minX: r.minX + delta, maxX: r.maxX + delta } : { ...r, minY: r.minY + delta, maxY: r.maxY + delta };
          let clash = false;
          for (let j = 0; j < n && !clash; j++) {
            if (j === i || !this.anchorOf[j]) continue;
            const q = this.rectOf(j);
            clash =
              shifted.minX <= q.maxX &&
              q.minX <= shifted.maxX &&
              shifted.minY <= q.maxY &&
              q.minY <= shifted.maxY;
          }
          if (clash) continue;
          const a = this.anchorOf[i]!;
          if (axis === 'x') a.gx += delta;
          else a.gy += delta;
          counts.set(cur, (counts.get(cur) ?? 0) - 1);
          counts.set(t, (counts.get(t) ?? 0) + 1);
          moved = true;
          break;
        }
      }
      if (!moved) return;
    }
  }

  /**
   * 阶段 7 通道约束压实：相邻占用行/列之间的空隙统一调整为恰好 margin
   * 格 —— 不足 margin 的（贴邻）扩张出走线走廊，超出 margin 的（大片
   * 空白）压缩回收。margin = 0 时全部压到贴邻。全局因此成行成列、走线
   * 走廊均匀。
   */
  compact(margin: number): void {
    this.remapAxis('x', () => 1 + margin);
    this.remapAxis('y', () => 1 + margin);
  }

  /** 全部元素的格 AABB（下标 = elements 下标）。 */
  boxes(): Box[] {
    return this.anchorOf.map((a, i) => ({
      x: a.gx,
      y: a.gy,
      width: this.sizeOf[i]!.w,
      height: this.sizeOf[i]!.h,
    }));
  }

  /** 元素格 AABB（闭合区间口径）。 */
  private rectOf(i: number): Rect {
    const a = this.anchorOf[i]!;
    const s = this.sizeOf[i]!;
    return { minX: a.gx, minY: a.gy, maxX: a.gx + s.w - 1, maxY: a.gy + s.h - 1 };
  }

  /**
   * 单向带内推挤：axis + dir 确定方向（如 x/+1 = 向右），delta 为让位
   * 格数，band 为另一轴上本元素的目标区间（行带/列带）。推挤组 = 与
   * band 相交且位于锚点对应侧（严格越过锚点格）的全部元素，组内按同
   * 一 delta 整体平移（相对位置不变，保序保连续）；再级联封闭：组内
   * 元素平移的扫掠区间（原位置与新位置之间）撞到的组外元素一并入组，
   * 直至不再新增 —— 落点因此必空、组不越过任何留置元素。与锚点同格
   * 交叉（既不在左也不在右）的元素不属本向推挤，由正交方向整体让位。
   */
  private pushSide(axis: 'x' | 'y', dir: 1 | -1, src: number, delta: number, band: Span): void {
    const anchor = this.anchorOf[src]!;
    const front = axis === 'x' ? anchor.gx : anchor.gy;
    const moved = new Set<number>();
    const queue: number[] = [];
    for (let j = 0; j < this.anchorOf.length; j++) {
      if (j === src || !this.anchorOf[j]) continue;
      const r = this.rectOf(j);
      if (this.inBand(axis, r, band) && this.onSide(axis, dir, front, r)) {
        moved.add(j);
        queue.push(j);
      }
    }
    while (queue.length > 0) {
      const m = this.rectOf(queue.pop()!);
      // 已入组元素的另一轴投影即级联判定的带。
      const crossBand: Span = { min: axis === 'x' ? m.minY : m.minX, max: axis === 'x' ? m.maxY : m.maxX };
      for (let j = 0; j < this.anchorOf.length; j++) {
        if (j === src || moved.has(j) || !this.anchorOf[j]) continue;
        const r = this.rectOf(j);
        if (this.inBand(axis, r, crossBand) && this.swept(axis, dir, delta, m, r)) {
          moved.add(j);
          queue.push(j);
        }
      }
    }
    for (const j of moved) {
      const a = this.anchorOf[j]!;
      if (axis === 'x') a.gx += dir * delta;
      else a.gy += dir * delta;
    }
  }

  /** 元素在 axis 轴上的投影与 band 相交（另一轴投影落在带内）。 */
  private inBand(axis: 'x' | 'y', r: Rect, band: Span): boolean {
    const lo = axis === 'x' ? r.minY : r.minX;
    const hi = axis === 'x' ? r.maxY : r.maxX;
    return lo <= band.max && hi >= band.min;
  }

  /** 元素整体位于锚点格 dir 侧（严格越过锚点格：left = maxX ≤ front−1）。 */
  private onSide(axis: 'x' | 'y', dir: 1 | -1, front: number, r: Rect): boolean {
    const lo = axis === 'x' ? r.minX : r.minY;
    const hi = axis === 'x' ? r.maxX : r.maxY;
    return dir === 1 ? lo >= front + 1 : hi <= front - 1;
  }

  /** 元素落在已入组元素 m 的扫掠区间内（m 平移后路径压住的格带）。 */
  private swept(axis: 'x' | 'y', dir: 1 | -1, delta: number, m: Rect, r: Rect): boolean {
    const lo = axis === 'x' ? r.minX : r.minY;
    const hi = axis === 'x' ? r.maxX : r.maxY;
    const mLo = axis === 'x' ? m.minX : m.minY;
    const mHi = axis === 'x' ? m.maxX : m.maxY;
    return dir === 1 ? lo > mHi && lo <= mHi + delta : hi < mLo && hi >= mLo - delta;
  }

  /**
   * 把元素 i 沿 axis/dir 平移 1 格：平移扫掠撞到的元素级联入组（与 i
   * 的另一轴投影相交、落在扫掠区间内），全组同一增量整体平移（相对
   * 位置不变）—— 落点必空、不越留置元素，无重叠由构造保证。消压线
   * 调整的让位基元：推的是压线元素自身（pushSide 推的是让位邻居）。
   */
  nudge(i: number, axis: 'x' | 'y', dir: 1 | -1): void {
    const moved = new Set<number>([i]);
    const queue: number[] = [i];
    while (queue.length > 0) {
      const m = this.rectOf(queue.pop()!);
      // 已入组元素的另一轴投影即级联判定的带。
      const crossBand: Span = { min: axis === 'x' ? m.minY : m.minX, max: axis === 'x' ? m.maxY : m.maxX };
      for (let j = 0; j < this.anchorOf.length; j++) {
        if (moved.has(j) || !this.anchorOf[j]) continue;
        const r = this.rectOf(j);
        if (this.inBand(axis, r, crossBand) && this.swept(axis, dir, 1, m, r)) {
          moved.add(j);
          queue.push(j);
        }
      }
    }
    for (const j of moved) {
      const a = this.anchorOf[j]!;
      if (axis === 'x') a.gx += dir;
      else a.gy += dir;
    }
  }

  /**
   * 单轴保序重映射基元：收集全部占用坐标排序后，第 k 对相邻坐标的新
   * 间距由 gapOf 给出；锚点（AABB 左上格）按映射平移，AABB 内部格跟随
   * 锚点、连续性不变。gapOf 约定返回值 ≥ 1，无重叠由构造保证。
   */
  private remapAxis(axis: 'x' | 'y', gapOf: (prev: number, cur: number) => number): void {
    const coords = new Set<number>();
    for (let i = 0; i < this.anchorOf.length; i++) {
      if (!this.anchorOf[i]) continue;
      const r = this.rectOf(i);
      const lo = axis === 'x' ? r.minX : r.minY;
      const hi = axis === 'x' ? r.maxX : r.maxY;
      for (let c = lo; c <= hi; c++) coords.add(c);
    }
    const sorted = [...coords].sort((a, b) => a - b);
    if (sorted.length <= 1) return;
    const remap = new Map<number, number>();
    let next = sorted[0]!;
    remap.set(sorted[0]!, next);
    for (let k = 1; k < sorted.length; k++) {
      next += gapOf(sorted[k - 1]!, sorted[k]!);
      remap.set(sorted[k]!, next);
    }
    for (const a of this.anchorOf) {
      if (!a) continue;
      if (axis === 'x') a.gx = remap.get(a.gx)!;
      else a.gy = remap.get(a.gy)!;
    }
  }
}

/** 边的元素对（两端为 elements/视图项下标）。 */
export interface EdgePair {
  u: number;
  v: number;
}

/** 元素 AABB 中心格（与 A* 中心格同口径：anchor + ⌊size/2⌋）。 */
function centerCellOf(g: ExpansionGrid, i: number): { x: number; y: number } {
  const a = g.anchorOf[i]!;
  const s = g.sizeOf[i]!;
  return { x: a.gx + Math.floor(s.w / 2), y: a.gy + Math.floor(s.h / 2) };
}

/** 两格之间的格直线（Bresenham，含两端点）。 */
function lineCells(from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const sx = to.x >= x ? 1 : -1;
  const sy = to.y >= y ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

/**
 * 阶段 4 膨胀后调整（消压线）：质点放置判定的连线零压线（R7）以 1×1
 * 质点为口径；膨胀使元素加宽，两端中心格的直线可能落进变宽后的第三方
 * AABB。以真实格 AABB 迭代校验：压线的第三方元素沿背离连线的方向推离
 * 1 格（nudge 级联让位），直至无压线或达到迭代上限（有界尽力；走线
 * 阶段的 A\* 避障始终兜底不穿 AABB）。skip 中的元素不参与判定
 * （subgraph 容器/容器视图项 —— 与走线障碍同口径，成员才是实体）。
 */
export function deflectEdgeCrossings(
  g: ExpansionGrid,
  edges: readonly EdgePair[],
  skip: ReadonlySet<number> = new Set(),
  maxPasses = 8,
): void {
  const n = g.anchorOf.length;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const { u, v } of edges) {
      const cells = lineCells(centerCellOf(g, u), centerCellOf(g, v));
      for (let w = 0; w < n; w++) {
        if (w === u || w === v || skip.has(w) || !g.anchorOf[w]) continue;
        const a = g.anchorOf[w]!;
        const s = g.sizeOf[w]!;
        const hit = cells.some((c) => c.x >= a.gx && c.x < a.gx + s.w && c.y >= a.gy && c.y < a.gy + s.h);
        if (!hit) continue;
        // 推离方向：w 中心相对连线 u→v 的侧向（叉积符号），沿主导法向
        // 轴推；中心恰在线上时推正方向（固定规则保确定性）。
        const p = centerCellOf(g, w);
        const cu = centerCellOf(g, u);
        const cv = centerCellOf(g, v);
        const dx = cv.x - cu.x;
        const dy = cv.y - cu.y;
        const cross = dx * (p.y - cu.y) - dy * (p.x - cu.x);
        if (Math.abs(dx) >= Math.abs(dy)) {
          g.nudge(w, 'y', cross >= 0 ? 1 : -1);
        } else {
          g.nudge(w, 'x', cross >= 0 ? 1 : -1);
        }
        moved = true;
        break; // 本边几何已变，下一轮 pass 重扫
      }
    }
    if (!moved) return;
  }
}
