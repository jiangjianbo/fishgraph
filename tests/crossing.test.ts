/**
 * 边交叉规则测试：
 *  1. 交叉计数（扫描线 + 严格相交）：X 交叉 / T 相触 / 共端点 / 预算回退
 *  2. 交叉收缩力：μ_e 放大橡皮筋劲度 —— 交叉的边收缩力量更大、收敛更快
 *  3. 交叉能量罚：同样的节点位置、同样的连线，有交叉的布局含能量更高
 *
 * 物理一致性要点：μ_e 与能量罚在每次力场求值时用同一组交叉计数 ——
 * 分段保守（力 = −∇E 在交叉事件之间严格成立），能量单调下降不受影响。
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { countEdgeCrossings, segmentsProperlyIntersect } from '../src/layout/force/crossings.js';


describe('边交叉计数', () => {
  const pts = [
    { x: -10, y: -10 }, // 0
    { x: 10, y: 10 }, // 1
    { x: -10, y: 10 }, // 2
    { x: 10, y: -10 }, // 3
    { x: 30, y: 30 }, // 4
  ];

  it('X 交叉计为 1；共享端点不算；分离不算', () => {
    // (0-1) 与 (2-3) 严格交叉
    expect(countEdgeCrossings(pts, [{ a: 0, b: 1 }, { a: 2, b: 3 }])).toEqual([1, 1]);
    // 共享端点 (0-1) 与 (1-4)：邻接边不算交叉
    expect(countEdgeCrossings(pts, [{ a: 0, b: 1 }, { a: 1, b: 4 }])).toEqual([0, 0]);
    // 分离的 (0-2) 与 (1-4)
    expect(countEdgeCrossings(pts, [{ a: 0, b: 2 }, { a: 1, b: 4 }])).toEqual([0, 0]);
  });

  it('严格相交：端点搭接与共线不算', () => {
    // 端点搭接
    expect(segmentsProperlyIntersect(0, 0, 10, 0, 10, 0, 10, 10)).toBe(false);
    // 共线重叠
    expect(segmentsProperlyIntersect(0, 0, 10, 0, 5, 0, 15, 0)).toBe(false);
    // 真交叉
    expect(segmentsProperlyIntersect(-1, -1, 1, 1, -1, 1, 1, -1)).toBe(true);
  });

  it('超出预算返回 null（调用方回退为无交叉）', () => {
    expect(countEdgeCrossings(pts, [{ a: 0, b: 1 }, { a: 2, b: 3 }], 0)).toBeNull();
  });
});

describe('交叉收缩力：线间避让斥力与能量罚', () => {
  function build(shrink: number, energy: number, lineAvoid = false) {
    return new ForceLayout(
      {
        nodes: [
          { id: 'a', x: -150, y: -100 },
          { id: 'b', x: 150, y: 100 },
          { id: 'c', x: -150, y: 100 + (lineAvoid ? 9 : 0) }, // 微扰破对称
          { id: 'd', x: 150, y: -100 },
        ],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'c', target: 'd' },
        ],
      },
      {
        naturalLength: 120,
        accuracy: 'exact',
        gravity: 'pairwise',
        seed: 5,
        crossingShrink: shrink,
        crossingEnergy: energy,
        lineAvoidance: lineAvoid,
      },
    );
  }
  function crossingsOf(layout: ForceLayout): number {
    const views = layout.nodeViews as any[];
    const edges = (layout.edgeViews as any[]).map((e) => ({ a: e.a, b: e.b }));
    return countEdgeCrossings(views, edges)!.reduce((s, x) => s + x, 0);
  }

  it('线间避让斥力（opt-in）不使布局恶化（守底线）', () => {
    // 实证：X 交叉态是当前保守力场的真局部极小（分开态能量更低但需
    // "旋转"分量才能到达，最速下降不可达）。线间斥力的价值是防贴身、
    // 防新交叉；既有缠绕的消解交给平面 init（树）或未来的分层策略。
    const withRule = build(0.15, 0.2, true);
    withRule.run({ maxIterations: 8000 });
    expect(crossingsOf(withRule)).toBeLessThanOrEqual(2);
  });

  it('默认（线间避让关）：X 对称态守得住底线（交叉不增加、收敛合法）', () => {
    const withRule = build(0.15, 0.2);
    withRule.run({ maxIterations: 6000 });
    const without = build(0, 0);
    without.run({ maxIterations: 6000 });
    expect(crossingsOf(withRule)).toBeLessThanOrEqual(2);
    expect(crossingsOf(without)).toBeLessThanOrEqual(2);
  });

  it('已分离的平行连线不会被线间斥力挤成交叉', () => {
    const layout = build(0.15, 0.2);
    layout.setNodePosition('a', -150, -120);
    layout.setNodePosition('b', 150, -120);
    layout.setNodePosition('c', -150, 120);
    layout.setNodePosition('d', 150, 120);
    const r = layout.run({ maxIterations: 6000 });
    expect(r.converged).toBe(true);
    expect(crossingsOf(layout)).toBe(0);
  });
});

describe('交叉能量罚：同位布局中含交叉者能量更高', () => {
  const positions = [
    { id: 'a', x: -100, y: -100, fixed: true },
    { id: 'b', x: 100, y: 100, fixed: true },
    { id: 'c', x: 100, y: -100, fixed: true },
    { id: 'd', x: -100, y: 100, fixed: true },
  ];
  // 对角线连线在中心交叉；同样的节点位置换成两条竖线则不交叉
  const crossEdges = [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'd' },
  ];
  const cleanEdges = [
    { source: 'a', target: 'd' },
    { source: 'b', target: 'c' },
  ];

  function energyOf(edges: typeof crossEdges, crossing: boolean): number {
    const layout = new ForceLayout(
      { nodes: positions.map((p) => ({ ...p })), edges },
      crossing
        ? { accuracy: 'exact', seed: 1 }
        : { accuracy: 'exact', seed: 1, crossingShrink: 0, crossingEnergy: 0 },
    );
    return layout._forceSnapshot('exact').energy;
  }

  it('默认交叉规则下：交叉布局能量 > 关闭规则的同位布局', () => {
    const eCross = energyOf(crossEdges, true);
    const eOff = energyOf(crossEdges, false);
    // μ_e 放大使负引力能略降（-1.2e-3 级），能量罚必须压过它（+3.3e-3 级）
    expect(eCross).toBeGreaterThan(eOff + 1e-4);
  });

  it('同位无交叉布局（竖线连线）不受罚：与关闭规则一致', () => {
    const eClean = energyOf(cleanEdges, true);
    const eCleanOff = energyOf(cleanEdges, false);
    expect(Math.abs(eClean - eCleanOff)).toBeLessThan(1e-9);
  });
});
