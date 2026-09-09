/**
 * 树 21 节点验收用例（用户提供，demo "树（21 节点）" 示例的同参数验收）：
 *
 *  demo 默认参数：naturalLength 120、edgeNodeRepulsion 3、weakGravityRatio 0.05、
 *  edgeTension 1.0、交叉规则默认、跳数衰减 0.7/0.35、gravity pairwise、
 *  accuracy exact、init bfs、seed 42。
 *
 *  验证条件（用户原话）：
 *   - b0—l0-2 之间不应该有线段交叉，即 l0-2 必须在 b2 的左侧；
 *   - b2—l2-2 之间不应该有线段交叉，即 l2-2 必须在 b0 的下方。
 *
 *  固化为：两条位置断言 + 全树 22 条边零线段交叉（树是可平面图，
 *  任何交叉都说明叶子跑错了侧）。
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { countEdgeCrossings } from '../src/layout/force/crossings.js';

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

describe('验收：树 21 节点无交叉嵌入（用户提供）', () => {
  it('l0-2 在 b2 左侧、l2-2 在 b0 下方、全树零线段交叉', () => {
    const layout = new ForceLayout(treeGraph(), {
      naturalLength: 120,
      edgeNodeRepulsion: 3,
      weakGravityRatio: 0.05,
      edgeTension: 1.0,
      crossingShrink: 0.15,
      crossingEnergy: 0.2,
      hopRepulsionDecay: 0.7,
      unrelatedRepulsion: 0.35,
      gravity: 'pairwise',
      accuracy: 'exact',
      init: 'bfs',
      seed: 42,
    });
    const r = layout.run({ maxIterations: 30000 });
    expect(r.converged).toBe(true);

    const p = layout.positions;
    expect(p.get('l0-2')!.x).toBeLessThan(p.get('b2')!.x); // l0-2 在 b2 左侧
    expect(p.get('l2-2')!.y).toBeGreaterThan(p.get('b0')!.y); // l2-2 在 b0 下方

    // 全树零交叉：树可平面，任何交叉都意味着叶子挂错了侧
    const views = layout.nodeViews;
    const edges = (layout.edgeViews as ReadonlyArray<{ a: number; b: number }>).map((e) => ({
      a: e.a,
      b: e.b,
    }));
    const names = views.map((v) => String(v.id));
    const counts = countEdgeCrossings(views, edges);
    const crossed = edges
      .map((e, i) => (counts![i] > 0 ? `${names[e.a]}-${names[e.b]}×${counts![i]}` : null))
      .filter(Boolean);
    expect(crossed, `交叉的边：${crossed.join(', ')}`).toEqual([]);
    expect(counts!.reduce((s, x) => s + x, 0)).toBe(0);
  });
});
