/**
 * 路径风格策略实现。
 *
 * 四种风格共用「端口 → 端口」的接口语义，区别在对布局走线拐点
 * （ctx.waypoints，中心-中心）的取舍：
 *   - orthogonal  保留拐点做正交骨架，端口处垂直 breakout 接入；
 *   - straight    忽略拐点，端口直连；
 *   - bezier      忽略拐点，控制点沿端口外法向伸出；
 *   - oblique     保留拐点做中段，两端斜线接入端口，平行边整体横移分散。
 */

import type { Vec2 } from '../types.js';
import type { EdgePath, EdgeRouteContext, PathStrategy } from './types.js';

/**
 * 去掉走线首尾的元素中心点，并裁掉仍处于两端 AABB 内部的段
 * （A* 从中心格出发，首段在元素内部 —— 端口策略接管后这些段必须裁掉，
 * 否则 breakout 后路径会反向穿回节点）。
 */
function coreWaypoints(ctx: EdgeRouteContext): readonly Vec2[] {
  const wps = ctx.waypoints;
  if (wps.length < 2) return [];
  let lo = 1;
  while (lo < wps.length - 1 && inside(wps[lo]!, ctx.sourceBox)) lo++;
  let hi = wps.length - 2;
  while (hi >= lo && inside(wps[hi]!, ctx.targetBox)) hi--;
  return wps.slice(lo, hi + 1);
}

function inside(p: Vec2, box: { x: number; y: number; hw: number; hh: number }): boolean {
  return Math.abs(p.x - box.x) <= box.hw && Math.abs(p.y - box.y) <= box.hh;
}

/** 追加点（与末点重合时跳过，保证段零长度不出现）。 */
function pushPoint(pts: Vec2[], p: Vec2): void {
  const last = pts[pts.length - 1]!;
  if (last.x !== p.x || last.y !== p.y) pts.push(p);
}

/**
 * a → b 的正交 L 连接：共轴直连；否则先走绝对位移大的轴
 * （与主流方向一致，避免无谓的短拐）。追加到 pts（起点 a 已在末尾）。
 */
function appendOrthogonal(pts: Vec2[], b: Vec2): void {
  const a = pts[pts.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 || dy === 0) {
    pushPoint(pts, b);
  } else if (Math.abs(dx) >= Math.abs(dy)) {
    pushPoint(pts, { x: b.x, y: a.y });
    pushPoint(pts, b);
  } else {
    pushPoint(pts, { x: a.x, y: b.y });
    pushPoint(pts, b);
  }
}

function toPath(pts: readonly Vec2[]): EdgePath {
  return {
    start: pts[0]!,
    segments: pts.slice(1).map((p) => ({ kind: 'line', to: p }) as const),
  };
}

/** 正交折线：网格走线骨架 + 端口处垂直 breakout（连线风格 = 经典流程图折线）。 */
export class OrthogonalPolylinePathStrategy implements PathStrategy {
  readonly name = 'orthogonal';

  constructor(
    /** 端口沿外法向的出口距离（布局坐标，默认 6）。 */
    private breakout = 6,
  ) {}

  route(ctx: EdgeRouteContext): EdgePath {
    const { source, target } = ctx;
    const pts: Vec2[] = [{ x: source.x, y: source.y }];
    // 出盒：沿端口外法向 breakout，首段沿法向接入骨架（避免 breakout 后
    // 反向折回形成的"钉子"）；与节点重叠的连接段由渲染端节点层遮盖。
    const exit = { x: source.x + source.nx * this.breakout, y: source.y + source.ny * this.breakout };
    pushPoint(pts, exit);
    const core = coreWaypoints(ctx);
    if (core.length > 0) {
      appendAxisFirst(pts, core[0]!, source.nx, source.ny);
      for (let i = 1; i < core.length; i++) appendOrthogonal(pts, core[i]!);
    }
    // 退化：骨架末点已落在 target 端口上（小盒锚点格心与侧边中点重合）
    // —— breakout 进出同点必成往返钉（simplify 对消后残留 0 长末段、
    // 箭头切向错 90°），骨架即终点，箭头切向沿骨架末段。
    const last = pts[pts.length - 1]!;
    if (last.x === target.x && last.y === target.y) {
      simplify(pts);
      return toPath(pts);
    }
    // 入盒：骨架先以垂直于法向的末段接入 entry（entry → target 沿法向
    // 贴边）—— 到达方向与最终段恒成直角，杜绝"伸出又折回"的回绕针。
    const entry = { x: target.x + target.nx * this.breakout, y: target.y + target.ny * this.breakout };
    appendApproach(pts, entry, target, target.nx, target.ny);
    pushPoint(pts, { x: target.x, y: target.y });
    simplify(pts);
    enforceEndStub(pts, Math.max(this.breakout, ctx.minStub ?? 0));
    return toPath(pts);
  }
}

/** 合并共线中间点：同轴延续的碎段收敛为单段（breakout 6px 段不再碎裂）。 */
function simplify(pts: Vec2[]): void {
  let i = 1;
  while (i + 1 < pts.length) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    if ((p.x === c.x && c.x === n.x) || (p.y === c.y && c.y === n.y)) pts.splice(i, 1);
    else i++;
  }
}

/**
 * 终点贴边段保障：末段短于 minStub（端口 breakout 或端帽占线长）时，
 * 把末拐点外推到末段轴上距 tip 恰好 minStub 处，并在其与倒数第三点
 * 之间补一个正交肘点（先沿倒数第三点所在轴对齐，再水平/垂直接入
 * moved）—— 全折线保持正交，末段方向不变，仍垂直贴边。
 * 肘臂与来路共线反向（会折出 180° 回折钉）时放弃外推保持原状。
 */
function enforceEndStub(pts: Vec2[], minStub: number): void {
  if (minStub <= 0 || pts.length < 3) return;
  const tip = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2]!;
  const dx = tip.x - prev.x;
  const dy = tip.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || len >= minStub) return;
  const vertical = dx === 0;
  const moved = { x: tip.x - (dx / len) * minStub, y: tip.y - (dy / len) * minStub };
  const q = pts[pts.length - 3]!;
  const elbow = vertical ? { x: q.x, y: moved.y } : { x: moved.x, y: q.y };
  const fore = pts.length >= 4 ? pts[pts.length - 4]! : null;
  if (fore) {
    const inX = q.x - fore.x;
    const inY = q.y - fore.y;
    const armX = elbow.x - q.x;
    const armY = elbow.y - q.y;
    if (armX * inY - armY * inX === 0 && armX * inX + armY * inY < 0) return;
  }
  pts[pts.length - 2] = moved;
  if ((elbow.x !== q.x || elbow.y !== q.y) && (elbow.x !== moved.x || elbow.y !== moved.y)) {
    pts.splice(pts.length - 2, 0, elbow);
  }
  simplify(pts);
}

/**
 * a → b 的正交 L 连接，且首段沿给定法向轴（端口 breakout 语义：先沿
 * 端口面的切向滑动，再转入骨架轴 —— 反序会反向穿过节点形成回绕）。
 */
function appendAxisFirst(pts: Vec2[], b: Vec2, nx: number, ny: number): void {
  if (Math.abs(nx) >= Math.abs(ny)) pushPoint(pts, { x: pts[pts.length - 1]!.x, y: b.y });
  else pushPoint(pts, { x: b.x, y: pts[pts.length - 1]!.y });
  pushPoint(pts, b);
}

/**
 * a → entry 的正交 L 连接，且末段沿给定法向轴（entry → target 沿法向
 * 贴边）：默认先沿切向轴对齐 entry、再沿法向接入 —— 与 appendAxisFirst
 * 对称，切向臂与最终贴边段同轴，simplify 合并后末段 = 从最后一个拐点
 * 到端点的单一直线，长度由骨架末点与端口的实际距离决定（骨架末点在
 * 锚点外一格，恒 ≥ 半格距 > 箭头长度），保证箭头之后有足够「尾巴」
 * 才开始转向。
 *
 * 例外一：切向臂与骨架来路同轴反向（原路往返，simplify 会把骨架末拐点
 * 一并对消）时退回法向轴先对齐 —— 保留走线骨架，代价是末段回落为
 * breakout 短段。
 *
 * 例外二：对齐臂终点恰为 target（小盒锚点格心与侧边中点重合：骨架已
 * 以正确方向抵达端口）—— 臂终点即终点，不再走 entry 往返（否则
 * simplify 对消后残留 0 长末段、箭头切向错 90°）。
 */
function appendApproach(pts: Vec2[], entry: Vec2, target: Vec2, nx: number, ny: number): void {
  const last = pts[pts.length - 1]!;
  const prev = pts.length >= 2 ? pts[pts.length - 2]! : null;
  const axisX = Math.abs(nx) >= Math.abs(ny);
  const armX = axisX ? 0 : entry.x - last.x;
  const armY = axisX ? entry.y - last.y : 0;
  let collision = false;
  if (prev) {
    const inX = last.x - prev.x;
    const inY = last.y - prev.y;
    if (armX !== 0 && inX !== 0) collision = inX * armX < 0 && inY === 0;
    else if (armY !== 0 && inY !== 0) collision = inY * armY < 0 && inX === 0;
  }
  const armEnd = collision
    ? (axisX ? { x: entry.x, y: last.y } : { x: last.x, y: entry.y })
    : (axisX ? { x: last.x, y: entry.y } : { x: entry.x, y: last.y });
  pushPoint(pts, armEnd);
  if (armEnd.x === target.x && armEnd.y === target.y) return;
  pushPoint(pts, entry);
}

/** 直线：两端口直连（忽略走线拐点）。 */
export class StraightLinePathStrategy implements PathStrategy {
  readonly name = 'straight';

  route(ctx: EdgeRouteContext): EdgePath {
    return {
      start: { x: ctx.source.x, y: ctx.source.y },
      segments: [{ kind: 'line', to: { x: ctx.target.x, y: ctx.target.y } }],
    };
  }
}

/** 三次贝塞尔：控制点沿两端端口外法向伸出，出线方向自然贴合端口侧。 */
export class CubicBezierPathStrategy implements PathStrategy {
  readonly name = 'bezier';

  constructor(
    /** 控制臂长 = 端口距 × 本系数（默认 0.35）。 */
    private leadRatio = 0.35,
    /** 控制臂长上限（布局坐标，默认 80）。 */
    private maxLead = 80,
  ) {}

  route(ctx: EdgeRouteContext): EdgePath {
    const { source, target } = ctx;
    const dist = Math.hypot(target.x - source.x, target.y - source.y);
    const lead = Math.min(this.maxLead, dist * this.leadRatio);
    return {
      start: { x: source.x, y: source.y },
      segments: [
        {
          kind: 'bezier',
          cp1: { x: source.x + source.nx * lead, y: source.y + source.ny * lead },
          cp2: { x: target.x + target.nx * lead, y: target.y + target.ny * lead },
          to: { x: target.x, y: target.y },
        },
      ],
    };
  }
}

/**
 * 斜折线 + 平行边分散：中段沿用走线骨架，两端以斜线直插端口
 * （直线段 + 折线段混合）；同端点对的平行边沿连线法向整体横移
 * （slot 序号决定偏移量），互不重叠。
 */
export class ObliqueDistributedPathStrategy implements PathStrategy {
  readonly name = 'oblique';

  constructor(
    /** 平行边的相邻间距（布局坐标，默认 10）。 */
    private spacing = 10,
  ) {}

  route(ctx: EdgeRouteContext): EdgePath {
    const { source, target, bundle } = ctx;
    // 连线方向的单位法向（整体横移轴）。
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const shift = (bundle.slot - (bundle.count - 1) / 2) * this.spacing;
    const off = (p: Vec2): Vec2 => ({ x: p.x + nx * shift, y: p.y + ny * shift });

    const pts: Vec2[] = [off({ x: source.x, y: source.y })];
    for (const w of coreWaypoints(ctx)) pushPoint(pts, off(w));
    pushPoint(pts, off({ x: target.x, y: target.y }));
    return toPath(pts);
  }
}
