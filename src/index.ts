// 内置策略在加载时自注册（副作用 import）。
import './layout/force-undirected/strategy.js';
import './layout/force-directed/strategy.js';
import './layout/grid-undirected/strategy.js';
import './layout/group-undirected/strategy.js';
import './layout/circle/strategy.js';

export { ForceLayout } from './layout.js';
export { estimateLabelBox, type LabelBox } from './label.js';

// 图数据底座（GraphSpec → GraphStore 工厂物化）
export {
  ClusterConstraint,
  GraphStore,
  LayoutElement,
  LayoutNode,
  LayoutSubgraphNode,
  type ElementInit,
  type GroupRoles,
  type InternalEdge,
} from './graph/store.js';
export { detectHiddenGroups, type HiddenGroup } from './graph/groups.js';

// 几何原语（统一形状口径：外接矩形碰撞、连线端点形状贴合）
export { halfExtentsOf, rayShapeExit, shapeContains, type HalfExtents } from './geometry.js';

// 坐标系（布局完成后的坐标修正策略）
export {
  createCoordinateSystem,
  listCoordinateSystems,
  registerCoordinateSystem,
  resolveRefineLattice,
  zoneLatticeCap,
  type CoordinateNode,
  type CoordinateSystem,
  type CoordinateSystemFactory,
  type RefineParams,
} from './layout/coordinates.js';

// 布局策略接缝
export {
  registerStrategy,
  createStrategy,
  listStrategies,
  type ForceSnapshot,
  type LayoutStrategy,
  type ResolvedLayoutOptions,
  type StrategyFactory,
} from './layout/strategy.js';

// 空间上下文（泛型化布局算法的空间原语接缝：离散网格 / 连续平面）
export {
  ContinuousSpaceContext,
} from './layout/space/continuous-context.js';
export { GridSpaceContext } from './layout/space/grid-context.js';
export { gridRouteAStar, type GridRouteOptions } from './layout/space/grid-route.js';
export type { Bounds, Box, Point, SpaceContext } from './layout/space/types.js';

export type {
  AccuracyMode,
  EdgeSpec,
  ElementId,
  ElementSpec,
  GraphSpec,
  GroupSpec,
  GravityMode,
  HiddenGroupSpec,
  LayoutOptions,
  LayoutStage,
  NodeId,
  NodeSpec,
  NodeView,
  RunOptions,
  RunResult,
  ShapeSpec,
  SubgraphSpec,
  SubgraphView,
  Vec2,
} from './types.js';
