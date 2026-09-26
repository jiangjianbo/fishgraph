/**
 * 网格空间的基础几何类型（点 / 尺寸 / 包围盒）。
 *
 * 坐标为整数格下标；包围盒采用半开区间口径（相切不算重叠）。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  width: number;
  height: number;
}

/** 有位置的包围盒（左上角 + 尺寸）—— 障碍物/节点 AABB 的统一形态。 */
export interface Box extends Bounds {
  x: number;
  y: number;
}

