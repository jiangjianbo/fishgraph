/**
 * 分组折叠模型 —— group-undirected 的组树与层级视图。
 *
 * 深度优先递归布局的数据基础：把 subgraph 与 hidden-group 统一为
 * "复合单元"（GroupSpec 抽象的两物化），任一层级的布局只看到
 * 「自由元素 + 子组单元」的扁平视图，组内部由同一套流水线递归处理：
 *   - subgraph：容器节点本身就是单元（store.elements 里的 LayoutSubgraphNode，
 *     外部连线可直接以容器 id 为端点）；
 *   - hidden-group：布局期伪单元（GroupUnitElement，不进 store、不产生实体，
 *     布局完成后只留下成员的映射坐标）。
 *
 * 折叠语义（纯 collapse，v1 边界）：
 *   - 组内成员只见组内边；跨组连线在本层"提升"到单元上（member↔external
 *     变为 unit↔external，多条提升边去重为一条）；
 *   - 成员不直接感受组外力场，组的内外耦合只有"单元半径 = 内部块包围半径"
 *     与最终的一次整体平移映射。
 */

import {
  LayoutElement,
  type InternalEdge,
  type LayoutSubgraphNode,
  elementsAABB,
} from '../../graph/store.js';
import type { GraphStore } from '../../graph/store.js';
import type { ElementId, HiddenGroupSpec, SubgraphSpec } from '../../types.js';

/** 组树节点：一个复合单元及其嵌套结构（布局期间的可变状态）。 */
export interface GroupTreeNode {
  /** 组声明 id（subgraph/hidden-group 共用 id 域的可见部分）。 */
  readonly id: ElementId;
  /** 直接成员的元素下标（声明序；可含子组容器下标）。 */
  readonly memberIndices: number[];
  /** 子组（成员集合被本组包含的组，按声明序）。 */
  readonly children: GroupTreeNode[];
  /** 子树覆盖的全部元素下标（含子组子树与子组容器），互斥于同层其他组。 */
  readonly subtreeIndices: number[];
  /** 本组在本层的单元元素：subgraph = 容器节点；hidden = 伪单元。 */
  readonly unit: LayoutElement;
  /** subgraph 容器节点（hidden-group 为 null）。 */
  readonly container: LayoutSubgraphNode | null;
  /** 容器的物理下标（hidden-group 为 -1）。 */
  readonly containerIndex: number;
  /** 成员包裹内边距（subgraph.padding；hidden 为 0）。 */
  readonly padding: number;
}

/**
 * 量测组内部块并把单元真实形状刷新为成员实占（统一形状口径的组侧入口）：
 * 子树成员外接矩形（AABB）的并集 + padding → 单元 shape（动态矩形）。
 * subgraph 容器走 updateBoundsFromChildren（同一计算）；hidden 伪单元
 * 不进 store，就地量测赋 shape。返回块的包围盒中心（映射期锚点）；
 * 子树为空返回 null。
 */
export function refreshGroupUnitShape(
  store: GraphStore,
  g: GroupTreeNode,
): { cx: number; cy: number } | null {
  if (g.container) {
    // subgraph 容器：直接成员口径（memberIndices 可含子组容器本体）
    g.container.updateBoundsFromChildren(store.elements);
    return measureBlockCenter(store, g);
  }
  // hidden 伪单元：子树口径（成员不在 store，形状就地刷新）
  const bounds = elementsAABB(store.elements, g.subtreeIndices);
  if (!bounds) return null;
  g.unit.setShapeFromMemberBounds(bounds, g.padding);
  return measureBlockCenter(store, g);
}

/** 量测组内部块中心：子树成员外接矩形并集的几何中心（映射期现算）。 */
export function measureBlockCenter(
  store: GraphStore,
  g: GroupTreeNode,
): { cx: number; cy: number } | null {
  const bounds = elementsAABB(store.elements, g.subtreeIndices);
  if (!bounds) return null;
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2 };
}

/**
 * hidden-group 的布局期伪单元：不注册进 store、不参与渲染，
 * 仅供层级力场把它当作一个"巨大号的节点"解算。力学强度与容器
 * 同一口径：质量归一 = 1（2026-09-22 起斥力与体积/成员数无关，
 * 两种复合单元必须一致，否则就是同一规则的两种答案）。
 */
export class GroupUnitElement extends LayoutElement {
  constructor(id: ElementId) {
    super({
      id,
      x: 0,
      y: 0,
      fixed: false,
      shape: { kind: 'circle', r: 1 },
      label: null,
      placed: false,
      mass: 1,
    });
  }
}

interface GroupDecl {
  spec: SubgraphSpec | HiddenGroupSpec;
  container: LayoutSubgraphNode | null;
  padding: number;
  indices: number[];
}

/**
 * 从 store 声明构建组森林（顶层组数组，声明序）。
 *
 * - 成员引用不存在的元素：由 store 物化时已校验，这里按 indexOf 缺失即跳过；
 * - 嵌套：组 B 的成员集合 ⊆ 组 A 的成员集合 → B 是 A 的子组（直接父取
 *   包含者中成员集最小者）；
 * - 重叠（两组成员集相交且互不包含）：抛错 —— 一个元素只能折叠进一个单元，
 *   模糊归属必须是显式错误而不是静默取舍。
 */
export function buildGroupForest(store: GraphStore): GroupTreeNode[] {
  const decls: GroupDecl[] = [];
  for (const spec of store.subgraphs) {
    decls.push({
      spec,
      container: store.subgraphById(spec.id),
      padding: spec.padding ?? 2,
      indices: spec.members
        .map((m) => store.indexOf(m))
        .filter((i) => i >= 0),
    });
  }
  for (const spec of store.hiddenGroups) {
    decls.push({
      spec,
      container: null,
      padding: 0,
      indices: spec.members
        .map((m) => store.indexOf(m))
        .filter((i) => i >= 0),
    });
  }

  const sets = decls.map((d) => new Set(d.indices));
  const n = decls.length;
  // 重叠校验：两组成员集相交且互不包含 → 抛错；完全相同 → 重复声明抛错。
  // 一个元素只能折叠进一个单元，模糊归属必须是显式错误而不是静默取舍。
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [small, big] =
        sets[i]!.size <= sets[j]!.size ? [sets[i]!, sets[j]!] : [sets[j]!, sets[i]!];
      const inter = [...small].some((x) => big.has(x));
      if (!inter) continue;
      if (isSubset(sets[i]!, sets[j]!) && isSubset(sets[j]!, sets[i]!)) {
        throw new Error(
          `groups ${String(decls[i]!.spec.id)} 与 ${String(decls[j]!.spec.id)} 成员完全相同（重复声明）`,
        );
      }
      if (!isSubset(sets[i]!, sets[j]!) && !isSubset(sets[j]!, sets[i]!)) {
        throw new Error(
          `groups ${String(decls[i]!.spec.id)} 与 ${String(decls[j]!.spec.id)} 成员重叠且互不嵌套；` +
          '一个元素只能属于一个组（允许整组嵌套）',
        );
      }
    }
  }
  // 直接父：包含本组的组中成员集最小者（-1 = 顶层组）。
  const parent = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (!isSubset(sets[i]!, sets[j]!)) continue;
      if (parent[i] === -1 || sets[j]!.size < sets[parent[i]!]!.size) parent[i] = j;
    }
  }

  const nodes: GroupTreeNode[] = decls.map((d) => {
    const unit =
      d.container ?? new GroupUnitElement(d.spec.id);
    return {
      id: d.spec.id,
      memberIndices: d.indices,
      children: [],
      subtreeIndices: [],
      unit,
      container: d.container,
      containerIndex: d.container ? store.indexOf(d.spec.id) : -1,
      padding: d.padding,
    };
  });
  for (let i = 0; i < n; i++) {
    if (parent[i] !== -1) nodes[parent[i]!]!.children.push(nodes[i]!);
  }
  // 子树收集：成员 + 子组的子树 + 子组容器（容器随父组整体移动/提升，
  // 无论它是否被显式声明为父组成员 —— 去重保证同一容器只出现一次；
  // 本组自己的容器不进本组子树：它是映射锚点，不由本组平移）。
  const collect = (node: GroupTreeNode): number[] => {
    const all = new Set<number>(node.memberIndices);
    for (const c of node.children) {
      for (const idx of collect(c)) all.add(idx);
      if (c.containerIndex >= 0) all.add(c.containerIndex);
    }
    return [...all];
  };
  for (const node of nodes) {
    (node.subtreeIndices as number[]) = collect(node);
  }
  return nodes.filter((_, i) => parent[i] === -1);
}

function isSubset(a: Set<number>, b: Set<number>): boolean {
  if (a.size > b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** 一层的扁平布局视图：自由元素 + 子组单元，与提升后的邻接/边。 */
export interface LevelView {
  /** 本层布局对象（自由元素在前、单元在后；下标即力学数组下标）。 */
  elements: LayoutElement[];
  /** adj[i] = 与本层下标 i 相邻的本层下标集合。 */
  adj: Array<Set<number>>;
  /** 提升后的边（多条物理边折叠为同一条；标签盒仅保留两端均为自由元素者）。 */
  edges: InternalEdge[];
  /** 本层下标 → 组树节点（单元下标有值，自由下标为 null）。 */
  unitOf: Array<GroupTreeNode | null>;
}

/**
 * 构建一层视图。memberPool = 本层可见成员的物理下标（含子组子树）；
 * childGroups = 本层的子组（折叠为单元，其 subtreeIndices 从自由集中排除，
 * 涉及它们的连线提升到单元上）。
 */
export function buildLevelView(
  store: GraphStore,
  memberPool: readonly number[],
  childGroups: readonly GroupTreeNode[],
): LevelView {
  const covered = new Set<number>();
  const coveringGroup = new Map<number, GroupTreeNode>();
  for (const g of childGroups) {
    for (const idx of g.subtreeIndices) {
      covered.add(idx);
      coveringGroup.set(idx, g);
    }
    // 子组容器本体以折叠单元身份参与本层（unit 即容器节点本体）：
    // 必须从自由段排除，否则同一对象在力学数组出现两份 —— 粗布局按
    // 两格归零而坐标互相覆盖（质心失真、布局整体漂出画布），弛豫中
    // 同坐标自配对斥力发散（能量爆炸、永不收敛）。
    if (g.containerIndex >= 0) {
      covered.add(g.containerIndex);
      coveringGroup.set(g.containerIndex, g);
    }
  }

  // 层级下标分配：自由元素按 memberPool 序，单元随后。
  const elements: LayoutElement[] = [];
  const unitOf: Array<GroupTreeNode | null> = [];
  const freeLevel = new Map<number, number>(); // 物理下标 → 层级下标
  const groupLevel = new Map<GroupTreeNode, number>();
  for (const idx of memberPool) {
    if (covered.has(idx)) continue;
    freeLevel.set(idx, elements.length);
    elements.push(store.elements[idx]!);
    unitOf.push(null);
  }
  for (const g of childGroups) {
    groupLevel.set(g, elements.length);
    elements.push(g.unit);
    unitOf.push(g);
  }

  // 提升连线：两端解析到本层下标（自由元素 / 所属组的单元），自环与
  // 完全不可见的边剔除，多条物理边折叠为一条（去重键 = 层级端点对）。
  const resolve = (idx: number): number | null => {
    const f = freeLevel.get(idx);
    if (f !== undefined) return f;
    const g = coveringGroup.get(idx);
    if (g) return groupLevel.get(g) ?? null;
    return null;
  };
  const adj: Array<Set<number>> = elements.map(() => new Set());
  const edges: InternalEdge[] = [];
  const seen = new Set<string>();
  for (const e of store.edges) {
    const a = resolve(e.sourceIndex);
    const b = resolve(e.targetIndex);
    if (a === null || b === null || a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adj[a]!.add(b);
    adj[b]!.add(a);
    const freeEnds = freeLevel.has(e.sourceIndex) && freeLevel.has(e.targetIndex);
    edges.push(
      freeEnds
        // 复制原边（保留标签盒度量），但端点必须改写为层级下标 ——
        // 物理下标只在 store.elements 上有效。
        ? { ...e, sourceIndex: a, targetIndex: b }
        : { sourceIndex: a, targetIndex: b, label: null, labelHw: 0, labelHh: 0 },
    );
  }
  return { elements, adj, edges, unitOf };
}
