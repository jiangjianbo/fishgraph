/**
 * 坐标系（布局完成后的坐标修正）测试：
 *  - grid（默认）：坐标吸附到格点倍数、节点不重叠、fixed 也吸附、确定性
 *  - subgraph：成员吸附后被钳制在包含区域内
 *  - 注册表：未知名报错、自定义坐标系可注册
 */

import { describe, expect, it } from 'vitest';
import {
  ForceLayout,
  createCoordinateSystem,
  listCoordinateSystems,
  registerCoordinateSystem,
  resolveRefineLattice,
  zoneLatticeCap,
} from '../src/index.js';
import type { GraphSpec } from '../src/types.js';
import type { CoordinateNode } from '../src/layout/coordinates.js';

/** 坐标到最近格胞中心 (i+0.5)·G 的残差（0 = 恰在中心）。 */
function centerResidual(v: number, G: number): number {
  const r = (((v - G / 2) % G) + G) % G;
  return Math.min(r, G - r);
}

function chainGraph(n = 8): GraphSpec {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ source: i, target: i + 1 }));
  return { nodes, edges };
}

describe('grid 坐标系（布局后网格化）', () => {
  it('默认即网格化：不指定 coordinateSystem 时坐标同样吸附格点', () => {
    const layout = new ForceLayout(chainGraph(8), {
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 4,
    });
    const r = layout.run({ maxIterations: 6000 });
    expect(r.converged).toBe(true);
    // 实际格距由布局暴露（L2 自适应：max(请求值, 力学平衡最近邻)），
    // 节点全部坐在格胞中心 (i+0.5)·lattice 上。
    const lattice = layout.gridLattice;
    expect(lattice, '网格化后应暴露实际格距').not.toBeNull();
    const views = layout.nodeViews;
    for (const nd of views) {
      expect(centerResidual(nd.x, lattice!)).toBeLessThan(1e-6);
      expect(centerResidual(nd.y, lattice!)).toBeLessThan(1e-6);
    }
  });

  it('流向约束：有向算法（force-directed, TB）默认网格化后链仍顺流', () => {
    // 8 节点链（0→1→…→7）：默认 grid 坐标系携带流向约束时，
    // target 的格行必须严格大于 source（TB 不允许同行/逆行）。
    const layout = new ForceLayout(chainGraph(8), {
      algorithm: 'force-directed',
      direction: 'TB',
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 4,
    });
    const r = layout.run({ maxIterations: 6000 });
    expect(r.converged).toBe(true);
    const views = layout.nodeViews;
    const pos = new Map(views.map((v) => [String(v.id), v]));
    for (let i = 0; i < 7; i++) {
      const a = pos.get(String(i))!;
      const b = pos.get(String(i + 1))!;
      expect(b.y, `边 ${i}→${i + 1} 逆流（${a.y} → ${b.y}）`).toBeGreaterThan(a.y);
    }
  });

  it('所有节点吸附到格点；节点间不重叠；fixed 也吸附', () => {    const layout = new ForceLayout(chainGraph(8), {
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 4,
      coordinateSystem: 'grid',
      gridSize: 60,
    });
    const r = layout.run({ maxIterations: 6000 });
    expect(r.converged).toBe(true);
    // 请求格距 60 小于链的力学平衡间距（≈naturalLength）→ L2 自适应抬格距；
    // 吸附目标 = 实际格距的格胞中心。
    const lattice = layout.gridLattice;
    expect(lattice, '自适应格距应不小于请求值 60').toBeGreaterThanOrEqual(60);
    const views = layout.nodeViews;
    for (const nd of views) {
      expect(centerResidual(nd.x, lattice!)).toBeLessThan(1e-6);
      expect(centerResidual(nd.y, lattice!)).toBeLessThan(1e-6);
    }
    // 无重叠：任意两节点中心距 ≥ 半径和
    for (let i = 0; i < views.length; i++) {
      for (let j = i + 1; j < views.length; j++) {
        const d = Math.hypot(views[i].x - views[j].x, views[i].y - views[j].y);
        expect(d).toBeGreaterThanOrEqual(views[i].r + views[j].r);
      }
    }
  });

  it('确定性：两次运行逐位相同', () => {
    const run = () => {
      const layout = new ForceLayout(chainGraph(6), {
        naturalLength: 120,
        accuracy: 'exact',
        gravity: 'pairwise',
        seed: 9,
        coordinateSystem: 'grid',
        gridSize: 60,
      });
      layout.run({ maxIterations: 6000 });
      return layout.nodeViews.map((v) => `${v.x},${v.y}`).join('|');
    };
    expect(run()).toBe(run());
  });

  // force-group 已由 group-undirected（递归折叠流水线）取代：成员包含
  // 由折叠布局保证，本用例随之切换算法恢复（原用例保留不删除）。
  it('subgraph 成员吸附后仍在包含区域内', () => {
    const graph: GraphSpec = {
      nodes: [{ id: 'in1' }, { id: 'in2' }, { id: 'ext' }],
      edges: [{ source: 'in1', target: 'in2' }, { source: 'sub', target: 'ext' }],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 400, h: 300 }, members: ['in1', 'in2'] },
      ],
    };
    const layout = new ForceLayout(graph, {
      algorithm: 'group-undirected',
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 6,
      coordinateSystem: 'grid',
      gridSize: 60,
    });
    layout.run({ maxIterations: 6000 });
    const hub = layout.positions.get('sub')!;
    const rIn = 0.55 * (Math.hypot(400, 300) / 2);
    for (const m of ['in1', 'in2']) {
      const p = layout.positions.get(m)!;
      const d = Math.hypot(p.x - hub.x, p.y - hub.y);
      expect(d).toBeLessThanOrEqual(rIn + 90); // 格点吸附的容差（一个格内）
    }
  });
});

describe('注册表', () => {
  it('未知名报错；自定义坐标系可注册并生效', () => {
    expect(() => createCoordinateSystem('nope')).toThrow(/nope/);
    expect(listCoordinateSystems()).toContain('grid');
    registerCoordinateSystem('origin-snap', () => ({
      name: 'origin-snap',
      refine(nodes) {
        for (const nd of nodes) {
          nd.x = 0;
          nd.y = 0;
        }
      },
    }));
    const layout = new ForceLayout(chainGraph(4), {
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 2,
      coordinateSystem: 'origin-snap',
    });
    layout.run({ maxIterations: 3000 });
    for (const v of layout.nodeViews) {
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    }
  });
});

describe('resolveRefineLattice（L2 格距自适应）', () => {
  /** n 个点等距排在 x 轴上，间距 spacing（只取 x/y 参与 最近邻估计）。 */
  function lineNodes(n: number, spacing: number): CoordinateNode[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i, x: i * spacing, y: 0, r: 10, fixed: false,
    }));
  }

  it('少于 2 个节点：透传请求格距（无最近邻可估）', () => {
    expect(resolveRefineLattice(120, [])).toBe(120);
    expect(resolveRefineLattice(120, [{ id: 'solo', x: 5, y: 7, r: 10, fixed: false }])).toBe(120);
  });

  it('请求格距不小于平衡间距：透传请求值', () => {
    // 等距 100 < 请求 120：就近量化已保证逐点一格，无需抬格距
    expect(resolveRefineLattice(120, lineNodes(5, 100))).toBe(120);
  });

  it('平衡间距大于请求格距：抬到覆盖最近邻（d ≥ G 才保证格分离）', () => {
    // 等距 158 > 请求 120：G 必须 ≥ 158，否则相邻点可能落进同一格胞
    expect(resolveRefineLattice(120, lineNodes(6, 158))).toBeGreaterThanOrEqual(158);
  });

  it('不动点：全部最近邻恰为 G 的吸附态，重复修正不漂移格距', () => {
    // 吸附完成后最近邻间距 = lattice；resolve 再输入同一状态必须返回
    // 同一 G —— 逐帧重复网格化不会让格距越滚越大。
    const nodes = lineNodes(6, 160);
    const G = resolveRefineLattice(120, nodes);
    expect(resolveRefineLattice(G, nodes)).toBe(G);
  });

  it('稳健估计：单点离群不主导格距（取最近邻中位而非最大）', () => {
    // 格距是「典型力学平衡间距」的估计：离群点（超大标签节点、孤立
    // 远点）只占最近邻样本至多一份，中位使它无法抬全局格距 —— 分层
    // 折叠布局的冻结样本可能只有几个元素，保守分位会把全部层级抬爆。
    // 逐点分离不依赖格距 ≥ 最大间距：吸附的占用表 + 距离检查兜底。
    const withOutlier = [...lineNodes(24, 150), { id: 'far', x: 20000, y: 20000, r: 10, fixed: false } as CoordinateNode];
    expect(resolveRefineLattice(120, withOutlier)).toBe(150);

    // 大图同口径：中位的稳健性与规模无关
    const big = lineNodes(200, 150);
    big.push({ id: 'far', x: 20000, y: 20000, r: 10, fixed: false });
    expect(resolveRefineLattice(120, big)).toBe(150);
  });

  it('zoneLatticeCap：净空容量决定最大格距', () => {
    // 净空 ±140 内放 2 个格胞：格距 140 时列数 = 2·⌊140/140⌋+1 = 3 ≥ 2 ✓
    expect(zoneLatticeCap(140, 140, 2)).toBeCloseTo(140, 9);
    // 单成员无容量约束
    expect(zoneLatticeCap(140, 140, 1)).toBe(Infinity);
    // 净空非正（容器装不下成员实体）：无约束（退回无约束语义）
    expect(zoneLatticeCap(0, 140, 2)).toBe(Infinity);
    // 9 个成员需要 3×3：格距 L 满足 (2⌊hw/L⌋+1)² ≥ 9 ⇔ L ≤ hw
    expect(zoneLatticeCap(150, 150, 9)).toBeCloseTo(150, 9);
    expect(zoneLatticeCap(150, 150, 10)).toBeLessThan(150);
  });

  it('格距自适应对容器容量上限取小：包含性优先于量化均匀', () => {
    // 弛豫平衡间距 277 远超容器容量上限 140：格距被钳到 140，
    // 容器净空内才装得下全部成员格胞（成员不出区）。
    const nodes = lineNodes(3, 277);
    expect(resolveRefineLattice(120, nodes, [140])).toBe(140);
    // 多容器取最小上限
    expect(resolveRefineLattice(120, nodes, [140, 200])).toBe(140);
    // 上限高于自适应值时不生效
    expect(resolveRefineLattice(120, nodes, [300])).toBeGreaterThanOrEqual(277);
    // 请求格距超过上限时维持请求值（不虚构包含，与旧语义一致）
    expect(resolveRefineLattice(200, nodes, [140])).toBe(200);
  });
});
