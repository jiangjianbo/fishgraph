/**
 * 跳数斥力衰减测试：
 *  1. 跳数矩阵：h=1 邻接不衰减、h≥2 逐跳乘 decay^(h-1)、不同分量乘 floor
 *  2. 行为：同分量隔跳节点（h=2）在规则开启时比关闭时靠得更近
 *  3. 防重叠底线：无关系节点（floor 很小）被强压到一起也不重叠
 *     （接触弹簧不随跳数衰减）
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { buildHopScale } from '../src/layout/force/hops.js';

function minSurfaceGap(layout: ForceLayout): number {
  const nodes = layout.nodeViews;
  let min = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const gap = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) - nodes[i].r - nodes[j].r;
      if (gap < min) min = gap;
    }
  }
  return min;
}

describe('跳数斥力衰减', () => {
  it('矩阵：邻接 σ=1，h=2 乘 decay，无关系乘 floor；decay≥1 停用', () => {
    // 链 0-1-2 + 孤立点 3
    const adj = [new Set([1]), new Set([0, 2]), new Set([1]), new Set<number>()];
    const scale = buildHopScale(adj, 0.5, 0.1)!;
    expect(scale[0 * 4 + 1]).toBe(1); // h=1
    expect(scale[0 * 4 + 2]).toBeCloseTo(0.5, 6); // h=2
    expect(scale[1 * 4 + 2]).toBe(1); // h=1
    expect(scale[0 * 4 + 3]).toBeCloseTo(0.1, 6); // 无关系（h=∞）
    expect(scale[3 * 4 + 0]).toBeCloseTo(0.1, 6); // 对称
    expect(buildHopScale(adj, 1, 0.1)).toBeNull(); // 关闭
  });

  it('行为：h=2 的自由圆在规则开启时贴得更近（pairwise 弱引力 vs 斥力）', () => {
    function nearest(extra: { hopRepulsionDecay: number; unrelatedRepulsion: number }): number {
      const layout = new ForceLayout(
        { nodes: [{ id: 0 }, { id: 1 }, { id: 2 }], edges: [{ source: 0, target: 1 }] },
        { accuracy: 'exact', gravity: 'pairwise', seed: 5, ...extra },
      );
      const r = layout.run({ maxIterations: 4000 });
      expect(r.converged).toBe(true);
      const p = layout.positions;
      const c = p.get(2)!;
      const a = p.get(0)!;
      const b = p.get(1)!;
      return Math.min(Math.hypot(c.x - a.x, c.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
    }
    const on = nearest({ hopRepulsionDecay: 0.5, unrelatedRepulsion: 0.1 });
    const off = nearest({ hopRepulsionDecay: 1, unrelatedRepulsion: 1 });
    // c 与键合对相距 2 跳 → 中程斥力减半 → 弱引力把它拉得更近
    expect(on).toBeLessThan(off - 5);
  });

  it('防重叠底线：无关系节点对（floor 很小）被强压也不重叠', () => {
    const layout = new ForceLayout(
      { nodes: Array.from({ length: 6 }, (_, i) => ({ id: i })), edges: [] },
      {
        accuracy: 'exact',
        seed: 9,
        init: 'random',
        centroidStrength: 5, // 极强的向心调和约束：把无关系节点压成一团
        unrelatedRepulsion: 0.05,
        hopRepulsionDecay: 0.5,
      },
    );
    const r = layout.run({ maxIterations: 6000 });
    assertFinite(layout);
    expect(r.iterations).toBeGreaterThan(0);
    // 接触弹簧不随跳数衰减 → 无论压得多紧都不会重叠
    expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
  });
});

function assertFinite(layout: ForceLayout): void {
  for (const p of layout.positions.values()) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  }
}
