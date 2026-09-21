/**
 * ContinuousSpaceContext —— 连续平面空间上下文（SpaceContext<number> 的
 * 浮点实现）。
 *
 * 坐标为像素/浮点；度量用欧氏距离，碰撞用连续 AABB（半开区间口径，
 * 相切不算重叠）。连续空间无限，expandSpaceIfNeeded 恒为空操作；
 * routeEdge 当前为直线降级 —— 完整的连续避障走线（可见性图 / 贝塞尔）
 * 属走线层的后续工作。应用场景：以网格解为初始解，在同一套算法原语上
 * 做短程力学弛豫（5~10 步），生成平滑的自由坐标布局。
 */

import type { Box, Bounds, Point, SpaceContext } from './types.js';

export class ContinuousSpaceContext implements SpaceContext<number> {
  readonly kind = 'continuous' as const;

  distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  isOverlapped(posA: Point, sizeA: Bounds, posB: Point, sizeB: Bounds): boolean {
    return (
      posA.x < posB.x + sizeB.width &&
      posB.x < posA.x + sizeA.width &&
      posA.y < posB.y + sizeB.height &&
      posB.y < posA.y + sizeA.height
    );
  }

  /** 8 方向单位矢量 × step（右、左、下、上、右下、左下、右上、左上，序固定）。 */
  getNeighbors(current: Point, step: number): Point[] {
    return [
      { x: current.x + step, y: current.y },
      { x: current.x - step, y: current.y },
      { x: current.x, y: current.y + step },
      { x: current.x, y: current.y - step },
      { x: current.x + step, y: current.y + step },
      { x: current.x - step, y: current.y + step },
      { x: current.x + step, y: current.y - step },
      { x: current.x - step, y: current.y - step },
    ];
  }

  /** 连续空间无限，无需扩容。 */
  expandSpaceIfNeeded(_pos: Point, _size: Bounds): boolean {
    return false;
  }

  /** 直线降级：完整连续避障走线属走线层后续工作。 */
  routeEdge(source: Point, target: Point, _obstacles: Box[] = []): Point[] {
    return [{ ...source }, { ...target }];
  }
}
