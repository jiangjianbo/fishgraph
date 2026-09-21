import { describe, expect, it } from 'vitest';
import { ContinuousSpaceContext } from '../src/layout/space/continuous-context.js';
import { GridSpaceContext } from '../src/layout/space/grid-context.js';
import { gridRouteAStar } from '../src/layout/space/grid-route.js';
import type { Box, Bounds, Point } from '../src/layout/space/types.js';

/** 遍历折线路径覆盖的全部格（相邻拐点之间为共线直线段）。 */
function pathCells(path: Point[]): Set<string> {
  const cells = new Set<string>();
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    expect(dx === 0 || dy === 0).toBe(true); // 正交：每段只沿一个轴
    let { x, y } = a;
    cells.add(`${x},${y}`);
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      cells.add(`${x},${y}`);
    }
  }
  return cells;
}

describe('GridSpaceContext（离散网格上下文）', () => {
  it('距离度量 = 曼哈顿 |dx|+|dy|', () => {
    const g = new GridSpaceContext();
    expect(g.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
    expect(g.distance({ x: -1, y: -2 }, { x: -4, y: -6 })).toBe(7);
  });

  it('碰撞检测：半开区间 —— 相交重叠、相切不重叠、分离不重叠', () => {
    const g = new GridSpaceContext();
    const s: Bounds = { width: 2, height: 2 };
    expect(g.isOverlapped({ x: 0, y: 0 }, s, { x: 1, y: 1 }, s)).toBe(true);
    expect(g.isOverlapped({ x: 0, y: 0 }, s, { x: 2, y: 0 }, s)).toBe(false); // 相切
    expect(g.isOverlapped({ x: 0, y: 0 }, s, { x: 5, y: 5 }, s)).toBe(false);
    expect(g.isOverlapped({ x: 1, y: 1 }, s, { x: 0, y: 0 }, s)).toBe(true); // 对称
  });

  it('邻域步进：4 邻域且顺序固定', () => {
    const g = new GridSpaceContext();
    expect(g.getNeighbors({ x: 10, y: 20 }, 3)).toEqual([
      { x: 13, y: 20 },
      { x: 7, y: 20 },
      { x: 10, y: 23 },
      { x: 10, y: 17 },
    ]);
  });

  it('occupy/isAreaFree：AABB 多格占位与区域空闲判定', () => {
    const g = new GridSpaceContext();
    expect(g.isAreaFree({ x: 0, y: 0 }, { width: 3, height: 3 })).toBe(true);
    g.occupy({ x: 1, y: 1 }, { width: 2, height: 1 });
    expect(g.isOccupied(1, 1)).toBe(true);
    expect(g.isOccupied(2, 1)).toBe(true);
    expect(g.isOccupied(3, 1)).toBe(false);
    expect(g.isAreaFree({ x: 0, y: 0 }, { width: 3, height: 3 })).toBe(false);
    expect(g.isAreaFree({ x: 3, y: 1 }, { width: 2, height: 1 })).toBe(true);
  });

  it('expandSpaceIfNeeded：空区域不扩容；阻塞格沿最短出边被推出且其余格整体平移', () => {
    const g = new GridSpaceContext();
    const area = { x: 0, y: 0 };
    const size = { width: 2, height: 2 };
    expect(g.expandSpaceIfNeeded(area, size)).toBe(false);

    // 阻塞格 (1,1)：距右缘 0 最近 → 右推一列
    g.occupy({ x: 1, y: 1 }, { width: 1, height: 1 });
    g.occupy({ x: 5, y: 0 }, { width: 1, height: 1 }); // 区域外，但 gx≥1 会被一起平移
    expect(g.expandSpaceIfNeeded(area, size)).toBe(true);
    expect(g.isAreaFree(area, size)).toBe(true);
    expect(g.isOccupied(2, 1)).toBe(true);
    expect(g.isOccupied(6, 0)).toBe(true);
    expect(g.isOccupied(1, 1)).toBe(false);

    // 阻塞格 (0,0)：距左缘 0 最近 → 左推一列
    expect(g.expandSpaceIfNeeded({ x: 0, y: 0 }, { width: 2, height: 2 })).toBe(false);
    g.occupy({ x: 0, y: 0 }, { width: 1, height: 1 });
    expect(g.expandSpaceIfNeeded({ x: 0, y: 0 }, { width: 2, height: 2 })).toBe(true);
    expect(g.isOccupied(-1, 0)).toBe(true);
    expect(g.isAreaFree({ x: 0, y: 0 }, { width: 2, height: 2 })).toBe(true);
  });

  it('insertLine：at 处插行/列，dir 侧占用格整体平移', () => {
    const g = new GridSpaceContext();
    g.occupy({ x: 3, y: 0 }, { width: 1, height: 2 });
    g.occupy({ x: 0, y: 0 }, { width: 1, height: 1 });
    g.insertLine('x', 2, 1);
    expect(g.isOccupied(4, 0)).toBe(true);
    expect(g.isOccupied(4, 1)).toBe(true);
    expect(g.isOccupied(0, 0)).toBe(true);
    expect(g.isOccupied(3, 0)).toBe(false);
  });

  it('routeEdge：无障碍走直线；单障碍绕行且全程不穿障碍格', () => {
    const g = new GridSpaceContext();
    expect(g.routeEdge({ x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);

    // 横向障碍墙 (0..2, 1)：从 (0,0) 到 (2,2) 必须绕行
    const wall: Box = { x: 0, y: 1, width: 3, height: 1 };
    const path = g.routeEdge({ x: 0, y: 0 }, { x: 2, y: 2 }, [wall])!;
    expect(path).not.toBeNull();
    const cells = pathCells(path);
    for (let gx = 0; gx < 3; gx++) {
      expect(cells.has(`${gx},1`)).toBe(false); // 不穿障碍
    }
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 2, y: 2 });
    expect(cells.size).toBeLessThanOrEqual(4 + 3); // 绕行走短路：不超 6 步 + 起点重复
  });

  it('routeEdge：拐点惩罚生效 —— 无障碍时偏好拐点最少的单调路径', () => {
    const g = new GridSpaceContext({ turnCost: 5 });
    const path = g.routeEdge({ x: 0, y: 0 }, { x: 4, y: 4 })!;
    // 最优 = 一步水平 + 一步垂直（1 个拐点）→ 压缩后 3 点
    expect(path.length).toBe(3);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 4 });
  });

  it('routeEdge：环形障碍封死目标 → 显式返回 null（不静默降级）', () => {
    const g = new GridSpaceContext();
    // 5x5 环把 (10,10) 围死（只留中心空格，四周全封）
    const ring: Box[] = [];
    for (let i = 8; i <= 12; i++) {
      ring.push({ x: i, y: 8, width: 1, height: 1 });
      ring.push({ x: i, y: 12, width: 1, height: 1 });
      ring.push({ x: 8, y: i, width: 1, height: 1 });
      ring.push({ x: 12, y: i, width: 1, height: 1 });
    }
    expect(g.routeEdge({ x: 0, y: 0 }, { x: 10, y: 10 }, ring)).toBeNull();
  });

  it('gridRouteAStar：端点落在障碍内仍可出发（端点豁免）', () => {
    const obstacle: Box = { x: 0, y: 0, width: 3, height: 1 };
    const path = gridRouteAStar({ x: 1, y: 0 }, { x: 1, y: 3 }, [obstacle])!;
    expect(path[0]).toEqual({ x: 1, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 1, y: 3 });
    const cells = pathCells(path);
    for (const c of cells) {
      const [gx, gy] = c.split(',').map(Number);
      if (gy === 0) expect(gx === 1).toBe(true); // 障碍行上只允许端点自身
    }
  });
});

describe('ContinuousSpaceContext（连续平面上下文）', () => {
  it('距离度量 = 欧氏 √(dx²+dy²)', () => {
    const c = new ContinuousSpaceContext();
    expect(c.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 12);
  });

  it('碰撞检测：连续 AABB 半开区间口径', () => {
    const c = new ContinuousSpaceContext();
    const s: Bounds = { width: 10, height: 10 };
    expect(c.isOverlapped({ x: 0, y: 0 }, s, { x: 9.9, y: 0 }, s)).toBe(true);
    expect(c.isOverlapped({ x: 0, y: 0 }, s, { x: 10, y: 0 }, s)).toBe(false); // 相切
    expect(c.isOverlapped({ x: 0, y: 0 }, s, { x: 20, y: 20 }, s)).toBe(false);
  });

  it('邻域步进：8 方向 × step', () => {
    const c = new ContinuousSpaceContext();
    expect(c.getNeighbors({ x: 0, y: 0 }, 2)).toEqual([
      { x: 2, y: 0 },
      { x: -2, y: 0 },
      { x: 0, y: 2 },
      { x: 0, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 },
      { x: 2, y: -2 },
      { x: -2, y: -2 },
    ]);
  });

  it('expandSpaceIfNeeded：连续空间无限，恒不扩容', () => {
    const c = new ContinuousSpaceContext();
    expect(c.expandSpaceIfNeeded({ x: 0, y: 0 }, { width: 5, height: 5 })).toBe(false);
  });

  it('routeEdge：直线降级（首尾为端点）', () => {
    const c = new ContinuousSpaceContext();
    const obstacle: Box = { x: 1, y: -1, width: 2, height: 2 };
    expect(c.routeEdge({ x: 0, y: 0 }, { x: 4, y: 0 }, [obstacle])).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('两种上下文实现同一 SpaceContext 接口', () => {
    const contexts = [new GridSpaceContext(), new ContinuousSpaceContext()];
    for (const ctx of contexts) {
      expect(['grid', 'continuous']).toContain(ctx.kind);
      expect(typeof ctx.distance({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe('number');
      expect(
        ctx.isOverlapped({ x: 0, y: 0 }, { width: 2, height: 2 }, { x: 1, y: 1 }, { width: 2, height: 2 }),
      ).toBe(true);
      expect(ctx.getNeighbors({ x: 0, y: 0 }, 1).length).toBeGreaterThan(0);
      expect(Array.isArray(ctx.routeEdge({ x: 0, y: 0 }, { x: 2, y: 2 }))).toBe(true);
    }
  });
});
