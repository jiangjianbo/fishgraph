/** 几何工具：向量、点到线段投影、形状 SDF（带符号距离函数）。 */

import type { ShapeSpec, Vec2 } from './types.js';

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

export interface SegmentPair {
  /** 两线段最近点对与距离（端点钳制）。 */
  p1: Vec2;
  p2: Vec2;
  dist: number;
}

/** 线段 [A1,A2] 与 [B1,B2] 的最近点对（参数钳制，一次牛顿式修正）。 */
export function segmentClosestPoints(
  a1x: number, a1y: number, a2x: number, a2y: number,
  b1x: number, b1y: number, b2x: number, b2y: number,
): SegmentPair {
  const d1x = a2x - a1x;
  const d1y = a2y - a1y;
  const d2x = b2x - b1x;
  const d2y = b2y - b1y;
  const rx = a1x - b1x;
  const ry = a1y - b1y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  const EPS = 1e-9;
  let s = 0;
  if (a > EPS) s = Math.min(1, Math.max(0, -(d1x * rx + d1y * ry) / a));
  let t = 0;
  if (e > EPS) t = Math.min(1, Math.max(0, f / e));
  // 平行/退化时的一次修正
  if (a > EPS && e > EPS) {
    const t2 = Math.min(1, Math.max(0, (t * (d2x * d1x + d2y * d1y) + f) / e));
    const s2 = Math.min(1, Math.max(0, (s * a - t2 * (d2x * d1x + d2y * d1y)) / a));
    s = s2;
    t = t2;
  }
  const p1 = { x: a1x + d1x * s, y: a1y + d1y * s };
  const p2 = { x: b1x + d2x * t, y: b1y + d2y * t };
  return { p1, p2, dist: Math.hypot(p1.x - p2.x, p1.y - p2.y) };
}
