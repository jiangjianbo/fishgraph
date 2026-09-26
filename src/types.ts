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
  /** 可选的初始位置（两维都给才生效）。 */
  x?: number;
  y?: number;
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
}

export interface LayoutOptions {
  /**
   * 布局算法（策略名）。默认 'grid-undirected'（纯网格布局，唯一主引擎）。
   * 内置：'grid-undirected' | 'circle'（最小环形，验证策略接缝）；
   * 可用 registerStrategy 注册自定义策略。
   * 运行时切换用 layout.setStrategy(name)（保留图数据，重新布局）。
   */
  algorithm?: string;
  /**
   * 流动方向（grid-undirected 的布局模式，默认 'none' = 无向放置）：
   *  - 'none'：无向波纹放置（张力 − 环周长 + 环内方位分类）；
   *  - 'TB'：有向层级布局，自顶向下（解环 + 最长路径分层，节点钉在
   *    自己的层级行上，所有边顺流——target 在 source 下方或同层下游）；
   *  - 'LR'：自左向右（层排列成列）。
   */
  direction?: 'none' | 'TB' | 'LR';
  /**
   * 自然边长（格）：粗布局格胞 = 本值 × 比例尺（grade.ts 分级基准），
   * 相邻节点表面的目标间隙。默认 6。
   */
  naturalLength?: number;
  /** 是否让边文字参与占位（文字盒并入节点格宽高），避免文字被盖住。 */
  labelCollision?: boolean;
  /** 估算文字包围盒用的字号（px）。 */
  labelFontSize?: number;
  /** 文字包围盒外扩留白（px）。 */
  labelPadding?: number;
  /** 随机初始化 / 抖动的种子，固定则结果可复现。 */
  seed?: number;
  /**
   * 走线通道宽度（格）：通道约束压实把相邻占用行/列之间的空隙压缩到
   * 恰好不小于本值 —— 相邻节点 AABB 之间天然留出走线走廊（Channel
   * Safety Margin）。默认 1；0 = 不留通道（压到贴邻）。
   */
  channelMargin?: number;
}

export interface RunOptions {
  maxIterations?: number;
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
  /**
   * 物化 AABB 物理宽/高（px，grid-undirected 产物）—— 中心 (x,y) +
   * 半宽高即节点包围盒。
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
