/**
 * 尺寸映射策略 —— 逻辑布局 ↔ 现实尺寸的可替换接缝（2026-09-27 定稿）。
 *
 * 同一策略在两个方向被消费：
 *  - 正向（供逻辑布局）：元素 px 盒 → 矩形基准格（cellW/cellH 宽高独立）
 *    + 各元素宽高格数 gw/gh —— 布局据此确定基准节点与各节点的膨胀占格；
 *  - 反向（供渲染）：逻辑格解 → 世界坐标可渲染图（RenderGraph）——
 *    入口是逻辑布局，出口带自由坐标；渲染端拿到出口自行决定缩放与
 *    绘制方式，不感知网格。
 *
 * 扩展维度（当前默认实现 = 现状口径，接口预留）：
 *  - measureBox：文字折行判据（面积最小；周长平局待接）、行距系数
 *    （现状 lineH = 字号，无行距）、字体族测量（现状 0.75 字宽比例估算）；
 *  - grade：聚类方式（现状宽/高独立锚定聚类，容差 1.25）；
 *  - render：比例尺、对齐相位、归零方式（现状 AABB 中心 + 质心归零）。
 */

import type { ShapeSpec, Vec2 } from '../../types.js';
import type { BoxSize, GradeBasis } from '../grade.js';
import type { Box, Point } from '../grid-undirected/space-types.js';

/** 元素度量输入（供 measureBox 覆盖；缺省度量不消费 font 之外的字段）。 */
export interface MetricElementInfo {
  label: string | null;
  shape: ShapeSpec;
  /** 文字度量参数（store 的 labelFontSize / labelPadding）。 */
  font: { size: number; padding: number };
}

/** 一条边的逻辑格走线（映射策略入口的一部分）。 */
export interface LayoutRoute {
  source: number;
  target: number;
  /**
   * 格点序列（首尾 = 端口边界格）：物理化时按格心 (p+0.5)·格距换算。
   */
  cells: Point[];
  /**
   * 退化直线的精确格端点（格坐标浮点，物理化直接乘格距、不做 +0.5 格
   * 心偏移）—— 正交寻路无可行路径时降级「元素中心到元素中心」，端点
   * 必须落在几何中心而非某格的格心。
   */
  exact?: [Vec2, Vec2];
}

/** 逻辑格解（布局产物，映射策略的入口）。 */
export interface LayoutSolution {
  /** 元素格 AABB（左上格 + 格宽高；与 store.elements 同序，含容器）。 */
  boxes: Box[];
  /** 每条边的格走线（与 store.edges 同序）。 */
  routes: LayoutRoute[];
  /**
   * 容器实占包裹的额外内边距（px；非容器为 null）—— 容器渲染 shape =
   * 格 AABB × 格距 + 两侧 padding。
   */
  containerPaddings: Array<number | null>;
}

/** 可渲染图的节点 AABB（左上角 + 宽高，世界坐标）。 */
export interface RenderNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 可渲染图的一条边（世界坐标拐点，含首尾端点）。 */
export interface RenderEdge {
  source: number;
  target: number;
  waypoints: Vec2[];
}

/** 可渲染图（映射策略的出口：带自由坐标，渲染端自行缩放绘制）。 */
export interface RenderGraph {
  /** 元素 AABB（与 store.elements 同序）。 */
  nodes: RenderNode[];
  /**
   * 容器实占 shape（世界坐标；非容器为 null）。渲染端作为背景层绘制，
   * 布局与走线不消费 padding。
   */
  containerShapes: Array<ShapeSpec | null>;
  /** 边走线（与 store.edges 同序）。 */
  edges: RenderEdge[];
}

/** 矩形基准格距（px/格，物理化的比例尺；x 轴 cellW、y 轴 cellH）。 */
export interface GridCellMetric {
  cellW: number;
  cellH: number;
}

/** 尺寸映射策略（顶层聚合：度量 → 分级 → 物理化）。 */
export interface MetricStrategy {
  readonly name: string;
  /**
   * 尺寸度量（可选覆盖；缺省 = 形状声明 ∨ 文字盒取大，文字盒按
   * estimateLabelBox 面积最小折行）。返回元素的物理盒（px）。
   */
  measureBox?(el: MetricElementInfo): BoxSize;
  /** 正向：全部元素 px 盒 → 矩形基准格 + 各元素宽高格数。 */
  grade(boxes: readonly BoxSize[]): GradeBasis;
  /** 反向：逻辑格解 + 基准格距 → 世界坐标可渲染图。 */
  render(solution: LayoutSolution, cells: GridCellMetric): RenderGraph;
}
