/**
 * GridSpaceContext —— 离散网格空间上下文（SpaceContext<number> 的网格实现）。
 *
 * 坐标为整数格下标；AABB 占据 [x, x+w) × [y, y+h) 的格区间（半开，相切
 * 不算重叠）。内部维护一张占用表（布局流水线把节点 AABB 标记进来），
 * expandSpaceIfNeeded 在空间不足时插入行/列，把该侧已占用格整体平移让位
 * —— 与粗布局的死锁插行列（coarse.ts insertLine）同一思想，但服务于
 * 「AABB 多格占位」的膨胀语义。
 */

import type { Box, Bounds, Point, SpaceContext } from './types.js';
import { gridRouteAStar, type GridRouteOptions } from './grid-route.js';

/** 上下文可调项（当前仅寻路参数）。 */
export type GridSpaceOptions = GridRouteOptions;

export class GridSpaceContext implements SpaceContext<number> {
  readonly kind = 'grid' as const;

  /** 占用格集合（键 "gx,gy"；布局流水线经 occupy/insertLine 维护）。 */
  private occ = new Set<string>();
  /** 占用包围盒（无占用时 min > max）。 */
  minGx = Infinity;
  maxGx = -Infinity;
  minGy = Infinity;
  maxGy = -Infinity;

  constructor(private routeOptions: GridSpaceOptions = {}) {}

  // ── 占用表管理（布局流水线 API）────────────────────────

  /** 格 (gx, gy) 是否被占用。 */
  isOccupied(gx: number, gy: number): boolean {
    return this.occ.has(`${gx},${gy}`);
  }

  /** 目标 AABB 区域是否完全空闲。 */
  isAreaFree(pos: Point, size: Bounds): boolean {
    for (let gx = pos.x; gx < pos.x + size.width; gx++) {
      for (let gy = pos.y; gy < pos.y + size.height; gy++) {
        if (this.occ.has(`${gx},${gy}`)) return false;
      }
    }
    return true;
  }

  /** 把 AABB 覆盖的全部格标记为占用。 */
  occupy(pos: Point, size: Bounds): void {
    for (let gx = pos.x; gx < pos.x + size.width; gx++) {
      for (let gy = pos.y; gy < pos.y + size.height; gy++) {
        this.mark(gx, gy);
      }
    }
  }

  /**
   * 在坐标 at 处插入一行（axis='y'）或一列（axis='x'）：dir=+1 把
   * 坐标 ≥ at 的占用格整体 +1，dir=-1 把坐标 ≤ at 的占用格整体 -1。
   * 纯平移不改变相对位置，用于腾出新行/列。
   */
  insertLine(axis: 'x' | 'y', at: number, dir: 1 | -1): void {
    const moved = new Set<string>();
    for (const key of this.occ) {
      const [gx, gy] = key.split(',').map(Number);
      if (axis === 'x') {
        moved.add(dir === 1 ? (gx >= at ? `${gx + 1},${gy}` : key) : gx <= at ? `${gx - 1},${gy}` : key);
      } else {
        moved.add(dir === 1 ? (gy >= at ? `${gx},${gy + 1}` : key) : gy <= at ? `${gx},${gy - 1}` : key);
      }
    }
    this.occ = moved;
    this.recomputeBounds();
  }

  // ── SpaceContext 原语 ──────────────────────────────────

  distance(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  isOverlapped(posA: Point, sizeA: Bounds, posB: Point, sizeB: Bounds): boolean {
    return (
      posA.x < posB.x + sizeB.width &&
      posB.x < posA.x + sizeA.width &&
      posA.y < posB.y + sizeB.height &&
      posB.y < posA.y + sizeA.height
    );
  }

  /** 4 邻域（右、左、下、上，序固定）。 */
  getNeighbors(current: Point, step: number): Point[] {
    return [
      { x: current.x + step, y: current.y },
      { x: current.x - step, y: current.y },
      { x: current.x, y: current.y + step },
      { x: current.x, y: current.y - step },
    ];
  }

  /**
   * 保证目标 AABB 可用：区域内有占用格时，把「离区域边缘最近」的占用格
   * 沿最短出边方向经 insertLine 推出区域，重复直到区域全空。
   * 平局与扫描序固定（y 升序 → x 升序；出边序 左→右→上→下），确定性。
   */
  expandSpaceIfNeeded(pos: Point, size: Bounds): boolean {
    let expanded = false;
    for (;;) {
      let blocked: Point | null = null;
      for (let gy = pos.y; gy < pos.y + size.height && blocked === null; gy++) {
        for (let gx = pos.x; gx < pos.x + size.width; gx++) {
          if (this.occ.has(`${gx},${gy}`)) {
            blocked = { x: gx, y: gy };
            break;
          }
        }
      }
      if (blocked === null) return expanded;
      // 选最短出边：左缘 / 右缘 / 上缘 / 下缘（平局按此固定序）。
      const dLeft = blocked.x - pos.x;
      const dRight = pos.x + size.width - 1 - blocked.x;
      const dTop = blocked.y - pos.y;
      const dBottom = pos.y + size.height - 1 - blocked.y;
      const dMin = Math.min(dLeft, dRight, dTop, dBottom);
      if (dMin === dLeft) {
        this.insertLine('x', blocked.x, -1);
      } else if (dMin === dRight) {
        this.insertLine('x', blocked.x, 1);
      } else if (dMin === dTop) {
        this.insertLine('y', blocked.y, -1);
      } else {
        this.insertLine('y', blocked.y, 1);
      }
      expanded = true;
    }
  }

  /** A* 正交寻路（障碍 = obstacles 栅格化；详情见 grid-route.ts）。 */
  routeEdge(source: Point, target: Point, obstacles: Box[] = []): Point[] | null {
    return gridRouteAStar(source, target, obstacles, this.routeOptions);
  }

  // ── 内部 ───────────────────────────────────────────────

  private mark(gx: number, gy: number): void {
    this.occ.add(`${gx},${gy}`);
    this.minGx = Math.min(this.minGx, gx);
    this.maxGx = Math.max(this.maxGx, gx);
    this.minGy = Math.min(this.minGy, gy);
    this.maxGy = Math.max(this.maxGy, gy);
  }

  private recomputeBounds(): void {
    this.minGx = Infinity;
    this.maxGx = -Infinity;
    this.minGy = Infinity;
    this.maxGy = -Infinity;
    for (const key of this.occ) {
      const [gx, gy] = key.split(',').map(Number);
      this.minGx = Math.min(this.minGx, gx);
      this.maxGx = Math.max(this.maxGx, gx);
      this.minGy = Math.min(this.minGy, gy);
      this.maxGy = Math.max(this.maxGy, gy);
    }
  }
}
