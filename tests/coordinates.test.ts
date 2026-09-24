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
} from '../src/index.js';
import type { GraphSpec } from '../src/types.js';

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
    // lattice = max(naturalLength, 2·rmax)：格距不小于最大直径，保证不重叠
    const views = layout.nodeViews;
    const lattice = Math.max(120, Math.max(...views.map((v) => v.r)) * 2);
    for (const nd of views) {
      expect(Math.abs(nd.x % lattice)).toBeLessThan(1e-6);
      expect(Math.abs(nd.y % lattice)).toBeLessThan(1e-6);
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
    const views = layout.nodeViews;
    for (const nd of views) {
      expect(Math.abs(nd.x % 60)).toBe(0); // 格点倍数（lattice=60）
      expect(Math.abs(nd.y % 60)).toBe(0);
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
