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
  /**
   * 分组声明。有 shape 的组是 **subgraph**：布局时生成一个虚拟大节点
   * （外部连线可直接以 group.id 为端点），成员被约束在其内部区域内；
   * 无 shape 的组是 **hidden-group**：不产生可见实体，仅对成员施加
   * "聚集在一起"的束缚（形状 = 成员包围盒）。
   * groups 也可不声明，由 detectHiddenGroups 按拓扑自动推断。
   */
  groups?: GroupSpec[];
}

export interface GroupSpec {
  id: NodeId;
  /** 声明形状 → subgraph；省略 → hidden-group。 */
  shape?: ShapeSpec;
  label?: string;
  /** 组内成员（节点 id）。 */
  members: NodeId[];
}

export type GravityMode = 'pairwise' | 'centroid';
export type AccuracyMode = 'exact' | 'barnes-hut';
export type InitMode = 'bfs' | 'circle' | 'grid' | 'random';

/**
 * 分阶段弛豫的力阶段（策略内部调度概念，供动画/调试观察进度）：
 *  0 = 只有节点力场；1 = 加入连线；2 = 加入避让与边文字；3 = 节点文字生效。
 */
export type LayoutStage = 0 | 1 | 2 | 3;

export interface LayoutOptions {
  /**
   * 布局算法（策略名）。默认 'force-directed'（力导向）。
   * 内置：'force-directed' | 'circle'；可用 registerStrategy 注册自定义策略。
   * 运行时切换用 layout.setStrategy(name)（保留图数据，重新初始化位置）。
   */
  algorithm?: string;
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
   * 连线弹力刚度倍率 τ（默认 1）：相邻节点之间的橡皮筋收缩力
   * F = τ·(k_a/L³)·g —— 连线越长拉力越大，g→0 拉力消失。
   * τ=1 时无交叉的平衡间隙恰为 naturalLength；更大则收得更紧。
   */
  edgeTension?: number;
  /**
   * 交叉收缩系数 λ（默认 0.15）：一条边每与其他边交叉一次，它的引力与
   * 张力就放大 (1+λ) 倍 —— 交叉越多的线收缩越强，交叉在能量上天然趋于消解。
   * 交叉计数在每次力场求值时按当前坐标重算，力与能量用同一组乘子
   * （分段保守，能量单调下降不受影响）；大图超出计数预算时自动停用。
   */
  crossingShrink?: number;
  /**
   * 交叉能量罚（默认 0.2，单位 k_a/L）：每条边每有一个交叉点，总能量加
   * crossingEnergy × (k_a/L) —— 交叉点越多的布局含能量越高。该项是分段
   * 常数势垒：不产生力，但通过能量比较影响线搜索的取舍（交叉事件即
   * 能量台阶），与 crossingShrink 的收缩力互补。
   */
  crossingEnergy?: number;
  /**
   * 线间避让斥力（默认 false）：两条连线中心线靠近到 0.35L 内时互相排斥，
   * 力学上直接挤开交叉。适用于稀疏流程图/树图；全连接图（边必然互相
   * 穿过中心区域）与高密度图应保持关闭，否则结构被边-边互斥撑坏。
   */
  lineAvoidance?: boolean;
  /**
   * 隐藏组聚集强度（默认 3）：hidden-group 的成员到组质心的简谐束缚强度
   * （相对力单位 k_a/L²、按成员数归一）。越大组内越紧凑。
   */
  groupCohesion?: number;
  /**
   * 坐标系（注册名，默认 'free'）。布局完成后以最优布局为基础做一次
   * 坐标修正（CoordinateSystem.refine）：'free' 恒等；'grid' 网格化吸附
   * （就近格点 + 冲突消解，保证不重叠）。可用 registerCoordinateSystem
   * 注册自定义坐标系（hex/polar 等）。
   */
  coordinateSystem?: string;
  /**
   * 网格间距（px，coordinateSystem: 'grid' 时生效）。默认 = naturalLength。
   * 实际吸附保证任意两节点不重叠（必要时自动放大间距或就近挪格）。
   */
  gridSize?: number;
  /**
   * 跳数斥力衰减（默认 0.7）：图上相距 2..3 跳的两节点，中程斥力乘
   * hopRepulsionDecay^(h−1)。邻接对（h=1）不衰减、键合平衡不变。
   * 跳数 > 3 的节点对与不同分量的节点对一样，远程斥力基本消失
   * （只乘 unrelatedRepulsion 下限防接触粘连）。
   * 防重叠的接触弹簧不衰减。设为 1 关闭本规则。
   */
  hopRepulsionDecay?: number;
  /**
   * 远程斥力下限系数（默认 0.35）：跳数 > 3 或不同连通分量（无直接或
   * 间接关系）的节点对，中程斥力乘该系数 —— 基本没有远程斥力，
   * 重叠仍由接触弹簧坚决阻止。节点数超过 3000 时自动停用。
   */
  unrelatedRepulsion?: number;
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
