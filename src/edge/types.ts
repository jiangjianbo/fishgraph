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

import type { ShapeSpec, Vec2 } from '../types.js';

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

/** 连线端点元素的几何快照。 */
export interface EdgeEndpointBox {
  /** 元素中心（布局坐标）。 */
  x: number;
  y: number;
  /** AABB 半宽 / 半高。 */
  hw: number;
  hh: number;
  /** 声明形状（贴合策略按真实形状边界求交用）。 */
  shape: ShapeSpec;
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
 * 贴合方式策略：把端口点（PortStrategy 在 AABB 侧边上选出）贴合到元素
 * 的真实几何上，并给出贴合点的外法向。
 * 返回的 PortWithNormal 即路径管线的最终端点。
 */
export interface EndpointFitStrategy {
  readonly name: string;
  fit(port: PortWithNormal, box: EdgeEndpointBox): PortWithNormal;
}

/** 端点装饰几何（全部为路径终点处的局部图形，布局坐标）。 */
export interface EndCapDecoration {
  /** 填充多边形（实心箭头的三角形等）。 */
  fills?: Array<{ points: Vec2[] }>;
  /** 描边折线（开放式箭头的 V 形两笔）。 */
  strokes?: Array<{ path: EdgePath }>;
  /** 实心圆点。 */
  dots?: Array<{ center: Vec2; radius: number }>;
}

/**
 * 两端形态策略（端帽）：决定连线起点/终点处的装饰。
 * tip = 路径端点，(dx,dy) = 该端指向"路径外部"的单位切向
 * （终点 = 行进方向，起点 = 行进反方向），at 区分起/终端。
 */
export interface EndCapStrategy {
  readonly name: string;
  /** 端帽沿切向占用的线体长度（路径策略据此保证贴边末段不短于它）。 */
  readonly tipLength: number;
  decorate(tip: Vec2, dx: number, dy: number, at: 'source' | 'target'): EndCapDecoration;
}

/** 单端（起点或终点）的样式组合：对接位置 + 贴合方式 + 端帽形态。 */
export interface EdgeEndpointStyle {
  ports: PortStrategy;
  fit: EndpointFitStrategy;
  cap: EndCapStrategy;
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
  /**
   * 终点贴边段的最小长度约束（两端端帽沿切向占用的最大线长；装配器
   * 传入，缺省 0）。路径策略保证终点贴边段不短于该值 —— 端帽之下
   * 保有完整的线体尾巴（终点垂直段 ≥ 箭头长度）。
   */
  minStub?: number;
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
