/** 几何工具：向量、点到线段投影、形状 SDF（带符号距离函数）。 */

import type { ShapeSpec } from './types.js';

export interface ClosestPoint {
  x: number;
  y: number;
  /** 投影参数 t ∈ [0,1]，Q = A + t·(B−A)。 */
  t: number;
}

/** 点 P 到线段 [A,B] 的最近点（含重心坐标 t，用于把反作用力分摊给端点）。 */
export function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): ClosestPoint {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: ax + abx * t, y: ay + aby * t, t };
}

export interface SdfSample {
  /** 有符号距离：外部为正，内部为负。 */
  dist: number;
  /** SDF 梯度方向（单位向量，指向"更远/向外"）。 */
  gx: number;
  gy: number;
}

/** 圆的 SDF。 */
export function sdfCircle(dx: number, dy: number, r: number): SdfSample {
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { dist: -r, gx: 1, gy: 0 };
  return { dist: d - r, gx: dx / d, gy: dy / d };
}

/** 轴对齐矩形的精确 SDF（中心在原点，半宽 hw、半高 hh）。 */
export function sdfRect(dx: number, dy: number, hw: number, hh: number): SdfSample {
  const qx = Math.abs(dx) - hw;
  const qy = Math.abs(dy) - hh;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const outside = Math.hypot(ox, oy);
  const dist = outside + Math.min(Math.max(qx, qy), 0);
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  if (outside > 1e-9) {
    return { dist, gx: (ox * sx) / outside, gy: (oy * sy) / outside };
  }
  // 在矩形内部：沿更靠近边界的轴推出。
  return qx >= qy ? { dist, gx: sx, gy: 0 } : { dist, gx: 0, gy: sy };
}

/**
 * 椭圆 SDF 的近似（径向缩放）：dist ≈ (|(dx/rx, dy/ry)| − 1) × min(rx, ry)。
 * 梯度取归一化的 (dx/rx², dy/ry²)。对力的计算而言精度足够。
 */
export function sdfEllipse(dx: number, dy: number, rx: number, ry: number): SdfSample {
  const qx = dx / rx;
  const qy = dy / ry;
  const q = Math.hypot(qx, qy);
  const dist = (q - 1) * Math.min(rx, ry);
  const gx0 = dx / (rx * rx);
  const gy0 = dy / (ry * ry);
  const g = Math.hypot(gx0, gy0);
  if (g < 1e-9) return { dist, gx: 1, gy: 0 };
  return { dist, gx: gx0 / g, gy: gy0 / g };
}

/** 任意形状的 SDF，dx/dy 为相对形状中心的偏移。 */
export function shapeSdf(shape: ShapeSpec, dx: number, dy: number): SdfSample {
  switch (shape.kind) {
    case 'circle':
      return sdfCircle(dx, dy, shape.r);
    case 'ellipse':
      return sdfEllipse(dx, dy, shape.rx, shape.ry);
    case 'rect':
      return sdfRect(dx, dy, shape.w / 2, shape.h / 2);
  }
}

/** 节点-节点力用的包围圆半径（矩形取半对角线，椭圆取长轴）。 */
export function boundingRadius(shape: ShapeSpec): number {
  switch (shape.kind) {
    case 'circle':
      return shape.r;
    case 'ellipse':
      return Math.max(shape.rx, shape.ry);
    case 'rect':
      return Math.hypot(shape.w, shape.h) / 2;
  }
}

export const DEFAULT_SHAPE: ShapeSpec = { kind: 'circle', r: 10 };
