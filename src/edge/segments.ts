/**
 * 路径段几何工具：段终点 / 弧长 / 弧上取点 / 贝塞尔取点 / 段长量取。
 * corners、crossings、renderer 共用的段模型语义，独立于任何策略实现。
 */

import type { Vec2 } from '../types.js';
import type { PathSegment } from './types.js';

export type ArcSegment = Extract<PathSegment, { kind: 'arc' }>;
export type BezierSegment = Extract<PathSegment, { kind: 'bezier' }>;

/** 段终点（arc 由圆心 + 末端角给出；line/bezier 即 to）。 */
export function segmentEnd(seg: PathSegment): Vec2 {
  if (seg.kind === 'arc') return arcPoint(seg, 1);
  return seg.to;
}

/** 弧的扫过角（0..2π，依 ccw 行进方向）。 */
export function arcSweep(seg: ArcSegment): number {
  const TAU = Math.PI * 2;
  let delta = (seg.endAngle - seg.startAngle) % TAU;
  if (delta < 0) delta += TAU;
  return seg.ccw ? TAU - delta : delta;
}

/** 弧上按行进方向的比例 t ∈ [0,1] 处的点。 */
export function arcPoint(seg: ArcSegment, t: number): Vec2 {
  const angle = seg.startAngle + arcSweep(seg) * (seg.ccw ? -t : t);
  return { x: seg.center.x + seg.radius * Math.cos(angle), y: seg.center.y + seg.radius * Math.sin(angle) };
}

/** 三次贝塞尔上参数 t 处的点。 */
export function bezierPoint(from: Vec2, seg: BezierSegment, t: number): Vec2 {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * from.x + w1 * seg.cp1.x + w2 * seg.cp2.x + w3 * seg.to.x,
    y: w0 * from.y + w1 * seg.cp1.y + w2 * seg.cp2.y + w3 * seg.to.y,
  };
}

/** 段长（arc 按弧长、bezier 按弦长与控制多边长的平均、line 按欧氏长）。 */
export function segmentLength(from: Vec2, seg: PathSegment): number {
  if (seg.kind === 'line') return Math.hypot(seg.to.x - from.x, seg.to.y - from.y);
  if (seg.kind === 'bezier') {
    const chord = Math.hypot(seg.to.x - from.x, seg.to.y - from.y);
    const poly =
      Math.hypot(seg.cp1.x - from.x, seg.cp1.y - from.y) +
      Math.hypot(seg.cp2.x - seg.cp1.x, seg.cp2.y - seg.cp1.y) +
      Math.hypot(seg.to.x - seg.cp2.x, seg.to.y - seg.cp2.y);
    return (chord + poly) / 2;
  }
  return seg.radius * arcSweep(seg);
}

/** 路径总长。 */
export function pathLength(path: { start: Vec2; segments: readonly PathSegment[] }): number {
  let total = 0;
  let from = path.start;
  for (const seg of path.segments) {
    total += segmentLength(from, seg);
    from = segmentEnd(seg);
  }
  return total;
}
