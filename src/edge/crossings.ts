/**
 * 交叉风格策略实现。
 *
 * 平交：不做任何处理（后画盖前画，即现状画法）。
 * 立交：按绘制序，本边与"先画边"的直线段求交，在每个交点处断开本边、
 * 以半圆跳线弧跨过 —— 视觉上本边从上方跨越（跳弧恒走行进方向同一侧，
 * 规则固定 → 确定性）。曲线段不参与求交（限制：跳线只发生在直线上）。
 */

import type { Vec2 } from '../types.js';
import type { CrossingStrategy, EdgePath, PathSegment } from './types.js';
import { segmentEnd } from './segments.js';

/** 平交：恒等变换。 */
export class PlainCrossingStrategy implements CrossingStrategy {
  readonly name = 'plain';

  apply(path: EdgePath, _others: readonly EdgePath[]): EdgePath {
    return path;
  }
}

/** 本边线段与另一边线段的内部交点（参数 t ∈ (0,1)，端点/平行不算）。 */
interface Crossing {
  segIndex: number;
  t: number;
  point: Vec2;
}

/** 立交（跳线桥）：交点处断开并画半圆弧。 */
export class BridgeCrossingStrategy implements CrossingStrategy {
  readonly name = 'bridge';

  constructor(
    /** 跳线半径（布局坐标，默认 4）。 */
    private gap = 4,
  ) {}

  apply(path: EdgePath, others: readonly EdgePath[]): EdgePath {
    const crossings = collectCrossings(path, others);
    if (crossings.length === 0) return path;

    // 按本边线段序、段内参数排序；同段相邻跳点过近时丢弃后者。
    crossings.sort((p, q) => p.segIndex - q.segIndex || p.t - q.t);
    const perSeg = groupBySeg(crossings, this.gap * 2);
    const out: PathSegment[] = [];
    let cur = path.start;
    let lineIndex = -1;
    for (const seg of path.segments) {
      if (seg.kind !== 'line') {
        out.push(seg);
        cur = segmentEnd(seg);
        continue;
      }
      lineIndex++;
      const hops = perSeg.get(lineIndex) ?? [];
      const len = Math.hypot(seg.to.x - cur.x, seg.to.y - cur.y);
      const dx = (seg.to.x - cur.x) / (len || 1);
      const dy = (seg.to.y - cur.y) / (len || 1);      for (const hop of hops) {
        const before = { x: hop.point.x - dx * this.gap, y: hop.point.y - dy * this.gap };
        const after = { x: hop.point.x + dx * this.gap, y: hop.point.y + dy * this.gap };
        // 交点离段起/终点（或前一跳）太近，跳弧放不下 —— 退化为直行。
        if (dist(before, cur) < this.gap || len - hop.t * len < this.gap) continue;
        pushLine(out, cur, before);
        out.push({
          kind: 'arc',
          center: hop.point,
          radius: this.gap,
          startAngle: Math.atan2(before.y - hop.point.y, before.x - hop.point.x),
          endAngle: Math.atan2(after.y - hop.point.y, after.x - hop.point.x),
          ccw: hopCcw(dx, dy),
        });
        cur = after;
      }
      pushLine(out, cur, seg.to);
      cur = seg.to;
    }
    return { start: path.start, segments: out };
  }
}

/** 收集本边 line 段与其它边 line 段的全部内部交点。 */
function collectCrossings(path: EdgePath, others: readonly EdgePath[]): Crossing[] {
  const mine = lineSegments(path);
  const result: Crossing[] = [];
  const theirs = others.flatMap((p) => lineSegments(p));
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i]!;
    for (const b of theirs) {
      const hit = segmentIntersection(a.a, a.b, b.a, b.b);
      if (hit) result.push({ segIndex: i, t: hit.t, point: hit.p });
    }
  }
  return result;
}

type Segment = { a: Vec2; b: Vec2 };

/** 展开路径中的直线段（起点追踪）。曲线段本身不参与求交，但需推进起点。 */
function lineSegments(path: EdgePath): Segment[] {
  const segs: Segment[] = [];
  let cur = path.start;
  for (const seg of path.segments) {
    if (seg.kind === 'line') {
      segs.push({ a: cur, b: seg.to });
      cur = seg.to;
    } else if (seg.kind === 'bezier') {
      cur = seg.to;
    } else {
      // arc 段终点 = 圆心 + 半径 × 末端角（圆角/跳线弧端点均在圆上）
      cur = {
        x: seg.center.x + seg.radius * Math.cos(seg.endAngle),
        y: seg.center.y + seg.radius * Math.sin(seg.endAngle),
      };
    }
  }
  return segs;
}

/** 两线段内部交点：参数式求解，平行或端点相触返回 null。 */
function segmentIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): { t: number; p: Vec2 } | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1.x - a1.x) * sy - (b1.y - a1.y) * sx) / denom;
  const u = ((b1.x - a1.x) * ry - (b1.y - a1.y) * rx) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { t, p: { x: a1.x + rx * t, y: a1.y + ry * t } };
}

/** 按 segIndex 分组并剔除同段过近的相邻跳点（沿线距离 < minDist）。 */
function groupBySeg(crossings: readonly Crossing[], minDist: number): Map<number, Crossing[]> {
  const map = new Map<number, Crossing[]>();
  for (const c of crossings) {
    const list = map.get(c.segIndex);
    const prev = list?.[list.length - 1];
    if (prev && Math.hypot(c.point.x - prev.point.x, c.point.y - prev.point.y) < minDist) continue;
    if (list) list.push(c);
    else map.set(c.segIndex, [c]);
  }
  return map;
}

/** 跳线弧方向：半圆恒走行进方向左侧（y 减小侧），规则固定。 */
function hopCcw(dx: number, dy: number): boolean {
  // start = angle(-d)、end = angle(+d)；经过 left = (dy, -dx) 的半圆
  // 对应「角度增加」路径 —— 即 canvas 语义 ccw=false。
  const start = Math.atan2(-dy, -dx);
  const end = Math.atan2(dy, dx);
  const mid = Math.atan2(-dx, dy);
  return !onIncreasingArc(start, end, mid);
}

/** mid 是否落在 start → end 的「角度增加」路径上（含 2π 归一化）。 */
function onIncreasingArc(start: number, end: number, mid: number): boolean {
  const TAU = Math.PI * 2;
  const norm = (a: number): number => {
    let x = a % TAU;
    if (x < 0) x += TAU;
    return x;
  };
  const delta = norm(end - start);
  const midRel = norm(mid - start);
  return delta > 0 && midRel < delta;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pushLine(out: PathSegment[], from: Vec2, to: Vec2): void {
  if (from.x === to.x && from.y === to.y) return;
  out.push({ kind: 'line', to });
}
