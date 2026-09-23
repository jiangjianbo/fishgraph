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
import { DEFAULT_SHAPE, boundingRadius, clampPointToShape, halfExtentsOf } from '../geometry.js';
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
 * 引擎只关心 x/y 与统一形状。形状尺寸**只有一处计算来源**（2026-09-23 起）：
 *   - shape：真实形状（渲染、连线贴合、命中、成员钳制共用）——普通节点为
 *     声明形状；subgraph 容器为成员实占包围盒 + padding 的动态矩形；
 *   - labelOutset：文字盒外扩（applyNodeLabelSizes 统一计算，仅参与力学）；
 *   - hw/hh：力学外接矩形（AABB）半尺寸 = 形状半尺寸 + labelOutset，
 *     碰撞检测唯一口径；
 *   - r：等效包围圆半径 = hypot(hw, hh)，只作"尺度"语义的派生值
 *     （BH 聚合、避让软墙、网格吸附占位），不再是可赋值状态。
 */
export abstract class LayoutElement {
  /** 判别符：是否为 subgraph 容器节点（容器子类覆盖为 true；收窄用 isSubgraphNode 守卫）。 */
  readonly isSubgraph: boolean = false;
  readonly id: ElementId;
  x: number;
  y: number;
  /** 力累加器（每轮力场求值前清零）。 */
  fx = 0;
  fy = 0;
  /** 固定元素：不受力移动，但仍对其他元素施力。 */
  fixed: boolean;
  /** 真实形状（渲染/贴合/命中/钳制共用；容器为动态实占矩形）。 */
  shape: ShapeSpec;
  /** 声明形状快照（容器成员钳制上界；普通节点与 shape 相同）。 */
  readonly declaredShape: ShapeSpec;
  /** 文字盒外扩量（仅参与力学 AABB；applyNodeLabelSizes 统一写入）。 */
  labelOutset = 0;
  /** 真实形状的声明包围半径（无文字外扩的尺度参考）。 */
  readonly baseR: number;
  readonly label: string | null;
  placed: boolean;
  /** 引力质量。 */
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
    this.shape = init.shape;
    this.declaredShape = init.shape;
    this.baseR = boundingRadius(init.shape);
    this.label = init.label;
    this.placed = init.placed;
    this.mass = init.mass;
  }

  /** 力学外接矩形（AABB）半宽：形状半尺寸 + 文字外扩（统一计算，只读）。 */
  get hw(): number {
    return halfExtentsOf(this.shape).hw + this.labelOutset;
  }

  /** 力学外接矩形（AABB）半高：形状半尺寸 + 文字外扩（统一计算，只读）。 */
  get hh(): number {
    return halfExtentsOf(this.shape).hh + this.labelOutset;
  }

  /**
   * 等效包围圆半径（"尺度"语义的派生值）：声明形状的包围圆半径 +
   * 文字外扩。circle 精确等于 shape.r（含文字增量与旧行为逐位一致），
   * rect = 半对角线，ellipse = 长轴 —— 粒子的尺度量（BH 聚合、避让
   * 软墙、网格吸附）不因碰撞口径改为外接矩形而改变。
   */
  get r(): number {
    return boundingRadius(this.shape) + this.labelOutset;
  }

  getBoundRadius(): number {
    return this.r;
  }

  /**
   * 复合单元口径（subgraph 容器与 hidden 伪单元共用）：把真实形状刷新为
   * 成员实占包围盒 + padding 的动态矩形 —— "实占 → 动态矩形"的唯一构造，
   * 渲染/碰撞/贴合随 shape 自动跟随。
   */
  setShapeFromMemberBounds(bounds: ElementAABB, padding: number): void {
    this.shape = {
      kind: 'rect',
      w: (bounds.maxX - bounds.minX) + 2 * padding,
      h: (bounds.maxY - bounds.minY) + 2 * padding,
    };
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
 * 有物理实体：引擎把它当作一个节点与外部元素解算碰撞与排斥；真实形状 =
 * 成员实占包围盒 + padding 的动态矩形（updateBoundsFromChildren，世界分块
 * 种入与终局对齐、分组层级量测时刷新），与力学外接矩形、渲染矩形、连线
 * 贴合同出一处。声明的形状只作成员钳制上界（declaredShape）与成员初始
 * 分布画布，不参与力学占位。
 * 结构上支持嵌套（children 可含其它容器 id）。
 */
export class LayoutSubgraphNode extends LayoutElement {
  readonly isSubgraph = true as const;
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
   * 按成员几何刷新容器真实形状（成员实占口径的唯一计算入口）：
   * 全部成员外接矩形的并集，四周各外扩 padding。刷新后 shape 即渲染
   * 矩形、力学 AABB 与连线贴合的共同口径 —— 容器画多大，碰撞与贴线
   * 就按多大算，不再存在第二套尺寸。
   */
  updateBoundsFromChildren(elements: readonly LayoutElement[]): void {
    const bounds = elementsAABB(elements, this.memberIndices);
    if (!bounds) return;
    this.setShapeFromMemberBounds(bounds, this.padding);
  }
}

/** 类型守卫：元素是否为 subgraph 容器（判别联合收窄）。 */
export function isSubgraphNode(el: LayoutElement): el is LayoutSubgraphNode {
  return el.isSubgraph;
}

/** 元素集合的实占包围盒（各元素力学外接矩形的并集；空集合返回 null）。 */
export interface ElementAABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 按元素下标集合求力学外接矩形（AABB）并集 —— 容器/伪单元实占量测的唯一实现。 */
export function elementsAABB(
  elements: readonly LayoutElement[],
  indices: readonly number[],
): ElementAABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const idx of indices) {
    const el = elements[idx];
    if (!el) continue;
    minX = Math.min(minX, el.x - el.hw);
    minY = Math.min(minY, el.y - el.hh);
    maxX = Math.max(maxX, el.x + el.hw);
    maxY = Math.max(maxY, el.y + el.hh);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
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
   * 把成员坐标钳制进所属容器：成员包围圆完全落在容器**声明形状**内
   * （钳制上界不随成员实占收缩 —— 实占矩形由成员决定，用它钳制自己
   * 没有约束意义）；非成员原样返回。
   */
  clampToContainer(id: ElementId, x: number, y: number): { x: number; y: number } {
    const el = this.elementById(id);
    const box = this.containerOf(id);
    if (!box) return { x, y };
    return clampPointToShape(box.declaredShape, box.x, box.y, x, y, el.r);
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
      // LayoutNode 无基类之外的成员，isSubgraph=false 的收窄类型结构兼容
      if (!el.isSubgraph) this.nodes[ni++] = el;
    }
    this.nodes.length = ni;
    let si = 0;
    for (const el of this.elements) {
      if (isSubgraphNode(el)) this.subgraphNodes[si++] = el;
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

  /**
   * 节点文字盒外扩（统一计算入口）：把文字包围盒折算成 labelOutset，
   * 只参与力学 AABB（hw/hh），不改变真实形状 —— 渲染仍画声明形状，
   * 文字多少通过力学占位把邻居撑开。容器不吃文字盒（真实形状由
   * 成员实占全权管理）。
   */
  applyNodeLabelSizes(enabled: boolean): void {
    const fs = this.labelFontSize;
    const pad = this.labelPadding;
    for (const nd of this.elements) {
      if (nd.isSubgraph || !enabled || nd.label === null) {
        nd.labelOutset = 0;
        continue;
      }
      const box = estimateLabelBox(nd.label, fs, pad);
      const outset = Math.hypot(box.hw, box.hh) + 2 - nd.baseR;
      nd.labelOutset = Math.max(outset, 0);
    }
  }

  /**
   * 元素的物理 AABB 尺寸（形状声明与文字盒取较大者，px）。
   * 网格布局（grid-undirected）用本尺寸换算节点的逻辑格宽高；
   * 注意不含 subgraph 容器的成员包裹（容器按声明形状参与网格布局）。
   */
  nodeBoxSize(el: LayoutElement): { w: number; h: number } {
    const he = halfExtentsOf(el.shape);
    let w = 2 * he.hw;
    let h = 2 * he.hh;
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

  /** 按 id 取 subgraph 容器（非容器 id 抛错）——分组层取容器的语义化入口。 */
  subgraphById(id: ElementId): LayoutSubgraphNode {
    const el = this.elementById(id);
    if (!isSubgraphNode(el)) throw new Error(`node ${String(id)} is not a subgraph container`);
    return el;
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

  /**
   * 作废全部边的走线拐点。waypoints 是 grid-undirected 的布局产物，
   * 绑定产出时的节点坐标 —— 切换到其他布局算法后节点整体重排，旧拐点
   * 指向的是失效位置，必须显式清除（否则渲染层会拿旧走线画错位折线）。
   */
  clearEdgeWaypoints(): void {
    for (const e of this.edges) e.waypoints = undefined;
  }

  /**
   * 作废全部节点的物化实占尺寸。w/h 是 grid-undirected 膨胀阶段的产物
   * （格宽高 × 格距的 AABB），其他策略不产出 —— 切换算法后残留的 w/h
   * 会让渲染层把节点画成旧网格的矩形、fit-to-view 按旧实占算包围盒，
   * 必须恢复为「未物化」（渲染按声明形状、fit 按包围圆口径）。
   */
  clearMaterializedSizes(): void {
    for (const el of this.elements) {
      el.w = undefined;
      el.h = undefined;
    }
  }

  get positions(): Map<ElementId, { x: number; y: number }> {
    const map = new Map<ElementId, { x: number; y: number }>();
    for (const el of this.elements) map.set(el.id, { x: el.x, y: el.y });
    return map;
  }
}
