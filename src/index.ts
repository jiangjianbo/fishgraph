/**
 * fishgraph 公共导出面。
 *
 * 主引擎：grid-undirected 纯网格布局
 * （波纹放置 → 中心对称膨胀 → 通道约束压实 → 网格 A* 避障走线）。
 */

// 公共 API 门面
export { ForceLayout } from './layout.js';

// 策略自注册（import 副作用：registerStrategy）
import './layout/grid-undirected/strategy.js';
import './layout/circle/strategy.js';

// 策略接缝
export {
  createStrategy,
  listStrategies,
  registerStrategy,
  type LayoutStrategy,
  type ResolvedLayoutOptions,
  type StrategyFactory,
} from './layout/strategy.js';

// 图数据底座与类型
export {
  GraphStore,
  LayoutElement,
  LayoutNode,
  LayoutSubgraphNode,
  isSubgraphNode,
  elementsAABB,
  type ElementAABB,
  type InternalEdge,
} from './graph/store.js';

// 几何与文字
export { DEFAULT_SHAPE, boundingRadius, clampPointToShape, halfExtentsOf, rayShapeExit, shapeContains } from './geometry.js';
export { estimateLabelBox } from './label.js';

// 尺寸分级（格单位架构 · 初始化：px 盒 → 整数格占用）
export {
  GRADE_TOLERANCE,
  gradeAxis,
  gradeBoxes,
  type AxisGrades,
  type BoxSize,
  type GradeBasis,
} from './layout/grade.js';

// 纯网格流水线（主引擎内部件，供测试与扩展）
export {
  coarseGridPlacement,
  undirectedHeuristics,
  insertLine,
  placeOrphan,
  type CoarseHeuristics,
  type CoarsePlacementOptions,
  type CoarsePlacementGrid,
  type Cell,
  type GridPos,
  type PointGrid,
  type PushDir,
  type UndirectedHeuristicsOptions,
} from './layout/grid-undirected/coarse.js';
export { computeLevels, type LevelInfo, type EdgeEndpoints } from './layout/grid-undirected/levels.js';
export { directedHeuristics } from './layout/grid-undirected/directed-placement.js';
export { ExpansionGrid } from './layout/grid-undirected/expansion.js';
export { GridSpaceContext, type GridSpaceOptions } from './layout/grid-undirected/grid-context.js';
export { gridRouteAStar, type GridRouteOptions } from './layout/grid-undirected/grid-route.js';
export type { Bounds, Box, Point } from './layout/grid-undirected/space-types.js';

// 连线风格策略（端点对接 / 路径 / 转弯 / 交叉 四接缝 + 装配渲染器）
export {
  EdgeStyleRenderer,
  pathMidpoint,
  endArrow,
  type EdgeScene,
  type EdgeGeometry,
  type EdgeStyleOptions,
} from './edge/renderer.js';
export { pathLength, segmentEnd, segmentLength } from './edge/segments.js';
export {
  FixedPortStrategy,
  DistributedPortStrategy,
  dominantSide,
  type Side,
} from './edge/ports.js';
export {
  OrthogonalPolylinePathStrategy,
  StraightLinePathStrategy,
  CubicBezierPathStrategy,
  ObliqueDistributedPathStrategy,
} from './edge/paths.js';
export { SharpCornerStrategy, RoundCornerStrategy } from './edge/corners.js';
export { PlainCrossingStrategy, BridgeCrossingStrategy } from './edge/crossings.js';
export type {
  PathSegment,
  EdgePath,
  EdgeEndpointBox,
  Port,
  PortWithNormal,
  PortStrategy,
  PathStrategy,
  EdgeRouteContext,
  CornerStrategy,
  CrossingStrategy,
} from './edge/types.js';

export type {
  ElementId,
  NodeId,
  Vec2,
  ShapeSpec,
  ElementSpec,
  NodeSpec,
  GroupSpec,
  SubgraphSpec,
  EdgeSpec,
  GraphSpec,
  LayoutOptions,
  RunOptions,
  RunResult,
  NodeView,
  SubgraphView,
} from './types.js';
