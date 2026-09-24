/**
 * 边-节点净空验收（用户报告：demo 21 节点树"节点跟线重叠"）——
 *
 * 根因：refine 的质量否决只检查「移动节点自己的关联边是否穿过第三方」
 * （crossOk），从不检查「两端已定的**无关联边**是否穿过我的候选格」。
 * 弛豫阶段边-节点有斥力，会把叶子推离根-枝连线；但就近量化允许 ±半格
 * 位移，把叶子拍回线上 —— 斥力在网格化时被抹掉（"网格化的时候斥力不够"）。
 *
 * 期望语义（用户棋盘哲学）：无关联边不许穿过节点所在格胞的"谷底台面"
 * （格胞内切圆，半径 = 半格距）。台面不被穿，叶子自然被推到对角格，
 * 形成用户期望的 X 形（水平端侧 4 叶避让垂直线，X--.--X）。
 *
 * 渐进三形（按用户记法，逐步加压）：
 *  1. ".-X"     根—枝—4叶（demo 树的最小片段，5 条边）
 *  2. "X-.-X"   根居中、左右两枝各带 4 叶（X--.--X 理想切片）
 *  3. "X-+-X"   完整 demo 树（根 + 4 枝 × 4 叶 = 21 节点）
 *
 * 不变量：对每条边与每个非端点节点，节点中心到线段距离 ≥ 半格距。
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import type { GraphSpec } from '../src/types.js';

/** 点到线段的最短距离。 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 全图「无关节点 → 边」的最小净空（节点中心到线段）。 */
function minUnrelatedClearance(
  views: readonly { x: number; y: number }[],
  edgeViews: readonly { sourceIndex: number; targetIndex: number }[],
): number {
  let min = Infinity;
  for (const e of edgeViews) {
    const a = views[e.sourceIndex]!;
    const b = views[e.targetIndex]!;
    for (let k = 0; k < views.length; k++) {
      if (k === e.sourceIndex || k === e.targetIndex) continue;
      min = Math.min(min, segDist(views[k]!.x, views[k]!.y, a.x, a.y, b.x, b.y));
    }
  }
  return min;
}

/** 一枝：parent 挂一个分支节点，分支再挂 fan 个叶子。返回追加的节点/边。 */
function branchOf(
  spec: GraphSpec,
  parent: string,
  name: string,
  fan: number,
): void {
  const branch = `b-${name}`;
  spec.nodes.push({ id: branch });
  (spec.edges as Array<{ source: string; target: string }>).push({ source: parent, target: branch });
  for (let j = 0; j < fan; j++) {
    const leaf = `l-${name}-${j}`;
    spec.nodes.push({ id: leaf });
    (spec.edges as Array<{ source: string; target: string }>).push({ source: branch, target: leaf });
  }
}

/** demo 同参：力导向无向图 + 自然长度/网格 120 + 边-节点斥力 3。 */
function fuLayout(spec: GraphSpec, seed: number): ForceLayout {
  return new ForceLayout(spec, {
    naturalLength: 6,
    edgeNodeRepulsion: 3,
    gridSize: 6,
    accuracy: 'exact',
    gravity: 'pairwise',
    seed,
  });
}

/** 收敛 + 台面不变量断言（返回最小净空便于失败消息定位）。 */
function expectClearance(layout: ForceLayout, tag: string): number {
  const r = layout.run({ maxIterations: 30000 });
  expect(r.converged, `${tag}: 应收敛`).toBe(true);
  const lattice = layout.gridLattice;
  expect(lattice, `${tag}: 应暴露实际格距`).not.toBeNull();

  const views = layout.nodeViews;
  // 节点两两不重叠（基础前提）
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const d = Math.hypot(views[i]!.x - views[j]!.x, views[i]!.y - views[j]!.y);
      expect(d, `${tag}: 节点 ${views[i]!.id}/${views[j]!.id} 重叠`).toBeGreaterThanOrEqual(
        views[i]!.r + views[j]!.r,
      );
    }
  }
  const min = minUnrelatedClearance(views, layout.edgeViews);
  expect(
    min,
    `${tag}: 无关联边穿台面（最小净空 ${min.toFixed(1)} < 半格距 ${lattice! / 2}）`,
  ).toBeGreaterThanOrEqual(lattice! / 2 - 1e-6);
  return min;
}

describe('边-节点净空（网格化不抹掉斥力）', () => {
  it('.-X：根—枝—4叶片段，叶子不被根-枝边穿过', () => {
    const spec: GraphSpec = { nodes: [{ id: 'root' }], edges: [] };
    branchOf(spec, 'root', 'e', 4);
    expect(spec.nodes.length).toBe(6);
    expect(spec.edges.length).toBe(5);
    expectClearance(fuLayout(spec, 4), '.-X');
  });

  it('X-.-X：根居中、左右两枝各 4 叶，长边不裁叶', () => {
    const spec: GraphSpec = { nodes: [{ id: 'root' }], edges: [] };
    branchOf(spec, 'root', 'w', 4);
    branchOf(spec, 'root', 'e', 4);
    expect(spec.nodes.length).toBe(11);
    expectClearance(fuLayout(spec, 4), 'X-.-X');
  });

  it('X-+-X：完整 demo 树（根 + 4 枝 × 4 叶 = 21 节点）', () => {
    const spec: GraphSpec = { nodes: [{ id: 'root' }], edges: [] };
    for (const name of ['n', 's', 'w', 'e']) branchOf(spec, 'root', name, 4);
    expect(spec.nodes.length).toBe(21);
    expect(spec.edges.length).toBe(20);
    expectClearance(fuLayout(spec, 4), 'X-+-X');
  });
});
