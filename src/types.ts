/** 图谱输入与布局输出的公共类型。 */

export type NodeId = string | number;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 节点形状。布局内部用包围圆做节点-节点力，
 * 用精确 SDF（带符号距离函数）做边/标签避让。
 */
export type ShapeSpec =
  | { kind: 'circle'; r: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'rect'; w: number; h: number };

export interface NodeSpec {
  id: NodeId;
  shape?: ShapeSpec;
  /** 节点文字。布局阶段 3 会让节点有效半径变大以容纳文字。 */
  label?: string;
  /** 参与引力的质量，默认 1。 */
  mass?: number;
  /** 可选的初始位置（两维都给才生效）。 */
  x?: number;
  y?: number;
  /** 固定节点：不受力移动，但仍对其他节点施力。 */
  fixed?: boolean;
}

export interface EdgeSpec {
  source: NodeId;
  target: NodeId;
  /** 附加在边中点的文字。 */
  label?: string;
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

export type GravityMode = 'pairwise' | 'centroid';
export type AccuracyMode = 'exact' | 'barnes-hut';
export type InitMode = 'bfs' | 'circle' | 'grid' | 'random';

export interface LayoutOptions {
  /**
   * 自然边长：相邻节点表面的平衡间距（不是中心距）。
   * 由核力常数校准导出：无张力时平衡间隙 g* = naturalLength。
   * 斥力作用域 = 2 × naturalLength，间隙达到作用域时斥力光滑归零。
   */
  naturalLength?: number;
  /**
   * 弱基础引力系数 k_w = weakGravityRatio × k_a。
   * 非相邻节点对的平衡间隙 g = 1/(k_w/k_r + 1/(2L))，饱和于斥力作用域
   * （陌生人比朋友远，但远到作用域边缘就再不推开 —— 图整体趋紧凑）。
   */
  weakGravityRatio?: number;
  /** 边-节点避让斥力倍率：k_en = edgeNodeRepulsion × k_r。 */
  edgeNodeRepulsion?: number;
  /**
   * 边的线性张力（橡皮筋）：拉力 = edgeTension × (k_a/L³) × g，g 为节点外部
   * 空隙中的线长（节点内部的那截不贡献拉力）。连线越长拉力线性增强，
   * 能量 ½k_t·g² 随长度二次增长。取值含义：g = L 时张力是引力的倍数。
   */
  edgeTension?: number;
  /** 是否让边文字包围盒温和推开节点，避免文字被盖住。 */
  labelCollision?: boolean;
  /** 估算文字包围盒用的字号（px）。 */
  labelFontSize?: number;
  /** 文字包围盒外扩留白（px）。 */
  labelPadding?: number;
  /** 弱引力的实现方式：任意节点对之间（pairwise）或朝向质心（centroid）。 */
  gravity?: GravityMode;
  /** centroid 模式下每节点受到的恒定引力强度（相对力单位 k_a/L²）。 */
  centroidStrength?: number;
  /** 节点-节点斥力的计算方式。 */
  accuracy?: AccuracyMode;
  /** Barnes-Hut 张开判据：cellSize / distance < theta 时聚合。 */
  theta?: number;
  /** 初始摆放方式。'bfs' 按度数优先、逐层环状增量放置（推荐）。 */
  init?: InitMode;
  /** 随机初始化 / 抖动的种子，固定则结果可复现。 */
  seed?: number;
  /** 单步最大位移（相对 naturalLength 的比例）。 */
  maxStepRatio?: number;
}

export interface RunOptions {
  maxIterations?: number;
  /**
   * 分阶段弛豫（默认 true，对应"先排节点 → 加连线微调 → 加边文字 → 加节点文字"）：
   * 阶段 0 只有力场（斥力+弱引力），阶段 1 加入连线，阶段 2 加入避让与边文字，
   * 阶段 3 节点文字生效（节点有效半径变大）。false 则一步到位全量力场。
   */
  staged?: boolean;
  /** 每个被接受的步进后回调（用于动画）。 */
  onTick?: () => void;
}

export interface RunResult {
  iterations: number;
  converged: boolean;
  energy: number;
}

/** 布局完成后的节点视图（坐标为只读快照引用）。 */
export interface NodeView {
  id: NodeId;
  x: number;
  y: number;
  /** 有效包围半径（阶段 3 含节点文字）。 */
  r: number;
  shape: ShapeSpec;
  label?: string | null;
  fixed: boolean;
}
