/**
 * 膨胀网格（Expansion Grid）—— grid-first 流水线的阶段 3 载体。
 *
 * 在质点网格放置（coarseGridPlacement）的产物之上，把每个 1×1 质点
 * 逐个「轴向膨胀」为 W×H 格的 AABB 包围盒：锚点不动，向右/向下扩张，
 * 扩张所需的每一列/行通过「插列/插行」把该侧已占用格整体平移让位
 * （与粗布局的死锁插行列同一思想）。膨胀完成后做**通道约束压实**：
 * 相邻占用行/列之间的空隙压缩到恰好不小于 channelMargin 格 —— 全局
 * 紧凑的同时，相邻节点 AABB 之间天然留出走线走廊（Channel Safety
 * Margin）。所有操作保序、保 AABB 连续性，无重叠由构造保证。
 */

import type { Box } from '../space/types.js';

const key = (gx: number, gy: number): string => `${gx},${gy}`;

export class ExpansionGrid {
  /** 元素锚点（AABB 左上格，下标 = elements 下标）。 */
  readonly anchorOf: Array<{ gx: number; gy: number }>;
  /** 元素 AABB 格尺寸（初始 1×1 质点）。 */
  readonly sizeOf: Array<{ w: number; h: number }>;
  /** 覆盖格 → 元素下标（每格至多属于一个 AABB）。 */
  private covered = new Map<string, number>();

  constructor(n: number) {
    this.anchorOf = new Array(n);
    this.sizeOf = Array.from({ length: n }, () => ({ w: 1, h: 1 }));
  }

  /** 锚定质点（放置产物，1×1）。 */
  place(i: number, gx: number, gy: number): void {
    this.anchorOf[i] = { gx, gy };
    this.covered.set(key(gx, gy), i);
  }

  /**
   * 把元素 i 从 1×1 质点膨胀为 w×h 格 AABB：先释放自身覆盖格，再向
   * 右插 w−1 列、向下插 h−1 行（其他元素整体让位），最后标记自身覆盖。
   */
  expand(i: number, w: number, h: number): void {
    const a = this.anchorOf[i]!;
    this.covered.delete(key(a.gx, a.gy));
    for (let d = 1; d < w; d++) this.shiftLine('x', a.gx + 1, 1);
    for (let d = 1; d < h; d++) this.shiftLine('y', a.gy + 1, 1);
    this.sizeOf[i] = { w, h };
    for (let gx = a.gx; gx < a.gx + w; gx++) {
      for (let gy = a.gy; gy < a.gy + h; gy++) {
        this.covered.set(key(gx, gy), i);
      }
    }
  }

  /**
   * 通道约束压实：相邻占用行/列之间的空隙统一调整为恰好 margin 格 ——
   * 不足 margin 的（贴邻）扩张出走线走廊（扫描插入空行/空列），超出
   * margin 的（大片空白）压缩回收。margin = 0 时全部压到贴邻。
   * 全局因此成行成列、走线走廊均匀；AABB 内部格全为占用列（间隔 0），
   * 重映射不影响其连续性，无重叠由构造保证。
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

  /**
   * 插行/插列：at 处开辟新行/列，dir=+1 把坐标 ≥ at 的占用格与锚点
   * 整体 +1（dir=-1 反向）。纯平移不改变相对位置与 AABB 连续性。
   */
  private shiftLine(axis: 'x' | 'y', at: number, dir: 1 | -1): void {
    const moved = new Map<string, number>();
    for (const [k, idx] of this.covered) {
      const [gx, gy] = k.split(',').map(Number);
      const c = axis === 'x' ? gx : gy;
      const nc = dir === 1 ? (c >= at ? c + 1 : c) : c <= at ? c - 1 : c;
      moved.set(axis === 'x' ? key(nc, gy) : key(gx, nc), idx);
    }
    this.covered = moved;
    for (const a of this.anchorOf) {
      if (!a) continue;
      const c = axis === 'x' ? a.gx : a.gy;
      if (dir === 1 ? c >= at : c <= at) {
        if (axis === 'x') a.gx += dir;
        else a.gy += dir;
      }
    }
  }

  /** 单轴压实：占用坐标重映射，相邻空隙统一为 margin 格。 */
  private compactAxis(axis: 'x' | 'y', margin: number): void {
    const coords = new Set<number>();
    for (const k of this.covered.keys()) {
      const [gx, gy] = k.split(',').map(Number);
      coords.add(axis === 'x' ? gx : gy);
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
    const moved = new Map<string, number>();
    for (const [k, idx] of this.covered) {
      const [gx, gy] = k.split(',').map(Number);
      moved.set(axis === 'x' ? key(remap.get(gx)!, gy) : key(gx, remap.get(gy)!), idx);
    }
    this.covered = moved;
    for (const a of this.anchorOf) {
      if (!a) continue;
      if (axis === 'x') a.gx = remap.get(a.gx)!;
      else a.gy = remap.get(a.gy)!;
    }
  }
}
