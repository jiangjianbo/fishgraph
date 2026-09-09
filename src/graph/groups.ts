/**
 * 隐藏组（hidden-group）拓扑推断 —— 无需用户声明，按连线结构自动分组。
 *
 * 规则（用户定义）：
 *   1. 只跟 1 个或 2 个节点分别有连线的节点，可与相邻节点组合成隐藏组
 *      → 实现为"度 ≤ 2 的极大路径"（链）成组；
 *   2. 构成环状结构的所有节点构成一个隐藏组
 *      → 实现为"边双连通分量中含环的部分"（去桥后含环的块）成组；
 *   3. 隐藏组和节点只有一个连线，则该节点可加入隐藏组
 *      → 链的端点自然并入（链端即度 1 节点）；挂接叶随所在链入组；
 *   4. 两个对外只有一条连线的隐藏组可以合并，对外连线少的被吞并；
 *      对外有多个连线的隐藏组原则上不合并
 *      → 组图上的迭代吞并（保留对外度大的组的 id）。
 *
 * 高度节点（星形中心等）不属于任何隐藏组。
 */

import type { GraphSpec, NodeId } from '../types.js';

export interface HiddenGroup {
  members: NodeId[];
}

/** 无向邻接表（自环忽略）。 */
function buildAdjacency(graph: GraphSpec): Array<Set<number>> {
  const adj: Array<Set<number>> = graph.nodes.map(() => new Set());
  for (const e of graph.edges) {
    const a = graph.nodes.findIndex((n) => n.id === e.source);
    const b = graph.nodes.findIndex((n) => n.id === e.target);
    if (a < 0 || b < 0 || a === b) continue;
    adj[a].add(b);
    adj[b].add(a);
  }
  return adj;
}

/** Tarjan 边双连通分量：返回每个"去桥后分量"的成员下标与内部边数。 */
function edgeBiconnectedComponents(
  adj: Array<Set<number>>,
): Array<{ members: number[]; internalEdges: number }> {
  const n = adj.length;
  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const isBridge = new Set<string>();
  let timer = 0;
  const dfs = (u: number, pe: string) => {
    disc[u] = low[u] = timer++;
    for (const v of adj[u]) {
      const edgeKey = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (edgeKey === pe) continue;
      if (disc[v] === -1) {
        dfs(v, edgeKey);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > disc[u]) isBridge.add(edgeKey);
      } else {
        low[u] = Math.min(low[u], disc[v]);
      }
    }
  };
  for (let i = 0; i < n; i++) if (disc[i] === -1) dfs(i, '');

  // 去桥后分桶
  const comp = new Array<number>(n).fill(-1);
  const comps: Array<{ members: number[]; internalEdges: number }> = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const ci = comps.length;
    const members: number[] = [];
    comp[s] = ci;
    const queue = [s];
    for (let h = 0; h < queue.length; h++) {
      const u = queue[h];
      members.push(u);
      for (const v of adj[u]) {
        const edgeKey = u < v ? `${u}-${v}` : `${v}-${u}`;
        if (isBridge.has(edgeKey)) continue; // 桥不连通两侧
        if (comp[v] === -1) {
          comp[v] = ci;
          queue.push(v);
        }
      }
    }
    // 内部边数（非桥边且两端都在分量内）
    let internalEdges = 0;
    for (const u of members) {
      for (const v of adj[u]) {
        const edgeKey = u < v ? `${u}-${v}` : `${v}-${u}`;
        if (comp[v] === ci && !isBridge.has(edgeKey)) internalEdges++;
      }
    }
    internalEdges /= 2;
    comps.push({ members, internalEdges });
  }
  return comps;
}

/**
 * 推断隐藏组。返回成员为节点 id 的组列表（已按规则 4 完成吞并合并）。
 * 同一节点只属于一个隐藏组；度 > 2 且不在环上的节点不入组。
 */
export function detectHiddenGroups(graph: GraphSpec): HiddenGroup[] {
  const adj = buildAdjacency(graph);
  const n = adj.length;
  const assigned = new Uint8Array(n); // 已入组标记
  const groups: Array<{ idx: number[] }> = [];

  // ── 规则 2：环（含环的双连通分量，≥3 节点）──
  for (const comp of edgeBiconnectedComponents(adj)) {
    if (comp.members.length >= 3 && comp.internalEdges >= comp.members.length) {
      groups.push({ idx: [...comp.members] });
      for (const m of comp.members) assigned[m] = 1;
    }
  }

  // ── 规则 1+3：链（未入组节点中，度 ≤ 2 的连通子图，且为路径形）──
  // 剩余子图 = 原图去掉已入组节点后的连通分量
  const remainingAdj: Array<Set<number>> = adj.map((set, i) => {
    if (assigned[i]) return new Set<number>();
    const s = new Set<number>();
    for (const v of set) if (!assigned[v]) s.add(v);
    return s;
  });
  const seen = new Uint8Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (assigned[s0] || seen[s0]) continue;
    const members: number[] = [];
    const queue = [s0];
    seen[s0] = 1;
    for (let h = 0; h < queue.length; h++) {
      const u = queue[h];
      members.push(u);
      for (const v of remainingAdj[u]) {
        if (!seen[v]) { seen[v] = 1; queue.push(v); }
      }
    }
    if (members.length < 2) continue;
    const maxDeg = Math.max(...members.map((u) => remainingAdj[u].size));
    const edgeCount = members.reduce((sum, u) => sum + remainingAdj[u].size, 0) / 2;
    // 路径形：连通、最大度 ≤ 2、边数 = 节点数 − 1（星形/分叉不入组）
    if (maxDeg <= 2 && edgeCount === members.length - 1) {
      groups.push({ idx: [...members] });
      for (const m of members) assigned[m] = 1;
    }
  }

  // ── 规则 3：挂接并入 —— 未入组、度为 1 的节点，若其唯一邻居已入组
  //    则并入该组（"隐藏组和节点只有一个连线则该节点可以加入"）──
  let attached = true;
  while (attached) {
    attached = false;
    for (let u = 0; u < n; u++) {
      if (assigned[u] || adj[u].size !== 1) continue;
      const nb = [...adj[u]][0];
      if (!assigned[nb]) continue;
      // 找到邻居所在组并入
      for (const g of groups) {
        if (g.idx.includes(nb)) {
          g.idx.push(u);
          assigned[u] = 1;
          attached = true;
          break;
        }
      }
    }
  }

  // ── 规则 4：组图上的吞并合并 ──
  // 对外连线数 = 与"非本组成员"相连的边数
  const externalDegree = (idx: number[]): number => {
    let count = 0;
    for (const u of idx) for (const v of adj[u]) {
      const inSame = idx.includes(v);
      if (!inSame) count++;
    }
    return count;
  };
  const crossEdges = (a: number[], b: number[]): number => {
    const setA = new Set(a);
    let count = 0;
    for (const u of a) for (const v of adj[u]) if (!setA.has(v) && b.includes(v)) count++;
    return count;
  };

  let merged = true;
  while (merged && groups.length > 1) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length && !merged; j++) {
        if (crossEdges(groups[i].idx, groups[j].idx) !== 1) continue;
        const extI = externalDegree(groups[i].idx);
        const extJ = externalDegree(groups[j].idx);
        if (extI > 3 || extJ > 3) continue; // 多连线组原则上不合并
        // 吞并：对外连线少的被并入对外连线多的
        const [keep, gone] = extI >= extJ ? [groups[i], groups[j]] : [groups[j], groups[i]];
        keep.idx = [...keep.idx, ...gone.idx];
        groups.splice(groups.indexOf(gone), 1);
        merged = true;
      }
    }
  }

  return groups.map((g) => ({ members: g.idx.map((i) => graph.nodes[i].id) }));
}
