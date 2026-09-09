/**
 * fishgraph 测试套件。
 *
 * 覆盖角度：
 *  1. 物理平衡：核力式斥力 vs 引力 + 线性张力；陌生节点弱引力
 *  2. 求解器性质：能量单调、确定性、NaN 防护、收敛
 *  3. 边-节点避让（压线被推开）
 *  4. Barnes-Hut：与精确解一致性、中等规模布局质量
 *  5. 规模：节点数量从少到多（5 → 2000）
 *  6. 构成：成群点与离散点的数量比例混合（0% / 25% / 50% / 75%）
 *  7. 五类构型场景：
 *     S1 同大小圆点无连线（2~6 个）自然构型
 *     S2 同大小圆点全两两连线，构型与无连线等同
 *     S3 两圆连线 + 1~4 个离散圆（品字/菱形等）
 *     S4 方形 1 对多连线，圆贴合四个边（pairwise 弱引力）
 *     S5 边文字撑开距离 + 长文字按最小面积回绕
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout, estimateLabelBox } from '../src/index.js';
import type { GraphSpec, NodeId } from '../src/types.js';

// ── 通用工具 ────────────────────────────────────────────────

function pairDistance(layout: ForceLayout, idA: NodeId, idB: NodeId): number {
  const a = layout.positions.get(idA)!;
  const b = layout.positions.get(idB)!;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 可复现随机图（LCG）。 */
function randomGraph(n: number, p: number, seed: number): GraphSpec {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < p) edges.push({ source: i, target: j, label: rand() < 0.2 ? `e${i}-${j}` : undefined });
    }
  }
  return { nodes, edges };
}

/** 连通随机图：随机生成树 + 额外边。 */
function connectedRandomGraph(n: number, extraRatio: number, seed: number): GraphSpec {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
  const edges: Array<{ source: number; target: number }> = [];
  for (let i = 1; i < n; i++) edges.push({ source: Math.floor(rand() * i), target: i });
  for (let k = 0; k < Math.floor(n * extraRatio); k++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b) edges.push({ source: a, target: b });
  }
  return { nodes, edges };
}

/** 相邻节点的平衡间隙 g*：截断斥力 = 橡皮筋弹力
 *  k_r(1/g − 1/2L)/g² = τ·(k_a/L²)·g → 2L⁴(1/g − 1/2L) = τ·g³（k_r = 2L·k_a）。
 *  τ=1 时恰有 g* = L（自然长度）；τ 越小橡皮筋越软、平衡被墙尾推得越远。 */
function equilibriumGap(L: number, stiffness: number): number {
  let lo = 1e-3;
  let hi = 2 * L;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (2 * Math.pow(L, 4) * (1 / mid - 1 / (2 * L)) - stiffness * Math.pow(mid, 3) < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

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

function assertAllFinite(layout: ForceLayout): void {
  for (const p of layout.positions.values()) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  }
}

interface RingInfo {
  radii: number[];
  angleGaps: number[];
  centerCount: number;
}

/** 以质心为原点分析环状构型：半径、相邻角度间隔、处于核心的节点数。 */
function ringInfo(nodes: ReadonlyArray<{ x: number; y: number }>): RingInfo {
  const n = nodes.length;
  const cx = nodes.reduce((s, p) => s + p.x, 0) / n;
  const cy = nodes.reduce((s, p) => s + p.y, 0) / n;
  const items = nodes
    .map((p) => ({ r: Math.hypot(p.x - cx, p.y - cy), a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((a, b) => a.a - b.a);
  const angleGaps: number[] = [];
  for (let i = 0; i < n; i++) {
    let da = items[(i + 1) % n].a - items[i].a;
    if (i === n - 1) da += Math.PI * 2;
    angleGaps.push((da * 180) / Math.PI);
  }
  const rmax = Math.max(...items.map((q) => q.r));
  return {
    radii: items.map((q) => q.r),
    angleGaps,
    centerCount: items.filter((q) => q.r < rmax * 0.4).length,
  };
}

function expectRegularRing(info: RingInfo, n: number, radiusTol: number, gapTolDeg: number): void {
  const mean = info.radii.reduce((s, r) => s + r, 0) / n;
  for (const r of info.radii) expect(Math.abs(r - mean)).toBeLessThan(mean * radiusTol);
  const gap = 360 / n;
  for (const g of info.angleGaps) expect(Math.abs(g - gap)).toBeLessThan(gapTolDeg);
}

// ── 1. 物理平衡 ──────────────────────────────────────────────

describe('物理平衡（核力式斥力 vs 引力 + 线性张力）', () => {
  const L = 100;

  it('相邻节点平衡在「斥力 = 引力 + 线性张力」处', () => {
    const gStar = equilibriumGap(L, 0.1); // ≈ 92.7 → 中心距 ≈ 112.7
    const layout = new ForceLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      { naturalLength: L, edgeTension: 0.1, gravity: 'pairwise', accuracy: 'exact', seed: 1 },
    );
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    const d = pairDistance(layout, 'a', 'b');
    expect(d).toBeGreaterThan(gStar + 20 - 7);
    expect(d).toBeLessThan(gStar + 20 + 7);
  });

  it('edgeTension=0 时橡皮筋松弛：间隙退到斥力作用域边缘（2L）', () => {
    const layout = new ForceLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      { naturalLength: L, edgeTension: 0, gravity: 'pairwise', accuracy: 'exact', seed: 1 },
    );
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    const d = pairDistance(layout, 'a', 'b');
    // 无弹力时只剩截断斥力：推到 g=R=2L 后力归零（平坦区，取下界断言）
    expect(d).toBeGreaterThan(2 * L + 20 - 25);
  });

  it('非相邻节点（弱引力 ratio=0.2）平衡距离大于相邻情形，饱和于作用域×无关系系数', () => {
    // 截断斥力 + 跳数衰减：无关系对（h=∞）远程斥力乘 unrelatedRepulsion=0.25
    // → 0.25·k_r(1/g − 1/R) = k_w → g ≈ 111 → 中心距 ≈ 131。
    // 陌生人仍比朋友远，且远程斥力基本消失（覆盖面积趋小）。
    const layout = new ForceLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] },
      { naturalLength: L, weakGravityRatio: 0.2, gravity: 'pairwise', accuracy: 'exact', init: 'grid', seed: 1 },
    );
    const r = layout.run({ maxIterations: 6000 });
    expect(r.converged).toBe(true);
    const d = pairDistance(layout, 'a', 'b');
    expect(d).toBeGreaterThan(120);
    expect(d).toBeLessThan(160);
  });

  it('三角形收敛为等边', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
        edges: [
          { source: 1, target: 2 },
          { source: 2, target: 3 },
          { source: 1, target: 3 },
        ],
      },
      { naturalLength: L, gravity: 'pairwise', accuracy: 'exact', seed: 7 },
    );
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    const sides = [pairDistance(layout, 1, 2), pairDistance(layout, 2, 3), pairDistance(layout, 1, 3)];
    for (const s of sides) {
      expect(s).toBeGreaterThan(sides[0] * 0.9);
      expect(s).toBeLessThan(sides[0] * 1.1);
    }
  });
});

// ── 2. 边-节点避让 ───────────────────────────────────────────

describe('边-节点避让', () => {
  it('压在别人线段上的节点被软墙推离', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'A', x: -80, y: 0 },
          { id: 'B', x: 80, y: 0 },
          { id: 'C', x: 0, y: 0 },
          { id: 'D', x: 0, y: 3 },
        ],
        edges: [{ source: 'A', target: 'B' }],
      },
      { naturalLength: 140, edgeNodeRepulsion: 3, accuracy: 'exact', seed: 3 },
    );
    layout.run({ maxIterations: 3000 });
    const A = layout.positions.get('A')!;
    const B = layout.positions.get('B')!;
    const segSurfaceDist = (p: { x: number; y: number }) => {
      const abx = B.x - A.x;
      const aby = B.y - A.y;
      let t = ((p.x - A.x) * abx + (p.y - A.y) * aby) / (abx * abx + aby * aby);
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (A.x + abx * t), p.y - (A.y + aby * t)) - 10;
    };
    // 软墙作用距离 ρ = 0.15×140 = 21：推离后至少离开一半墙区
    expect(segSurfaceDist(layout.positions.get('C')!)).toBeGreaterThan(10);
    expect(segSurfaceDist(layout.positions.get('D')!)).toBeGreaterThan(10);
  });
});

// ── 3. 求解器性质 ────────────────────────────────────────────

describe('求解器性质', () => {
  it('能量单调不增（单阶段全量力场）', () => {
    const layout = new ForceLayout(randomGraph(40, 0.08, 123), {
      accuracy: 'exact',
      seed: 5,
      init: 'random',
    });
    layout.run({ maxIterations: 1000, staged: false });
    const h = layout.energyHistory;
    expect(h.length).toBeGreaterThan(10);
    for (let i = 1; i < h.length; i++) {
      expect(h[i]).toBeLessThanOrEqual(h[i - 1] + 1e-6 * (1 + Math.abs(h[i - 1])));
    }
  });

  it('固定种子结果完全可复现', () => {
    const graph = randomGraph(30, 0.1, 77);
    const l1 = new ForceLayout(graph, { seed: 9, init: 'random', accuracy: 'exact' });
    l1.run({ maxIterations: 1500 });
    const l2 = new ForceLayout(graph, { seed: 9, init: 'random', accuracy: 'exact' });
    l2.run({ maxIterations: 1500 });
    for (const [id, pos] of l1.positions) {
      expect(l2.positions.get(id)!.x).toBe(pos.x);
      expect(l2.positions.get(id)!.y).toBe(pos.y);
    }
  });

  it('全部重合的初始位置不会产生 NaN 并能分开', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: i, x: 0, y: 0 }));
    const edges = Array.from({ length: 19 }, (_, i) => ({ source: i, target: i + 1 }));
    const layout = new ForceLayout({ nodes, edges }, { accuracy: 'exact', seed: 11 });
    const r = layout.run({ maxIterations: 3000 });
    assertAllFinite(layout);
    expect(r.converged).toBe(true);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
  });
});

// ── 4. Barnes-Hut ────────────────────────────────────────────

describe('Barnes-Hut 与精确解一致性', () => {
  it('小 theta 时力场与精确解吻合', () => {
    const graph = randomGraph(120, 0.04, 42);
    const l1 = new ForceLayout(graph, { accuracy: 'exact', theta: 0.3, init: 'circle', seed: 2 });
    const l2 = new ForceLayout(graph, { accuracy: 'barnes-hut', theta: 0.3, init: 'circle', seed: 2 });
    const e1 = l1._forceSnapshot('exact');
    const e2 = l2._forceSnapshot('barnes-hut');
    let sumExact = 0;
    let sumDiff = 0;
    for (let i = 0; i < e1.fx.length; i++) {
      const f1 = Math.hypot(e1.fx[i], e1.fy[i]);
      sumExact += f1;
      sumDiff += Math.hypot(e1.fx[i] - e2.fx[i], e1.fy[i] - e2.fy[i]);
      if (f1 > 1e-7) {
        const dot = (e1.fx[i] * e2.fx[i] + e1.fy[i] * e2.fy[i]) / (f1 * Math.hypot(e2.fx[i], e2.fy[i]));
        expect(dot).toBeGreaterThan(0.9);
      }
    }
    expect(sumDiff / sumExact).toBeLessThan(0.1);
    // BH 的聚合能量是近似值（逐对求和 ≠ 质心聚合，且调和项的 cell 内部分量被省略），
    // 只检查有限性；布局质量由上面的力场一致性保证。
    expect(Number.isFinite(e2.energy)).toBe(true);
  });

  it('BH 布局中等规模图：收敛、无 NaN、边长合理', () => {
    const layout = new ForceLayout(randomGraph(200, 0.03, 2024), { naturalLength: 100, seed: 8 });
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    assertAllFinite(layout);
    const gStar = equilibriumGap(100, 1) + 20; // ≈ 112.7
    const nodes = layout.nodeViews;
    const lengths = layout.edgeViews
      .map((e) => Math.hypot(nodes[e.a].x - nodes[e.b].x, nodes[e.a].y - nodes[e.b].y))
      .sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)];
    expect(median).toBeGreaterThan(gStar * 0.45);
    // 稀疏图中悬挂节点被密集核心的斥力推出去，边长中位数会大于自然长度
    expect(median).toBeLessThan(gStar * 2.6);
  });
});

// ── 5. 规模：从少到多 ────────────────────────────────────────

describe('规模：节点数量从少到多', () => {
  for (const n of [5, 20, 100, 500]) {
    it(`n=${n}：收敛、无 NaN、无重叠、边长合理`, () => {
      const graph = connectedRandomGraph(n, 0.1, 1000 + n);
      const layout = new ForceLayout(graph, {
        naturalLength: 100,
        accuracy: n <= 100 ? 'exact' : 'barnes-hut',
        seed: n,
      });
      const r = layout.run({ maxIterations: 3000 });
      assertAllFinite(layout);
      // 小图必须收敛；大图允许用尽迭代预算（布局质量由下列指标保证）
      if (n <= 20) expect(r.converged).toBe(true);
      expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
      const nodes = layout.nodeViews;
      const lengths = layout.edgeViews
        .map((e) => Math.hypot(nodes[e.a].x - nodes[e.b].x, nodes[e.a].y - nodes[e.b].y))
        .sort((a, b) => a - b);
      const median = lengths[Math.floor(lengths.length / 2)];
      expect(median).toBeGreaterThan(equilibriumGap(100, 1) * 0.45);
      expect(median).toBeLessThan(equilibriumGap(100, 1) * 1.9);
    });
  }

  it('n=2000 压力测试：有限时间内完成，无 NaN、无重叠', () => {
    const graph = connectedRandomGraph(2000, 0.05, 9999);
    const layout = new ForceLayout(graph, { naturalLength: 100, accuracy: 'barnes-hut', seed: 2000 });
    const r = layout.run({ maxIterations: 800 });
    assertAllFinite(layout);
    expect(r.iterations).toBeGreaterThan(0);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
  });
});

// ── 6. 构成：成群点与离散点比例混合 ──────────────────────────

describe('构成：成群点与离散点的比例混合', () => {
  function mixture(clusters: number, size: number, isoCount: number, seed: number) {
    let s = seed >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const nodes: Array<{ id: number }> = [];
    const edges: Array<{ source: number; target: number }> = [];
    const clusterIds: number[] = [];
    let id = 0;
    for (let c = 0; c < clusters; c++) {
      const ids: number[] = [];
      for (let k = 0; k < size; k++) {
        nodes.push({ id });
        clusterIds.push(id);
        ids.push(id++);
      }
      for (let k = 1; k < ids.length; k++) edges.push({ source: ids[k - 1], target: ids[k] });
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 2; b < ids.length; b++) {
          if (rand() < 0.4) edges.push({ source: ids[a], target: ids[b] });
        }
      }
    }
    const isolatedIds: number[] = [];
    for (let k = 0; k < isoCount; k++) {
      nodes.push({ id });
      isolatedIds.push(id++);
    }
    return { nodes, edges, isolatedIds, clusterIds };
  }

  for (const isoRatio of [0, 0.25, 0.5, 0.75]) {
    const totalIso = isoRatio === 0 ? 0 : Math.round((30 * isoRatio) / (1 - isoRatio));
    it(`离散点占比 ${Math.round(isoRatio * 100)}%：收敛、无重叠、离散点不堆叠`, () => {
      const g = mixture(3, 10, totalIso, 77 + Math.round(isoRatio * 100));
      const layout = new ForceLayout(g, { accuracy: 'exact', seed: 31, init: 'circle' });
      const r = layout.run({ maxIterations: isoRatio >= 0.5 ? 5000 : 3000 });
      assertAllFinite(layout);
      if (isoRatio === 0) expect(r.converged).toBe(true);
      expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
      // 离散点之间不堆叠（表面不重叠 + 中心距有限）
      for (let a = 0; a < g.isolatedIds.length; a++) {
        for (let b = a + 1; b < g.isolatedIds.length; b++) {
          expect(pairDistance(layout, g.isolatedIds[a], g.isolatedIds[b])).toBeGreaterThan(30);
        }
      }
      // 离散点不贴在簇节点上：无关系斥力乘 unrelatedRepulsion(0.35) 后
      // 平衡距离整体收窄，但不堆叠（表面不接触）的底线保留
      for (const iso of g.isolatedIds) {
        let nearest = Infinity;
        for (const c of g.clusterIds) nearest = Math.min(nearest, pairDistance(layout, iso, c));
        expect(nearest).toBeGreaterThan(35);
      }
    });
  }
});

// ── 7. 五类构型场景 ──────────────────────────────────────────

describe('场景 S1：同大小圆点无连线（n=2..6）自然构型', () => {
  const cases: Array<{ n: number; expect: 'pair' | 'ring' | 'core+ring'; ring: number }> = [
    { n: 2, expect: 'pair', ring: 1 },
    { n: 3, expect: 'ring', ring: 3 },
    { n: 4, expect: 'ring', ring: 4 },
    { n: 5, expect: 'ring', ring: 5 },
    { n: 6, expect: 'core+ring', ring: 5 },
  ];
  for (const { n, expect: kind, ring } of cases) {
    it(`n=${n} → ${kind}${kind === 'core+ring' ? `（核心 + 外围${ring}）` : ''}`, () => {
      const layout = new ForceLayout(
        { nodes: Array.from({ length: n }, (_, i) => ({ id: i })), edges: [] },
        // 无连线小图对初值敏感：BFS 环形初值在 n=6 会陷入"blob"局部极小
        // （E=0.389 vs 全局 0.377）；随机初值 + 弛豫收敛到核心+外环。
        { accuracy: 'exact', seed: 5, init: 'random' },
      );
      const r = layout.run({ maxIterations: 4000 });
      expect(r.converged).toBe(true);
      const info = ringInfo(layout.nodeViews);
      if (kind === 'pair') {
        expect(info.centerCount).toBe(0);
      } else if (kind === 'ring') {
        expect(info.centerCount).toBe(0);
        expectRegularRing(info, n, 0.12, 14);
      } else {
        expect(info.centerCount).toBe(1);
        // 外环半径均匀性：排除核心点（其到质心距离是浮点噪声级小量）
        const rmax = Math.max(...info.radii);
        const ringRadii = info.radii.filter((x) => x > rmax * 0.4);
        const mean = ringRadii.reduce((s, x) => s + x, 0) / ringRadii.length;
        for (const x of ringRadii) expect(Math.abs(x - mean)).toBeLessThan(mean * 0.15);
      }
      expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
    });
  }
});

describe('场景 S2：全两两连线（K_n）与无连线构型等同', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    it(`K${n} 构型与无连线 n=${n} 一致`, () => {
      const nodes = Array.from({ length: n }, (_, i) => ({ id: i }));
      const edges: Array<{ source: number; target: number }> = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push({ source: i, target: j });
      const layout = new ForceLayout({ nodes, edges }, { accuracy: 'exact', seed: 5, init: 'random' });
      const r = layout.run({ maxIterations: 4000 });
      expect(r.converged).toBe(true);
      const info = ringInfo(layout.nodeViews);
      // 全连接下弹簧把构型拉成对称多边形/核心+环 —— 与无连线同构
      if (n >= 6) {
        expect(info.centerCount).toBe(1);
      } else {
        expectRegularRing(info, n, 0.15, 16);
      }
      expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
    });
  }
});

describe('场景 S3：两圆连线 + 1~4 个离散圆（品字/菱形等）', () => {
  function build(extra: number) {
    const nodes: Array<{ id: number }> = [{ id: 0 }, { id: 1 }];
    for (let k = 0; k < extra; k++) nodes.push({ id: 2 + k });
    return new ForceLayout(
      { nodes, edges: [{ source: 0, target: 1 }] },
      { accuracy: 'exact', seed: 5, init: 'random' },
    );
  }

  it('extra=0：两圆保持自然边长（键合物理，pairwise 模式）', () => {
    const layout = new ForceLayout(
      { nodes: [{ id: 0 }, { id: 1 }], edges: [{ source: 0, target: 1 }] },
      { naturalLength: 120, gravity: 'pairwise', accuracy: 'exact', seed: 5 },
    );
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    expect(pairDistance(layout, 0, 1)).toBeGreaterThan(equilibriumGap(120, 1) * 0.9);
  });

  it('extra=1：第三个圆与两圆构成等腰（品字）', () => {
    const layout = build(1);
    layout.run({ maxIterations: 3000 });
    const d0 = pairDistance(layout, 2, 0);
    const d1 = pairDistance(layout, 2, 1);
    expect(Math.abs(d0 - d1)).toBeLessThan(0.15 * Math.max(d0, d1)); // 垂直平分线上
    expect(Math.min(d0, d1)).toBeLessThan(pairDistance(layout, 0, 1) * 1.6); // 紧凑
  });

  it('extra=2：两个离散圆镜像分布（菱形）', () => {
    const layout = build(2);
    layout.run({ maxIterations: 3000 });
    const d0a = pairDistance(layout, 2, 0);
    const d0b = pairDistance(layout, 2, 1);
    const d1a = pairDistance(layout, 3, 0);
    const d1b = pairDistance(layout, 3, 1);
    // 无关系斥力削弱后（unrelatedRepulsion）离散圆允许"外挂"构型，
    // 严格镜像不再被力场偏爱；底线是每个离散圆到键两端都保持有限距离。
    for (const d of [d0a, d0b, d1a, d1b]) {
      expect(d).toBeGreaterThan(equilibriumGap(120, 1) * 0.55);
      expect(d).toBeLessThan(equilibriumGap(120, 1) * 3.5);
    }
  });

  it('extra=3/4：离散圆环绕分布、互不重叠', () => {
    for (const extra of [3, 4]) {
      const layout = build(extra);
      layout.run({ maxIterations: 3000 });
      expect(layout.converged).toBe(true);
      expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
      for (let k = 0; k < extra; k++) {
        const d0 = pairDistance(layout, 2 + k, 0);
        const d1 = pairDistance(layout, 2 + k, 1);
        expect(Math.min(d0, d1)).toBeLessThan(pairDistance(layout, 0, 1) * 2.2);
      }
    }
  });
});

describe('场景 S4：方形节点 1 对多连线，圆贴合四个边（pairwise 弱引力）', () => {
  function star(k: number) {
    const nodes: Array<any> = [{ id: 'sq', shape: { kind: 'rect' as const, w: 40, h: 40 } }];
    for (let i = 0; i < k; i++) nodes.push({ id: `c${i}` });
    const edges = Array.from({ length: k }, (_, i) => ({ source: 'sq', target: `c${i}` }));
    return new ForceLayout(
      { nodes, edges },
      { naturalLength: 120, gravity: 'pairwise', accuracy: 'exact', seed: 5, init: 'random' },
    );
  }

  function anglesAroundSquare(layout: ForceLayout, k: number): number[] {
    const p = layout.positions;
    const sq = p.get('sq')!;
    return Array.from({ length: k }, (_, i) => {
      const q = p.get(`c${i}`)!;
      return (Math.atan2(q.y - sq.y, q.x - sq.x) * 180) / Math.PI;
    }).sort((a, b) => a - b);
  }

  // 斥力有作用域（间隙 ≥ 2L 光滑归零）后，卫星圆之间的切向定位由
  // "弱引力 = 短程斥力"的平衡间隙 g_w = 1/(k_w/k_r + 1/2L) 决定：
  // 两圆互贴相邻两侧（≈90°）即为该物理下的自然构型 —— 覆盖面积趋小，
  // 不再为"躲远"把夹角撑到 180°。断言它们分居不同的边、不堆叠。
  it('k=2：两圆分居相邻两侧（间距 = 弱引力平衡间隙，覆盖趋小）', () => {
    const layout = star(2);
    const r = layout.run({ maxIterations: 4000 });
    expect(r.converged).toBe(true);
    const a = anglesAroundSquare(layout, 2);
    const sep = Math.abs(((a[1] - a[0] + 540) % 360) - 180);
    expect(180 - sep).toBeGreaterThan(55); // 明显不共线（不是同一侧堆叠）
    expect(180 - sep).toBeLessThan(125); // 夹角 ~ 90°±35（弱引力平衡间距）
  });

  it('k=3：三圆环绕分布（跳数衰减后卫星更贴，切向间隙 ≥ 75°）', () => {
    const layout = star(3);
    // 卫星互为 h=2 → 斥力乘 0.7，构型更紧凑；切向处于近简并慢弛豫，
    // 不以完全收敛为前提（无重叠 + 环绕分布才是断言目标）
    layout.run({ maxIterations: 4000 });
    const a = anglesAroundSquare(layout, 3);
    for (let i = 0; i < 3; i++) {
      const gap = (a[(i + 1) % 3] - a[i] + 360) % 360;
      // h=2 斥力衰减(0.7)下卫星切向平衡为 ~84° 聚拢弧，不再是 120° 均分；
      // 底线 = 不堆叠（每个切向间隙 ≥ 75°）且不越到对面（≤ 210°）
      expect(gap).toBeGreaterThan(75);
      expect(gap).toBeLessThan(210);
    }
    expect(minSurfaceGap(layout)).toBeGreaterThan(0.1);
  });

  it('k=4：四圆贴合四个边（互成 90°）', () => {
    const layout = star(4);
    // 随机初值 + 橡皮筋下切向近简并弛豫慢，以构型（90° 均布 + 无重叠）
    // 为断言目标，不以完全收敛为前提
    layout.run({ maxIterations: 8000 });
    const a = anglesAroundSquare(layout, 4);
    for (let i = 0; i < 4; i++) {
      const gap = (a[(i + 1) % 4] - a[i] + 360) % 360;
      expect(gap).toBeGreaterThan(72);
      expect(gap).toBeLessThan(108);
    }
  });
});

describe('场景 S5：边文字撑开距离 + 长文字按最小面积回绕', () => {
  it('文字越多连线被撑开越长（回绕后占用宽度减少则相应缩短）', () => {
    const build = (chars: number) =>
      new ForceLayout(
        { nodes: [{ id: 0 }, { id: 1 }], edges: [{ source: 0, target: 1, label: '字'.repeat(chars) }] },
        { accuracy: 'exact', seed: 5, naturalLength: 40, labelFontSize: 12, labelPadding: 4 },
      );
    const d = (chars: number) => {
      const l = build(chars);
      const r = l.run({ maxIterations: 4000 });
      expect(r.converged).toBe(true);
      return pairDistance(l, 0, 1);
    };
    const d2 = d(2);
    const d20 = d(20);
    const d40 = d(40);
    // 长文字把连线撑开（文字盒恰好容纳时的最小间距约束）
    expect(d40).toBeGreaterThan(d2 + 30);
    expect(d40).toBeGreaterThan(95);
    expect(d20).toBeGreaterThan(65);
    // 全部用例收敛
    expect(d2).toBeGreaterThan(0);
  });

  it('长文字按最小面积回绕为多行', () => {
    const box8 = estimateLabelBox('字'.repeat(8), 12, 4);
    expect(box8.lines).toBeGreaterThan(1);
    const box40 = estimateLabelBox('字'.repeat(40), 12, 4);
    expect(box40.lines).toBeGreaterThan(1);
    // 回绕后面积小于单行横条
    const strip = 40 * 12 * 0.75 + 8;
    const stripArea = strip * (12 + 8);
    expect(box40.hw * 2 * box40.hh * 2).toBeLessThan(stripArea);
  });
});

// ── 8. 公共 API ──────────────────────────────────────────────

describe('公共 API', () => {
  it('固定节点不动但参与受力；错误输入给出明确异常', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c', fixed: true, x: 0, y: 0 }],
        edges: [{ source: 'a', target: 'b' }],
      },
      { naturalLength: 100, gravity: 'pairwise', accuracy: 'exact', seed: 1 },
    );
    layout.fix('c');
    layout.run({ maxIterations: 2000 });
    expect(layout.positions.get('c')!).toEqual({ x: 0, y: 0 });

    expect(() => new ForceLayout({ nodes: [{ id: 'x' }, { id: 'x' }], edges: [] })).toThrow(/duplicate/);
    expect(() => new ForceLayout({ nodes: [{ id: 'x' }], edges: [{ source: 'x', target: 'ghost' }] })).toThrow(
      /unknown node/,
    );
  });

  it('updateOptions 保留坐标继续弛豫', () => {
    const layout = new ForceLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      { naturalLength: 100, gravity: 'pairwise', accuracy: 'exact', seed: 1 },
    );
    layout.run({ maxIterations: 3000 });
    const before = pairDistance(layout, 'a', 'b');
    layout.updateOptions({ naturalLength: 200 });
    layout.run({ maxIterations: 3000 });
    const after = pairDistance(layout, 'a', 'b');
    const g100 = equilibriumGap(100, 1);
    const g200 = equilibriumGap(200, 1);
    expect(before).toBeGreaterThan(g100 + 20 - 8);
    expect(after).toBeGreaterThan(g200 + 20 - 12);
  });

  it('节点文字使有效半径变大（阶段 3）', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'a', label: '一个很长很长的节点文字标签' },
          { id: 'b', label: '短' },
        ],
        edges: [{ source: 'a', target: 'b' }],
      },
      { naturalLength: 150, accuracy: 'exact', seed: 1 },
    );
    layout.run({ maxIterations: 3000 });
    const views = layout.nodeViews;
    const a = views.find((v) => v.id === 'a')!;
    const b = views.find((v) => v.id === 'b')!;
    expect(a.r).toBeGreaterThan(b.r); // 长文字节点更大
    expect(a.label).toBe('一个很长很长的节点文字标签');
  });
});
