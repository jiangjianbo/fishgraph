// 内置策略在加载时自注册（副作用 import）。
import './layout/force/strategy.js';
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

// 坐标系（布局完成后的坐标修正策略）
export {
  createCoordinateSystem,
  listCoordinateSystems,
  registerCoordinateSystem,
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

export type {
  AccuracyMode,
  EdgeSpec,
  ElementId,
  ElementSpec,
  GraphSpec,
  GroupSpec,
  GravityMode,
  HiddenGroupSpec,
  InitMode,
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
