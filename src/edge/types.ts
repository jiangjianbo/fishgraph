/**
 * 连线风格策略 —— 连线渲染几何的可替换接缝。
 *
 * 连线"长什么样"由四个正交维度决定，各自抽象为独立接口、以实现类替换：
 *   1. PortStrategy     端点对接位置（固定四点 / 同侧均匀分布 …）；
 *   2. PathStrategy     路径风格（正交折线 / 直线 / 贝塞尔 / 斜折线分散 …）；
 *   3. CornerStrategy   转弯风格（直角 / 任意半径圆角 …）；
 *   4. CrossingStrategy 交叉风格（平交 / 立交跳线 …）。
 *
 * 全部策略只做纯几何计算（输入布局输出，输出路径段），不持有图数据、
 * 不触碰画布 —— 渲染端（canvas/svg）只需翻译 PathSegment。
 */

import type { Vec2 } from '../types.js';

/**
 * 路径段（canvas 路径命令的几何等价物，起点 = 上一段终点）。
 *  - line   直线段；
 *  - arc    圆弧段（canvas arc 语义：圆心 + 半径 + 起止角 + 方向）；
 *  - bezier 三次贝塞尔段。
 */
export type PathSegment =
  | { kind: 'line'; to: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; startAngle: number; endAngle: number; ccw: boolean }
  | { kind: 'bezier'; cp1: Vec2; cp2: Vec2; to: Vec2 };

/** 一条连线的几何路径：起点 + 后续段序列。 */
export interface EdgePath {
  start: Vec2;
  segments: PathSegment[];
}

/** 连线端点元素的几何快照（AABB 语义；圆/椭圆取其半宽高）。 */
export interface EdgeEndpointBox {
  /** 元素中心（布局坐标）。 */
  x: number;
  y: number;
  /** AABB 半宽 / 半高。 */
  hw: number;
  hh: number;
}

/** 端点策略的对接位置（布局坐标）。 */
export type Port = { x: number; y: number };

/** 端口外法向：端口离开元素的方向（单位向量，随端口侧固定）。 */
export type PortWithNormal = Port & { nx: number; ny: number };

/**
 * 端点对接策略：决定连线在元素边界上的出发/到达位置。
 *
 * @param end       本端元素几何快照
 * @param toward    指向对端元素中心的方向（用于选侧，不要求单位化）
 * @param slot      本边在「同侧边组」中的序号（0 起，组内沿侧边自然序）
 * @param slotCount 同侧边组的大小（1 = 本侧只有这条边）
 */
export interface PortStrategy {
  /** 注册名（demo 下拉框取值）。 */
  readonly name: string;
  port(end: EdgeEndpointBox, toward: Vec2, slot: number, slotCount: number): PortWithNormal;
}

/**
 * 路径风格策略：决定两端口之间的几何路径。
 * 输入的 waypoints 是布局走线层输出的中心-中心拐点（无网格布局时为空），
 * 策略可自由取舍 —— 直线/贝塞尔忽略它，折线族以它为骨架。
 */
export interface PathStrategy {
  readonly name: string;
  route(ctx: EdgeRouteContext): EdgePath;
}

export interface EdgeRouteContext {
  /** 两端端口（PortStrategy 产出，已在元素边界上）。 */
  source: PortWithNormal;
  target: PortWithNormal;
  /** 两端元素 AABB 快照（走线骨架裁剪内部段用）。 */
  sourceBox: EdgeEndpointBox;
  targetBox: EdgeEndpointBox;
  /** 布局走线拐点（首尾为两端元素中心；可为空）。 */
  waypoints: readonly Vec2[];
  /**
   * 平行边分组信息（同端点对的边序）：分散类策略按 slot 横移避让，
   * count = 1 表示无平行伙伴。
   */
  bundle: { slot: number; count: number };
}

/**
 * 转弯风格策略：把路径中的折线拐点变换为段序列（直角保留尖点、
 * 圆角以弧替代）。仅作用于 line→line 顶点；曲线段原样通过。
 */
export interface CornerStrategy {
  readonly name: string;
  apply(path: EdgePath): EdgePath;
}

/**
 * 交叉风格策略：处理本边与其它边的交叉。
 * others = 绘制序在本边之前的边（后画者有权"抬桥"）。
 */
export interface CrossingStrategy {
  readonly name: string;
  apply(path: EdgePath, others: readonly EdgePath[]): EdgePath;
}
