/**
 * 抽象空间流形上下文（Space Context）—— 泛型化布局算法的空间原语接缝。
 *
 * 同一套布局算法逻辑只需传入不同的空间上下文，即可适应离散网格与
 * 连续平面（doc/布局核心原则.md「泛型化可复用布局算法架构」）：
 *  - GridSpaceContext：整数格坐标、曼哈顿度量、AABB 格子占用、插行列扩容、
 *    A* 栅格寻路 —— 主布局引擎；
 *  - ContinuousSpaceContext：浮点坐标、欧氏度量、连续 AABB 碰撞、
 *    梯度方向步进 —— 自由坐标模式（以网格解为初始解做短弛豫）。
 */

/** 泛型点坐标：T 在语义上区分整数格坐标与浮点像素坐标。 */
export interface Point<T extends number = number> {
  x: T;
  y: T;
}

/** 泛型包围盒尺寸（宽高，同一坐标单位）。 */
export interface Bounds<T extends number = number> {
  width: T;
  height: T;
}

/** 有位置的包围盒（左上角 + 尺寸）—— 障碍物/节点 AABB 的统一形态。 */
export interface Box<T extends number = number> extends Bounds<T> {
  x: T;
  y: T;
}

/**
 * 空间原语集合：布局算法只通过本接口感知空间，不直接写死坐标运算。
 * @typeParam T 坐标数值类型（现阶段均为 number，语义上区分格/像素）。
 */
export interface SpaceContext<T extends number = number> {
  /** 空间种类判别符（'grid' = 离散网格，'continuous' = 连续平面）。 */
  readonly kind: 'grid' | 'continuous';

  /** 距离度量：网格用曼哈顿 |dx|+|dy|，连续用欧氏 √(dx²+dy²)。 */
  distance(a: Point<T>, b: Point<T>): number;

  /**
   * 碰撞检测：两个 AABB 是否重叠。坐标为包围盒左上角。
   * 网格与连续均采用半开区间口径 —— 边界相切不算重叠。
   */
  isOverlapped(posA: Point<T>, sizeA: Bounds<T>, posB: Point<T>, sizeB: Bounds<T>): boolean;

  /**
   * 邻域搜索/步进候选：网格沿 (±step, 0)/(0, ±step) 网格点，
   * 连续沿 8 个方向单位矢量 × step。返回顺序固定（确定性）。
   */
  getNeighbors(current: Point<T>, step: T): Point<T>[];

  /**
   * 动态空间开辟：保证目标 AABB 可用。
   * 网格在空间不足时插入行/列把已占用格整体平移让位（会改变其他
   * 已占用格的坐标）；连续空间无限，恒为空操作。
   * @returns 是否发生了扩容（连续上下文恒为 false）。
   */
  expandSpaceIfNeeded(pos: Point<T>, size: Bounds<T>): boolean;

  /**
   * 走线寻路：返回路径点序列（首尾必为 source/target，中间为拐点）。
   * 网格在自由通道格中做 A* 正交寻路（含拐点惩罚）；连续当前返回
   * 直线降级（完整避障走线属走线层的后续工作）。找不到路径时返回
   * null（显式失败，不静默降级）。
   */
  routeEdge(source: Point<T>, target: Point<T>, obstacles: Box<T>[]): Point<T>[] | null;
}
