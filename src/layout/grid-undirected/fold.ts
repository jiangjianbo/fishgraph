/**
 * 折叠布局（folding）—— grid-first 流水线的可选预处理 / 展开后处理。
 *
 * 目标：把"长蛇阵"（链）与 subgraph 收成单质点参与粗布局，布局完成后
 * 再递归展开 —— 长链不再拉长全局布局，容器成员由递归子布局评估尺寸。
 *
 * 三类折叠单元（视图项）：
 *   - element   未折叠的单元素（真实元素下标）；
 *   - chain     透明 group：本作用域内度 ≤ 2 的极简单链（长度 ≥ 阈值，
 *     成环不折叠），成员序列保持链序 —— 展开 = 沿主轴排开；
 *   - subgraph  容器整体折叠，尺寸由子作用域递归布局评估（包裹 + padding）。
 *
 * 结构：
 *   - 作用域树：root + 每个 subgraph 一个作用域；元素归属最内层容器
 *     作用域，容器元素归属父作用域；
 *   - 边归属 LCA：每条边归入两端作用域的最近公共祖先的视图（unit 内
 *     部边 / 连自身容器的边提升后成自环，丢弃）；
 *   - 链识别：作用域内元素-元素边上度 ≤ 2 的极简单链，从下标最小的
 *     可行种子向两端延伸（取下标最小的可行邻居，确定性）。
 *
 * 展开（unfold）：chain → 成员沿主轴按格尺寸排开（间隙 1 格走线走廊，
 * 垂直于主轴在 AABB 内居中）；subgraph → 子作用域相对布局平移进容器
 * AABB（padding 偏移）后递归展开。展开产物 = 每个真实元素的格 AABB，
 * 交回主流水线物理化与走线。
 */

import type { GraphStore, LayoutSubgraphNode } from '../../graph/store.js';
import { isSubgraphNode } from '../../graph/store.js';
import type { Box } from './space-types.js';

/**
 * 链内相邻成员的格间隙。默认 0（成员紧贴成块）：紧贴时折叠块面积恒为
 * 成员格数之和，「面积最小」退化为常数，**周长最小成为形状判据** ——
 * 展开 / subgraph 紧凑准则由此落到近方形状。
 */
export const CHAIN_GAP = 0;

/** 视图项：折叠单元。 */
export type FoldItem =
  | { kind: 'element'; index: number }
  | { kind: 'chain'; members: number[] }
  | { kind: 'subgraph'; index: number; scope: FoldScope };

/** 作用域：一个容器（或 root）内部的折叠视图。 */
export interface FoldScope {
  /** 视图项（下标 = 视图下标）。 */
  items: FoldItem[];
  /** 视图邻接（item 下标域）。 */
  adjacency: Array<Set<number>>;
  /** 真实元素下标 → 视图项下标（容器元素 → 容器项；链成员 → 链项）。 */
  itemOfElement: Map<number, number>;
  /** 本作用域对应的容器元素下标（root = -1）。 */
  containerIndex: number;
  /** 父作用域（root = null）。 */
  parent: FoldScope | null;
  /** LCA 归属到本作用域的边（真实元素下标对；归属阶段链尚未折叠）。 */
  elementEdges: Array<[number, number]>;
}

export interface FoldPlan {
  root: FoldScope;
  /** 全部作用域（含 root；构建序）。 */
  scopes: FoldScope[];
}

/** 元素 → 所属作用域（容器元素 → 父作用域）的映射在 buildFoldPlan 内构建。 */

/**
 * 构建折叠计划：作用域树 + 链识别 + 视图邻接。
 * @param minChainLength 链折叠的最小长度（< 该长度的链不折叠）。
 */
export function buildFoldPlan(store: GraphStore, minChainLength: number): FoldPlan {
  const scopes: FoldScope[] = [];
  const scopeOfElement = new Map<number, FoldScope>();

  const makeScope = (directNodes: number[], subContainers: number[], containerIndex: number, parent: FoldScope | null): FoldScope => {
    const scope: FoldScope = {
      items: [],
      adjacency: [],
      itemOfElement: new Map(),
      containerIndex,
      parent,
      elementEdges: [],
    };
    scopes.push(scope);
    // 子容器：递归建子作用域，容器元素与全部（递归）成员都映射到容器项。
    for (const ci of subContainers) {
      const container = store.elements[ci] as LayoutSubgraphNode;
      const own: number[] = [];
      const nested: number[] = [];
      for (const m of container.memberIndices) {
        const el = store.elements[m]!;
        if (isSubgraphNode(el)) nested.push(m);
        else own.push(m);
      }
      const sub = makeScope(own, nested, ci, scope);
      const idx = scope.items.length;
      scope.items.push({ kind: 'subgraph', index: ci, scope: sub });
      scope.itemOfElement.set(ci, idx);
      scopeOfElement.set(ci, scope);
    }
    // 直接节点。
    for (const ni of directNodes) {
      const idx = scope.items.length;
      scope.items.push({ kind: 'element', index: ni });
      scope.itemOfElement.set(ni, idx);
      scopeOfElement.set(ni, scope);
    }
    return scope;
  };

  // 顶层：非成员普通元素为直接节点；无父容器的 subgraph 为顶层子容器。
  const rootNodes: number[] = [];
  const rootContainers: number[] = [];
  store.elements.forEach((el, i) => {
    if (store.hubOfMember(i) !== -1) return;
    if (isSubgraphNode(el)) rootContainers.push(i);
    else rootNodes.push(i);
  });
  const root = makeScope(rootNodes, rootContainers, -1, null);

  // 边归属 LCA：每条边提升到两端作用域的最近公共祖先，记录元素对。
  for (const e of store.edges) {
    let a = e.sourceIndex;
    let b = e.targetIndex;
    let sa = requireScope(scopeOfElement, a);
    let sb = requireScope(scopeOfElement, b);
    while (sa !== sb) {
      if (depthOf(sa) > depthOf(sb)) {
        a = sa.containerIndex;
        sa = requireParent(sa);
      } else if (depthOf(sb) > depthOf(sa)) {
        b = sb.containerIndex;
        sb = requireParent(sb);
      } else {
        a = sa.containerIndex;
        sa = requireParent(sa);
        b = sb.containerIndex;
        sb = requireParent(sb);
      }
    }
    sa.elementEdges.push([a, b]);
  }

  // 链识别（逐作用域）：在本作用域的元素-元素边上找极简单链。
  for (const scope of scopes) foldChainsInScope(scope, minChainLength);

  // 视图邻接：elementEdges 按视图项映射（自环丢弃）。
  for (const scope of scopes) {
    scope.adjacency = scope.items.map(() => new Set<number>());
    for (const [a, b] of scope.elementEdges) {
      const ia = scope.itemOfElement.get(a);
      const ib = scope.itemOfElement.get(b);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      scope.adjacency[ia]!.add(ib);
      scope.adjacency[ib]!.add(ia);
    }
  }

  return { root, scopes };
}

function requireScope(map: Map<number, FoldScope>, idx: number): FoldScope {
  const s = map.get(idx);
  if (!s) throw new Error(`element ${idx} not in any fold scope`);
  return s;
}

function requireParent(scope: FoldScope): FoldScope {
  if (!scope.parent) throw new Error('root scope has no parent');
  return scope.parent;
}

function depthOf(scope: FoldScope): number {
  let d = 0;
  for (let s: FoldScope | null = scope; s; s = s.parent) d++;
  return d;
}

/**
 * 作用域内链识别与替换：元素-元素边上「链节点」的极简单链（长度 ≥
 * minChainLength 且不成环）折叠为 chain 项。
 *
 * 链节点口径（用户定义）：只有两条连线、且分别跟**不同**节点（排除
 * 双边连同一点）；链为这类节点的连续集合，不含环。端点可以是度 1 的
 * 叶子或挂接在分叉点上的链尾。
 */
function foldChainsInScope(scope: FoldScope, minChainLength: number): void {
  // 元素-元素多重邻接（本作用域，链候选图；邻居数组含平行边重复）。
  const nodeItems = new Map<number, number>(); // 元素下标 → element 项下标
  scope.items.forEach((item, idx) => {
    if (item.kind === 'element') nodeItems.set(item.index, idx);
  });
  const adj = new Map<number, number[]>(); // 元素下标 → 邻居（按边计，含重复）
  for (const [a, b] of scope.elementEdges) {
    if (!nodeItems.has(a) || !nodeItems.has(b) || a === b) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  // 链节点：度 1（叶子端头）或度 2 且两邻居不同（"分别跟不同的节点"）。
  const chainable = (v: number): boolean => {
    const ns = adj.get(v) ?? [];
    if (ns.length === 1) return true;
    if (ns.length === 2) return ns[0] !== ns[1];
    return false;
  };
  const inChain = new Set<number>();
  const chains: number[][] = [];

  // 从 from 经 to 离开，沿唯一可行方向走到链端：返回 [from, to, ...]；
  // 遇分叉（>1 可行延伸）返回 []，遇环（回到已走节点）返回 []。
  const walk = (from: number, to: number): number[] => {
    const path = [from, to];
    let prev = from;
    let cur = to;
    for (;;) {
      const cands = [...(adj.get(cur) ?? [])].filter((n) => n !== prev && !inChain.has(n) && chainable(n));
      if (cands.length === 0) return path; // 端点
      if (cands.length > 1) return []; // 分叉：非链
      const next = cands[0]!;
      if (path.includes(next)) return []; // 环：放弃
      path.push(next);
      prev = cur;
      cur = next;
    }
  };

  const seeds = [...nodeItems.keys()].sort((x, y) => x - y);
  for (const v of seeds) {
    if (inChain.has(v) || !chainable(v)) continue;
    const nbrs = [...new Set(adj.get(v) ?? [])].filter((n) => !inChain.has(n) && chainable(n)).sort((x, y) => x - y);
    let chain: number[];
    if (nbrs.length === 0) {
      chain = [v];
    } else if (nbrs.length === 1) {
      chain = walk(v, nbrs[0]!);
    } else {
      // 两端延伸：下标较小的邻居走左向（确定性），其余走右向。
      const left = walk(v, nbrs[1]!).reverse(); // [端L,…,v]
      const right = walk(v, nbrs[0]!); // [v,…,端R]
      chain = left.length === 0 || right.length === 0 ? [] : [...left.slice(0, -1), ...right];
    }
    if (chain.length < minChainLength) continue;
    chains.push(chain);
    for (const m of chain) inChain.add(m);
  }

  // 替换视图项：链成员 element 项移除，chain 项追加。
  if (chains.length === 0) return;
  const removed = new Set(chains.flat());
  scope.items = scope.items.filter(
    (item) => !(item.kind === 'element' && removed.has(item.index)),
  );
  for (const chain of chains) {
    scope.items.push({ kind: 'chain', members: chain });
  }
  // 项下标因移除而位移：全部映射按新 items 重建（element/chain/subgraph）。
  scope.itemOfElement.clear();
  scope.items.forEach((item, idx) => {
    if (item.kind === 'chain') {
      for (const m of item.members) scope.itemOfElement.set(m, idx);
    } else {
      scope.itemOfElement.set(item.index, idx);
    }
  });
}

/**
 * 链展开的蛇形网格布局（与 subgraph 展开同一紧凑准则）：
 * **包围盒面积最小，平局取周长（W+H）最小，再平局取横向**。
 *
 * 枚举每行成员数 c = 1..N，行优先分组、行内蛇形（偶数行正序、奇数行
 * 反序，保证链边在换行处也连接相邻单元），成员间留 gap 格走线走廊。
 */
export interface ChainGridLayout {
  /** 链序成员的相对格位（AABB 左上角）。 */
  positions: Array<{ x: number; y: number }>;
  /** 包裹尺寸（格）。 */
  width: number;
  height: number;
}

export function chainGridLayout(
  sizes: ReadonlyArray<{ w: number; h: number }>,
  gap = CHAIN_GAP,
): ChainGridLayout {
  const n = sizes.length;
  if (n === 0) return { positions: [], width: 0, height: 0 };
  let bestC = 1;
  let bestArea = Infinity;
  let bestPerim = Infinity;
  let bestW = 0;
  for (let c = 1; c <= n; c++) {
    const rows: number[][] = [];
    for (let i = 0; i < n; i += c) rows.push(sizes.map((_, k) => k).slice(i, i + c));
    let w = 0;
    let h = 0;
    for (const row of rows) {
      w = Math.max(w, row.reduce((s, i) => s + sizes[i]!.w, 0) + (row.length - 1) * gap);
      h += Math.max(...row.map((i) => sizes[i]!.h));
    }
    h += (rows.length - 1) * gap;
    const area = w * h;
    const perim = w + h;
    // 字典序：面积 → 周长 → 平局取横向（W ≥ H，长蛇的常规读向）。
    const better =
      area < bestArea ||
      (area === bestArea && perim < bestPerim) ||
      (area === bestArea && perim === bestPerim && w > bestW);
    if (better) {
      bestC = c;
      bestArea = area;
      bestPerim = perim;
      bestW = w;
    }
  }

  // 按 bestC 生成蛇形位置：第一遍求各尺寸，第二遍落位。
  const rows: number[][] = [];
  for (let i = 0; i < n; i += bestC) rows.push(sizes.map((_, k) => k).slice(i, i + bestC));
  const rowWidths = rows.map((row) => row.reduce((s, k) => s + sizes[k]!.w, 0) + (row.length - 1) * gap);
  const rowHeights = rows.map((row) => Math.max(...row.map((k) => sizes[k]!.h)));
  const width = Math.max(...rowWidths);
  const positions: Array<{ x: number; y: number }> = new Array(n);
  let y = 0;
  rows.forEach((row, r) => {
    const seq = r % 2 === 0 ? row : [...row].reverse();
    // 反序行从右端起放，行末成员与下一行行末成员蛇形相邻。
    let cursor = r % 2 === 0 ? 0 : width - rowWidths[r]!;
    for (const k of seq) {
      positions[k] = { x: cursor, y };
      cursor += sizes[k]!.w + gap;
    }
    y += rowHeights[r]! + gap;
  });
  return { positions, width, height: y - gap };
}

/**
 * 链展开落位：按蛇形网格布局把成员写回 out[成员元素下标]
 * （相对格位平移到链 AABB 原点）。
 */
export function unfoldChain(
  members: readonly number[],
  box: Box,
  sizeOf: (el: number) => { w: number; h: number },
  out: Box[],
): void {
  const sizes = members.map((m) => sizeOf(m));
  const layout = chainGridLayout(sizes);
  members.forEach((m, i) => {
    const p = layout.positions[i]!;
    out[m] = { x: box.x + p.x, y: box.y + p.y, width: sizes[i]!.w, height: sizes[i]!.h };
  });
}
