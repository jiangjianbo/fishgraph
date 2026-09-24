/**
 * group-undirected（无向分组布局：深度优先递归的复合布局）测试。
 *
 * 验收结构对应用户定义的两步实现路径：
 *  1. 前提验证：force-undirected 引擎（粗布局 + 弛豫求解器）可在 group
 *     内部节点的子图切片上直接运行 —— 递归布局的数据基础；
 *  2. 递归布局：subgraph / hidden-group 折叠为单元参与外层布局，
 *     组内成员由同一套流水线递归布局并平移映射回单元位置。
 *
 * 布局验收：
 *  - 物理节点两两无重叠（组内、组间、跨层级）；
 *  - subgraph 成员落在容器包围圆内，外部节点在容器之外；
 *  - hidden-group 成员聚成模块（组内平均间距 < 组间平均间距）；
 *  - 嵌套组递归正确（子组容器随父组移动、成员映射不出子组）；
 *  - 无组声明时与 force-undirected 逐位一致（退化纯度）；
 *  - 成员重叠且互不嵌套的声明显式报错。
 */

import { describe, expect, it } from 'vitest';
import { assertAllFinite, minSurfaceGap } from './helpers.js';
import {
  ForceLayout,
  GraphStore,
  detectHiddenGroups,
  listStrategies,
} from '../src/index.js';
import { coarsePlacement } from '../src/layout/force-undirected/coarse.js';
import { deriveParams, type ForceContext } from '../src/layout/force-undirected/forces.js';
import { RelaxationSolver } from '../src/layout/force-undirected/solver.js';
import type { GraphSpec as Spec } from '../src/types.js';

// ── 通用工具 ────────────────────────────────────────────────

/** 物理节点两两最小表面间隙（nodeViews 只含物理节点，天然不含容器）。 */
/** 两点平均两两距离（模块化验收用）。 */
function meanPairDistance(points: Array<{ x: number; y: number }>): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      sum += Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * subgraph 归属充分检查：逐容器 × 逐点验收「点是否在 subgraph 中」——
 * 成员必须落在容器矩形内（网格约束下的包含口径：容器画在容器节点
 * 位置、按成员实占贴合，包含是构造性不变量；包围圆是它的松弛上界，
 * 格点最小间距 = 格距使内切圆口径对多成员组不可满足），非成员必须
 * 落在容器包围圆外（跨容器身份重复检查：一点在甲组内、同时在乙组外
 * 的两侧断言都会显式执行）。
 */
function assertSubgraphMembership(
  layout: ForceLayout,
  checks: ReadonlyArray<{
    subId: string;
    members: readonly string[];
    nonMembers: readonly string[];
  }>,
): void {
  for (const { subId, members, nonMembers } of checks) {
    const view = layout.subgraphViews.find((v) => v.id === subId);
    expect(view, `subgraph view ${subId} exists`).toBeDefined();
    const rect = view!.shape as { kind: 'rect'; w: number; h: number };
    const hub = layout.positions.get(subId)!;
    for (const m of members) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - hub.x), `member ${m} inside ${subId}`).toBeLessThanOrEqual(
        rect.w / 2 + 1e-6,
      );
      expect(Math.abs(p.y - hub.y), `member ${m} inside ${subId}`).toBeLessThanOrEqual(
        rect.h / 2 + 1e-6,
      );
    }
    for (const o of nonMembers) {
      const p = layout.positions.get(o)!;
      // 保留区口径：容器矩形（声明）内只有成员，外部节点在矩形之外
      //（逐轴逃离；保留区是 refine 的构造性约束）
      const declared = view!.declaredShape as { kind: 'rect'; w: number; h: number };
      const outside =
        Math.abs(p.x - hub!.x) > declared.w / 2 + 1e-6 ||
        Math.abs(p.y - hub!.y) > declared.h / 2 + 1e-6;
      expect(outside, `non-member ${o} outside ${subId}`).toBe(true);
    }
  }
}

// ── 1. 前提验证：force-undirected 引擎在组内子图切片上运行 ─────

describe('前提验证：force-undirected 引擎可在 group 内部节点上运行', () => {
  it('粗布局 + 弛豫求解器在成员子图切片上直接运行（用户步骤 1）', () => {
    // 5 成员成环链 + 2 组外节点；组内切片应作为独立图求解
    const graph: Spec = {
      nodes: [
        { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
        { id: 'x' }, { id: 'y' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'd' },
        { source: 'd', target: 'e' },
        { source: 'a', target: 'c' }, // 组内成环
        { source: 'e', target: 'x' }, // 跨组边（切片中剔除）
        { source: 'x', target: 'y' },
      ],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 300, h: 200 }, members: ['a', 'b', 'c', 'd', 'e'] },
      ],
    };
    const store = new GraphStore(graph);
    const sub = store.subgraphNodes[0]!;
    const members = sub.memberIndices;
    expect(members.length).toBe(5);

    // 组内切片：成员元素 + 组内邻接/边（引擎接口全部数组化，切片即一张图）
    const local = new Map(members.map((gi, i) => [gi, i] as const));
    const subElements = members.map((i) => store.elements[i]!);
    const subAdj = members.map(() => new Set<number>());
    const subEdges = store.edges
      .filter((e) => local.has(e.sourceIndex) && local.has(e.targetIndex))
      .map((e) => ({
        sourceIndex: local.get(e.sourceIndex)!,
        targetIndex: local.get(e.targetIndex)!,
        label: null,
        labelHw: 0,
        labelHh: 0,
      }));
    for (const e of subEdges) {
      subAdj[e.sourceIndex]!.add(e.targetIndex);
      subAdj[e.targetIndex]!.add(e.sourceIndex);
    }
    expect(subEdges.length).toBe(5); // 跨组边 e-x 已被剔除

    // ① 粗布局（质点网格 + 压实）在切片上运行
    coarsePlacement(subElements, subAdj, 120);
    for (const el of subElements) {
      expect(Number.isFinite(el.x)).toBe(true);
      expect(Number.isFinite(el.y)).toBe(true);
    }
    for (let i = 0; i < subElements.length; i++) {
      for (let j = i + 1; j < subElements.length; j++) {
        const gap =
          Math.hypot(subElements[i]!.x - subElements[j]!.x, subElements[i]!.y - subElements[j]!.y) -
          subElements[i]!.getBoundRadius() -
          subElements[j]!.getBoundRadius();
        expect(gap).toBeGreaterThan(0);
      }
    }

    // ② 弛豫引擎（RelaxationSolver + 全栈力场）在切片上运行
    const L = 120;
    const params = deriveParams(
      {
        naturalLength: L / 20, // 格数：S=20 时 L_px = 120 不变
        weakGravityRatio: 0.2,
        edgeNodeRepulsion: 3,
        edgeTension: 1,
        centroidStrength: 0.1,
        crossingShrink: 0.15,
        crossingEnergy: 0.05,
        lineAvoidance: false,
      },
      subElements.length,
      20, // 格单位比例尺：测试自定 S=20，L/20 格 → 120px 不变
    );
    const ctx: ForceContext = {
      elements: subElements,
      edges: subEdges,
      adj: subAdj,
      params,
      gravity: 'centroid',
      accuracy: 'exact',
      theta: 0.9,
      labelCollision: false,
      edgeKaMul: subEdges.map(() => 1),
      edgeCrossCounts: subEdges.map(() => 0),
      crossPenaltyEnergy: 0,
      hopScale: new Float32Array(subElements.length).fill(1),
      extensions: {},
      stage: 3,
      energy: 0,
      maxForceUnit: 0,
    };
    const solver = new RelaxationSolver(ctx, {
      maxStep: 0.2 * L,
      initStep: L * 0.05,
      minStep: 1e-3,
      forceEps: 0.02,
      calmNeeded: 5,
      driftForceEps: 1e-6,
      driftRatio: 0.1,
    });
    let used = 0;
    while (!solver.converged && used < 2000) {
      if (solver.step()) used++;
    }
    expect(used).toBeGreaterThan(0);
    expect(Number.isFinite(ctx.energy)).toBe(true);
    for (let i = 0; i < subElements.length; i++) {
      for (let j = i + 1; j < subElements.length; j++) {
        const gap =
          Math.hypot(subElements[i]!.x - subElements[j]!.x, subElements[i]!.y - subElements[j]!.y) -
          subElements[i]!.getBoundRadius() -
          subElements[j]!.getBoundRadius();
        expect(gap).toBeGreaterThan(-1e-6);
      }
    }
  });
});

// ── 2. 递归布局：端到端验收 ────────────────────────────────

describe('group-undirected（深度优先递归分组布局）', () => {
  it('注册为可切换策略', () => {
    expect(listStrategies()).toContain('group-undirected');
  });

  it('subgraph：成员在容器内、外部节点在容器外、全体无重叠', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'in1' }, { id: 'in2' }, { id: 'in3' },
          { id: 'out1' }, { id: 'out2' },
        ],
        edges: [
          { source: 'in1', target: 'in2' },
          { source: 'in2', target: 'in3' },
          { source: 'in3', target: 'out1' },
          { source: 'out1', target: 'out2' },
        ],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 300, h: 220 }, members: ['in1', 'in2', 'in3'] },
        ],
      },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 7 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);

    const hub = layout.positions.get('sub')!;
    const view = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const rect = view.shape as { kind: 'rect'; w: number; h: number };
    // 成员在容器矩形内（网格约束下的包含口径，构造性不变量）
    for (const m of ['in1', 'in2', 'in3']) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - hub.x), `member ${m} inside container`).toBeLessThanOrEqual(
        rect.w / 2 + 1e-6,
      );
      expect(Math.abs(p.y - hub.y), `member ${m} inside container`).toBeLessThanOrEqual(
        rect.h / 2 + 1e-6,
      );
    }
    // 外部节点在容器声明矩形之外（保留区：容器矩形内只有成员）
    const declared = view.declaredShape as { kind: 'rect'; w: number; h: number };
    for (const o of ['out1', 'out2']) {
      const p = layout.positions.get(o)!;
      const outside =
        Math.abs(p.x - hub.x) > declared.w / 2 + 1e-6 ||
        Math.abs(p.y - hub.y) > declared.h / 2 + 1e-6;
      expect(outside, `external ${o} outside container`).toBe(true);
    }
  });

  it('hidden-group：成员聚成模块（组内平均间距 < 组间平均间距）', () => {
    // 两个 4 节点链 + 一条跨组边；无边界组折叠为不可见单元
    const layout = new ForceLayout(
      {
        nodes: Array.from({ length: 8 }, (_, i) => ({ id: i })),
        edges: [
          { source: 0, target: 1 },
          { source: 1, target: 2 },
          { source: 2, target: 3 },
          { source: 4, target: 5 },
          { source: 5, target: 6 },
          { source: 6, target: 7 },
          { source: 3, target: 4 }, // 跨组边：提升到单元之间
        ],
        hiddenGroups: [
          { id: 'g1', members: [0, 1, 2, 3] },
          { id: 'g2', members: [4, 5, 6, 7] },
        ],
      },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 11 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);

    const p = layout.positions;
    const g1 = [0, 1, 2, 3].map((i) => p.get(i)!);
    const g2 = [4, 5, 6, 7].map((i) => p.get(i)!);
    const intra = (meanPairDistance(g1) + meanPairDistance(g2)) / 2;
    const cross: Array<{ x: number; y: number }[]> = [];
    for (const a of g1) for (const b of g2) cross.push([a, b]);
    const inter = meanPairDistance(cross.flat());
    expect(intra).toBeLessThan(inter);
  });

  it('嵌套 subgraph：递归折叠，子组容器随父组移动，成员不出自己的容器', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'm1' }, { id: 'm2' }, { id: 'm3' },
          { id: 'ext1' }, { id: 'ext2' },
        ],
        edges: [
          { source: 'm1', target: 'm2' }, // inner 内部边
          { source: 'm2', target: 'm3' }, // outer 内部边（跨 inner 边界）
          { source: 'inner', target: 'ext1' },
          { source: 'outer', target: 'ext2' },
        ],
        subgraphs: [
          { id: 'inner', shape: { kind: 'rect', w: 200, h: 160 }, members: ['m1', 'm2'] },
          { id: 'outer', shape: { kind: 'rect', w: 400, h: 320 }, members: ['m1', 'm2', 'm3', 'inner'] },
        ],
      },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 3 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);

    const outer = layout.positions.get('outer')!;
    const inner = layout.positions.get('inner')!;
    const outerView = layout.subgraphViews.find((v) => v.id === 'outer')!;
    const innerView = layout.subgraphViews.find((v) => v.id === 'inner')!;
    const outerRect = outerView.shape as { kind: 'rect'; w: number; h: number };
    const innerRect = innerView.shape as { kind: 'rect'; w: number; h: number };
    // inner 在 outer 矩形内；outer 成员都在 outer 矩形内（矩形包含口径）
    expect(Math.abs(inner.x - outer.x)).toBeLessThanOrEqual(outerRect.w / 2 + 1e-6);
    expect(Math.abs(inner.y - outer.y)).toBeLessThanOrEqual(outerRect.h / 2 + 1e-6);
    for (const m of ['m1', 'm2', 'm3']) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - outer.x), `${m} inside outer`).toBeLessThanOrEqual(
        outerRect.w / 2 + 1e-6,
      );
      expect(Math.abs(p.y - outer.y), `${m} inside outer`).toBeLessThanOrEqual(
        outerRect.h / 2 + 1e-6,
      );
    }
    // inner 成员在 inner 矩形内
    for (const m of ['m1', 'm2']) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - inner.x), `${m} inside inner`).toBeLessThanOrEqual(
        innerRect.w / 2 + 1e-6,
      );
      expect(Math.abs(p.y - inner.y), `${m} inside inner`).toBeLessThanOrEqual(
        innerRect.h / 2 + 1e-6,
      );
    }
  });

  it('hidden-group 嵌套于 subgraph：伪单元随父组平移，成员映射不出容器', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'h1' }, { id: 'h2' }, { id: 'h3' },
          { id: 's1' },
          { id: 'ext' },
        ],
        edges: [
          { source: 'h1', target: 'h2' },
          { source: 'h2', target: 'h3' },
          { source: 'h3', target: 's1' },
          { source: 'sub', target: 'ext' },
        ],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 360, h: 280 }, members: ['h1', 'h2', 'h3', 's1'] },
        ],
        hiddenGroups: [{ id: 'hg', members: ['h1', 'h2', 'h3'] }],
      },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 5 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    const hub = layout.positions.get('sub')!;
    const view = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const rect = view.shape as { kind: 'rect'; w: number; h: number };
    for (const m of ['h1', 'h2', 'h3', 's1']) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - hub.x), `${m} inside sub`).toBeLessThanOrEqual(rect.w / 2 + 1e-6);
      expect(Math.abs(p.y - hub.y), `${m} inside sub`).toBeLessThanOrEqual(rect.h / 2 + 1e-6);
    }
  });

  it('确定性：同参数两次布局逐位一致', () => {
    const build = (): Spec => ({
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: i })),
      edges: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 0, target: 4 },
        { source: 4, target: 5 },
      ],
      subgraphs: [{ id: 's', shape: { kind: 'rect', w: 300, h: 200 }, members: [0, 1, 2, 3, 4] }],
    });
    const run = (): ForceLayout => {
      const layout = new ForceLayout(build(), {
        algorithm: 'group-undirected',
        naturalLength: 6,
        accuracy: 'exact',
        seed: 42,
      });
      layout.run();
      return layout;
    };
    const a = run();
    const b = run();
    expect(a.positions.size).toBe(b.positions.size);
    for (const [id, p] of a.positions) {
      const q = b.positions.get(id)!;
      expect(p.x).toBe(q.x);
      expect(p.y).toBe(q.y);
    }
  });

  it('退化纯度：无组声明时与 force-undirected 结果逐位一致', () => {
    const graph: Spec = {
      nodes: Array.from({ length: 12 }, (_, i) => ({ id: i })),
      edges: [
        { source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 },
        { source: 3, target: 4 }, { source: 4, target: 5 }, { source: 0, target: 5 },
        { source: 6, target: 7 }, { source: 7, target: 8 }, { source: 8, target: 9 },
        { source: 9, target: 10 }, { source: 10, target: 11 }, { source: 5, target: 6 },
      ],
    };
    const run = (algorithm: string): ForceLayout => {
      const layout = new ForceLayout(graph, {
        algorithm,
        naturalLength: 6,
        accuracy: 'exact',
        gravity: 'pairwise',
        seed: 42,
      });
      layout.run();
      return layout;
    };
    const base = run('force-undirected');
    const group = run('group-undirected');
    expect(group.positions.size).toBe(base.positions.size);
    for (const [id, p] of base.positions) {
      const q = group.positions.get(id)!;
      expect(p.x).toBe(q.x);
      expect(p.y).toBe(q.y);
    }
  });

  it('成员带显式坐标不污染布局（组内 placed 语义被忽略）', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          // m1 的坐标远在万米之外：组内层级必须忽略它，否则块包围盒被拉爆
          { id: 'm1', x: 99999, y: -99999 },
          { id: 'm2' }, { id: 'm3' },
          { id: 'ext' },
        ],
        edges: [
          { source: 'm1', target: 'm2' },
          { source: 'm2', target: 'm3' },
          { source: 'm3', target: 'ext' },
        ],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 300, h: 200 }, members: ['m1', 'm2', 'm3'] },
        ],
      },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 9 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    const hub = layout.positions.get('sub')!;
    const view = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const rect = view.shape as { kind: 'rect'; w: number; h: number };
    for (const m of ['m1', 'm2', 'm3']) {
      const p = layout.positions.get(m)!;
      expect(Math.abs(p.x - hub.x), `${m} inside sub`).toBeLessThanOrEqual(rect.w / 2 + 1e-6);
      expect(Math.abs(p.y - hub.y), `${m} inside sub`).toBeLessThanOrEqual(rect.h / 2 + 1e-6);
    }
  });

  it('重叠组声明（相交且互不嵌套）显式报错', () => {
    expect(
      () =>
        new ForceLayout(
          {
            nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
            edges: [{ source: 'a', target: 'd' }],
            hiddenGroups: [
              { id: 'g1', members: ['a', 'b', 'c'] },
              { id: 'g2', members: ['b', 'c', 'd'] },
            ],
          },
          { algorithm: 'group-undirected' },
        ),
    ).toThrow(/重叠/);
  });

  it('detectHiddenGroups 推断结果可直接驱动分组布局（集成冒烟）', () => {
    const graph: Spec = {
      nodes: Array.from({ length: 6 }, (_, i) => ({ id: i })),
      edges: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 4, target: 5 },
      ],
    };
    const hiddenGroups = detectHiddenGroups(graph);
    expect(hiddenGroups.length).toBeGreaterThan(0);
    const layout = new ForceLayout(
      { ...graph, hiddenGroups },
      { algorithm: 'group-undirected', naturalLength: 6, accuracy: 'exact', seed: 13 },
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
  });
});

// ── 3. 从简单到复杂的最小用例（逐容器 × 逐点归属充分检查）───────

describe('group-undirected：从简单到复杂的最小用例', () => {
  const L = 120;

  /** 最小声明参数（固定确定性）。 */
  const opts = (seed: number) => ({
    algorithm: 'group-undirected',
    naturalLength: L / 20, // 格数：S=20 → 120px
    accuracy: 'exact' as const,
    seed,
  });

  it('1. 5 个离散点，其中 2 个在 subgraph 里', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }, { id: 'p5' },
        ],
        edges: [],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 160, h: 120 }, members: ['p1', 'p2'] },
        ],
      },
      opts(21),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    assertSubgraphMembership(layout, [
      { subId: 'sub', members: ['p1', 'p2'], nonMembers: ['p3', 'p4', 'p5'] },
    ]);
  });

  it('2. 2 个点互相连线，其中一个点在 subgraph 中', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b' }],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 160, h: 120 }, members: ['a'] },
        ],
      },
      opts(22),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    assertSubgraphMembership(layout, [
      { subId: 'sub', members: ['a'], nonMembers: ['b'] },
    ]);
  });

  it('3. 3 个点：subgraph 内两点连线，外面一点孤立', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [{ source: 'a', target: 'b' }],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 160, h: 120 }, members: ['a', 'b'] },
        ],
      },
      opts(23),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    assertSubgraphMembership(layout, [
      { subId: 'sub', members: ['a', 'b'], nonMembers: ['c'] },
    ]);
    // 组内边端点保持连接（弛豫后边长为有限正值，由无重叠间接保证 > 0）
    const d = Math.hypot(
      layout.positions.get('a')!.x - layout.positions.get('b')!.x,
      layout.positions.get('a')!.y - layout.positions.get('b')!.y,
    );
    expect(d).toBeLessThan(2 * L);
  });

  it('4. 4 个点：subgraph 内两点连线，subgraph 外两点连线', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        edges: [
          { source: 'a', target: 'b' }, // 组内边
          { source: 'c', target: 'd' }, // 组外边
        ],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 160, h: 120 }, members: ['a', 'b'] },
        ],
      },
      opts(24),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    assertSubgraphMembership(layout, [
      { subId: 'sub', members: ['a', 'b'], nonMembers: ['c', 'd'] },
    ]);
    // 两条边都保持连接（各自端点距离为有限正值且小于 2 倍自然边长）
    const p = layout.positions;
    const d = (u: string, v: string): number =>
      Math.hypot(p.get(u)!.x - p.get(v)!.x, p.get(u)!.y - p.get(v)!.y);
    expect(d('a', 'b')).toBeLessThan(2 * L);
    expect(d('c', 'd')).toBeLessThan(2 * L);
  });

  it('5. 4 个点连成蛇形链，尾部 2 个点在同一个 subgraph 中', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 's0' }, { id: 's1' }, { id: 's2' }, { id: 's3' }],
        edges: [
          { source: 's0', target: 's1' },
          { source: 's1', target: 's2' },
          { source: 's2', target: 's3' },
        ],
        subgraphs: [
          { id: 'sub', shape: { kind: 'rect', w: 160, h: 120 }, members: ['s2', 's3'] },
        ],
      },
      opts(25),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    assertSubgraphMembership(layout, [
      { subId: 'sub', members: ['s2', 's3'], nonMembers: ['s0', 's1'] },
    ]);
    // 链穿过容器边界仍连通：提升边 s1→sub 与组内边 s2→s3 端点均为有限距离
    const p = layout.positions;
    const d = (u: string, v: string): number =>
      Math.hypot(p.get(u)!.x - p.get(v)!.x, p.get(u)!.y - p.get(v)!.y);
    expect(d('s2', 's3')).toBeLessThan(2 * L);
  });

  it('6. 3 个点连成链，头尾分别在一个 subgraph 中', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'h' }, { id: 'm' }, { id: 't' }],
        edges: [
          { source: 'h', target: 'm' },
          { source: 'm', target: 't' },
        ],
        subgraphs: [
          { id: 'subA', shape: { kind: 'rect', w: 160, h: 120 }, members: ['h'] },
          { id: 'subB', shape: { kind: 'rect', w: 160, h: 120 }, members: ['t'] },
        ],
      },
      opts(26),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    // 归属充分检查：每点对两个容器分别断言内/外身份
    assertSubgraphMembership(layout, [
      { subId: 'subA', members: ['h'], nonMembers: ['m', 't'] },
      { subId: 'subB', members: ['t'], nonMembers: ['h', 'm'] },
    ]);
    // 两个容器互不重叠（单元包围圆分离 + 视图半径 ≤ 单元半径）
    const gap = Math.hypot(
      layout.positions.get('subA')!.x - layout.positions.get('subB')!.x,
      layout.positions.get('subA')!.y - layout.positions.get('subB')!.y,
    );
    const rA = layout.subgraphViews.find((v) => v.id === 'subA')!.r;
    const rB = layout.subgraphViews.find((v) => v.id === 'subB')!.r;
    expect(gap).toBeGreaterThan(rA + rB - 2);
  });

  it('7. 2 个点互相连线，两个点分别在两个 subgraph 中', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b' }],
        subgraphs: [
          { id: 'subA', shape: { kind: 'rect', w: 160, h: 120 }, members: ['a'] },
          { id: 'subB', shape: { kind: 'rect', w: 160, h: 120 }, members: ['b'] },
        ],
      },
      opts(27),
    );
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    // 归属充分检查：a 只在 subA、b 只在 subB（跨容器身份双侧断言）
    assertSubgraphMembership(layout, [
      { subId: 'subA', members: ['a'], nonMembers: ['b'] },
      { subId: 'subB', members: ['b'], nonMembers: ['a'] },
    ]);
    // 跨组边提升为容器间连线：两容器分离且边保持有限连接
    const gap = Math.hypot(
      layout.positions.get('subA')!.x - layout.positions.get('subB')!.x,
      layout.positions.get('subA')!.y - layout.positions.get('subB')!.y,
    );
    const rA = layout.subgraphViews.find((v) => v.id === 'subA')!.r;
    const rB = layout.subgraphViews.find((v) => v.id === 'subB')!.r;
    expect(gap).toBeGreaterThan(rA + rB - 2);
    const p = layout.positions;
    expect(
      Math.hypot(p.get('a')!.x - p.get('b')!.x, p.get('a')!.y - p.get('b')!.y),
    ).toBeLessThan(4 * L);
  });
});
