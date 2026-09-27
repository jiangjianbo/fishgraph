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
 * AABB 全程完整，无重叠由构造保证。膨胀完成后做**通道约束压实**：
 * 相邻占用行/列之间的空隙压缩到恰好不小于 channelMargin 格 —— 全局
 * 紧凑的同时，相邻节点 AABB 之间天然留出走线走廊（Channel Safety
 * Margin）。
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
   * 通道约束压实：相邻占用行/列之间的空隙统一调整为恰好 margin 格 ——
   * 不足 margin 的（贴邻）扩张出走线走廊，超出 margin 的（大片空白）
   * 压缩回收。margin = 0 时全部压到贴邻。全局因此成行成列、走线走廊
   * 均匀；AABB 内部格全为占用坐标（间隔 0），重映射不影响其连续性，
   * 无重叠由构造保证。
   */
  compact(margin: number): void {
    this.compactAxis('x', margin);
    this.compactAxis('y', margin);
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

  /** 单轴压实：占用坐标重映射，相邻空隙统一为 margin 格。 */
  private compactAxis(axis: 'x' | 'y', margin: number): void {
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
    // 保序重映射：每对相邻占用坐标的空隙统一为 margin 格。
    const remap = new Map<number, number>();
    let next = sorted[0]!;
    remap.set(sorted[0]!, next);
    for (let k = 1; k < sorted.length; k++) {
      next += 1 + margin;
      remap.set(sorted[k]!, next);
    }
    for (const a of this.anchorOf) {
      if (!a) continue;
      if (axis === 'x') a.gx = remap.get(a.gx)!;
      else a.gy = remap.get(a.gy)!;
    }
  }
}
