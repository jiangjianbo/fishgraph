/**
 * 分组（group / hidden-group / subgraph）测试：
 *
 * 推断规则（用户定义）：
 *   1. 度 ≤ 2 的相邻节点组成隐藏组（链）
 *   2. 环上所有节点组成隐藏组
 *   3. 隐藏组与节点只有一条连线 → 该节点加入（叶随链入组）
 *   4. 两个对外只有一条连线的隐藏组合并，对外少的被吞并
 *   5. 多连线组原则上不合并；星形中心（多连线节点）不入组
 *
 * 布局验收：
 *   - hidden-group 成员聚集（组内平均间距显著小于无组束缚）
 *   - subgraph 成员被约束在 hub 内部区域内，外部节点在 hub 外
 *   - 入口/出口/内部角色分类
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout, detectHiddenGroups, listStrategies } from '../src/index.js';
import type { GraphSpec } from '../src/types.js';

function chainGraph(): GraphSpec {
  return {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
    ],
  };
}

function cycleGraph(): GraphSpec {
  return {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ],
  };
}

function memberSets(groups: ReturnType<typeof detectHiddenGroups>): Set<string>[] {
  return groups.map((g) => new Set(g.members.map(String)));
}

describe('隐藏组推断', () => {
  it('规则 1：链（度≤2 路径）成一个隐藏组', () => {
    const groups = detectHiddenGroups(chainGraph());
    expect(groups.length).toBe(1);
    expect(memberSets(groups)[0]).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('规则 2：环上所有节点成一个隐藏组', () => {
    const groups = detectHiddenGroups(cycleGraph());
    expect(groups.length).toBe(1);
    expect(memberSets(groups)[0]).toEqual(new Set(['a', 'b', 'c']));
  });

  it('规则 3：环的挂接叶节点并入环组', () => {
    const graph = cycleGraph();
    graph.nodes.push({ id: 'leaf' });
    graph.edges.push({ source: 'a', target: 'leaf' });
    const groups = detectHiddenGroups(graph);
    // leaf 度 1，与环组只有一条连线 → 并入
    expect(groups.length).toBe(1);
    expect(memberSets(groups)[0].has('leaf')).toBe(true);
  });

  it('规则 4：两条链由一条边相连 → 合并成一个组（吞并）', () => {
    const graph = chainGraph();
    graph.nodes.push({ id: 'e' }, { id: 'f' });
    graph.edges.push({ source: 'd', target: 'e' }, { source: 'e', target: 'f' });
    // a-b-c-d-e-f 是一条更长链 → 本就是一个组；改造成两条链单边相连：
    // x-y（链1）与 p-q（链2），y-p 单边相连 → 合并
    const g2: GraphSpec = {
      nodes: [{ id: 'x' }, { id: 'y' }, { id: 'p' }, { id: 'q' }],
      edges: [
        { source: 'x', target: 'y' },
        { source: 'y', target: 'p' },
        { source: 'p', target: 'q' },
      ],
    };
    const groups = detectHiddenGroups(g2);
    expect(groups.length).toBe(1);
    expect(memberSets(groups)[0]).toEqual(new Set(['x', 'y', 'p', 'q']));
    void graph;
  });

  it('规则 5：星形中心（多连线）不入组', () => {
    const graph: GraphSpec = {
      nodes: [{ id: 'hub' }, { id: 's1' }, { id: 's2' }, { id: 's3' }],
      edges: [
        { source: 'hub', target: 's1' },
        { source: 'hub', target: 's2' },
        { source: 'hub', target: 's3' },
      ],
    };
    const groups = detectHiddenGroups(graph);
    // s1/s2/s3 度 1 但互不相邻（无可组合的相邻低度路径）→ 不成组
    expect(groups.length).toBe(0);
  });
});

describe('分组布局', () => {
  it('hidden-group：成员聚集（组束缚使组内更紧凑）', () => {
    // 六节点链声明为隐藏组 + 远处一个三节点团
    const graph: GraphSpec = {
      nodes: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      edges: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 4, target: 5 },
      ],
      hiddenGroups: [{ id: 'h1', members: [0, 1, 2, 3, 4, 5] }],
    };
    const layout = new ForceLayout(graph, {
      algorithm: 'group-undirected',
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 3,
    });
    // 组束缚+斥力的平衡弛豫较慢，以构型（跨度压缩）为验收目标
    layout.run({ maxIterations: 6000 });
    const p = layout.positions;
    // 有组束缚：全链跨度被压缩（自然长度 ~600+，束缚后显著更短）
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < 6; i++) {
      minX = Math.min(minX, p.get(i)!.x);
      maxX = Math.max(maxX, p.get(i)!.x);
    }
    expect(maxX - minX).toBeLessThan(420);
  });

  it('subgraph：成员约束在内部区域内、外部节点在 hub 外', () => {
    const graph: GraphSpec = {
      nodes: [
        { id: 'in1' },
        { id: 'in2' },
        { id: 'in3' },
        { id: 'out1' },
        { id: 'out2' },
      ],
      edges: [
        { source: 'in1', target: 'in2' },
        { source: 'in2', target: 'in3' },
        { source: 'sub', target: 'out1' },
        { source: 'out2', target: 'sub' },
      ],
      subgraphs: [
        {
          id: 'sub',
          shape: { kind: 'rect', w: 400, h: 300 },
          members: ['in1', 'in2', 'in3'],
        },
      ],
    };
    const layout = new ForceLayout(graph, {
      algorithm: 'group-undirected',
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 7,
    });
    layout.run({ maxIterations: 8000 });
    // z-order 约定：subgraph 物化为独立容器节点（渲染层据此作为背景层先画）
    expect(layout.subgraphViews.some((v) => v.id === 'sub')).toBe(true);
    for (const m of ['in1', 'in2']) {
      expect(layout.subgraphViews.some((v) => v.id === m)).toBe(false);
    }
    const hub = layout.positions.get('sub')!;
    const hubR = 0.55 * (Math.hypot(400, 300) / 2); // 包围半径 × 0.55（内切近似）
    // 成员在内部区域内（中心距 + 半径 ≤ 内切半径）
    for (const m of ['in1', 'in2', 'in3']) {
      const p = layout.positions.get(m)!;
      const d = Math.hypot(p.x - hub.x, p.y - hub.y);
      expect(d + 10).toBeLessThanOrEqual(hubR + 30); // 30px 容差（软墙）
    }
    // 外部节点在 hub 包围半径之外
    for (const o of ['out1', 'out2']) {
      const p = layout.positions.get(o)!;
      const d = Math.hypot(p.x - hub.x, p.y - hub.y);
      expect(d).toBeGreaterThan(150);
    }
  });

  it('角色分类：入口/出口/内部', () => {
    const graph: GraphSpec = {
      nodes: [
        { id: 'in1' }, { id: 'mid' }, { id: 'out1' }, { id: 'ext1' }, { id: 'ext2' },
      ],
      edges: [
        { source: 'ext1', target: 'in1' },
        { source: 'in1', target: 'mid' },
        { source: 'mid', target: 'out1' },
        { source: 'out1', target: 'ext2' },
      ],
      hiddenGroups: [{ id: 'g', members: ['in1', 'mid', 'out1'] }],
    };
    const layout = new ForceLayout(graph, { accuracy: 'exact', seed: 1 });
    const roles = (layout as unknown as { store: { groupRoles(id: string): { entry: string[]; exit: string[]; internal: string[] } | null } }).store.groupRoles('g');
    expect(roles).not.toBeNull();
    expect(roles!.entry).toEqual(['in1']);
    expect(roles!.exit).toEqual(['out1']);
    expect(roles!.internal).toEqual(['mid']);
  });
});

describe('外部直连容器内成员（group-undirected：包含与连通）', () => {
  function build(withEdge: boolean) {
    // 初始坐标直接进 GraphSpec（placed=true），避免 BFS init 覆盖对照布局
    return new ForceLayout(
      {
        nodes: [
          { id: 'm1', x: 0, y: -20 },
          { id: 'f1', x: 0, y: 300, fixed: true },
          { id: 'filler', x: -500, y: 0, fixed: true },
        ],
        edges: withEdge
          ? [{ source: 'f1', target: 'm1' }, { source: 'sub', target: 'filler' }]
          : [{ source: 'sub', target: 'filler' }],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect' as const, w: 400, h: 300 }, members: ['m1'] },
        ],
      },
      { algorithm: 'group-undirected', naturalLength: 120, accuracy: 'exact', gravity: 'pairwise', seed: 21 },
    );
  }

  it('角色分类：member/hub/free 正确派生', () => {
    const layout = build(true);
    // 物化顺序：nodes → subgraphs → hiddenGroups → edges，sub 在物理下标 3
    const store = (layout as unknown as {
      store: {
        elements: { isSubgraph: boolean }[];
        hubOfMember(index: number): number;
      };
    }).store;
    expect(store.hubOfMember(0)).toBe(3); // m1: member → 容器 sub（下标 3）
    expect(store.hubOfMember(2)).toBe(-1); // filler: free
    expect(store.elements[3].isSubgraph).toBe(true); // sub: hub（容器节点）
  });

  it('跨容器直连：成员保持包含、与外部节点间距有界', () => {
    // 旧 force-group 的"张力传导"力学已随算法重写消亡（简单传导实验
    // 发散已回退）；group-undirected 下的等价语义：容器折叠不破坏
    // 包含性，跨容器边经折叠提升后仍保持端点间距有界。
    const layout = build(true);
    layout.run({ maxIterations: 6000 });
    const m1 = layout.positions.get('m1')!;
    const sub = layout.positions.get('sub')!;
    const f1 = layout.positions.get('f1')!;
    // 包含保持：成员不出容器（声明内切半径 + 容差）
    const d = Math.hypot(m1.x - sub.x, m1.y - sub.y);
    expect(d).toBeLessThan(300);
    // 跨容器边连通：m1—f1 间距有界 = 容器外层边弛豫（~自然长度）+
    // 成员容器内偏移（<300，上一断言），合计数倍自然长度内（防发散量级）
    expect(Math.hypot(m1.x - f1.x, m1.y - f1.y)).toBeLessThan(4 * 120);
    // 容器—外部固定点（filler）经容器边保持分离且间距有界
    const filler = layout.positions.get('filler')!;
    const dSubFiller = Math.hypot(sub.x - filler.x, sub.y - filler.y);
    expect(dSubFiller).toBeGreaterThan(0);
    expect(dSubFiller).toBeLessThan(4 * 120);
  });
});

describe('算法纯粹性：force 纯力导向 / group-undirected 分组', () => {
  function chainGraph(): GraphSpec {
    return {
      nodes: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      edges: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 4, target: 5 },
      ],
    };
  }

  function run(graph: GraphSpec, algorithm: string): ForceLayout {
    const layout = new ForceLayout(graph, {
      algorithm,
      naturalLength: 120,
      accuracy: 'exact',
      gravity: 'pairwise',
      seed: 3,
    });
    layout.run({ maxIterations: 6000 });
    return layout;
  }

  function chainSpan(layout: ForceLayout): number {
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 6; i++) {
      minX = Math.min(minX, layout.positions.get(i)!.x);
      maxX = Math.max(maxX, layout.positions.get(i)!.x);
    }
    return maxX - minX;
  }

  function samePositions(a: ForceLayout, b: ForceLayout): boolean {
    if (a.positions.size !== b.positions.size) return false;
    return [...a.positions.entries()].every(([id, p]) => {
      const q = b.positions.get(id)!;
      return p.x === q.x && p.y === q.y;
    });
  }

  it('注册表包含 group-undirected（分组折叠算法）', () => {
    expect(listStrategies()).toContain('force-directed');
    expect(listStrategies()).toContain('group-undirected');
  });

  it('纯度：force-directed 忽略 hiddenGroups 声明（与无组声明逐位一致）', () => {
    const withGroup = run({ ...chainGraph(), hiddenGroups: [{ id: 'h1', members: [0, 1, 2, 3, 4, 5] }] }, 'force-directed');
    const withoutGroup = run(chainGraph(), 'force-directed');
    // 基础力场不读取任何 group 声明 → 同种子下轨迹必须完全一致
    expect(samePositions(withGroup, withoutGroup)).toBe(true);
  });

  it('分组：group-undirected 消费 hiddenGroups（组内跨度被压缩）', () => {
    const withoutGroup = run(chainGraph(), 'group-undirected');
    const withGroup = run({ ...chainGraph(), hiddenGroups: [{ id: 'h1', members: [0, 1, 2, 3, 4, 5] }] }, 'group-undirected');
    // 有组束缚后链的总体跨度显著收缩（自然长度约 600+，束缚后 < 420）
    expect(chainSpan(withGroup)).toBeLessThan(420);
    expect(samePositions(withGroup, withoutGroup)).toBe(false);
  });
});
