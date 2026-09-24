/**
 * 测试通用工具 —— 单一实现，供各测试文件导入。
 *
 * 维护约定：布局口径变化时只改本文件（例如表面间隙口径跟随
 * `forces.surfaceGap`），禁止在各测试文件内复制粘贴副本 ——
 * 多头副本曾在口径变更时造成漏改返工。
 */

import { expect } from 'vitest';
import { registerCoordinateSystem } from '../src/index.js';
import type { ForceLayout } from '../src/index.js';

/**
 * 物理节点两两最小表面间隙（nodeViews 只含物理节点，天然不含容器）。
 * 与 `forces.surfaceGap` 同一口径：圆-圆对用圆间隙，其余组合用外接矩形
 * （分离 = 最短表面距离，重叠 = 负的浅轴穿透深度）。
 */
export function minSurfaceGap(layout: ForceLayout): number {
  const nodes = layout.nodeViews;
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i]!.x - nodes[j]!.x;
      const dy = nodes[i]!.y - nodes[j]!.y;
      let gap: number;
      if (nodes[i]!.shape.kind === 'circle' && nodes[j]!.shape.kind === 'circle') {
        gap = Math.hypot(dx, dy) - nodes[i]!.r - nodes[j]!.r;
      } else {
        const sx = Math.abs(dx) - nodes[i]!.hw - nodes[j]!.hw;
        const sy = Math.abs(dy) - nodes[i]!.hh - nodes[j]!.hh;
        gap = sx > 0 || sy > 0 ? Math.hypot(Math.max(sx, 0), Math.max(sy, 0)) : -Math.min(-sx, -sy);
      }
      if (gap < min) min = gap;
    }
  }
  return min;
}

/** 断言全部元素坐标有限（非 NaN/Inf），消息携带元素 id 便于定位。 */
export function assertAllFinite(layout: ForceLayout): void {
  for (const [id, p] of layout.positions) {
    expect(Number.isFinite(p.x), `x of ${String(id)} not finite: ${p.x}`).toBe(true);
    expect(Number.isFinite(p.y), `y of ${String(id)} not finite: ${p.y}`).toBe(true);
  }
}

/**
 * identity 坐标系（幂等注册）：恒等修正，保持弛豫终点坐标。
 *
 * 物理与几何基线测试（方向顺流、零穿越、自然构型、平衡距离等）断言的
 * 是求解器行为，应通过本坐标系隔离「布局终点坐标修正」层 —— 默认已
 * 网格化吸附（坐标全落格点、格距不小于最大直径），连续几何断言在格点
 * 上不成立。返回注册名，直接放进 LayoutOptions.coordinateSystem。
 */
export function useIdentityCoordinateSystem(): 'identity' {
  registerCoordinateSystem('identity', () => ({
    name: 'identity',
    refine() {
      // 恒等：不做任何修正
    },
  }));
  return 'identity';
}
