/**
 * force-undirected 渐进阶梯：n=1 → 5 微型图在默认网格路径下的终态精确断言。
 *
 * 定位（与现有套件互补，不重合）：
 *  - tests/layout.test.ts 用恒等坐标系测连续物理（平衡距离、自然构型），
 *    完全不经过网格吸附；
 *  - tests/force-undirected.test.ts 在默认网格路径上只测 n≥15 的宽松质量
 *    （收敛 / 无 NaN / 无重叠）。
 *  - 本文件填补空白：默认交付路径（grid 吸附）上微型图的**可精确推导**
 *    终态不变量。格点离散化让很多构型可以精确断言（边端点恰距一格、
 *    星形正交十字、三角形最小周长），这类断言对吸附/占用/就近性回归
 *    的检出率远高于"收敛、无重叠"。
 *
 * 断言原则：只锁数学上可辩护的不变量（格点对齐、互不同格、就近性、
 * 最小周长、唯一最优构型），不锁离散局部极小的具体折叠形状（如链的
 * 90° 折弯是网格离散性的固有行为，换一个等价实现允许不同折法）。
 */
import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import type { GraphSpec, NodeId } from '../src/types.js';

const L = 120; // 默认 naturalLength = gridSize = 120
const EPS = 1e-6;

/** 默认参数（seed 42）跑完整 run()：粗布局 → 弛豫 → 网格吸附修正。 */
function run(spec: Omit<GraphSpec, 'id'>): ForceLayout {
  const layout = new ForceLayout(spec as GraphSpec, { algorithm: 'force-undirected', seed: 42 });
  layout.run();
  return layout;
}

function pos(layout: ForceLayout, id: NodeId): { x: number; y: number } {
  const p = layout.positions.get(id);
  expect(p, `节点 ${id} 缺少坐标`).toBeDefined();
  return p!;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 切比雪夫格距：两点各自吸附格的切比雪夫距离（1 = 含对角的相邻格）。 */
function chebCells(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(Math.round(a.x / L) - Math.round(b.x / L)), Math.abs(Math.round(a.y / L) - Math.round(b.y / L)));
}

/** 全部节点坐标有限且落在全局格点上（网格不变量的根基）。 */
function expectAllOnGrid(layout: ForceLayout, ids: readonly NodeId[]): void {
  for (const id of ids) {
    const p = pos(layout, id);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y), `节点 ${id} 坐标有限`).toBe(true);
    expect(Math.abs(p.x % L), `节点 ${id} x=${p.x} 吸附格点`).toBeLessThan(EPS);
    expect(Math.abs(p.y % L), `节点 ${id} y=${p.y} 吸附格点`).toBeLessThan(EPS);
  }
}

/** 互不同格（格点占用唯一性；蕴含两两欧氏距离 ≥ lattice，即无重叠）。 */
function expectDistinctCells(layout: ForceLayout, ids: readonly NodeId[]): void {
  const cells = new Set(ids.map((id) => `${Math.round(pos(layout, id).x / L)},${Math.round(pos(layout, id).y / L)}`));
  expect(cells.size, `节点 ${ids.join(',')} 各占一格`).toBe(ids.length);
}

describe('force-undirected 渐进阶梯（n=1→5 微型图，默认网格路径）', () => {
  it('L1 单节点：收敛且吸附格点', () => {
    // 检出目标：吸附层在 n=1（无任何边/无斥力对）时 NaN、崩溃或漏吸附
    const layout = run({ nodes: [{ id: 'a' }], edges: [] });
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['a']);
  });

  it('L2 两个孤立点：互不同格（间距 ≥ 一格）', () => {
    // 检出目标：无边节点不注册格点占用 → 两点叠进同一格（孤立点堆叠）
    const layout = run({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] });
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['a', 'b']);
    expectDistinctCells(layout, ['a', 'b']);
    expect(dist(pos(layout, 'a'), pos(layout, 'b'))).toBeGreaterThanOrEqual(L - EPS);
  });

  it('L2 同格双 fixed：先占格、冲突外扩、自由点避开', () => {
    // 检出目标：格点占用消解路径（就近格被占 → 拒绝 → 环形外扩搜索）。
    // 稀疏图弛豫终态间距 ≥1 格，占用冲突从不触发；只有把两个 fixed 节点
    // 放进同一格（10px 近距）才能强迫冲突：f1 最近格 (0,0) 空闲保持原格，
    // f2 就近格被占必须外扩到邻格，自由点 m 再避开两者。
    const spec = {
      nodes: [
        { id: 'f1', x: 0, y: 0, fixed: true },
        { id: 'f2', x: 10, y: 4, fixed: true },
        { id: 'm', x: 5, y: 2 },
      ],
      edges: [],
    };
    const layout = run(spec);
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['f1', 'f2', 'm']);
    expectDistinctCells(layout, ['f1', 'f2', 'm']);
    const f1 = pos(layout, 'f1');
    expect(f1.x, 'f1 最近格空闲应保持原位 x').toBe(0);
    expect(f1.y, 'f1 最近格空闲应保持原位 y').toBe(0);
    const f2 = pos(layout, 'f2');
    expect(Math.max(Math.abs(f2.x / L), Math.abs(f2.y / L)), 'f2 外扩后仍在 f1 相邻格（切比雪夫 1）').toBeLessThanOrEqual(1);
  });

  it('L2 两点一边：端点恰距一格（= 自然长度的正交邻位）', () => {
    // 数学：格点对间最小距离 = lattice = naturalLength，弹簧零张力的唯一
    // 格点构型是正交邻位（欧氏 120）。落到对角 169.7 = 吸附就近性丢失；
    // 距 240 = 弹簧平衡回归（弛豫没把边收缩到自然长度）。
    const layout = run({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] });
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['a', 'b']);
    const d = dist(pos(layout, 'a'), pos(layout, 'b'));
    expect(d, `边端点距离 ${d} 应恰为自然长度 ${L}`).toBeCloseTo(L, 6);
    expect(chebCells(pos(layout, 'a'), pos(layout, 'b'))).toBe(1);
  });

  it('L3 三节点链：边端点就近（切比雪夫 ≤1 格）、互不同格', () => {
    // 检出目标：BFS 放置/吸附把相连端点甩到相距多格（就近性破坏）。
    // 说明：链不保证共线 —— 网格离散局部极小允许 90° 折弯（实测如此），
    // 只锁正确性不变量，不锁折法。
    const spec = { nodes: [{ id: 0 }, { id: 1 }, { id: 2 }], edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }] };
    const layout = run(spec);
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, [0, 1, 2]);
    expectDistinctCells(layout, [0, 1, 2]);
    for (const [a, b] of [[0, 1], [1, 2]] as const) {
      expect(chebCells(pos(layout, a), pos(layout, b)), `边 ${a}-${b} 端点相邻格`).toBeLessThanOrEqual(1);
      expect(dist(pos(layout, a), pos(layout, b)), `边 ${a}-${b} 距离 ≥ lattice`).toBeGreaterThanOrEqual(L - EPS);
    }
  });

  it('L3 三角形：最小周长格点构型（两正交边 + 一对角）', () => {
    // 数学：等边三角形在格点上不可满足（√3 无理）；3 个不同格点两两
    // 距离 ≥ L 时周长的下界 = 2L + L√2 ≈ 409.71（两短边必为正交邻位，
    // 第三边 = 对角）。实测恰达下界；周长更大 = 吸附产生了冗余分离。
    const spec = { nodes: [{ id: 0 }, { id: 1 }, { id: 2 }], edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 0 }] };
    const layout = run(spec);
    expectAllOnGrid(layout, [0, 1, 2]);
    expectDistinctCells(layout, [0, 1, 2]);
    const d01 = dist(pos(layout, 0), pos(layout, 1));
    const d12 = dist(pos(layout, 1), pos(layout, 2));
    const d20 = dist(pos(layout, 2), pos(layout, 0));
    for (const d of [d01, d12, d20]) expect(d, '三角形边长 ≥ lattice').toBeGreaterThanOrEqual(L - EPS);
    const perimeter = d01 + d12 + d20;
    expect(perimeter, `周长 ${perimeter.toFixed(3)} 应达格点下界 ${2 * L + L * Math.SQRT2}`).toBeLessThanOrEqual(2 * L + L * Math.SQRT2 + EPS);
  });

  it('L3 一条边 + 1 个孤立点：边恰一格、孤立点不堆叠', () => {
    const spec = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'iso' }], edges: [{ source: 'a', target: 'b' }] };
    const layout = run(spec);
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['a', 'b', 'iso']);
    expectDistinctCells(layout, ['a', 'b', 'iso']);
    expect(dist(pos(layout, 'a'), pos(layout, 'b'))).toBeCloseTo(L, 6);
    for (const end of ['a', 'b'] as const) {
      expect(dist(pos(layout, 'iso'), pos(layout, end)), `孤立点距端点 ${end} ≥ 一格`).toBeGreaterThanOrEqual(L - EPS);
    }
  });

  it('L4 四节点链：边端点就近、互不同格', () => {
    const spec = {
      nodes: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
      edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 }],
    };
    const layout = run(spec);
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, [0, 1, 2, 3]);
    expectDistinctCells(layout, [0, 1, 2, 3]);
    for (const [a, b] of [[0, 1], [1, 2], [2, 3]] as const) {
      expect(chebCells(pos(layout, a), pos(layout, b)), `边 ${a}-${b} 端点相邻格`).toBeLessThanOrEqual(1);
      expect(dist(pos(layout, a), pos(layout, b)), `边 ${a}-${b} 距离 ≥ lattice`).toBeGreaterThanOrEqual(L - EPS);
    }
  });

  it('L4 两组独立连线：分量内端点邻位、分量间不同格且质心分离', () => {
    // 检出目标：连通分量间分离失效 —— 两分量叠进同一片格（unrelated
    // 斥力/分量互斥回归）。质心距下界取田字挤压极限 L（两个 2 格分量
    // 最紧只能拼成 2×2 田字，质心距 = L）。
    const spec = {
      nodes: [{ id: 'a1' }, { id: 'a2' }, { id: 'b1' }, { id: 'b2' }],
      edges: [{ source: 'a1', target: 'a2' }, { source: 'b1', target: 'b2' }],
    };
    const layout = run(spec);
    expectAllOnGrid(layout, ['a1', 'a2', 'b1', 'b2']);
    expectDistinctCells(layout, ['a1', 'a2', 'b1', 'b2']);
    for (const [p, q] of [['a1', 'a2'], ['b1', 'b2']] as const) {
      const d = dist(pos(layout, p), pos(layout, q));
      expect(d, `分量内边 ${p}-${q} 距 ${d}，应在 [L, L√2] 邻位区间`).toBeLessThanOrEqual(L * Math.SQRT2 + EPS);
    }
    const ca = { x: (pos(layout, 'a1').x + pos(layout, 'a2').x) / 2, y: (pos(layout, 'a1').y + pos(layout, 'a2').y) / 2 };
    const cb = { x: (pos(layout, 'b1').x + pos(layout, 'b2').x) / 2, y: (pos(layout, 'b1').y + pos(layout, 'b2').y) / 2 };
    expect(dist(ca, cb), '两分量质心距 ≥ 田字挤压极限').toBeGreaterThanOrEqual(L - EPS);
  });

  it('L4 一条边 + 2 个孤立点：边恰一格、四点四格、孤立点不堆叠', () => {
    const spec = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'i1' }, { id: 'i2' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    const layout = run(spec);
    expectAllOnGrid(layout, ['a', 'b', 'i1', 'i2']);
    expectDistinctCells(layout, ['a', 'b', 'i1', 'i2']);
    expect(dist(pos(layout, 'a'), pos(layout, 'b'))).toBeCloseTo(L, 6);
    for (const iso of ['i1', 'i2'] as const) {
      for (const end of ['a', 'b'] as const) {
        expect(dist(pos(layout, iso), pos(layout, end)), `孤立点 ${iso} 距端点 ${end} ≥ 一格`).toBeGreaterThanOrEqual(L - EPS);
      }
    }
    expect(dist(pos(layout, 'i1'), pos(layout, 'i2')), '两孤立点互不堆叠').toBeGreaterThanOrEqual(L - EPS);
  });

  it('L5 星形 K1,4：收敛为正交十字（叶恰在 hub 的上下左右邻格）', () => {
    // 旗舰精确断言：lattice = naturalLength 时，K1,4 在格点上的唯一能量
    // 最优构型是正交十字 —— 4 叶互不同格且每条辐恰距一格，只可能是
    // {(±L,0),(0,±L)}。任何一叶被甩到 2 格外或叠进对角都是回归。
    const spec = {
      nodes: [{ id: 'hub' }, { id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }],
      edges: [
        { source: 'hub', target: 'l1' }, { source: 'hub', target: 'l2' },
        { source: 'hub', target: 'l3' }, { source: 'hub', target: 'l4' },
      ],
    };
    const layout = run(spec);
    expect(layout.converged).toBe(true);
    expectAllOnGrid(layout, ['hub', 'l1', 'l2', 'l3', 'l4']);
    expectDistinctCells(layout, ['hub', 'l1', 'l2', 'l3', 'l4']);
    const hub = pos(layout, 'hub');
    const offsets = ['l1', 'l2', 'l3', 'l4'].map((id) => {
      const p = pos(layout, id);
      return `${p.x - hub.x},${p.y - hub.y}`;
    }).sort();
    expect(offsets, `叶相对 hub 偏移 ${offsets.join(' | ')} 应恰为正交四邻`).toEqual(
      expect.arrayContaining([`${-L},0`, `${L},0`, `0,${-L}`, `0,${L}`]),
    );
    expect(new Set(offsets).size).toBe(4);
  });

  it('确定性：L1→L5 全阶梯同 seed 重跑逐位一致', () => {
    // 检出目标：吸附层 BFS/占用排序对迭代顺序不稳定 → 微型图上出现
    // 非确定性（大图确定性已有专测，这里是吸附排序的最小暴露面）。
    const specs: Array<Omit<GraphSpec, 'id'>> = [
      { nodes: [{ id: 'a' }], edges: [] },
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      { nodes: [{ id: 0 }, { id: 1 }, { id: 2 }], edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }] },
      { nodes: [{ id: 0 }, { id: 1 }, { id: 2 }], edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 0 }] },
      {
        nodes: [{ id: 'hub' }, { id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }],
        edges: [
          { source: 'hub', target: 'l1' }, { source: 'hub', target: 'l2' },
          { source: 'hub', target: 'l3' }, { source: 'hub', target: 'l4' },
        ],
      },
    ];
    for (const spec of specs) {
      const a = run(spec);
      const b = run(spec);
      for (const [id, pa] of a.positions) {
        const pb = b.positions.get(id)!;
        expect(pb.x, `节点 ${id} x 逐位一致`).toBe(pa.x);
        expect(pb.y, `节点 ${id} y 逐位一致`).toBe(pa.y);
      }
    }
  });
});
