// 内置策略在加载时自注册（副作用 import）。
import './layout/force/strategy.js';
import './layout/circle/strategy.js';

export { ForceLayout } from './layout.js';
export { estimateLabelBox, type LabelBox } from './label.js';

// 节点/边管理（稳定底座）
export { GraphStore, type InternalEdge, type LayoutNode } from './graph/store.js';

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
  GraphSpec,
  GravityMode,
  InitMode,
  LayoutOptions,
  LayoutStage,
  NodeId,
  NodeSpec,
  NodeView,
  RunOptions,
  RunResult,
  ShapeSpec,
  Vec2,
} from './types.js';
