/**
 * GraphStore —— 节点/边管理（与布局算法完全分离的稳定底座）。
 *
 * 职责只有"图数据的持有与变更"：
 *   - 校验并构建节点/边（id 唯一、边端点存在、自环剔除）；
 *   - 邻接表、固定状态、节点位置与质量；
 *   - 边文字/节点文字的包围盒度量（纯数据，不含任何力学）；
 *   - 增删节点/边、拖拽相关的位置写入。
 *
 * 布局算法（src/layout/ 下的策略实现）只读取这些数据、写回坐标，
 * 不拥有图数据；图结构变化后由调用方通知策略 rebuild()。
 */

import { estimateLabelBox } from '../label.js';
import { DEFAULT_SHAPE, boundingRadius } from '../geometry.js';
import type { EdgeSpec, GraphSpec, NodeId, NodeSpec, NodeView, ShapeSpec } from '../types.js';

export interface LayoutNode {
  id: NodeId;
  x: number;
  y: number;
  fx: number;
  fy: number;
  /** 包围圆半径（节点-节点力用；阶段 3 会因节点文字变大）。 */
  r: number;
  /** 初始的形状包围半径（不含节点文字）。 */
  baseR: number;
  mass: number;
  shape: ShapeSpec;
  label: string | null;
  fixed: boolean;
  /** 用户是否显式给了初始位置。 */
  placed: boolean;
}

export interface InternalEdge {
  /** 节点下标。 */
  a: number;
  b: number;
  label: string | null;
  /** 标签包围盒半宽/半高（无标签时为 0）。 */
  labelHw: number;
  labelHh: number;
}

export class GraphStore {
  readonly nodes: LayoutNode[] = [];
  edges: InternalEdge[] = [];
  /** adj[i] = 与下标 i 相邻的节点下标集合。 */
  readonly adj: Array<Set<number>> = [];
  private idToIndex = new Map<NodeId, number>();
  private labelFontSize = 12;
  private labelPadding = 4;

  constructor(graph: GraphSpec) {
    graph.nodes.forEach((spec) => this.insertNode(spec));
    for (const spec of graph.edges) this.insertEdge(spec);
  }

  // ── 构建 ────────────────────────────────────────────────

  private insertNode(spec: NodeSpec): number {
    if (this.idToIndex.has(spec.id)) {
      throw new Error(`duplicate node id: ${String(spec.id)}`);
    }
    const shape = spec.shape ?? DEFAULT_SHAPE;
    const baseR = boundingRadius(shape);
    const index = this.nodes.length;
    this.idToIndex.set(spec.id, index);
    this.nodes.push({
      id: spec.id,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      fx: 0,
      fy: 0,
      r: baseR,
      baseR,
      mass: spec.mass && spec.mass > 0 ? spec.mass : 1,
      shape,
      label: spec.label ?? null,
      fixed: spec.fixed ?? false,
      placed: spec.x !== undefined && spec.y !== undefined,
    });
    this.adj.push(new Set());
    return index;
  }

  private insertEdge(spec: EdgeSpec): void {
    const a = this.idToIndex.get(spec.source);
    const b = this.idToIndex.get(spec.target);
    if (a === undefined || b === undefined) {
      const missing = a === undefined ? spec.source : spec.target;
      throw new Error(`edge references unknown node id: ${String(missing)}`);
    }
    if (a === b) return; // 自环不参与力学
    this.edges.push({ a, b, label: spec.label ?? null, labelHw: 0, labelHh: 0 });
    this.adj[a].add(b);
    this.adj[b].add(a);
  }

  // ── 变更（图结构）───────────────────────────────────────
  // 变更只改数据；调用方随后通知布局策略 rebuild()（或换策略）。

  addNode(spec: NodeSpec): void {
    this.insertNode(spec);
  }

  removeNode(id: NodeId): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    this.edges = this.edges.filter((e) => e.a !== index && e.b !== index);
    this.nodes.splice(index, 1);
    this.adj.splice(index, 1);
    this.idToIndex.clear();
    this.nodes.forEach((nd, i) => this.idToIndex.set(nd.id, i));
    this.rebuildAdjacency();
  }

  addEdge(spec: EdgeSpec): void {
    this.insertEdge(spec);
  }

  removeEdge(source: NodeId, target: NodeId): void {
    const a = this.idToIndex.get(source);
    const b = this.idToIndex.get(target);
    if (a === undefined || b === undefined) {
      throw new Error(`edge references unknown node id: ${String(a === undefined ? source : target)}`);
    }
    const before = this.edges.length;
    this.edges = this.edges.filter((e) => !(e.a === a && e.b === b) && !(e.a === b && e.b === a));
    if (this.edges.length === before) {
      throw new Error(`edge not found: ${String(source)}-${String(target)}`);
    }
    this.rebuildAdjacency();
  }

  private rebuildAdjacency(): void {
    for (const set of this.adj) set.clear();
    for (const e of this.edges) {
      this.adj[e.a].add(e.b);
      this.adj[e.b].add(e.a);
    }
  }

  // ── 文字段落度量（纯数据，无力学）────────────────────────

  /** 设置文字度量参数并刷新全部标签包围盒。 */
  setLabelMetrics(fontSize: number, padding: number): void {
    this.labelFontSize = fontSize;
    this.labelPadding = padding;
    this.refreshLabelBoxes();
  }

  refreshLabelBoxes(): void {
    const fs = this.labelFontSize;
    const pad = this.labelPadding;
    for (const e of this.edges) {
      if (e.label === null) {
        e.labelHw = 0;
        e.labelHh = 0;
      } else {
        const box = estimateLabelBox(e.label, fs, pad);
        e.labelHw = box.hw;
        e.labelHh = box.hh;
      }
    }
  }

  /** 节点文字使有效包围半径变大（布局用包围圆，渲染仍可用原形状）。 */
  applyNodeLabelSizes(enabled: boolean): void {
    const fs = this.labelFontSize;
    const pad = this.labelPadding;
    for (const nd of this.nodes) {
      if (!enabled || nd.label === null) {
        nd.r = nd.baseR;
        continue;
      }
      const box = estimateLabelBox(nd.label, fs, pad);
      nd.r = Math.max(nd.baseR, Math.hypot(box.hw, box.hh) + 2);
    }
  }

  // ── 交互（拖拽支持）─────────────────────────────────────

  /** 固定节点（可同时移动它）。固定节点不受力移动，但仍对其他节点施力。 */
  fix(id: NodeId, x?: number, y?: number): void {
    const nd = this.nodeById(id);
    nd.fixed = true;
    if (x !== undefined) nd.x = x;
    if (y !== undefined) nd.y = y;
  }

  unfix(id: NodeId): void {
    this.nodeById(id).fixed = false;
  }

  setNodePosition(id: NodeId, x: number, y: number): void {
    const nd = this.nodeById(id);
    nd.x = x;
    nd.y = y;
  }

  nodeById(id: NodeId): LayoutNode {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    return this.nodes[index];
  }

  indexOf(id: NodeId): number {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    return index;
  }

  // ── 视图 ────────────────────────────────────────────────

  /** 节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  get nodeViews(): readonly NodeView[] {
    return this.nodes;
  }

  /** 物理边列表（a/b 为 nodeViews 下标；自环已剔除）。 */
  get edgeViews(): readonly Readonly<InternalEdge>[] {
    return this.edges;
  }

  get positions(): Map<NodeId, { x: number; y: number }> {
    const map = new Map<NodeId, { x: number; y: number }>();
    for (const nd of this.nodes) map.set(nd.id, { x: nd.x, y: nd.y });
    return map;
  }
}
