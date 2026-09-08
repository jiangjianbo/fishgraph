/**
 * 力场计算 —— 算法的物理核心。
 *
 * 所有节点对之间（核力式斥力 + 引力），g 为表面间隙（中心距 − 两包围圆半径）：
 *   斥力（作用域 g < R = 1.5L）
 *        E_r = k_r·mᵢmⱼ/2 · (1/g − 1/R)²      F_r = k_r·mᵢmⱼ·(1/g − 1/R)/g²
 *     —— 接触/近距时陡增（g→0 主项回到 k_r/g³ 的核力行为），
 *        在作用域边界 g = R 处能量与力同时光滑归零（C¹）。
 *        脱离接触后斥力迅速消失：定位由连线引力主导，节点不会为了
 *        "躲远处的邻居堆"而把两条连线折到同一侧。
 *   引力   F_a = k_a · mᵢmⱼ / g²          （仅相邻节点对，万有引力式，长程）
 *   弱引力 F_w = k_w · mᵢmⱼ / g²          （非相邻节点对，k_w ≪ k_a；或 centroid 调和约束）
 *
 *   相邻平衡间隙由 k_r·(1/g−1/R) = k_a + k_t·g³ 决定（≈ 0.6L，比旧长尾模型更紧凑）；
 *   非相邻平衡间隙 k_r·(1/g−1/R) = k_w（< R，陌生人仍比朋友远，且在墙外彻底自由）。
 *
 * 边-节点避让：节点压到不相关的线段上时受到垂直于线段的强斥力 F = k_en/h²，
 * 反作用力按投影重心坐标分摊给线段两端节点（线也能"让路"）。
 *
 * 所有力都由势能求导得到（F = −∇E），保证与求解器的能量单调下降一致。
 */

import type { AccuracyMode, GravityMode, LayoutStage } from '../../types.js';
import { closestPointOnSegment, shapeSdf } from '../../geometry.js';
import { jitterDirection } from '../../rng.js';
import type { InternalEdge, LayoutNode } from '../../graph/store.js';
import { QuadTree, type BHPoint, type QuadCell } from './quadtree.js';
import { SpatialGrid, type GridItem } from './spatialgrid.js';

/** 标签软墙的全压强度（× 力单位 k_a/L²）：足以对抗弹簧，把节点撑开到恰好容纳文字。 */
const LABEL_STRENGTH = 50;

export interface DerivedParams {
  L: number;
  ka: number;
  kr: number;
  /** 斥力作用域（表面间隙上限）：≥ repR 时斥力能量与力光滑归零。 */
  repR: number;
  kw: number;
  kt: number;
  /** 边-节点软墙全压强度（已含 edgeNodeRepulsion 倍率）。 */
  ken: number;
  /** 标签软墙全压强度。 */
  klbl: number;
  /** 调和约束（centroid 模式）：全对弹簧系数，等价于到质心的简谐束缚。 */
  kharm: number;
  kcent: number;
  /** 力 → 像素位移的换算：位移 = F / forceUnit × stepSize（截断到 stepSize）。 */
  forceUnit: number;
  /** 边-节点避让墙的作用距离（节点表面到线段小于它才受力）。 */
  obstacleR: number;
  /** 接触弹簧的作用距离（间隙小于它进入重叠推离区），随布局尺度缩放。 */
  gFloor: number;
}

export interface ForceContext {
  nodes: LayoutNode[];
  edges: InternalEdge[];
  /** adj[i] = 与 i 相邻的节点下标集合。 */
  adj: Array<Set<number>>;
  params: DerivedParams;
  gravity: GravityMode;
  accuracy: AccuracyMode;
  theta: number;
  labelCollision: boolean;
  stage: LayoutStage;
  energy: number;
  /** 力残差：max|F|/forceUnit。收敛判据 —— 所有节点的合力趋近 0。 */
  maxForceUnit: number;
}

export function deriveParams(
  opts: {
    naturalLength: number;
    weakGravityRatio: number;
    edgeNodeRepulsion: number;
    edgeTension: number;
    centroidStrength: number;
  },
  nodeCount: number,
): DerivedParams {
  const L = Math.max(opts.naturalLength, 1e-3);
  const ka = 1;
  // 斥力作用域：间隙达到 2L 时斥力光滑归零（脱离接触后迅速消失）。
  const repR = 2 * L;
  // 校准 kr：无张力时相邻平衡间隙恰为 L —— k_r·(1/L − 1/repR) = k_a。
  const kr = (ka * L * repR) / (repR - L);
  const kw = ka * Math.max(opts.weakGravityRatio, 1e-6);
  // 线性张力 k_t：g = L 时张力是引力（k_a/L²）的 edgeTension 倍 → k_t = τ·k_a/L³
  const kt = Math.max(opts.edgeTension, 0) * (ka / (L * L * L));
  // 避让软墙全压强度：约为键合力（k_a/L²）的 edgeNodeRepulsion×10 倍 ——
  // 足以坚决推开压线的节点，又不会远程扭曲整个布局。
  const ken = Math.max(opts.edgeNodeRepulsion, 0) * 10 * (ka / (L * L));
  // 调和约束：F = kharm·(pⱼ−pᵢ) 作用于所有节点对。
  // 由平行轴定理 ½kharm·Σd² = ½kharm·n·Σ|pᵢ−c|²，等价于"到质心的简谐束缚"；
  // 按节点数归一化使总束缚强度与规模无关。合力恒为 0（无漂移/转矩）。
  const kharm = (2 * Math.max(opts.centroidStrength, 0) * ka) / (L * L * Math.max(nodeCount, 1));
  return {
    L,
    ka,
    kr,
    repR,
    kw,
    kt,
    ken,
    klbl: LABEL_STRENGTH * (ka / (L * L)),
    kharm,
    kcent: opts.centroidStrength * (ka / (L * L)),
    forceUnit: ka / (L * L),
    obstacleR: Math.max(6, 0.15 * L),
    gFloor: Math.max(0.5, 0.01 * L),
  };
}

function resetForces(ctx: ForceContext): void {
  ctx.energy = 0;
  ctx.maxForceUnit = 0;
  for (const nd of ctx.nodes) {
    nd.fx = 0;
    nd.fy = 0;
  }
}

/** 力累加结束后调用：记录最大合力（力单位），供收敛判据使用。 */
function finalizeForces(ctx: ForceContext): void {
  let maxF = 0;
  for (const nd of ctx.nodes) {
    const f = Math.hypot(nd.fx, nd.fy);
    if (f > maxF) maxF = f;
  }
  ctx.maxForceUnit = maxF * (1 / ctx.params.forceUnit);
}

/** 一对节点之间的作用类型。 */
export type PairKind =
  | 'adjacent'            // 相邻：斥力 + k_a 引力
  | 'stranger-pairwise'   // 非相邻：斥力 + k_w 弱引力
  | 'stranger-repulsion'; // 非相邻（centroid 模式或 BH 已算引力）：仅斥力

function pairKind(ctx: ForceContext, adjacent: boolean): PairKind {
  if (adjacent) return 'adjacent';
  return ctx.gravity === 'pairwise' ? 'stranger-pairwise' : 'stranger-repulsion';
}

/** 节点对的核力式斥力项（有限作用域 + 重叠接触弹簧）。
 *  势取"截断平移平方"形式（R = repR，s 为表面间隙）：
 *    E(s) = kr·m/2 · (1/s − 1/R)²      F(s) = kr·m · (1/s − 1/R) / s²
 *  - s ≥ R：能量与力同时光滑归零（C¹）—— 脱离接触后斥力迅速消失，
 *    远端节点完全不干扰邻居的定位；
 *  - s → 0：主项回归 kr·m/s³ 的核力陡增，保证不重叠；
 *  - s < gFloor：接触弹簧线性延拓，E 与 F 严格一致（力 = −∂E/∂d），
 *    保证线搜索总有效。gFloor ≈ 1%×L 把最大力控制在位移可解的范围内。
 */
function repulsionTerm(
  kr: number,
  m: number,
  s: number,
  gFloor: number,
  repR: number,
): { f: number; e: number; g: number } {
  if (s >= repR) return { f: 0, e: 0, g: s };
  if (s >= gFloor) {
    const inv = 1 / s - 1 / repR;
    return { f: (kr * m * inv) / (s * s), e: 0.5 * kr * m * inv * inv, g: s };
  }
  const fWall = (kr * m * (1 / gFloor - 1 / repR)) / (gFloor * gFloor);
  const kv = kr / Math.pow(gFloor, 4);
  const depth = gFloor - s;
  // E(s) = E(gFloor) + F(gFloor)·depth + ½·kv·m·depth² —— F = −∂E/∂s 精确成立。
  return {
    f: fWall + kv * m * depth,
    e:
      0.5 * kr * m * Math.pow(1 / gFloor - 1 / repR, 2) +
      fWall * depth +
      0.5 * kv * m * depth * depth,
    g: gFloor,
  };
}

/** 引力项（万有引力式 k/g² + 可选线性张力 kt·g），g 为表面间隙。
 *  间隙低于 gFloor 后引力截断为常力（防止重叠时引力发散），
 *  能量用线性延拓 E(s) = E(gFloor) − F(gFloor)·(gFloor − s) ——
 *  穿透越深引力能量越低（引力本性如此），重叠推开由斥力接触弹簧负责；
 *  关键是力 = −∂E/∂d 在截断处之后依然精确成立。 */
function attractionTerm(
  k: number,
  kt: number,
  m: number,
  s: number,
  gFloor: number,
): { f: number; e: number } {
  if (k === 0 && kt === 0) return { f: 0, e: 0 };
  if (s >= gFloor) {
    return { f: (k * m) / (s * s) + kt * s, e: -(k * m) / s + 0.5 * kt * s * s };
  }
  const f = (k * m) / (gFloor * gFloor) + kt * gFloor;
  return {
    f,
    e: -(k * m) / gFloor + 0.5 * kt * gFloor * gFloor - f * (gFloor - s),
  };
}

/** 一对节点之间的核力式相互作用，返回势能贡献。 */
function applyNodePair(ctx: ForceContext, i: number, j: number, kind: PairKind): number {
  const ni = ctx.nodes[i];
  const nj = ctx.nodes[j];
  const p = ctx.params;
  const dx = ni.x - nj.x;
  const dy = ni.y - nj.y;
  const d = Math.hypot(dx, dy);
  let ux: number;
  let uy: number;
  if (d < 1e-9) {
    // 完全重合时用确定性的伪随机方向弹出。
    const dir = jitterDirection(i, j);
    ux = dir.x;
    uy = dir.y;
  } else {
    ux = dx / d;
    uy = dy / d;
  }
  const s = d - ni.r - nj.r;
  const m = ni.mass * nj.mass;
  const rep = repulsionTerm(p.kr, m, s, p.gFloor, p.repR);
  // 引力（仅相邻对带线性张力；非相邻对按模式带弱引力）
  const kLong = kind === 'adjacent' ? p.ka : kind === 'stranger-pairwise' ? p.kw : 0;
  const ktPair = kind === 'adjacent' ? p.kt : 0;
  const att = attractionTerm(kLong, ktPair, m, s, p.gFloor);
  // 调和约束（centroid 模式，所有节点对）：F = kharm·m·d，能量 ½kharm·m·d²
  const harm = ctx.gravity === 'centroid' ? p.kharm * m * d : 0;
  const net = rep.f - att.f - harm;
  ni.fx += net * ux;
  ni.fy += net * uy;
  nj.fx -= net * ux;
  nj.fy -= net * uy;
  return (
    rep.e +
    att.e +
    0.5 * p.kharm * m * d * d * (ctx.gravity === 'centroid' ? 1 : 0)
  );
}

/** BH 模式：沿边累加相邻节点的引力 + 线性张力（斥力已由四叉树负责）。
 *  与精确模式 adjacent 对的引力项是同一个 attractionTerm，保证两种精度一致。 */
function applyEdgeAttraction(ctx: ForceContext, e: InternalEdge): number {
  const na = ctx.nodes[e.a];
  const nb = ctx.nodes[e.b];
  const p = ctx.params;
  const dx = na.x - nb.x;
  const dy = na.y - nb.y;
  const d = Math.hypot(dx, dy);
  const m = na.mass * nb.mass;
  const att = attractionTerm(p.ka, p.kt, m, d - na.r - nb.r, p.gFloor);
  const ux = d > 1e-9 ? dx / d : 0;
  const uy = d > 1e-9 ? dy / d : 0;
  na.fx -= att.f * ux;
  na.fy -= att.f * uy;
  nb.fx += att.f * ux;
  nb.fy += att.f * uy;
  return att.e;
}

/**
 * BH 模式：节点 p 与远处聚合块 c 的近似核力（斥力 + 弱引力 + 调和约束）。
 * 能量按"块质量集中在质心"的聚合势计一次；p 受完整聚合力，
 * 反作用力以每单位质量的常力挂在块上（聚合势对成员位置的梯度
 * 恰是均摊常力），遍历结束后 distributeReactions 摊派给成员 ——
 * 力与能量同为一个泛函的精确梯度。
 */
function applyCellInteraction(ctx: ForceContext, i: number, cell: QuadCell): number {
  const ni = ctx.nodes[i];
  const p = ctx.params;
  const dx = ni.x - cell.comX;
  const dy = ni.y - cell.comY;
  const dist = Math.max(Math.hypot(dx, dy), 1e-9);
  const ux = dx / dist;
  const uy = dy / dist;
  const m = ni.mass * cell.mass;
  const s = dist - ni.r - cell.avgR;
  const rep = repulsionTerm(p.kr, m, s, p.gFloor, p.repR);
  const kLong = ctx.gravity === 'pairwise' ? p.kw : 0;
  const att = attractionTerm(kLong, 0, m, s, p.gFloor);
  // 调和约束的力关于位置是线性的，按质心聚合是精确的（无近似误差）。
  const fh = ctx.gravity === 'centroid' ? p.kharm * m * dist : 0;
  const net = rep.f - att.f - fh;
  ni.fx += net * ux;
  ni.fy += net * uy;
  cell.aAccX -= (net * ux) / cell.mass;
  cell.aAccY -= (net * uy) / cell.mass;
  return rep.e + att.e + 0.5 * p.kharm * m * dist * dist;
}

/**
 * 节点 vs 边的避让"软墙"斥力。调用方需保证 nodeIdx 不是该边端点。
 *  - 节点表面距线段超过 obstacleR：无力（不干扰布局）；
 *  - 贴近/压入：线性加压，全压强度约为键合力的 30 倍 —— 节点压线被坚决推开。
 * 反作用力按投影重心坐标分摊给端点（线也能"让路"）。
 * 力 = ken·(ρ−h)/ρ，能量 ½·ken·(ρ−h)²/ρ（C¹ 连续）。
 */
function applyEdgeNodeInteraction(ctx: ForceContext, nodeIdx: number, e: InternalEdge): number {
  const c = ctx.nodes[nodeIdx];
  const a = ctx.nodes[e.a];
  const b = ctx.nodes[e.b];
  const p = ctx.params;
  const q = closestPointOnSegment(c.x, c.y, a.x, a.y, b.x, b.y);
  const dx = c.x - q.x;
  const dy = c.y - q.y;
  const dist = Math.hypot(dx, dy);
  const hRaw = dist - c.r;
  const rho = p.obstacleR;
  if (hRaw > rho) return 0;
  let ux: number;
  let uy: number;
  if (dist < 1e-9) {
    // 节点正压在线段上：沿法线方向弹出。
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.hypot(ex, ey);
    if (el < 1e-9) {
      const dir = jitterDirection(nodeIdx, e.a * 100003 + e.b);
      ux = dir.x;
      uy = dir.y;
    } else {
      ux = -ey / el;
      uy = ex / el;
    }
  } else {
    ux = dx / dist;
    uy = dy / dist;
  }
  // 注意：不钳制 hRaw —— 力必须与能量梯度严格一致，否则线搜索会全线拒绝。
  const gapToWall = rho - hRaw;
  const f = (p.ken * gapToWall) / rho;
  c.fx += f * ux;
  c.fy += f * uy;
  const wa = 1 - q.t;
  const wb = q.t;
  a.fx -= f * ux * wa;
  a.fy -= f * uy * wa;
  b.fx -= f * ux * wb;
  b.fy -= f * uy * wb;
  return (0.5 * p.ken * gapToWall * gapToWall) / rho;
}

/**
 * 节点 vs 边标签包围盒的"软墙"斥力。
 *  - 节点表面距盒子超过 margin：无力（不干扰自然布局）；
 *  - 贴近/压入：线性加压，把节点撑开到恰好容纳文字（文字多少自动撑开距离）。
 * 对标签自己的端点同样生效；反作用力均分给两端（盒中心 = 边中点）。
 * 力 = klbl·(margin − h)/margin，能量 ½·klbl·(margin − h)²/margin（C¹ 连续）。
 */
function applyLabelNodeInteraction(ctx: ForceContext, nodeIdx: number, e: InternalEdge): number {
  if (e.label === null) return 0;
  const c = ctx.nodes[nodeIdx];
  const a = ctx.nodes[e.a];
  const b = ctx.nodes[e.b];
  const p = ctx.params;
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const sdf = shapeSdf({ kind: 'rect', w: e.labelHw * 2, h: e.labelHh * 2 }, c.x - midX, c.y - midY);
  const hRaw = sdf.dist - c.r;
  const margin = Math.max(2, p.L * 0.04);
  if (hRaw > margin) return 0;
  // 不钳制 hRaw：穿透越深推力越大，能量 ½·klbl·(margin−hRaw)²/margin 一致。
  const gapToWall = margin - hRaw;
  const f = (p.klbl * gapToWall) / margin;
  c.fx += f * sdf.gx;
  c.fy += f * sdf.gy;
  a.fx -= f * sdf.gx * 0.5;
  a.fy -= f * sdf.gy * 0.5;
  b.fx -= f * sdf.gx * 0.5;
  b.fy -= f * sdf.gy * 0.5;
  return (0.5 * p.klbl * gapToWall * gapToWall) / margin;
}

/** 精确模式：O(n²) 全对力 + 全部避让对。作为参考实现，也是小图的首选。 */
export function computeForcesExact(ctx: ForceContext): number {
  resetForces(ctx);
  const n = ctx.nodes.length;
  const edgesActive = ctx.stage >= 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      ctx.energy += applyNodePair(ctx, i, j, pairKind(ctx, edgesActive && ctx.adj[i].has(j)));
    }
  }
  if (ctx.stage >= 2) {
    for (let c = 0; c < n; c++) {
      for (const e of ctx.edges) {
        // 边的避让不作用于自己的端点（线属于这两个节点）；
        // 标签避让对端点同样生效（文字会把两端撑开）。
        if (e.a !== c && e.b !== c) ctx.energy += applyEdgeNodeInteraction(ctx, c, e);
        if (ctx.labelCollision) ctx.energy += applyLabelNodeInteraction(ctx, c, e);
      }
    }
  }
  finalizeForces(ctx);
  return ctx.energy;
}

/** Barnes-Hut 模式：四叉树近似节点-节点力，空间网格加速避让候选对。 */
export function computeForcesBH(ctx: ForceContext): number {
  resetForces(ctx);
  const n = ctx.nodes.length;

  // 用当前坐标构建四叉树（节点-节点力）与空间网格（避让候选对）。
  const points: BHPoint[] = ctx.nodes.map((nd, index) => ({
    index,
    x: nd.x,
    y: nd.y,
    mass: nd.mass,
    radius: nd.r,
  }));
  const tree = new QuadTree(points);
  const p0 = ctx.params;
  const grid = new SpatialGrid(Math.max(p0.obstacleR * 2, 1));

  // 1. 节点-节点：斥力 + 弱引力/调和约束（相邻节点的引力在第 2 步沿边精确累加，避免重复）。
  //    双树遍历保证每个无序对恰好访问一次，力与能量是同一泛函的精确梯度。
  tree.forEachPairInteraction(
    ctx.theta,
    (a, b) => {
      const adjacent = ctx.stage >= 1 && ctx.adj[a.index].has(b.index);
      const kind: PairKind = adjacent ? 'stranger-repulsion' : pairKind(ctx, false);
      ctx.energy += applyNodePair(ctx, a.index, b.index, kind);
    },
    (p, cell) => {
      ctx.energy += applyCellInteraction(ctx, p.index, cell);
    },
  );
  // 远块聚合交互的反作用力按均摊常力摊派给块内成员。
  tree.distributeReactions((index, fx, fy) => {
    const nd = ctx.nodes[index];
    nd.fx += fx;
    nd.fy += fy;
  });

  // 2. 沿边累加相邻引力 + 线性张力
  if (ctx.stage >= 1) {
    for (const e of ctx.edges) {
      ctx.energy += applyEdgeAttraction(ctx, e);
    }
  }

  // 3. 避让：网格给出候选（边/标签 × 节点），内部再按影响半径过滤
  let rmax = 0;
  for (const nd of ctx.nodes) if (nd.r > rmax) rmax = nd.r;
  const edgeItems: GridItem[] = ctx.edges.map((_, ei) => ({ kind: 0 as const, edgeIndex: ei, stamp: 0 }));
  const labelItems: GridItem[] = ctx.labelCollision
    ? ctx.edges.map((_, ei) => ({ kind: 1 as const, edgeIndex: ei, stamp: 0 }))
    : [];
  ctx.edges.forEach((e, ei) => {
    const a = ctx.nodes[e.a];
    const b = ctx.nodes[e.b];
    grid.insert(
      Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.max(a.x, b.x), Math.max(a.y, b.y),
      edgeItems[ei],
    );
  });
  if (ctx.labelCollision) {
    ctx.edges.forEach((e, ei) => {
      if (e.label === null) return;
      const a = ctx.nodes[e.a];
      const b = ctx.nodes[e.b];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      grid.insert(
        mx - e.labelHw, my - e.labelHh,
        mx + e.labelHw, my + e.labelHh,
        labelItems[ei],
      );
    });
  }
  const queryR = ctx.params.obstacleR + rmax;
  if (ctx.stage >= 2) {
    for (let c = 0; c < n; c++) {
      const nd = ctx.nodes[c];
      grid.query(nd.x, nd.y, queryR, (item) => {
        const e = ctx.edges[item.edgeIndex];
        if (item.kind === 0) {
          if (e.a !== c && e.b !== c) ctx.energy += applyEdgeNodeInteraction(ctx, c, e);
        } else if (e.label !== null) {
          ctx.energy += applyLabelNodeInteraction(ctx, c, e);
        }
      });
    }
  }

  finalizeForces(ctx);
  return ctx.energy;
}
