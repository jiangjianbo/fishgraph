/**
 * GraphStore —— 图数据底座（与布局算法完全分离的稳定底座）。
 *
 * 职责只有"图数据的校验、物化与变更"（GraphSpec → GraphStore 工厂）：
 *   - 物化：NodeSpec → LayoutNode（物理节点）；
 *           SubgraphSpec → LayoutSubgraphNode（有边界的物理容器，参与碰撞）；
 *           HiddenGroupSpec → ClusterConstraint（无边界，仅聚类引力约束）；
 *   - 邻接表、固定状态、元素位置与质量；
 *   - 边文字/节点文字的包围盒度量（纯数据，不含任何力学）；
 *   - 增删元素/边、拖拽相关的位置写入。
 *
 * 布局引擎（src/layout/ 下的策略实现）只面向 LayoutElement 多态基类：
 * 读 x/y/getBoundRadius()、写回坐标，不区分物理节点与容器节点；
 * 图结构变化后由调用方通知策略 rebuild()。
 */

import { estimateLabelBox } from '../label.js';
import { DEFAULT_SHAPE, boundingRadius, clampPointToShape } from '../geometry.js';
import type {
  EdgeSpec,
  ElementId,
  GraphSpec,
  GroupSpec,
  HiddenGroupSpec,
  NodeSpec,
  NodeView,
  ShapeSpec,
  SubgraphSpec,
  SubgraphView,
} from '../types.js';

/** 成员包裹后的默认内边距（px）。 */
const DEFAULT_SUBGRAPH_PADDING = 2;

/** 元素物化所需的公共初值。 */
export interface ElementInit {
  id: ElementId;
  x: number;
  y: number;
  fixed: boolean;
  shape: ShapeSpec;
  label: string | null;
  /** 用户是否显式给了初始位置。 */
  placed: boolean;
  mass: number;
}

/**
 * LayoutElement —— 布局引擎视角的抽象元素（多态基类）。
 *
 * 物理节点（LayoutNode）与 subgraph 容器（LayoutSubgraphNode）的统一口径：
 * 引擎只关心 x/y 与 getBoundRadius()，把容器当作"巨大号的节点"一起解算
 * 碰撞与排斥。力累加器与有效半径放在基类，因为两类元素都参与力场迭代。
 */
export abstract class LayoutElement {
  /** 判别符：是否为 subgraph 容器节点（子类覆盖为 true）。 */
  readonly isSubgraph: boolean = false;
  readonly id: ElementId;
  x: number;
  y: number;
  /** 力累加器（每轮力场求值前清零）。 */
  fx = 0;
  fy = 0;
  /** 固定元素：不受力移动，但仍对其他元素施力。 */
  fixed: boolean;
  /** 有效包围半径（节点文字/成员包裹会使它变大）。 */
  r: number;
  /** 形状声明的初始包围半径（不含文字/成员外扩）。 */
  readonly baseR: number;
  readonly shape: ShapeSpec;
  label: string | null;
  placed: boolean;
  /** 引力质量（容器 = 成员数 + 1：外部视角的"大节点"惯性更大）。 */
  mass: number;
  /** 网格布局（grid-undirected）物化的 AABB 物理宽（px）；连续布局不设置。 */
  w?: number;
  /** 网格布局（grid-undirected）物化的 AABB 物理高（px）；连续布局不设置。 */
  h?: number;

  protected constructor(init: ElementInit) {
    this.id = init.id;
    this.x = init.x;
    this.y = init.y;
    this.fixed = init.fixed;
    this.r = boundingRadius(init.shape);
    this.baseR = this.r;
    this.shape = init.shape;
    this.label = init.label;
    this.placed = init.placed;
    this.mass = init.mass;
  }

  /** 有效包围半径（布局引擎与渲染共用的唯一半径口径）。 */
  getBoundRadius(): number {
    return this.r;
  }
}

/** 物理节点：图的基本粒子。 */
export class LayoutNode extends LayoutElement {
  constructor(spec: NodeSpec) {
    super({
      id: spec.id,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      fixed: spec.fixed ?? false,
      shape: spec.shape ?? DEFAULT_SHAPE,
      label: spec.label ?? null,
      placed: spec.x !== undefined && spec.y !== undefined,
      mass: spec.mass && spec.mass > 0 ? spec.mass : 1,
    });
  }
}

/**
 * LayoutSubgraphNode —— subgraph 容器（Compound Node）。
 *
 * 有物理实体：引擎把它当作一个节点与外部元素解算碰撞与排斥；半径 =
 * 成员实占 + padding（updateBoundsFromChildren，世界分块种入与终局
 * 对齐时刷新），声明的 shape 只用于渲染与成员钳制，不参与力学占位。
 * 结构上支持嵌套（children 可含其它容器 id）。
 */
export class LayoutSubgraphNode extends LayoutElement {
  readonly isSubgraph = true;
  /** 成员元素 id（声明序快照）。 */
  readonly children: ElementId[];
  /** 成员元素下标（物化派生；增删元素后由 store 重建）。 */
  memberIndices: number[] = [];
  /** 成员下标集合（hub-成员斥力豁免的 O(1) 查询）。 */
  memberSet: Set<number> = new Set();
  /** 成员包裹后外扩的内边距。 */
  readonly padding: number;

  constructor(spec: SubgraphSpec) {
    super({
      id: spec.id,
      x: 0,
      y: 0,
      fixed: false,
      shape: spec.shape,
      label: spec.label ?? null,
      placed: false,
      // 斥力强度与节点大小无关（2026-09-22 起）：质量维度整体归一，
      // 容器不再按成员数放大力学强度（对外推力、提升边弹力、弱引力）。
      mass: 1,
    });
    this.children = [...spec.members];
    this.padding = spec.padding ?? DEFAULT_SUBGRAPH_PADDING;
  }

  /**
   * 按成员几何刷新容器半径（成员实占口径，2026-09-22 起）：
   * 包围全部成员（中心距 + 成员半径的最大值）再外扩 padding。
   * 不再以声明形状的 baseR 为下限——容器本体的力学占位与外部元素
   * 的斥力平衡距离跟随成员实占，声明的空白画布不参与力学。
   */
  updateBoundsFromChildren(elements: readonly LayoutElement[]): void {
    let maxD = 0;
    for (const idx of this.memberIndices) {
      const nd = elements[idx];
      maxD = Math.max(maxD, Math.hypot(nd.x - this.x, nd.y - this.y) + nd.r);
    }
    this.r = maxD + this.padding;
  }
}

/**
 * ClusterConstraint —— hidden-group 的物理化身（Hidden Group Dynamics）。
 *
 * 不继承 LayoutElement：不参与空间包围盒碰撞，也不产生可见实体；
 * 只在力导向迭代时作为辅助引力钩子，向成员施加"到组质心的简谐束缚"
 * （向心力，保守、合力恒为零 —— "尽量聚集"而非"约束在界内"）。
 */
export class ClusterConstraint {
  /** 每成员束缚系数（k_a/L² 尺度）。由布局策略按聚集强度与 naturalLength 派生后写入。 */
  k = 0;
  /** 成员元素下标（物化派生；增删元素后由 store 重建）。 */
  memberIndices: number[];

  constructor(
    readonly id: ElementId,
    /** 声明的聚集强度；null = 使用全局默认（LayoutOptions.groupCohesion）。 */
    readonly strength: number | null,
    memberIndices: number[],
  ) {
    this.memberIndices = memberIndices;
  }

  /** 向成员施加到组质心的简谐束缚（就地累加力），返回该组势能。 */
  applyForces(elements: readonly LayoutElement[]): number {
    const m = this.memberIndices.length;
    if (m === 0 || this.k === 0) return 0;
    let cx = 0;
    let cy = 0;
    for (const idx of this.memberIndices) {
      cx += elements[idx].x;
      cy += elements[idx].y;
    }
    cx /= m;
    cy /= m;
    let energy = 0;
    for (const idx of this.memberIndices) {
      const nd = elements[idx];
      nd.fx += (this.k * nd.mass) * (cx - nd.x);
      nd.fy += (this.k * nd.mass) * (cy - nd.y);
      energy += 0.5 * this.k * nd.mass * ((nd.x - cx) ** 2 + (nd.y - cy) ** 2);
    }
    return energy;
  }
}

export interface InternalEdge {
  /** 端点元素下标（elements 数组；可为 subgraph 容器下标）。 */
  sourceIndex: number;
  targetIndex: number;
  label: string | null;
  /** 标签包围盒半宽/半高（无标签时为 0）。 */
  labelHw: number;
  labelHh: number;
  /**
   * 走线层输出的物理路径拐点（首尾为两端节点中心，中间为格中心；
   * 正交折线语义）。力导向等连续布局不产生本字段。
   */
  waypoints?: Array<{ x: number; y: number }>;
}

/** group 内成员的角色：与组外有连线的成员是边界（入口/出口），纯内连是内部。 */
export interface GroupRoles {
  group: GroupSpec;
  /** 成员 id → elements 下标（未知成员为 -1）。 */
  indexOf: (memberId: ElementId) => number;
  entry: ElementId[];
  exit: ElementId[];
  internal: ElementId[];
}

export class GraphStore {
  /**
   * 全量布局元素（物理节点 + subgraph 容器），声明序混排；
   * 下标即力学数组（edges/adj/四叉树）的物理下标。
   */
  readonly elements: LayoutElement[] = [];
  /** 物理节点视图（elements 的 LayoutNode 子集缓存）。 */
  readonly nodes: LayoutNode[] = [];
  /** subgraph 容器视图（elements 的 LayoutSubgraphNode 子集缓存）。 */
  readonly subgraphNodes: LayoutSubgraphNode[] = [];
  edges: InternalEdge[] = [];
  /** adj[i] = 与下标 i 相邻的元素下标集合。 */
  readonly adj: Array<Set<number>> = [];
  /** hidden-group 物化出的聚类引力约束。 */
  readonly clusterConstraints: ClusterConstraint[] = [];
  /** 声明保留（角色分类 groupRoles 等需要原始 spec）。 */
  readonly subgraphs: SubgraphSpec[] = [];
  readonly hiddenGroups: HiddenGroupSpec[] = [];
  /** 成员元素 id → 所属 subgraph 容器下标。 */
  private memberHub = new Map<ElementId, number>();
  private idToIndex = new Map<ElementId, number>();
  private labelFontSize = 12;
  private labelPadding = 4;

  constructor(graph: GraphSpec) {
    graph.nodes.forEach((spec) => this.insertNode(spec));
    // subgraph 先于边物化：外部边可以直接以 group.id 为端点
    for (const spec of graph.subgraphs ?? []) this.insertSubgraph(spec);
    for (const spec of graph.hiddenGroups ?? []) this.insertHiddenGroup(spec);
    for (const spec of graph.edges) this.insertEdge(spec);
    this.rebuildGroupIndices();
  }

  // ── 物化（GraphSpec → GraphStore 工厂）─────────────────

  private insertNode(spec: NodeSpec): void {
    if (this.idToIndex.has(spec.id)) {
      throw new Error(`duplicate node id: ${String(spec.id)}`);
    }
    const index = this.elements.length;
    this.idToIndex.set(spec.id, index);
    const node = new LayoutNode(spec);
    this.elements.push(node);
    this.nodes.push(node);
    this.adj.push(new Set());
  }

  /** subgraph：物化为容器大节点（成员被约束在其内部区域内）。 */
  private insertSubgraph(spec: SubgraphSpec): void {
    if (this.idToIndex.has(spec.id)) {
      throw new Error(`duplicate node id: ${String(spec.id)}（与 subgraph id 冲突）`);
    }
    for (const m of spec.members) {
      if (!this.idToIndex.has(m)) {
        throw new Error(`subgraph ${String(spec.id)} 引用未知成员：${String(m)}`);
      }
    }
    const index = this.elements.length;
    this.idToIndex.set(spec.id, index);
    const node = new LayoutSubgraphNode(spec);
    this.elements.push(node);
    this.subgraphNodes.push(node);
    this.subgraphs.push(spec);
    this.adj.push(new Set());
  }

  /** hidden-group：物化为聚类引力约束（无实体，仅"尽量聚集"）。 */
  private insertHiddenGroup(spec: HiddenGroupSpec): void {
    const memberIndices: number[] = [];
    for (const m of spec.members) {
      const idx = this.idToIndex.get(m);
      if (idx === undefined) {
        throw new Error(`hidden group ${String(spec.id)} 引用未知成员：${String(m)}`);
      }
      memberIndices.push(idx);
    }
    this.clusterConstraints.push(
      new ClusterConstraint(spec.id, spec.attractionStrength ?? null, memberIndices),
    );
    this.hiddenGroups.push(spec);
  }

  private insertEdge(spec: EdgeSpec): void {
    const a = this.idToIndex.get(spec.source);
    const b = this.idToIndex.get(spec.target);
    if (a === undefined || b === undefined) {
      const missing = a === undefined ? spec.source : spec.target;
      throw new Error(`edge references unknown node id: ${String(missing)}`);
    }
    if (a === b) return; // 自环不参与力学
    this.edges.push({ sourceIndex: a, targetIndex: b, label: spec.label ?? null, labelHw: 0, labelHh: 0 });
    this.adj[a].add(b);
    this.adj[b].add(a);
  }

  /** 重建分组派生下标（构造与增删元素后调用）：成员 id → 物理下标。 */
  private rebuildGroupIndices(): void {
    this.memberHub.clear();
    this.subgraphNodes.forEach((sg, gi) => {
      const spec = this.subgraphs[gi];
      const hubIdx = this.idToIndex.get(sg.id);
      if (hubIdx === undefined) return; // 容器自身已被删除
      sg.memberIndices = [];
      sg.memberSet.clear();
      for (const m of spec.members) {
        const mi = this.idToIndex.get(m);
        if (mi === undefined) continue;
        sg.memberIndices.push(mi);
        sg.memberSet.add(mi);
        this.memberHub.set(m, hubIdx);
      }
    });
    this.clusterConstraints.forEach((c, gi) => {
      const spec = this.hiddenGroups[gi];
      c.memberIndices = spec.members
        .map((m) => this.idToIndex.get(m))
        .filter((x): x is number => x !== undefined);
    });
  }

  // ── 分组查询 ────────────────────────────────────────────

  /** 下标所属 subgraph 容器的下标（非成员返回 -1）。 */
  hubOfMember(index: number): number {
    const el = this.elements[index];
    if (!el) return -1;
    return this.memberHub.get(el.id) ?? -1;
  }

  /** id 所属最内层 subgraph 容器（非成员返回 null）。 */
  containerOf(id: ElementId): LayoutSubgraphNode | null {
    const hub = this.memberHub.get(id);
    if (hub === undefined) return null;
    const el = this.elements[hub];
    return el instanceof LayoutSubgraphNode ? el : null;
  }

  /**
   * 容器的全部成员 id（递归展开嵌套容器：嵌套容器本体与其成员都包含；
   * 容器自身不在结果中）。交互整体平移（拖容器带成员）使用。
   */
  subgraphMemberIds(id: ElementId): ElementId[] {
    const out: ElementId[] = [];
    const visit = (cid: ElementId): void => {
      const idx = this.idToIndex.get(cid);
      const el = idx === undefined ? null : this.elements[idx];
      if (!(el instanceof LayoutSubgraphNode)) return;
      for (const child of el.children) {
        out.push(child);
        visit(child);
      }
    };
    visit(id);
    return out;
  }

  /**
   * 把成员坐标钳制进所属容器：成员包围圆完全落在容器边界内
   * （margin = 成员有效半径）；非成员原样返回。
   */
  clampToContainer(id: ElementId, x: number, y: number): { x: number; y: number } {
    const el = this.elementById(id);
    const box = this.containerOf(id);
    if (!box) return { x, y };
    return clampPointToShape(box.shape, box.x, box.y, x, y, el.r);
  }

  /**
   * group 内成员角色：与组外有连线的是边界节点（有向边 外→成员 = 入口，
   * 成员→外 = 出口），纯内连的是内部节点。
   */
  groupRoles(groupId: ElementId): GroupRoles | null {
    const spec =
      this.subgraphs.find((g) => g.id === groupId) ??
      this.hiddenGroups.find((g) => g.id === groupId);
    if (!spec) return null;
    const memberIdx = new Set(
      spec.members.map((m) => this.idToIndex.get(m)).filter((x): x is number => x !== undefined),
    );
    const entry: ElementId[] = [];
    const exit: ElementId[] = [];
    const internal: ElementId[] = [];
    for (const m of spec.members) {
      const mi = this.idToIndex.get(m);
      if (mi === undefined) continue;
      let hasIn = false;
      let hasOut = false;
      for (const e of this.edges) {
        const fromMember = memberIdx.has(e.sourceIndex);
        const toMember = memberIdx.has(e.targetIndex);
        if (fromMember && toMember) continue;
        if (e.sourceIndex === mi && !toMember) hasOut = true;
        if (e.targetIndex === mi && !fromMember) hasIn = true;
      }
      if (hasIn && !hasOut) entry.push(m);
      else if (hasOut && !hasIn) exit.push(m);
      else if (hasIn && hasOut) { entry.push(m); exit.push(m); }
      else internal.push(m);
    }
    return { group: spec, indexOf: (m) => this.idToIndex.get(m) ?? -1, entry, exit, internal };
  }

  // ── 变更（图结构）───────────────────────────────────────
  // 变更只改数据；调用方随后通知布局策略 rebuild()（或换策略）。

  addNode(spec: NodeSpec): void {
    this.insertNode(spec);
  }

  removeNode(id: ElementId): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    this.edges = this.edges.filter((e) => e.sourceIndex !== index && e.targetIndex !== index);
    this.elements.splice(index, 1);
    this.adj.splice(index, 1);
    this.idToIndex.clear();
    this.elements.forEach((nd, i) => this.idToIndex.set(nd.id, i));
    // 物理节点/容器缓存与全量数组保持同序子集关系
    let ni = 0;
    for (const el of this.elements) {
      if (!el.isSubgraph) this.nodes[ni++] = el as LayoutNode;
    }
    this.nodes.length = ni;
    let si = 0;
    for (const el of this.elements) {
      if (el.isSubgraph) this.subgraphNodes[si++] = el as LayoutSubgraphNode;
    }
    this.subgraphNodes.length = si;
    this.rebuildAdjacency();
    this.rebuildGroupIndices();
  }

  addEdge(spec: EdgeSpec): void {
    this.insertEdge(spec);
  }

  removeEdge(source: ElementId, target: ElementId): void {
    const a = this.idToIndex.get(source);
    const b = this.idToIndex.get(target);
    if (a === undefined || b === undefined) {
      throw new Error(`edge references unknown node id: ${String(a === undefined ? source : target)}`);
    }
    const before = this.edges.length;
    this.edges = this.edges.filter(
      (e) => !(e.sourceIndex === a && e.targetIndex === b) && !(e.sourceIndex === b && e.targetIndex === a),
    );
    if (this.edges.length === before) {
      throw new Error(`edge not found: ${String(source)}-${String(target)}`);
    }
    this.rebuildAdjacency();
  }

  private rebuildAdjacency(): void {
    for (const set of this.adj) set.clear();
    for (const e of this.edges) {
      this.adj[e.sourceIndex].add(e.targetIndex);
      this.adj[e.targetIndex].add(e.sourceIndex);
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
    for (const nd of this.elements) {
      // 容器的 r 由 updateBoundsFromChildren（成员实占）全权管理，
      // 不吃文字盒、也不回落 baseR 声明值。
      if (nd.isSubgraph) continue;
      if (!enabled || nd.label === null) {
        nd.r = nd.baseR;
        continue;
      }
      const box = estimateLabelBox(nd.label, fs, pad);
      nd.r = Math.max(nd.baseR, Math.hypot(box.hw, box.hh) + 2);
    }
  }

  /**
   * 元素的物理 AABB 尺寸（形状声明与文字盒取较大者，px）。
   * 网格布局（grid-undirected）用本尺寸换算节点的逻辑格宽高；
   * 注意不含 subgraph 容器的成员包裹（容器按声明形状参与网格布局）。
   */
  nodeBoxSize(el: LayoutElement): { w: number; h: number } {
    let w: number;
    let h: number;
    switch (el.shape.kind) {
      case 'circle':
        w = h = 2 * el.shape.r;
        break;
      case 'ellipse':
        w = 2 * el.shape.rx;
        h = 2 * el.shape.ry;
        break;
      case 'rect':
        w = el.shape.w;
        h = el.shape.h;
        break;
    }
    if (el.label !== null) {
      const box = estimateLabelBox(el.label, this.labelFontSize, this.labelPadding);
      w = Math.max(w, 2 * box.hw);
      h = Math.max(h, 2 * box.hh);
    }
    return { w, h };
  }

  // ── 交互（拖拽支持）─────────────────────────────────────

  /** 固定节点（可同时移动它）。固定节点不受力移动，但仍对其他节点施力。 */
  fix(id: ElementId, x?: number, y?: number): void {
    const nd = this.elementById(id);
    nd.fixed = true;
    if (x !== undefined) nd.x = x;
    if (y !== undefined) nd.y = y;
  }

  unfix(id: ElementId): void {
    this.elementById(id).fixed = false;
  }

  setNodePosition(id: ElementId, x: number, y: number): void {
    const nd = this.elementById(id);
    nd.x = x;
    nd.y = y;
  }

  elementById(id: ElementId): LayoutElement {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    return this.elements[index];
  }

  indexOf(id: ElementId): number {
    const index = this.idToIndex.get(id);
    if (index === undefined) throw new Error(`unknown node id: ${String(id)}`);
    return index;
  }

  // ── 视图 ────────────────────────────────────────────────

  /** 物理节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  getPhysicalNodes(): readonly LayoutNode[] {
    return this.nodes;
  }

  /** subgraph 容器视图（实时反映最新位置与自适应半径）。 */
  getSubgraphs(): readonly LayoutSubgraphNode[] {
    return this.subgraphNodes;
  }

  /** 节点视图（内部坐标的只读引用，实时反映最新位置）。 */
  get nodeViews(): readonly NodeView[] {
    return this.nodes;
  }

  /** subgraph 容器视图（渲染约定：背景层最先绘制）。 */
  get subgraphViews(): readonly SubgraphView[] {
    return this.subgraphNodes;
  }

  /** 物理边列表（sourceIndex/targetIndex 为 nodeViews 所在 elements 数组下标；自环已剔除）。 */
  get edgeViews(): readonly Readonly<InternalEdge>[] {
    return this.edges;
  }

  get positions(): Map<ElementId, { x: number; y: number }> {
    const map = new Map<ElementId, { x: number; y: number }>();
    for (const el of this.elements) map.set(el.id, { x: el.x, y: el.y });
    return map;
  }
}
