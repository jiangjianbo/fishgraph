/**
 * force-directed（有向图布局）验收：
 *
 * 覆盖角度（doc/布局核心原则.md 有向图流水线）：
 *  1. 层级解环：含环图收敛不死循环；反馈边忽略后全部正向边顺流
 *     （TB：target 在 source 下方 / LR：右侧）；
 *  2. 层级流动感：链上相邻层级行距接近 naturalLength（方向感不被微调拉平）；
 *  3. TB/LR 双方向：同一图两个方向都满足顺流与无重叠；
 *  4. 结构压测：树/星形（大量叶子 + 插列压力）不死锁、无重叠；
 *  5. 确定性：同 seed 两次布局逐位一致。
 */

import { describe, expect, it } from 'vitest';
import { minSurfaceGap } from './helpers.js';
import { ForceLayout } from '../src/index.js';
import { computeLevels } from '../src/layout/force-directed/levels.js';

/** 有向链 + 分叉 + 回环 + 独立分量的样本图。 */
function flowGraph() {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `n${i}` }));
  const edges = [
    { source: 0, target: 1 },
    { source: 1, target: 2 },
    { source: 2, target: 3 },
    { source: 1, target: 4 },
    { source: 4, target: 5 },
    { source: 5, target: 6 },
    { source: 2, target: 7 },
    { source: 7, target: 8 },
    { source: 8, target: 9 },
    { source: 9, target: 6 },
    { source: 6, target: 0 }, // 反馈边（成环）
    { source: 10, target: 11 }, // 独立分量
  ];
  return { nodes, edges };
}

function assertNoOverlap(layout: ForceLayout): void {
  const nodes = layout.nodeViews;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      expect(d).toBeGreaterThanOrEqual(nodes[i].r + nodes[j].r);
    }
  }
}

describe('force-directed：有向图布局', () => {
  it('含环图收敛不死循环：解环后全部正向边顺流（TB）', () => {
    const layout = new ForceLayout(flowGraph(), {
      algorithm: 'force-directed',
      direction: 'TB',
      naturalLength: 6,
      accuracy: 'exact',
      seed: 42,
    });
    const r = layout.run();
    expect(r.converged).toBe(true);
    for (const p of layout.nodeViews) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    assertNoOverlap(layout);

    // 正向边顺流：target 在 source 下方（反馈边 6→0 与独立分量不要求）
    const { isForwardEdge } = computeLevels(
      layout.nodeViews.length,
      layout.edgeViews.map((e) => ({ sourceIndex: e.sourceIndex, targetIndex: e.targetIndex })),
    );
    let forward = 0;
    let downstream = 0;
    for (let ei = 0; ei < layout.edgeViews.length; ei++) {
      if (!isForwardEdge[ei]) continue;
      forward++;
      const e = layout.edgeViews[ei];
      if (layout.nodeViews[e.targetIndex].y > layout.nodeViews[e.sourceIndex].y) downstream++;
    }
    expect(forward).toBeGreaterThan(0);
    expect(downstream).toBe(forward);
  });

  it('层级流动感：链式 DAG 的相邻层级行距接近 naturalLength（TB）', () => {
    const layout = new ForceLayout(
      {
        nodes: Array.from({ length: 6 }, (_, i) => ({ id: i })),
        edges: Array.from({ length: 5 }, (_, i) => ({ source: i, target: i + 1 })),
      },
      {
        algorithm: 'force-directed',
        direction: 'TB',
        naturalLength: 6,
        accuracy: 'exact',
        seed: 7,
      },
    );
    const r = layout.run();
    expect(r.converged).toBe(true);
    const p = layout.positions;
    for (let i = 0; i < 5; i++) {
      expect(p.get(i + 1)!.y).toBeGreaterThan(p.get(i)!.y);
    }
    // 层级行距：流动弹簧应把相邻层级维持在 naturalLength 量级
    for (let i = 0; i < 5; i++) {
      const dy = p.get(i + 1)!.y - p.get(i)!.y;
      expect(dy).toBeGreaterThan(120 * 0.4);
      expect(dy).toBeLessThan(120 * 2.2);
    }
  });

  it('LR 方向：全部正向边顺流（target 在右侧），无重叠', () => {
    const layout = new ForceLayout(flowGraph(), {
      algorithm: 'force-directed',
      direction: 'LR',
      naturalLength: 6,
      accuracy: 'exact',
      seed: 42,
    });
    const r = layout.run();
    expect(r.converged).toBe(true);
    assertNoOverlap(layout);
    const { isForwardEdge } = computeLevels(
      layout.nodeViews.length,
      layout.edgeViews.map((e) => ({ sourceIndex: e.sourceIndex, targetIndex: e.targetIndex })),
    );
    for (let ei = 0; ei < layout.edgeViews.length; ei++) {
      if (!isForwardEdge[ei]) continue;
      const e = layout.edgeViews[ei];
      expect(layout.nodeViews[e.targetIndex].x).toBeGreaterThan(layout.nodeViews[e.sourceIndex].x);
    }
  });

  it('方向切换（updateOptions TB→LR）：整体重排后仍满足顺流与无重叠', () => {
    const layout = new ForceLayout(flowGraph(), {
      algorithm: 'force-directed',
      direction: 'TB',
      naturalLength: 6,
      seed: 42,
    });
    layout.run();
    layout.updateOptions({ direction: 'LR' });
    const r = layout.run();
    expect(r.converged).toBe(true);
    assertNoOverlap(layout);
    const { isForwardEdge } = computeLevels(
      layout.nodeViews.length,
      layout.edgeViews.map((e) => ({ sourceIndex: e.sourceIndex, targetIndex: e.targetIndex })),
    );
    for (let ei = 0; ei < layout.edgeViews.length; ei++) {
      if (!isForwardEdge[ei]) continue;
      const e = layout.edgeViews[ei];
      expect(layout.nodeViews[e.targetIndex].x).toBeGreaterThan(layout.nodeViews[e.sourceIndex].x);
    }
  });

  it('结构压测：树 21 与星形（1+16）不死锁、无重叠、收敛', () => {
    const treeNodes: Array<{ id: string }> = [{ id: 'root' }];
    const treeEdges: Array<{ source: string; target: string }> = [];
    for (let i = 0; i < 4; i++) {
      treeNodes.push({ id: `b${i}` });
      treeEdges.push({ source: 'root', target: `b${i}` });
      for (let j = 0; j < 4; j++) {
        treeNodes.push({ id: `l${i}-${j}` });
        treeEdges.push({ source: `b${i}`, target: `l${i}-${j}` });
      }
    }
    const tree = new ForceLayout(
      { nodes: treeNodes, edges: treeEdges },
      { algorithm: 'force-directed', naturalLength: 6, seed: 42 },
    );
    expect(tree.run({ maxIterations: 6000 }).converged).toBe(true);
    assertNoOverlap(tree);

    const star = new ForceLayout(
      {
        nodes: [{ id: 'hub' }, ...Array.from({ length: 16 }, (_, i) => ({ id: `s${i}` }))],
        edges: Array.from({ length: 16 }, (_, i) => ({ source: 'hub', target: `s${i}` })),
      },
      { algorithm: 'force-directed', naturalLength: 5, seed: 42 },
    );
    expect(star.run({ maxIterations: 6000 }).converged).toBe(true);
    assertNoOverlap(star);
    expect(minSurfaceGap(star)).toBeGreaterThan(0.1);
  });

  it('确定性：同 seed 两次布局逐位一致', () => {
    const run = () => {
      const layout = new ForceLayout(flowGraph(), {
        algorithm: 'force-directed',
        direction: 'TB',
        naturalLength: 6,
        accuracy: 'exact',
        seed: 9,
      });
      layout.run();
      return layout.nodeViews.map((v) => `${v.x},${v.y}`).join('|');
    };
    expect(run()).toBe(run());
  });
});
