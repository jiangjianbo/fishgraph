/**
 * 有向图的解环与层级计算（doc/布局核心原则.md 有向图流水线阶段 1）。
 *
 *  1. 解环：DFS 识别反馈边（回边，即破坏 DAG 性质的边），布局时临时忽略
 *     —— 图转为 DAG，其余边（正向/交叉/前向边）保持原方向。
 *  2. 层级：在 DAG 上按拓扑序做最长路径分层 level(v) = max(level(u)+1)，
 *     源点（无入边）在第 0 层 —— 层级即"到任意上游源点的最大距离"，
 *     决定理想行/列坐标 y_ideal = level × RowSpacing。
 *
 * 返回的 isForwardEdge 同时是流动势能的作用域：反馈边不参与"源在上游、
 * 汇在下游"的定向推力（它俩的真实几何关系由环上其余路径决定）。
 *
 * 全部迭代实现（显式栈 DFS + 计数队列 Kahn），2000+ 节点无递归爆栈风险。
 */

export interface LevelInfo {
  /** 每个元素的最长路径层级（0 = 源点层）。 */
  level: Int32Array;
  /** 每条边是否为正向边（非反馈边）：1 = 参与层级与流动势能，0 = 忽略。 */
  isForwardEdge: Uint8Array;
}

/** 层级计算只需要边的两端下标（接受 InternalEdge 或其投影）。 */
export interface EdgeEndpoints {
  sourceIndex: number;
  targetIndex: number;
}

/** DFS 三色：0 未访问 / 1 在栈（灰）/ 2 完成（黑）。 */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * 解环 + 最长路径层级。
 * @param n 元素总数（含 subgraph 容器；孤立点层级 0）
 * @param edges 边数组（sourceIndex/targetIndex 指向元素下标）
 */
export function computeLevels(n: number, edges: readonly EdgeEndpoints[]): LevelInfo {
  const level = new Int32Array(n);
  const isForwardEdge = new Uint8Array(edges.length).fill(1);

  // 出边邻接表（存边下标），供 DFS 与 Kahn 共用。
  const outEdges: number[][] = Array.from({ length: n }, () => []);
  for (let ei = 0; ei < edges.length; ei++) {
    outEdges[edges[ei]!.sourceIndex]?.push(ei);
  }

  // ── 解环：迭代式三色 DFS，target 在栈上（灰）的边即反馈边 ──
  const color = new Uint8Array(n);
  const cursor = new Int32Array(n); // 每节点已展开的出边指针
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (color[s] !== WHITE) continue;
    color[s] = GRAY;
    stack.push(s);
    while (stack.length > 0) {
      const v = stack[stack.length - 1]!;
      const outs = outEdges[v]!;
      if (cursor[v] < outs.length) {
        const ei = outs[cursor[v]++]!;
        const w = edges[ei]!.targetIndex;
        if (w === v || color[w] === GRAY) {
          isForwardEdge[ei] = 0; // 自环或回边：反馈边
        } else if (color[w] === WHITE) {
          color[w] = GRAY;
          stack.push(w);
        }
        // color[w] === BLACK：交叉/前向边，保持正向
      } else {
        color[v] = BLACK;
        stack.pop();
      }
    }
  }

  // ── 层级：仅正向边上的 Kahn 拓扑序 + 最长路径松弛 ──
  const indeg = new Int32Array(n);
  for (let ei = 0; ei < edges.length; ei++) {
    if (isForwardEdge[ei]) indeg[edges[ei]!.targetIndex]++;
  }
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let v = 0; v < n; v++) {
    if (indeg[v] === 0) queue[tail++] = v;
  }
  while (head < tail) {
    const v = queue[head++]!;
    for (const ei of outEdges[v]!) {
      if (!isForwardEdge[ei]) continue;
      const w = edges[ei]!.targetIndex;
      if (level[v]! + 1 > level[w]!) level[w] = level[v]! + 1;
      if (--indeg[w] === 0) queue[tail++] = w;
    }
  }
  return { level, isForwardEdge };
}
