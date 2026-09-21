/**
 * 跳数斥力衰减 —— "两个节点之间的斥力随跳数增多而下降"。
 *
 * 图拓扑（与坐标无关）决定每一对节点的跳数 h（BFS 最短路）：
 *   σ(i,j) = 1                                  h ≤ 1（邻接，键合物理不变）
 *   σ(i,j) = decay^(h−1)                        h = 2..3（同分量，逐跳衰减）
 *   σ(i,j) = floor                              h > 3 或不同分量（远程斥力基本
 *                                                消失，只留下限防接触粘连）
 *
 * 防重叠的接触弹簧（g < gFloor）**不衰减** —— 无关节点靠得再近也不会重叠，
 * 衰减只作用于中程斥力尾巴。节点数超过上限时整个特性自动停用（σ 恒 1），
 * 以免 O(n²) 矩阵失控。
 */

export const HOP_SCALE_NODE_CAP = 3000;

/**
 * 全对跳数斥力乘子矩阵（行主序 n×n，σ 对称）。
 * 超出节点上限或 decay ≥ 1（等于关闭）时返回 null。
 */
export function buildHopScale(
  adjacency: Array<Set<number>>,
  decay: number,
  floor: number,
): Float32Array | null {
  const n = adjacency.length;
  if (n === 0 || n > HOP_SCALE_NODE_CAP || decay >= 1) return null;
  const f = Math.min(Math.max(floor, 0), 1);
  const d = Math.min(Math.max(decay, 0), 1);
  const scale = new Float32Array(n * n).fill(f);
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  for (let src = 0; src < n; src++) {
    dist.fill(-1);
    dist[src] = 0;
    let head = 0;
    let tail = 0;
    queue[tail++] = src;
    while (head < tail) {
      const cur = queue[head++];
      const step = dist[cur] + 1;
      for (const nb of adjacency[cur]) {
        if (dist[nb] === -1) {
          dist[nb] = step;
          queue[tail++] = nb;
        }
      }
    }
    const base = src * n;
    for (let j = 0; j < n; j++) {
      const h = dist[j];
      // h≤1 邻接不衰减；h=2..3 逐跳衰减；h>3 与不可达（无直接或间接关系）
      // 远程斥力基本消失，只留 floor 防接触粘连
      scale[base + j] = h < 0 || h > 3 ? f : h === 1 ? 1 : Math.pow(d, h - 1);
    }
  }
  return scale;
}
