/**
 * 连线风格装配器：布局输出 → 绘制几何。
 *
 * 管线（每条边依序经过）：
 *   PortStrategy（端点对接）→ PathStrategy（路径风格）→
 *   CornerStrategy（转弯风格）→ CrossingStrategy（交叉风格，按绘制序
 *   逐边处理，后画边可对先画边"抬桥"）。
 *
 * 渲染端只需翻译输出的段序列（line/arc/bezier），几何细节全部在此收口：
 * 标签锚点（按曲线长度取中点）与末端箭头（位置 + 切向）一并算好。
 */

import { halfExtentsOf } from '../geometry.js';
import type { InternalEdge } from '../graph/store.js';
import type { NodeView, SubgraphView, Vec2 } from '../types.js';
import { dominantSide, type Side } from './ports.js';
import { arcPoint, bezierPoint, segmentEnd, segmentLength } from './segments.js';
import type {
  CornerStrategy,
  CrossingStrategy,
  EdgeEndpointBox,
  EdgeEndpointStyle,
  EdgePath,
  EndCapDecoration,
  PathStrategy,
} from './types.js';

export type { EdgeEndpointStyle };

/** 渲染器消费的最小布局输出面。 */
export interface EdgeScene {
  nodeViews: readonly NodeView[];
  subgraphViews: readonly SubgraphView[];
  edgeViews: readonly InternalEdge[];
}

/** 一条边的最终绘制几何（布局坐标系）。 */
export interface EdgeGeometry {
  /** edgeViews 下标。 */
  index: number;
  path: EdgePath;
  label: string | null;
  /** 标签锚点：按曲线长度取的路径中点。 */
  labelAnchor: Vec2;
  /** 末端箭头：尖端位置与单位切向（指向路径外部）。 */
  arrow: { tip: Vec2; dx: number; dy: number };
  /** 起点切向：位置与单位切向（指向路径外部，即行进反方向）。 */
  startTangent: { tip: Vec2; dx: number; dy: number };
  /** 两端端帽装饰（按 source/target 端各自的 EndCapStrategy 产出）。 */
  caps: { source: EndCapDecoration; target: EndCapDecoration };
}

/** 连线风格配置：起/终端各自的端点样式（端口 + 贴合 + 端帽）独立配置。 */
export interface EdgeStyleOptions {
  source: EdgeEndpointStyle;
  target: EdgeEndpointStyle;
  path: PathStrategy;
  corners: CornerStrategy;
  crossings: CrossingStrategy;
}

export class EdgeStyleRenderer {
  constructor(private options: EdgeStyleOptions) {}

  render(scene: EdgeScene): EdgeGeometry[] {
    const ends = [...scene.nodeViews, ...scene.subgraphViews];
    const boxes = ends.map(toEndpointBox);
    const slots = this.computeSlots(scene.edgeViews, ends);
    const bundles = computeBundles(scene.edgeViews);
    const result: EdgeGeometry[] = [];
    const drawn: EdgePath[] = [];

    for (let i = 0; i < scene.edgeViews.length; i++) {
      const e = scene.edgeViews[i]!;
      const a = boxes[e.sourceIndex]!;
      const b = boxes[e.targetIndex]!;
      const sourceStyle = this.options.source;
      const targetStyle = this.options.target;
      const portA = sourceStyle.ports.port(
        a,
        portToward(e.waypoints, 'source', a, b),
        slots[i]!.a.slot,
        slots[i]!.a.count,
      );
      const portB = targetStyle.ports.port(
        b,
        portToward(e.waypoints, 'target', a, b),
        slots[i]!.b.slot,
        slots[i]!.b.count,
      );
      // 贴合：把 AABB 侧边端口收放到元素真实几何上（口径由各端策略决定）
      const fitA = sourceStyle.fit.fit(portA, a);
      const fitB = targetStyle.fit.fit(portB, b);

      const base = this.options.path.route({
        source: fitA,
        target: fitB,
        sourceBox: a,
        targetBox: b,
        waypoints: e.waypoints ?? [],
        bundle: bundles[i]!,
      });
      const shaped = this.options.crossings.apply(this.options.corners.apply(base), drawn);
      drawn.push(shaped);

      const arrow = endArrow(shaped);
      const start = startTangent(shaped);
      result.push({
        index: i,
        path: shaped,
        label: e.label,
        labelAnchor: pathMidpoint(shaped),
        arrow,
        startTangent: start,
        caps: {
          source: sourceStyle.cap.decorate(start.tip, start.dx, start.dy, 'source'),
          target: targetStyle.cap.decorate(arrow.tip, arrow.dx, arrow.dy, 'target'),
        },
      });
    }
    return result;
  }

  /**
   * 同侧边组：每个元素按「对端方向」的主导侧分组，组内沿侧边自然坐标
   * 排序（竖边按 y、横边按 x），序号即 PortStrategy 的 slot —— 与
   * 端口沿侧边展开的方向一致，保证分布次序确定。
   */
  private computeSlots(
    edges: readonly InternalEdge[],
    ends: ReadonlyArray<{ x: number; y: number }>,
  ): ReadonlyArray<{ a: SlotInfo; b: SlotInfo }> {
    // per 元素：侧 → (边序, 元素下标, 排序键)
    const groups = new Map<number, Map<Side, Array<{ edge: number; at: number; key: number }>>>();
    edges.forEach((e, i) => {
      recordEnd(groups, e.sourceIndex, ends[e.targetIndex]!, ends[e.sourceIndex]!, i);
      recordEnd(groups, e.targetIndex, ends[e.sourceIndex]!, ends[e.targetIndex]!, i);
    });
    const slotOf = new Map<string, SlotInfo>();
    for (const bySide of groups.values()) {
      for (const list of bySide.values()) {
        list.sort((p, q) => p.key - q.key);
        list.forEach((item, slot) => slotOf.set(`${item.edge}:${item.at}`, { slot, count: list.length }));
      }
    }
    return edges.map((e, i) => ({
      a: slotOf.get(`${i}:${e.sourceIndex}`) ?? ZERO_SLOT,
      b: slotOf.get(`${i}:${e.targetIndex}`) ?? ZERO_SLOT,
    }));
  }
}

interface SlotInfo {
  slot: number;
  count: number;
}
const ZERO_SLOT: SlotInfo = { slot: 0, count: 1 };

/** 把「元素 at 的第 i 条边」按对端方向归入 at 的同侧分组。 */
function recordEnd(
  groups: Map<number, Map<Side, Array<{ edge: number; at: number; key: number }>>>,
  at: number,
  from: { x: number; y: number },
  center: { x: number; y: number },
  edge: number,
): void {
  const toward = { x: from.x - center.x, y: from.y - center.y };
  const side = dominantSide(toward.x, toward.y);
  // 排序键 = 侧边自然坐标：竖边按对端 y（slot 0 在上端）、横边按对端 x。
  const key = side === 'right' || side === 'left' ? toward.y : toward.x;
  let bySide = groups.get(at);
  if (!bySide) {
    bySide = new Map();
    groups.set(at, bySide);
  }
  const list = bySide.get(side);
  const item = { edge, at, key };
  if (list) list.push(item);
  else bySide.set(side, [item]);
}

/**
 * 端口朝向：优先取走线骨架首段（source 出盒方向）/ 末段反方向
 * （target 入盒面朝向）—— 端口面与骨架实际出入方向一致，消除
 * 「中心连线 45° 平局」下端口侧向与走线相悖的回绕；无骨架
 * （waypoints 少于两点）回退两端中心连线方向。
 */
function portToward(
  waypoints: readonly Vec2[] | undefined,
  at: 'source' | 'target',
  a: EdgeEndpointBox,
  b: EdgeEndpointBox,
): Vec2 {
  const wp = waypoints ?? [];
  if (wp.length >= 2) {
    const last = wp.length - 1;
    return at === 'source'
      ? { x: wp[1]!.x - wp[0]!.x, y: wp[1]!.y - wp[0]!.y }
      : { x: wp[last - 1]!.x - wp[last]!.x, y: wp[last - 1]!.y - wp[last]!.y };
  }
  return at === 'source'
    ? { x: b.x - a.x, y: b.y - a.y }
    : { x: a.x - b.x, y: a.y - b.y };
}

/** 平行边分组：同端点对（无序）的边为一组，组内按声明序给 slot。 */
function computeBundles(edges: readonly InternalEdge[]): ReadonlyArray<{ slot: number; count: number }> {
  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const key = e.sourceIndex < e.targetIndex
      ? `${e.sourceIndex}:${e.targetIndex}`
      : `${e.targetIndex}:${e.sourceIndex}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  const bundle = new Map<number, { slot: number; count: number }>();
  for (const list of groups.values()) {
    list.forEach((edge, slot) => bundle.set(edge, { slot, count: list.length }));
  }
  return edges.map((_, i) => bundle.get(i) ?? { slot: 0, count: 1 });
}

/** 布局元素 → 端点几何快照（物化尺寸优先，缺省用声明形状的半宽高）。 */
function toEndpointBox(el: NodeView | SubgraphView): EdgeEndpointBox {
  const he = halfExtentsOf(el.shape);
  const materialized = el as NodeView;
  return {
    x: el.x,
    y: el.y,
    hw: materialized.w !== undefined ? materialized.w / 2 : he.hw,
    hh: materialized.h !== undefined ? materialized.h / 2 : he.hh,
    shape: el.shape,
  };
}

// ── 路径几何量取（标签锚点 / 箭头）────────────────────────

/** 路径按曲线长度的比例位置。 */
function pointAt(path: EdgePath, ratio: number): Vec2 {
  let total = 0;
  let from = path.start;
  const lens: number[] = [];
  const starts: Vec2[] = [];
  for (const seg of path.segments) {
    starts.push(from);
    const len = segmentLength(from, seg);
    lens.push(len);
    total += len;
    from = segmentEnd(seg);
  }
  let remain = total * ratio;
  for (let i = 0; i < path.segments.length; i++) {
    const len = lens[i]!;
    if (remain <= len || i === path.segments.length - 1) {
      const t = len === 0 ? 0 : remain / len;
      const seg = path.segments[i]!;
      if (seg.kind === 'arc') return arcPoint(seg, t);
      if (seg.kind === 'bezier') return bezierPoint(starts[i]!, seg, t);
      const s = starts[i]!;
      return { x: s.x + (seg.to.x - s.x) * t, y: s.y + (seg.to.y - s.y) * t };
    }
    remain -= len;
  }
  return { ...path.start };
}

/** 路径按曲线长度的中点。 */
export function pathMidpoint(path: EdgePath): Vec2 {
  return pointAt(path, 0.5);
}

/** 末端箭头：路径终点与末端切向（单位向量，指向路径外部 = 行进方向）。 */
export function endArrow(path: EdgePath): { tip: Vec2; dx: number; dy: number } {
  const last = path.segments[path.segments.length - 1];
  if (!last) return { tip: { ...path.start }, dx: 1, dy: 0 };
  if (last.kind === 'line') {
    // 切向 = 末段自身的行进方向（末段起点 → 终点）。多段折线（正交
    // 走线）的整体位移不沿末段轴向，不能代表箭头进入端口的方向。
    const from =
      path.segments.length >= 2 ? segmentEnd(path.segments[path.segments.length - 2]!) : path.start;
    return tipWith(last.to, last.to.x - from.x, last.to.y - from.y);
  }
  if (last.kind === 'bezier') return tipWith(last.to, last.to.x - last.cp2.x, last.to.y - last.cp2.y);
  // arc 末端切向：半径向量旋转 ±90°（依行进方向）
  const rx = Math.cos(last.endAngle);
  const ry = Math.sin(last.endAngle);
  return tipWith(
    { x: last.center.x + last.radius * rx, y: last.center.y + last.radius * ry },
    last.ccw ? ry : -ry,
    last.ccw ? -rx : rx,
  );
}

/** 起点切向：路径起点与起始切向（单位向量，指向路径外部 = 行进反方向）。 */
export function startTangent(path: EdgePath): { tip: Vec2; dx: number; dy: number } {
  const first = path.segments[0];
  if (!first) return { tip: { ...path.start }, dx: -1, dy: 0 };
  if (first.kind === 'line') {
    return tipWith({ ...path.start }, path.start.x - first.to.x, path.start.y - first.to.y);
  }
  if (first.kind === 'bezier') {
    return tipWith({ ...path.start }, path.start.x - first.cp1.x, path.start.y - first.cp1.y);
  }
  // arc 起始切向：与末端同式，角度换为起始角
  const rx = Math.cos(first.startAngle);
  const ry = Math.sin(first.startAngle);
  const tip = { x: first.center.x + first.radius * rx, y: first.center.y + first.radius * ry };
  // 起点外部方向 = 行进反方向（行进切向再取反）
  const dx = first.ccw ? ry : -ry;
  const dy = first.ccw ? -rx : rx;
  return tipWith(tip, -dx, -dy);
}

function tipWith(tip: Vec2, dx: number, dy: number): { tip: Vec2; dx: number; dy: number } {
  const len = Math.hypot(dx, dy) || 1;
  return { tip, dx: dx / len, dy: dy / len };
}
