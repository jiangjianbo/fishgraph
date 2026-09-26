/**
 * 转弯风格策略实现。
 *
 * 转弯只作用于折线拐点（line→line 顶点）：直角策略原样保留尖点，
 * 圆角策略在每个拐点用相切圆弧替代 —— 切点取在前后段上、半径不超过
 * 前后段长的一半（相邻两个拐点共享一段时互不越界）。曲线段原样通过。
 */

import type { Vec2 } from '../types.js';
import type { CornerStrategy, EdgePath, PathSegment } from './types.js';
import { segmentEnd } from './segments.js';

/** 直角（尖点）：恒等变换，即现状折线画法。 */
export class SharpCornerStrategy implements CornerStrategy {
  readonly name = 'sharp';

  apply(path: EdgePath): EdgePath {
    return path;
  }
}

/** 圆角：每个拐点以圆弧替代，半径取 min(设定值, 前半段, 后半段)。 */
export class RoundCornerStrategy implements CornerStrategy {
  readonly name = 'round';

  constructor(
    /** 圆角半径（布局坐标，默认 8）。 */
    private radius = 8,
  ) {}

  apply(path: EdgePath): EdgePath {
    const out: PathSegment[] = [];
    let chain: Vec2[] = [path.start];
    const flush = (): void => {
      if (chain.length > 1) out.push(...roundChain(chain, this.radius));
      chain = [];
    };
    for (const seg of path.segments) {
      if (seg.kind === 'line') {
        chain.push(seg.to);
        continue;
      }
      flush();
      out.push(seg);
      // 曲线段原样通过，顶点链从其终点重开
      chain = [segmentEnd(seg)];
    }
    flush();
    return { start: path.start, segments: out };
  }
}

/** 顶点链（首点为链起点）→ 段序列：拐点处 line 到切点 + 圆弧，其余直连。 */
function roundChain(vs: readonly Vec2[], radius: number): PathSegment[] {
  const segs: PathSegment[] = [];
  for (let i = 1; i + 1 < vs.length; i++) {
    const prev = vs[i - 1]!;
    const v = vs[i]!;
    const next = vs[i + 1]!;
    const l1 = Math.hypot(v.x - prev.x, v.y - prev.y);
    const l2 = Math.hypot(next.x - v.x, next.y - v.y);
    const d1x = (v.x - prev.x) / (l1 || 1);
    const d1y = (v.y - prev.y) / (l1 || 1);
    const d2x = (next.x - v.x) / (l2 || 1);
    const d2y = (next.y - v.y) / (l2 || 1);
    const cross = d1x * d2y - d1y * d2x;
    // 共线直行、180° 掉头无法内切 —— 保留尖点。
    const r = Math.abs(cross) < 1e-9 ? 0 : Math.min(radius, l1 / 2, l2 / 2);
    if (r <= 0) {
      segs.push({ kind: 'line', to: v });
      continue;
    }
    const a = { x: v.x - d1x * r, y: v.y - d1y * r };
    const b = { x: v.x + d2x * r, y: v.y + d2y * r };
    // 圆心 = 切点 a + 前段法向 × r，法向朝拐角内侧（cross 符号决定侧）。
    const nx = cross > 0 ? -d1y : d1y;
    const ny = cross > 0 ? d1x : -d1x;
    const c = { x: a.x + nx * r, y: a.y + ny * r };
    const startAngle = Math.atan2(a.y - c.y, a.x - c.x);
    const endAngle = Math.atan2(b.y - c.y, b.x - c.x);
    // 圆弧恒走短弧（≤180°）：angle 增加路径为 ccw=false（canvas 语义）。
    let delta = endAngle - startAngle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    if (i === 1 && a.x === vs[0]!.x && a.y === vs[0]!.y) {
      // 切点与链起点重合（零长首段）时省略 line
    } else {
      segs.push({ kind: 'line', to: a });
    }
    segs.push({ kind: 'arc', center: c, radius: r, startAngle, endAngle, ccw: delta < 0 });
  }
  segs.push({ kind: 'line', to: vs[vs.length - 1]! });
  return segs;
}
