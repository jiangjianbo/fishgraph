/**
 * 力场计算 —— 算法的物理核心。
 *
 * 所有节点对之间（核力式斥力 + 引力），g 为表面间隙（中心距 − 两包围圆半径）：
 *   斥力（作用域 g < R = 2L）
 *        E_r = k_r·mᵢmⱼ/2 · (1/g − 1/R)²      F_r = k_r·mᵢmⱼ·(1/g − 1/R)/g²
 *     —— 接触/近距时陡增（g→0 主项回到 k_r/g³ 的核力行为），
 *        在作用域边界 g = R 处能量与力同时光滑归零（C¹）。
 *        脱离接触后斥力迅速消失：定位由连线引力主导，节点不会为了
 *        "躲远处的邻居堆"而把两条连线折到同一侧。
 *   连线弹力 F_b = τ·k_a/L² · μ_e · g    （橡皮筋：仅相邻节点对，越长拉力越大；
 *      τ = edgeTension 刚度倍率，τ=1 时无交叉平衡间隙恰为 L。
 *      连线在节点内部的那截不贡献弹力）
 *     μ_e = 1 + λ·X_e 是每条边的交叉收缩乘子：X_e 为该边与其它（不共享
 *     端点的）边的严格相交次数，λ = crossingShrink。交叉越多的线收缩力
 *     越强，交叉在能量上天然趋于消解。X_e 在每次力场求值时按当前坐标
 *     重算，力与能量用同一组 μ_e —— 分段保守（力 = −∇E 在交叉事件之间
 *     严格成立），能量单调下降不受影响。
 *   弱引力 F_w = k_w · mᵢmⱼ / g²          （非相邻节点对，k_w ≪ k_a；或 centroid 调和约束）
 *
 *   相邻平衡间隙由 k_r·(1/g−1/R) = μ_e·(k_a + k_t·g³) 决定（μ=1、无张力时恰为 L）；
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
import { countEdgeCrossings } from './crossings.js';
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
  /** 交叉收缩系数 λ：边每交叉一次，引力/张力放大 (1+λ) 倍。 */
  crossLambda: number;
  /** 交叉能量罚（绝对单位）：每条边每有一个交叉点，能量加 crossK。
   *  分段常数（无梯度），由能量比较影响线搜索的接受判断 ——
   *  交叉事件即能量台阶；必须压过 μ_e 放大负引力能的降幅。 */
  crossK: number;
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
  /** 近程防穿越墙强度（不随跳数衰减）：k_near = ½k_r。 */
  nearK: number;
  /** 近程防穿越墙作用域：g_near = 0.6L。 */
  nearR: number;
  /** 线间避让斥力全压强度（两条线贴到 d=0 时的力）：k_ee = 30k_a/L²。 */
  kee: number;
  /** 线间避让作用距离：d_ee = 0.35L（线段中心线到中心线）。 */
  dee: number;
  /** subgraph 包含墙强度（成员出界拉回）：k_in = 12k_a/L²。 */
  kin: number;
  /** 隐藏组聚集系数（groupCohesion 选项值）。 */
  groupCohesion: number;
  /** 跨容器张力传导开关（实验性，默认关）。 */
  tensionConduction: boolean;
  /** 线间避让开关（opt-in，默认关）。 */
  lineAvoid: boolean;
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
  /** 每条边的引力乘子 μ_e = 1 + λ×交叉数（每次力场求值时刷新）。 */
  edgeKaMul: number[];
  /** 每条边的交叉点数 X_e（与 edgeKaMul 同步刷新）。 */
  edgeCrossCounts: number[];
  /** 本轮求值的交叉能量罚总额 kCross·ΣX_e（调用方累加进能量）。 */
  crossPenaltyEnergy: number;
  /** 跳数斥力乘子矩阵（n²，拓扑导出）；null = 特性停用（σ 恒 1）。 */
  hopScale: Float32Array | null;
  /** 节点角色（0=free 1=member 2=hub，由 groups 声明派生）。 */
  nodeRole: Int8Array;
  /** 成员/hub → 所属组下标（free 为 -1）。 */
  nodeGroup: Int32Array;
  /** 成员 → 所属 subgraph 的 hub 下标（free/hub 自身为 -1）。 */
  hubOfMember: Int32Array;
  /** hidden-group 聚集束缚：成员下标 + 每成员束缚系数（k_a/L²·cohesion/n）。 */
  hiddenGroups: Array<{ members: number[]; k: number }>;
  /** subgraph 聚集束缚：hub 下标 + 成员下标 + 束缚系数（hub 作为容器锚点）。 */
  subgraphBoxes: Array<{ hub: number; members: number[]; k: number }>;
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
    crossingShrink: number;
    crossingEnergy: number;
    lineAvoidance: number | boolean;
    groupCohesion: number;
    tensionConduction: number | boolean;
  },
  nodeCount: number,
): DerivedParams {
  const L = Math.max(opts.naturalLength, 1e-3);
  const ka = 1;
  // 斥力作用域：间隙达到 2L 时斥力光滑归零（脱离接触后迅速消失）。
  const repR = 2 * L;
  // 交叉收缩系数：≥0。每交叉一次，该边引力+张力放大 (1+λ) 倍。
  const crossLambda = Math.max(opts.crossingShrink, 0);
  // 交叉能量罚：能量单位 k_a/L × crossingEnergy。默认 0.2 时单交叉点
  // 总罚（两条边各记一次）明显大于 μ_e 缩放带来的负弹力能降幅。
  const crossK = Math.max(opts.crossingEnergy, 0) * (ka / L);
  // 校准 kr：无张力时相邻平衡间隙恰为 L —— k_r·(1/L − 1/repR) = k_a。
  const kr = (ka * L * repR) / (repR - L);
  // 近程防穿越墙：远程推挤（0.8L~2L）可按跳数衰减，0.8L 内的贴身排斥
  // 是硬规则（永不衰减）—— 防重叠也防"叶子自由穿越远分支造成交叉"。
  const nearK = 0.5 * kr;
  const nearR = 0.8 * L;
  // 线间避让斥力：两条连线靠近时互相推开（防交叉的主力，原则 8 的力学支撑）。
  // 全压强度 30 倍力单位 —— 需要压过节点互斥与弱引力的向心聚集，
  // 才能把交织的线真正挤开；线性软墙远离即归零，不干扰正常布局。
  const kee = 30 * (ka / (L * L));
  const dee = 0.35 * L;
  const lineAvoid = !!opts.lineAvoidance;
  const tensionConduction = !!opts.tensionConduction;
  // subgraph 容器表面张力：成员出界每 1px 拉回 8·k_a/L³（把成员拢在容器内）。
  const kin = 8 * (ka / (L * L * L));
  const groupCohesion = Math.max(opts.groupCohesion, 0);
  const kw = ka * Math.max(opts.weakGravityRatio, 1e-6);
  // 橡皮筋刚度 k_b = τ·k_a/L³：F = k_b·g 随线长线性增强（连线越长拉力越大），
  // τ=1 时与截断斥力的平衡间隙恰为 naturalLength（k_r(1/L−1/2L)/L² = k_b·L）。
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
    crossLambda,
    crossK,
    nearK,
    nearR,
    kee,
    dee,
    kin,
    groupCohesion,
    lineAvoid,
    tensionConduction,
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

/** 节点对在"逐对循环"里的作用类型：相邻对的引力/张力一律走边循环
 *  （applyEdgeAttraction，按边乘子 μ_e 缩放），这里只剩斥力与弱引力。 */
export type PairKind =
  | 'stranger-pairwise'   // 非相邻：斥力 + k_w 弱引力
  | 'stranger-repulsion'; // 非相邻（centroid 模式或已由边循环算引力）：仅斥力

function pairKind(ctx: ForceContext, adjacent: boolean): PairKind {
  if (adjacent) return 'stranger-repulsion';
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
  scale = 1,
  nearK = 0,
  nearR = 0,
): { f: number; e: number; g: number } {
  // scale=0 语义 = 这一对之间完全没有斥力（subgraph hub vs 其成员）：
  // 远程墙、近程墙、接触弹簧一并豁免 —— 成员位于 hub 内部是期望状态，
  // 不算穿透（防重叠由成员间互斥与包含墙保证）。
  if (scale === 0) return { f: 0, e: 0, g: s };
  // 远程墙（σ 缩放，作用域 repR）+ 近程墙（不缩放，作用域 nearR，防穿越）
  // 两项同为"截断平移平方"势，和的梯度 = 梯度的和，保守性保持。
  let f = 0;
  let e = 0;
  if (s < repR) {
    const inv = 1 / s - 1 / repR;
    f += (kr * m * inv) / (s * s) * scale;
    e += 0.5 * kr * m * inv * inv * scale;
  }
  if (nearK > 0 && s < nearR && s >= gFloor) {
    const invN = 1 / s - 1 / nearR;
    f += (nearK * m * invN) / (s * s);
    e += 0.5 * nearK * m * invN * invN;
  }
  if (s >= gFloor) return { f, e, g: s };
  // 接触弹簧延拓（防重叠不可妥协，永不衰减）：
  // gFloor 处两墙取值线性化 + kv·m·depth 二次硬化。
  let fWall = (kr * m * (1 / gFloor - 1 / repR)) / (gFloor * gFloor) * scale;
  let eWall = 0.5 * kr * m * Math.pow(1 / gFloor - 1 / repR, 2) * scale;
  if (nearK > 0 && nearR > gFloor) {
    fWall += (nearK * m * (1 / gFloor - 1 / nearR)) / (gFloor * gFloor);
    eWall += 0.5 * nearK * m * Math.pow(1 / gFloor - 1 / nearR, 2);
  }
  const kv = kr / Math.pow(gFloor, 4);
  const depth = gFloor - s;
  return {
    f: fWall + kv * m * depth,
    e: eWall + fWall * depth + 0.5 * kv * m * depth * depth,
    g: gFloor,
  };
}

/** 弱引力项（万有引力式 k/g²，仅 stranger-pairwise 弱基础引力使用）。
 *  间隙低于 gFloor 后截断为常力（防止重叠时发散），能量线性延拓 ——
 *  力 = −∂E/∂d 在截断处之后依然精确成立。 */
function attractionTerm(
  k: number,
  m: number,
  s: number,
  gFloor: number,
): { f: number; e: number } {
  if (k === 0) return { f: 0, e: 0 };
  if (s >= gFloor) {
    return { f: (k * m) / (s * s), e: -(k * m) / s };
  }
  const f = (k * m) / (gFloor * gFloor);
  return {
    f,
    e: -(k * m) / gFloor - f * (gFloor - s),
  };
}

/** 连线弹力项（橡皮筋收缩力）：F = k_b·g，E = ½·k_b·g²。
 *  连线越长拉力越大（线性）；g→0 拉力消失（压缩由斥力负责）。
 *  k_b = τ·k_a/L³·μ_e：交叉收缩放大劲度 —— 交叉越多的线收缩力量越大。
 *  间隙低于 gFloor 后按常力线性延拓（力 = −∂E/∂s 精确成立）。 */
function bondTerm(
  kb: number,
  m: number,
  s: number,
  gFloor: number,
): { f: number; e: number } {
  if (kb === 0) return { f: 0, e: 0 };
  if (s >= gFloor) {
    return { f: kb * m * s, e: 0.5 * kb * m * s * s };
  }
  const f = kb * m * gFloor;
  return {
    f,
    e: 0.5 * kb * m * gFloor * gFloor - f * (gFloor - s),
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
  // 跳数斥力衰减：h=1 邻接不衰减，逐跳乘 decay^(h-1)，无关系对乘 floor。
  let scale = ctx.hopScale ? ctx.hopScale[i * ctx.nodes.length + j] : 1;
  // subgraph 的 hub 是"区域"而非实体：hub 与其成员之间无斥力
  // （成员被包含墙约束在 hub 内部区域内，靠近 hub 是期望行为）。
  if (ctx.nodeRole[i] === 2 && ctx.nodeGroup[i] === ctx.nodeGroup[j]) scale = 0;
  if (ctx.nodeRole[j] === 2 && ctx.nodeGroup[j] === ctx.nodeGroup[i]) scale = 0;
  const rep = repulsionTerm(p.kr, m, s, p.gFloor, p.repR, scale, p.nearK, p.nearR);
  // 弱基础引力（相邻对的连线弹力由边循环按 μ_e 缩放施加）
  const kLong = kind === 'stranger-pairwise' ? p.kw : 0;
  const att = attractionTerm(kLong, m, s, p.gFloor);
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
/** 沿边累加相邻节点的橡皮筋弹力（斥力已由逐对/四叉树负责）。
 *  精确与 BH 模式走同一函数：弹力按交叉收缩乘子 μ_e 缩放
 *  （力与能量同乘子，分段保守）。 */
function applyEdgeAttraction(ctx: ForceContext, edgeIndex: number): number {
  const e = ctx.edges[edgeIndex];
  const na = ctx.nodes[e.a];
  const nb = ctx.nodes[e.b];
  const p = ctx.params;
  const dx = na.x - nb.x;
  const dy = na.y - nb.y;
  const d = Math.hypot(dx, dy);
  const m = na.mass * nb.mass;
  const mul = ctx.edgeKaMul[edgeIndex];
  // 橡皮筋弹力：交叉收缩 μ_e 放大劲度（收缩力量更大，收敛更果断）
  const att = bondTerm(p.kt * mul, m, d - na.r - nb.r, p.gFloor);
  const ux = d > 1e-9 ? dx / d : 0;
  const uy = d > 1e-9 ? dy / d : 0;
  na.fx -= att.f * ux;
  na.fy -= att.f * uy;
  nb.fx += att.f * ux;
  nb.fy += att.f * uy;
  // 跨 subgraph 边的张力传导：半力作用于端点所属的 hub ——
  // 容器被内部绷紧的连线拉向对方容器（层与层之间有连线则靠近）。
  // 能量记 ½·att.e（传导半弹簧），与 hub 受力自洽。
  // 张力传导（有界）：跨容器边（成员↔free 或 成员↔异组成员）的弹力按
  // min(半力, 封顶) 传导给成员所属的 hub —— 容器朝连接方向响应，而拉力
  // 有界（不超过 20 力单位），不会把成员拖出容器，也不会发散。
  // 实验开关（默认关）：简单传导会发散，需要专项设计（hub 间引力+阻尼）
  if (!ctx.params.tensionConduction) return att.e;
  const hubA = ctx.hubOfMember[e.a];
  const hubB = ctx.hubOfMember[e.b];
  if (hubA >= 0 || hubB >= 0) {
    const fCap = 60 * ctx.params.forceUnit;
    const fCond = Math.min(0.5 * att.f, fCap);
    if (hubA >= 0) {
      const ha = ctx.nodes[hubA];
      ha.fx -= fCond * ux;
      ha.fy -= fCond * uy;
    }
    if (hubB >= 0) {
      const hb = ctx.nodes[hubB];
      hb.fx += fCond * ux;
      hb.fy += fCond * uy;
    }
    ctx.energy += 0.5 * (fCond / Math.max(att.f, 1e-9)) * att.e;
  }
  return att.e;
}

/** 单次力场求值内刷新交叉项：
 *  μ_e = 1 + λ·X_e（收缩乘子，缩放引力/张力 —— 力与能量同组乘子，分段保守）
 *  与交叉能量罚 kCross·ΣX_e（分段常数，抬高含交叉布局的能量）。
 *  阶段 0（边未启用）、系数全零、边太少或超出计数预算时全部归零/恒 1。 */
const EDGE_CROSSING_TEST_BUDGET = 80_000;

function refreshCrossingTerms(ctx: ForceContext): void {
  const mul = ctx.edgeKaMul;
  const { crossLambda, crossK } = ctx.params;
  if (ctx.stage < 1 || (crossLambda <= 0 && crossK <= 0) || ctx.edges.length < 2) {
    mul.fill(1);
    ctx.edgeCrossCounts.fill(0);
    ctx.crossPenaltyEnergy = 0;
    return;
  }
  const counts = countEdgeCrossings(ctx.nodes, ctx.edges, EDGE_CROSSING_TEST_BUDGET);
  if (counts === null) {
    mul.fill(1);
    ctx.edgeCrossCounts.fill(0);
    ctx.crossPenaltyEnergy = 0;
    return;
  }
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    mul[i] = 1 + crossLambda * counts[i];
    ctx.edgeCrossCounts[i] = counts[i];
    sum += counts[i];
  }
  ctx.crossPenaltyEnergy = crossK * sum;
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
  // 聚合块用代表成员的跳数近似（远块斥力本就趋于 0，近似误差可忽略）；
  // repIndex<0 为空块兜底（不缩放）
  const repIdx = cell.repIndex;
  const scale =
    ctx.hopScale && repIdx >= 0 ? ctx.hopScale[i * ctx.nodes.length + repIdx] : 1;
  const rep = repulsionTerm(p.kr, m, s, p.gFloor, p.repR, scale, p.nearK, p.nearR);
  const kLong = ctx.gravity === 'pairwise' ? p.kw : 0;
  const att = attractionTerm(kLong, m, s, p.gFloor);
  // 调和约束的力关于位置是线性的，按质心聚合是精确的（无近似误差）。
  const fh = ctx.gravity === 'centroid' ? p.kharm * m * dist : 0;
  const net = rep.f - att.f - fh;
  ni.fx += net * ux;
  ni.fy += net * uy;
  cell.aAccX -= (net * ux) / cell.mass;
  cell.aAccY -= (net * uy) / cell.mass;
  return rep.e + att.e + 0.5 * p.kharm * m * dist * dist;
}

/** 两连线的避让斥力（采样点法，严格保守）：
 *  每条边按间距 d_ee 离散成固定参数的采样点 P = lerp(a, b, t)，采样点对
 *  对方线段做"点-线软墙"（与边-节点墙同构）：
 *    E = ½·k_ee·(d_ee − h)²/d_ee   F = k_ee·(d_ee − h)/d_ee   （h = 点到线距离）
 *  采样点是端点的线性插值 → ∂P/∂a = 1−t、∂P/∂b = t，力按插值权重分摊
 *  回两端 —— 力 = −∇E 严格成立（垂足分摊法不满足这一点，已废弃）。
 *  共享端点的邻接边跳过；d ≥ d_ee 的采样对无力。 */
function applyEdgeEdgeInteraction(ctx: ForceContext, ei: number, ej: number): number {
  const e1 = ctx.edges[ei];
  const e2 = ctx.edges[ej];
  if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) return 0;
  const n = ctx.nodes;
  const dee = ctx.params.dee;
  let energy = 0;
  // side1：e1 的采样点 vs e2 线段；side2 反向。共用内联实现。
  for (let side = 0; side < 2; side++) {
    const pa = side === 0 ? n[e1.a] : n[e2.a];
    const pb = side === 0 ? n[e1.b] : n[e2.b];
    const qa = side === 0 ? n[e2.a] : n[e1.a];
    const qb = side === 0 ? n[e2.b] : n[e1.b];
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const samples = Math.min(6, Math.max(1, Math.ceil(len / dee)));
    for (let k = 0; k < samples; k++) {
      const t = (k + 0.5) / samples;
      const px = pa.x + (pb.x - pa.x) * t;
      const py = pa.y + (pb.y - pa.y) * t;
      const q = closestPointOnSegment(px, py, qa.x, qa.y, qb.x, qb.y);
      const dx = px - q.x;
      const dy = py - q.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= dee) continue;
      const h = Math.max(dist, 1e-6);
      const gap = dee - h;
      const f = (ctx.params.kee * gap) / dee;
      let ux = dx / h;
      let uy = dy / h;
      if (!Number.isFinite(ux) || !Number.isFinite(uy) || Math.abs(ux) + Math.abs(uy) < 1e-12) {
        const dir = jitterDirection(ei * 131 + ej * 7 + k, side * 977 + ej);
        ux = dir.x;
        uy = dir.y;
      }
      // 采样点受力 → 按插值权重回端点；反作用按垂足重心给对方两端
      const wa = 1 - t;
      pa.fx += f * ux * wa;
      pa.fy += f * uy * wa;
      pb.fx += f * ux * t;
      pb.fy += f * uy * t;
      const wqa = 1 - q.t;
      qa.fx -= f * ux * wqa;
      qa.fy -= f * uy * wqa;
      qb.fx -= f * ux * q.t;
      qb.fy -= f * uy * q.t;
      energy += (0.5 * ctx.params.kee * gap * gap) / dee;
    }
  }
  return energy;
}

/** 组束缚力（精确与 BH 共用，O(成员数)）：
 *  - hidden-group：成员到组质心的简谐束缚（平行轴定理下等价于组内全对
 *    弹簧，保守、总合力零）—— "隐藏组内的节点倾向于聚集在一起"；
 *  - subgraph：成员出界软墙 —— 成员中心保持在 hub 内部区域内，
 *    g_out = d + member.r − rIn > 0 时向心拉回，E = ½k·g_out²/rIn；
 *    反作用推 hub（容器被成员向外顶），hub 由全局力场定位。 */
/** 组聚集的质心简谐束缚：成员到锚点的线性弹力（保守、合力零）。
 *  anchor 为坐标；返回该组势能。 */
function pullToAnchor(
  ctx: ForceContext,
  members: number[],
  k: number,
  anchorX: number,
  anchorY: number,
): number {
  let e = 0;
  for (const idx of members) {
    const nd = ctx.nodes[idx];
    const fx = (k * nd.mass) * (anchorX - nd.x);
    const fy = (k * nd.mass) * (anchorY - nd.y);
    nd.fx += fx;
    nd.fy += fy;
    e += 0.5 * k * nd.mass * ((nd.x - anchorX) ** 2 + (nd.y - anchorY) ** 2);
  }
  return e;
}

function applyGroupForces(ctx: ForceContext): number {
  let energy = 0;
  for (const hg of ctx.hiddenGroups) {
    const m = hg.members.length;
    if (m === 0) continue;
    let cx = 0;
    let cy = 0;
    for (const idx of hg.members) {
      cx += ctx.nodes[idx].x;
      cy += ctx.nodes[idx].y;
    }
    cx /= m;
    cy /= m;
    energy += pullToAnchor(ctx, hg.members, hg.k, cx, cy);
  }
  for (const box of ctx.subgraphBoxes) {
    if (box.members.length === 0) continue;
    const hub = ctx.nodes[box.hub];
    // 锚点 = hub。hub 与成员间无斥力（成员在容器内是期望状态）。
    energy += pullToAnchor(ctx, box.members, box.k, hub.x, hub.y);
    // hub 斥力域自适应：包围全部成员（成员被束缚 → maxD 有界 → 不爆炸）。
    let maxD = 0;
    for (const idx of box.members) {
      const nd = ctx.nodes[idx];
      maxD = Math.max(maxD, Math.hypot(nd.x - hub.x, nd.y - hub.y) + nd.r);
    }
    hub.r = Math.max(hub.baseR, maxD + 2);
  }
  return energy;
}


/** 遍历全部边-边候选对（网格给候选，ei<ej 去重）施加线间避让。 */
function applyEdgeEdgeAvoidance(ctx: ForceContext, grid: SpatialGrid): void {
  const m = ctx.edges.length;

  for (let i = 0; i < m; i++) {
    const a = ctx.nodes[ctx.edges[i].a];
    const b = ctx.nodes[ctx.edges[i].b];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const r = Math.hypot(b.x - a.x, b.y - a.y) / 2 + ctx.params.dee;
    grid.query(mx, my, r, (item) => {
      if (item.kind !== 0) return; // 跳过标签 item（BH 网格共用，否则线间斥力翻倍）
      const j = item.edgeIndex;
      if (j <= i) return;
      if ((i === 112 || j === 112) && typeof (globalThis as any).__eeAcc !== 'undefined') {
        const g8 = (globalThis as any).__eeAcc[(globalThis as any).__mode] ??
          ((globalThis as any).__eeAcc[(globalThis as any).__mode] = { n: 0, fx: 0, fy: 0 });
        g8.n++;
      }
      ctx.energy += applyEdgeEdgeInteraction(ctx, i, j);
    });
  }
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
  if (typeof (globalThis as any).__mode !== 'undefined') (globalThis as any).__mode = 'exact';
  resetForces(ctx);
  const n = ctx.nodes.length;
  const edgesActive = ctx.stage >= 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      ctx.energy += applyNodePair(ctx, i, j, pairKind(ctx, edgesActive && ctx.adj[i].has(j)));
    }
  }
  // 相邻弹力：与 BH 模式同一条路径（按交叉收缩乘子 μ_e 缩放，
  // 并累加交叉能量罚 —— 交叉点越多的布局含能量越高）。
  if (ctx.stage >= 1) {
    refreshCrossingTerms(ctx);
    for (let ei = 0; ei < ctx.edges.length; ei++) {
      ctx.energy += applyEdgeAttraction(ctx, ei);
    }
    ctx.energy += ctx.crossPenaltyEnergy;
    // 线间避让斥力：交叉在力学上直接被挤开（原则 8 的力学支撑，opt-in）
    if (ctx.params.lineAvoid && ctx.edges.length > 1) {
      const grid = new SpatialGrid(Math.max(ctx.params.dee * 2, 1));
      ctx.edges.forEach((e, i) => {
        const a = ctx.nodes[e.a];
        const b = ctx.nodes[e.b];
        grid.insert(
          Math.min(a.x, b.x), Math.min(a.y, b.y),
          Math.max(a.x, b.x), Math.max(a.y, b.y),
          { kind: 0 as const, edgeIndex: i, stamp: 0 },
        );
      });
      if (ctx.params.lineAvoid) applyEdgeEdgeAvoidance(ctx, grid);
    }
    ctx.energy += applyGroupForces(ctx);
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
  if (typeof (globalThis as any).__mode !== 'undefined') (globalThis as any).__mode = 'bh';
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

  // 2. 沿边累加相邻弹力（按 μ_e 缩放）+ 交叉能量罚
  if (ctx.stage >= 1) {
    refreshCrossingTerms(ctx);
    for (let ei = 0; ei < ctx.edges.length; ei++) {
      ctx.energy += applyEdgeAttraction(ctx, ei);
    }
    ctx.energy += ctx.crossPenaltyEnergy;
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
  // 线间避让斥力：必须在 edgeItems 插入网格之后（原则 8 的力学支撑，opt-in）
  if (ctx.stage >= 1 && ctx.params.lineAvoid && ctx.edges.length > 1) {
    applyEdgeEdgeAvoidance(ctx, grid);
  }
  ctx.energy += applyGroupForces(ctx);
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
