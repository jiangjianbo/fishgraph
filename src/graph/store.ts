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
import type { EdgeSpec, GraphSpec, GroupSpec, NodeId, NodeSpec, NodeView, ShapeSpec } from '../types.js';

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
  /** subgraph 容器节点：渲染时应作为背景层先画（在其上绘制成员与其它节点）。 */
  groupHub: boolean;
}

/** 节点角色（由 groups 声明派生，不由用户声明）：
 *  0 = free（普通节点）；1 = member（容器成员）；2 = hub（subgraph 容器锚点）。 */
export const ROLE_FREE = 0;
export const ROLE_MEMBER = 1;
export const ROLE_HUB = 2;

/** group 内成员的角色：与组外有连线的成员是边界（入口/出口），纯内连是内部。 */
export interface GroupRoles {
  group: GroupSpec;
  /** 组的下标（store.groups）。-1 表示非成员。 */
  indexOf: (memberId: NodeId) => number;
  entry: NodeId[];
  exit: NodeId[];
  internal: NodeId[];
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
  /** 分组声明（hidden-group 与 subgraph）。 */
  readonly groups: GroupSpec[] = [];
  /** group.id → hub 节点下标（subgraph 的虚拟大节点）。 */
  readonly groupHub = new Map<NodeId, number>();
  /** 节点角色（ROLE_FREE/ROLE_MEMBER/ROLE_HUB，增删时 rebuildRoles 重算）。 */
  nodeRole: Int8Array = new Int8Array(0);
  /** 成员/hub → 所属 group 下标（groups 数组下标）；free 为 -1。 */
  nodeGroup: Int32Array = new Int32Array(0);
  private idToIndex = new Map<NodeId, number>();
  private labelFontSize = 12;
  private labelPadding = 4;

  constructor(graph: GraphSpec) {
    graph.nodes.forEach((spec) => this.insertNode(spec));
    // subgraph 先于边处理：外部边可以以 group.id 为端点（映射到虚拟 hub 节点）
    for (const spec of graph.groups ?? []) {
      if (spec.shape) this.insertSubgraphHub(spec);
    }
    for (const spec of graph.edges) this.insertEdge(spec);
    for (const spec of graph.groups ?? []) this.groups.push(spec);
    this.rebuildRoles();
  }

  /** subgraph：生成虚拟大节点（hub），成员被约束在其内部区域内。 */
  private insertSubgraphHub(spec: GroupSpec): void {
    if (this.idToIndex.has(spec.id)) {
      throw new Error(`duplicate node id: ${String(spec.id)}（与 subgraph id 冲突）`);
    }
    for (const m of spec.members) {
      if (!this.idToIndex.has(m)) {
        throw new Error(`group ${String(spec.id)} 引用未知成员：${String(m)}`);
      }
    }
    this.insertNode({
      id: spec.id,
      shape: spec.shape,
      label: spec.label,
      // 质量随成员数增长：外部视角的"大节点"惯性更大
      mass: spec.members.length + 1,
    });
    this.nodes[this.nodes.length - 1].groupHub = true; // 容器节点：渲染时作背景层
    this.groupHub.set(spec.id, this.nodes.length - 1);
  }

  /** 重算节点角色与组归属（groups 声明派生；增删节点/组后调用）。 */
  private rebuildRoles(): void {
    this.nodeRole = new Int8Array(this.nodes.length); // 默认 free
    this.nodeGroup = new Int32Array(this.nodes.length).fill(-1);
    this.groups.forEach((spec, gi) => {
      if (spec.shape) {
        const hubIdx = this.groupHub.get(spec.id);
        if (hubIdx !== undefined) {
          this.nodeRole[hubIdx] = ROLE_HUB;
          this.nodeGroup[hubIdx] = gi;
        }
      }
      for (const m of spec.members) {
        const mi = this.idToIndex.get(m);
        if (mi !== undefined) {
          this.nodeRole[mi] = ROLE_MEMBER;
          this.nodeGroup[mi] = gi;
        }
      }
    });
  }

  /** 下标是否为某 subgraph 的 hub 节点。 */
  isGroupHub(index: number): boolean {
    return this.nodeRole[index] === ROLE_HUB;
  }

  /** 下标所属 subgraph 的 hub 下标（非 subgraph 成员返回 -1）。 */
  hubOfMember(index: number): number {
    if (this.nodeRole[index] !== ROLE_MEMBER) return -1;
    const gi = this.nodeGroup[index];
    const spec = this.groups[gi];
    if (!spec?.shape) return -1;
    return this.groupHub.get(spec.id) ?? -1;
  }

  /**
   * group 内成员角色：与组外有连线的是边界节点（有向边 外→成员 = 入口，
   * 成员→外 = 出口），纯内连的是内部节点。
   */
  groupRoles(groupId: NodeId): GroupRoles | null {
    const gi = this.groups.findIndex((g) => g.id === groupId);
    if (gi === -1) return null;
    const spec = this.groups[gi];
    const memberIdx = new Set(
      spec.members.map((m) => this.idToIndex.get(m)).filter((x): x is number => x !== undefined),
    );
    const entry: NodeId[] = [];
    const exit: NodeId[] = [];
    const internal: NodeId[] = [];
    for (const m of spec.members) {
      const mi = this.idToIndex.get(m);
      if (mi === undefined) continue;
      let hasIn = false;
      let hasOut = false;
      for (const e of this.edges) {
        const fromMember = memberIdx.has(e.a);
        const toMember = memberIdx.has(e.b);
        if (fromMember && toMember) continue;
        if (e.a === mi && !toMember) hasOut = true;
        if (e.b === mi && !fromMember) hasIn = true;
      }
      if (hasIn && !hasOut) entry.push(m);
      else if (hasOut && !hasIn) exit.push(m);
      else if (hasIn && hasOut) { entry.push(m); exit.push(m); }
      else internal.push(m);
    }
    return { group: spec, indexOf: (m) => this.idToIndex.get(m) ?? -1, entry, exit, internal };
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
      groupHub: false,
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
    this.rebuildRoles();
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
