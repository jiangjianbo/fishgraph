/**
 * 树 21 节点验收用例（用户提供，demo "树（21 节点）" 示例的同参数验收）——
 * force-directed 有向算法：树天然有向（root→b_i→l_ij），TB 方向验收。
 *
 *  验证条件（有向语义）：
 *   - 方向流动感：全部 21 条边 target 在 source 下方（按层级流动）；
 *   - 层级清晰：b 层整体在 root 与 l 层之间（层级行不倒挂）；
 *   - 收敛、无重叠、零交叉（层内 barycenter 排序消解行内交错）。
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { countEdgeCrossings } from '../src/layout/force-undirected/crossings.js';

function treeGraph() {
  const nodes: Array<{ id: string; label: string }> = [{ id: 'root', label: 'root' }];
  const edges: Array<{ source: string; target: string }> = [];
  const level1: string[] = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `b${i}`, label: `b${i}` });
    edges.push({ source: 'root', target: `b${i}` });
    level1.push(`b${i}`);
  }
  level1.forEach((p, pi) => {
    for (let j = 0; j < 4; j++) {
      const id = `l${pi}-${j}`;
      nodes.push({ id, label: id });
      edges.push({ source: p, target: id });
    }
  });
  return { nodes, edges };
}

describe('验收：树 21 节点有向布局（force-directed，TB）', () => {
  it('全部边顺流而下、层级行不倒挂、无重叠、交叉不退化', () => {
    // 旧 px 口径恢复：naturalLength 以格声明，除以本图分级比例尺换回
    // 120px 语义（节点带标签、比例尺 > 20px，固定格数会整体放大几何，
    // 收敛与层级断言全部失配）。
    const scale0 = new ForceLayout(treeGraph(), {
      algorithm: 'force-directed',
      direction: 'TB',
    }).cellScale;
    const layout = new ForceLayout(treeGraph(), {
      algorithm: 'force-directed',
      direction: 'TB',
      naturalLength: 120 / scale0,
      edgeNodeRepulsion: 3,
      weakGravityRatio: 0.05,
      edgeTension: 1.0,
      crossingShrink: 0.15,
      crossingEnergy: 0.2,
      hopRepulsionDecay: 0.7,
      unrelatedRepulsion: 0.35,
      gravity: 'pairwise',
      accuracy: 'exact',
      seed: 42,
    });
    const r = layout.run({ maxIterations: 30000 });
    expect(r.converged).toBe(true);

    const p = layout.positions;
    // 方向流动感：每条边 target 在 source 下方（有向树的层级语义）
    for (const e of treeGraph().edges) {
      expect(
        p.get(e.target)!.y,
        `边 ${e.source}→${e.target} 的 target 应在 source 下方`,
      ).toBeGreaterThan(p.get(e.source)!.y);
    }
    // 层级清晰：第二层（l*）整体低于第一层（b*）的中位行
    const bY = [0, 1, 2, 3].map((i) => p.get(`b${i}`)!.y);
    const lY = [0, 1, 2, 3].flatMap((pi) => [0, 1, 2, 3].map((j) => p.get(`l${pi}-${j}`)!.y));
    expect(Math.min(...lY)).toBeGreaterThan(Math.max(...bY));

    // 无重叠
    const views = layout.nodeViews;
    for (let i = 0; i < views.length; i++) {
      for (let j = i + 1; j < views.length; j++) {
        const d = Math.hypot(views[i].x - views[j].x, views[i].y - views[j].y);
        expect(d).toBeGreaterThanOrEqual(views[i].r + views[j].r);
      }
    }

    // 零交叉：21 条边的有向树，层内 barycenter 排序后子树区间连续，
    // 行内交叉应完全消解（有序流动是有向美学的组成部分）。
    const edges = layout.edgeViews.map((e) => ({
      sourceIndex: e.sourceIndex,
      targetIndex: e.targetIndex,
    }));
    const counts = countEdgeCrossings(views, edges);
    const total = counts!.reduce((s, x) => s + x, 0);
    expect(total, `全树交叉数 ${total}，应为零交叉`).toBe(0);
  });
});
