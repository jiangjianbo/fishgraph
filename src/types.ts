/** 图谱输入与布局输出的公共类型。 */

/** 元素 id：物理节点与 subgraph 容器共用同一 id 域（外部边可直接以容器 id 为端点）。 */
export type ElementId = string | number;

/** 向后兼容别名（历史口径：节点 id）。 */
export type NodeId = ElementId;

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

/** 元素声明公共接口：物理节点与 subgraph 容器共享 id 与文字。 */
export interface ElementSpec {
  id: ElementId;
  /** 文字。布局阶段 3 会让节点有效半径变大以容纳文字。 */
  label?: string;
}

export interface NodeSpec extends ElementSpec {
  /** 缺省为默认圆（r=10）。 */
  shape?: ShapeSpec;
  /** 参与引力的质量，默认 1。 */
  mass?: number;
  /** 可选的初始位置（两维都给才生效）。 */
  x?: number;
  y?: number;
  /** 固定节点：不受力移动，但仍对其他节点施力。 */
  fixed?: boolean;
}

/**
 * 分组声明的公共部分（抽象）：subgraph 与 hidden-group 的统一成员语义。
 * 用户不直接使用本类型 —— 按"有无固定边界"二选一：
 * 有边界用 {@link SubgraphSpec}，仅聚类用 {@link HiddenGroupSpec}。
 */
export interface GroupSpec extends ElementSpec {
  /** 组内成员（元素 id）。 */
  members: ElementId[];
}

/**
 * subgraph：有固定边界/物理实体的分组。布局时物化为一个"巨大号的节点"
 * （容器参与碰撞与排斥），成员被约束在其内部区域内；外部连线可直接以
 * group.id 为端点。
 */
export interface SubgraphSpec extends GroupSpec {
  /** 容器形状（必填：声明形状即声明了它是物理实体）。 */
  shape: ShapeSpec;
  /** 成员包裹后外扩的内边距（px，缺省 2）。 */
  padding?: number;
}

/**
 * hidden-group：无边界、不可见的分组。布局时不产生任何实体，
 * 仅对成员施加"尽量聚集"的向心引力束缚（物化为 ClusterConstraint）。
 */
export interface HiddenGroupSpec extends GroupSpec {
  /**
   * 聚集强度（成员到组质心的简谐束缚，越大组内越紧凑）。
   * 缺省用全局 LayoutOptions.groupCohesion。
   */
  attractionStrength?: number;
}

export interface EdgeSpec {
  source: ElementId;
  target: ElementId;
  /** 附加在边中点的文字。 */
  label?: string;
}

export interface GraphSpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /**
   * subgraph 声明（有固定边界的物理容器）。GraphStore 工厂会把每个声明
   * 物化为一个 LayoutSubgraphNode（参与碰撞/排斥的大节点）。
   */
  subgraphs?: SubgraphSpec[];
  /**
   * hidden-group 声明（无边界、仅聚类）。GraphStore 工厂会把每个声明
   * 物化为一个 ClusterConstraint（力导向迭代时的辅助向心引力）。
   * 可不声明；需要自动分组时，先调用 detectHiddenGroups 按拓扑推断，
   * 再把结果作为 hiddenGroups 传入（库内不会自动推断）。
   */
  hiddenGroups?: HiddenGroupSpec[];
}

export type GravityMode = 'pairwise' | 'centroid';
export type AccuracyMode = 'exact' | 'barnes-hut';

/**
 * 分阶段弛豫的力阶段（策略内部调度概念，供动画/调试观察进度）：
 *  0 = 只有节点力场；1 = 加入连线；2 = 加入避让与边文字；3 = 节点文字生效。
 */
export type LayoutStage = 0 | 1 | 2 | 3;

export interface LayoutOptions {
  /**
   * 布局算法（策略名）。默认 'force-undirected'（无向力导向基础算法）。
   * 内置：'force-undirected' | 'force-directed' | 'grid-undirected' |
   * 'group-undirected' | 'circle'；可用 registerStrategy 注册自定义策略。
   * 'force-undirected'：均匀分布、结构对称、无交叉的紧凑布局
   * （质点网格粗布局 → 膨胀压实 → 短弛豫微调，见 doc/布局核心原则.md）。
   * 'force-directed'：有向图布局 —— 在无向基础算法上派生，叠加层级解环、
   * 软层级引导放置与方向流动势能，配合 direction 指定流动方向。
   * 'group-undirected'：无向分组布局 —— 深度优先递归的复合布局：组内成员
   * 先用同一套流水线递归布局，组折叠为一个"巨大号的单元"（单元半径 =
   * 内部块包围半径）参与外层布局，最后把内部块平移映射到单元最终位置。
   * 消费 subgraphs 与 hiddenGroups 声明（含嵌套；成员重叠抛错）。
   * 运行时切换用 layout.setStrategy(name)（保留图数据，重新初始化位置）。
   */
  algorithm?: string;
  /**
   * 有向图流动方向（算法：force-directed，默认 'TB'）。
   * 'TB' = 自顶向下（top→bottom，边 target 在 source 下方）；
   * 'LR' = 自左向右（left→right，边 target 在 source 右方）。其他算法不消费。
   */
  direction?: 'TB' | 'LR';
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
   * 交叉能量罚（默认 0.05，单位 k_a/L）：每条边每有一个交叉点，总能量加
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
   * hidden-group 聚集强度全局默认值（默认 3，算法：force-group）：
   * HiddenGroupSpec.attractionStrength 未声明时生效。成员到组质心的
   * 简谐束缚（相对力单位 k_a/L²、按成员数归一）。纯力导向不消费本项。
   */
  groupCohesion?: number;
  /**
   * 坐标系（注册名，默认 'grid'）。布局完成后以最优布局为基础做一次
   * 坐标修正（CoordinateSystem.refine）：'grid' 网格化吸附（就近格点 +
   * 冲突消解，保证不重叠）。可用 registerCoordinateSystem 注册自定义
   * 坐标系（hex/polar 等）。
   */
  coordinateSystem?: string;
  /**
   * 网格吸附间距（px）。默认 = naturalLength。
   * 实际吸附保证任意两节点不重叠（必要时自动放大间距或就近挪格）。
   */
  gridSize?: number;
  /**
   * 跨容器张力传导（实验性，默认 false，算法：force-group）：跨容器连线的
   * 张力按有界比例传导给两端容器（hub），使容器朝连接方向靠近。已知问题：
   * 简单传导与容器互斥/弱引力平衡后仍可能振荡，需要专项的引力+阻尼设计。
   */
  tensionConduction?: boolean;
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
  /** 随机初始化 / 抖动的种子，固定则结果可复现。 */
  seed?: number;
  /** 单步最大位移（相对 naturalLength 的比例）。 */
  maxStepRatio?: number;
  /**
   * 连线方向对齐强度（相对力单位 k_a）：连线落在水平/垂直方向能量最低，
   * ±45° 稍高，其余角度更高 —— 温和鼓励图形成横平竖直（兼对角）的排列感。
   * 纯切向内力（合力恒零），只转边不改边长。
   * 开关（opt-in）：默认 0 = 关闭，需要排列感时显式设置正值（如 0.1）开启。
   */
  edgeAngleAlignment?: number;
  /**
   * 走线通道宽度（格，算法：grid-undirected）：通道约束压实把相邻占用
   * 行/列之间的空隙压缩到恰好不小于本值 —— 相邻节点 AABB 之间天然留出
   * 走线走廊（Channel Safety Margin）。默认 1；0 = 不留通道（压到贴邻）。
   */
  channelMargin?: number;
}

export interface RunOptions {
  maxIterations?: number;
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
  id: ElementId;
  x: number;
  y: number;
  /** 等效包围圆半径（统一形状的派生值：hypot(外接矩形半宽, 半高)，含文字外扩）。 */
  readonly r: number;
  /** 力学外接矩形（AABB）半宽（形状半尺寸 + 文字外扩，统一计算）。 */
  readonly hw: number;
  /** 力学外接矩形（AABB）半高。 */
  readonly hh: number;
  shape: ShapeSpec;
  label?: string | null;
  fixed: boolean;
  /**
   * 物化 AABB 物理宽/高（px，算法：grid-undirected）—— 中心 (x,y) +
   * 半宽高即节点包围盒；力导向等连续布局不产生本字段（用 r 包围圆）。
   */
  w?: number;
  h?: number;
}

/**
 * 布局完成后的 subgraph 容器视图。渲染约定：**作为背景层最先绘制**，
 * 成员与其它节点绘制在其上 —— 否则容器矩形会盖住内部节点。
 */
export interface SubgraphView {
  id: ElementId;
  x: number;
  y: number;
  /** 等效包围圆半径（统一形状的派生值；真实形状见 shape —— 成员实占动态矩形）。 */
  readonly r: number;
  /** 真实形状（成员实占包围盒 + padding 的动态矩形）。 */
  shape: ShapeSpec;
  /** 声明形状快照（成员钳制上界与初始分布画布）。 */
  declaredShape: ShapeSpec;
  label?: string | null;
  /** 成员包裹内边距。 */
  padding: number;
  /** 成员元素 id（结构上允许嵌套 subgraph 容器 id）。 */
  children: ElementId[];
}
