/**
 * 边-边交叉计数。
 *
 * "线之间交叉越多，该线的收缩力越大"的计数基础：对每条边统计它与
 * 多少条**不共享端点**的边发生严格相交（proper intersection —— 端点搭接、
 * 共线重叠不算交叉）。线段取中心到中心；共享端点的邻接边天然排除。
 *
 * 候选对检测用按 x 区间排序的扫描线 + 活跃集：布局紧凑时边都很短，
 * 活跃集很小，整体接近 O(E log E + K)。为防病态大图（大量长边互相
 * 横跨）退化成 O(E²)，带测试预算：超预算返回 null，调用方回退为
 * "无交叉"（乘子全 1）—— 特性在大图上自动停用而不是拖垮求解器。
 */

export interface CrossSeg {
  a: number;
  b: number;
}
export interface CrossPoint {
  x: number;
  y: number;
}

/** 严格相交（两线段内部互分对方为两段）；端点接触/共线不算。 */
export function segmentsProperlyIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * 统计每条边与其它边的交叉次数。返回与 edges 等长的计数数组；
 * 超出 testBudget 时返回 null（调用方回退为无交叉）。
 */
export function countEdgeCrossings(
  pts: readonly CrossPoint[],
  edges: readonly CrossSeg[],
  testBudget = 80_000,
): number[] | null {
  const m = edges.length;
  const counts = new Array<number>(m).fill(0);
  if (m < 2) return counts;

  const x0 = new Float64Array(m);
  const x1 = new Float64Array(m);
  const y0 = new Float64Array(m);
  const y1 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const A = pts[edges[i].a];
    const B = pts[edges[i].b];
    x0[i] = Math.min(A.x, B.x);
    x1[i] = Math.max(A.x, B.x);
    y0[i] = Math.min(A.y, B.y);
    y1[i] = Math.max(A.y, B.y);
  }
  const order: number[] = Array.from({ length: m }, (_, i) => i).sort((p, q) => x0[p] - x0[q]);

  const active: number[] = [];
  let budget = testBudget;
  for (const i of order) {
    // 丢弃不再横跨当前边的活跃边（swap-pop）
    for (let k = active.length - 1; k >= 0; k--) {
      if (x1[active[k]] < x0[i]) {
        active[k] = active[active.length - 1];
        active.pop();
      }
    }
    const ei = edges[i];
    for (const j of active) {
      if (budget-- <= 0) return null;
      const ej = edges[j];
      // 共享端点的邻接边不算交叉
      if (ei.a === ej.a || ei.a === ej.b || ei.b === ej.a || ei.b === ej.b) continue;
      // 包围盒 y 预筛
      if (y1[j] < y0[i] || y1[i] < y0[j]) continue;
      const A = pts[ei.a];
      const B = pts[ei.b];
      const C = pts[ej.a];
      const D = pts[ej.b];
      if (segmentsProperlyIntersect(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y)) {
        counts[i]++;
        counts[j]++;
      }
    }
    active.push(i);
  }
  return counts;
}
