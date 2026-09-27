/**
 * 折叠布局测试：长蛇阵 / subgraph 收成质点 → 质点布局 → 递归评估展开。
 *
 * 覆盖角度：
 *  1. 链识别与还原：链折叠后成员排成一线（链序保持）、非链节点不受影响
 *  2. 折叠开关等价性：folding 关闭走原流水线；开启后布局不变量仍成立
 *  3. 递归评估：subgraph 收成点后尺寸由成员子布局决定（包裹 + padding）
 *  4. 无重叠与确定性：折叠模式下相邻元素 AABB 不重叠、同输入逐位重放
 *  5. 链阈值：低于 foldChainMin 的短链不折叠
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout, GraphStore } from '../src/index.js';
import { buildFoldPlan, chainGridLayout } from '../src/layout/grid-undirected/fold.js';
import { coarseGridPlacement, undirectedHeuristics } from '../src/layout/grid-undirected/coarse.js';
import type { GraphSpec } from '../src/index.js';
import type { LayoutElement } from '../src/graph/store.js';

/** 相邻元素 AABB 是否重叠（半开区间：相切不算）。 */
function overlapping(a: { x: number; y: number; w?: number; h?: number }, b: { x: number; y: number; w?: number; h?: number }): boolean {
  const aw = (a.w ?? 0) / 2;
  const ah = (a.h ?? 0) / 2;
  const bw = (b.w ?? 0) / 2;
  const bh = (b.h ?? 0) / 2;
  return (
    Math.abs(a.x - b.x) < aw + bw - 1e-9 && Math.abs(a.y - b.y) < ah + bh - 1e-9
  );
}

/** 链图：n 节点直线连接（id 0..n-1）。 */
function chainGraph(n: number): GraphSpec {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: i, label: `n${i}` })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ source: i, target: i + 1 })),
  };
}

describe('折叠布局', () => {
  it('链折叠：长蛇收成点布局后还原为紧凑网格，链序蛇形相邻', () => {
    const layout = new ForceLayout(chainGraph(6), { folding: true, foldChainMin: 3, naturalLength: 6, seed: 1 });
    layout.run();
    const views = layout.nodeViews;
    expect(views).toHaveLength(6);
    const byId = new Map(views.map((v) => [Number(v.id), v]));
    // 链序蛇形相邻：相邻中心距 = 成员格 + 通道格 = 2 格（矩形格：同行
    // 对 2×cellW、换行对 2×cellH）。3×2 行优先蛇形的换行对 = (2,3)。
    const distX = 2 * layout.cellW;
    const distY = 2 * layout.cellH;
    const expected = [distX, distX, distY, distX, distX];
    for (let i = 0; i < 5; i++) {
      const a = byId.get(i)!;
      const b = byId.get(i + 1)!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(expected[i]!, 6);
    }
    // 包裹 = 3×2 格（面积/周长最优），行内成员共行
    expect(Math.abs(byId.get(0)!.y - byId.get(1)!.y)).toBeLessThan(1e-6);
    expect(Math.abs(byId.get(3)!.y - byId.get(4)!.y)).toBeLessThan(1e-6);
    expect(byId.get(0)!.y).toBeLessThan(byId.get(3)!.y);
  });

  it('链阈值：foldChainMin 高于链长时不折叠（行为与关闭一致）', () => {
    const spec = chainGraph(4);
    const off = new ForceLayout(spec, { folding: false, naturalLength: 6, seed: 1 });
    off.run();
    const on = new ForceLayout(spec, { folding: true, foldChainMin: 5, naturalLength: 6, seed: 1 });
    on.run();
    // 4 节点链 < 阈值 5：不折叠，两种模式的质点布局同为非折叠路径
    const coords = (l: ForceLayout) => l.nodeViews.map((v) => [Math.round(v.x), Math.round(v.y)].join(',')).join(';');
    expect(coords(on)).toBe(coords(off));
  });

  it('折叠模式布局不变量：无 AABB 重叠、确定性重放', () => {
    // 链 + 环 + 分叉的混合图
    const spec: GraphSpec = {
      nodes: Array.from({ length: 12 }, (_, i) => ({ id: i, label: `n${i}` })),
      edges: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
        { source: 2, target: 3 },
        { source: 3, target: 4 },
        { source: 4, target: 5 },
        { source: 2, target: 6 },
        { source: 6, target: 7 },
        { source: 6, target: 8 },
        { source: 8, target: 9 },
        { source: 9, target: 10 },
        { source: 10, target: 11 },
        { source: 11, target: 8 }, // 环 8-9-10-11：不折叠
      ],
    };
    const layout = new ForceLayout(spec, { folding: true, foldChainMin: 3, naturalLength: 6, seed: 7 });
    layout.run();
    const els = layout.nodeViews;
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        expect(overlapping(els[i]!, els[j]!)).toBe(false);
      }
    }
    // 确定性：重建后逐位一致
    const again = new ForceLayout(spec, { folding: true, foldChainMin: 3, naturalLength: 6, seed: 7 });
    again.run();
    const key = (l: ForceLayout) => l.nodeViews.map((v) => `${v.id}:${v.x.toFixed(6)},${v.y.toFixed(6)}`).join('|');
    expect(key(again)).toBe(key(layout));
  });

  it('subgraph 折叠：容器尺寸由成员子布局评估（包裹 + padding）', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
        { id: 'c', label: 'c' },
        { id: 'out', label: 'out' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'out' },
      ],
      subgraphs: [{ id: 'sub', shape: { kind: 'rect', w: 100, h: 100 }, label: 'sub', members: ['a', 'b', 'c'], padding: 2 }],
    };
    const layout = new ForceLayout(spec, { folding: true, foldChainMin: 3, naturalLength: 6, seed: 3 });
    layout.run();
    const sub = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const members = ['a', 'b', 'c'].map((id) => layout.nodeViews.find((v) => v.id === id)!);
    // 容器物化尺寸（成员子布局包裹 + padding）
    const box = sub as unknown as { w?: number; h?: number };
    expect((box.w ?? 0)).toBeGreaterThan(0);
    expect((box.h ?? 0)).toBeGreaterThan(0);
    // 成员收进容器：三成员的并集范围 ≤ 容器 AABB（物化 w/h）
    for (const m of members) {
      expect(Math.abs(m.x - sub.x)).toBeLessThanOrEqual((box.w ?? 0) / 2);
      expect(Math.abs(m.y - sub.y)).toBeLessThanOrEqual((box.h ?? 0) / 2);
    }
  });

  it('容器大小在布线前按调整布局确定，布线插空行列后仍包含全部成员', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'in-a', label: 'in-a' },
        { id: 'in-b', label: 'in-b' },
        { id: 'in-c', label: 'in-c' },
        { id: 'ext-1', label: '外部1' },
        { id: 'ext-2', label: '外部2' },
      ],
      edges: [
        { source: 'in-a', target: 'in-b' },
        { source: 'in-b', target: 'in-c' },
        { source: 'sub', target: 'ext-1' },
        { source: 'ext-2', target: 'sub' },
        { source: 'ext-1', target: 'in-b' },
      ],
      subgraphs: [{ id: 'sub', shape: { kind: 'rect', w: 380, h: 280 }, label: '子图', members: ['in-a', 'in-b', 'in-c'] }],
    };
    const layout = new ForceLayout(spec, { folding: true, foldChainMin: 3, naturalLength: 6, seed: 42 });
    layout.run();
    const sub = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const members = ['in-a', 'in-b', 'in-c'].map((id) => layout.nodeViews.find((v) => v.id === id)!);
    // 实占 shape（成员包裹 + padding）不小于成员实占包裹
    const halfW = sub.shape.kind === 'rect' ? sub.shape.w / 2 : 0;
    // 容器物化尺寸（实占包裹）同样覆盖成员
    const box = sub as unknown as { w?: number; h?: number };
    expect((box.w ?? 0)).toBeGreaterThanOrEqual(halfW * 2 - 4.01); // shape = 包裹 + 2×padding
    for (const m of members) {
      expect(Math.abs(m.x - sub.x)).toBeLessThanOrEqual((box.w ?? 0) / 2);
      expect(Math.abs(m.y - sub.y)).toBeLessThanOrEqual((box.h ?? 0) / 2);
    }
  });

  it('子图坐标系隔离：外部增删节点改变插行插列，成员相对坐标不变', () => {
    const subNodes = [
      { id: 'in-a', label: 'in-a' },
      { id: 'in-b', label: 'in-b' },
      { id: 'in-c', label: 'in-c' },
      { id: 'in-d', label: 'in-d' },
    ];
    const subEdges = [
      { source: 'in-a', target: 'in-b' },
      { source: 'in-b', target: 'in-c' },
      { source: 'in-c', target: 'in-d' },
      { source: 'in-d', target: 'in-a' },
    ];
    const subgraph = {
      id: 'sub',
      shape: { kind: 'rect' as const, w: 380, h: 280 },
      label: '子图',
      members: ['in-a', 'in-b', 'in-c', 'in-d'],
    };
    // 少外部节点 vs 拥堵外部（多条外部边迫使父作用域让位/插空行列）
    const sparse: GraphSpec = {
      nodes: [...subNodes, { id: 'ext-1', label: '外部1' }],
      edges: [...subEdges, { source: 'sub', target: 'ext-1' }],
      subgraphs: [subgraph],
    };
    const crowd: GraphSpec = {
      nodes: [
        ...subNodes,
        { id: 'ext-1', label: '外部1' },
        { id: 'ext-2', label: '外部2' },
        { id: 'ext-3', label: '外部3' },
        { id: 'ext-4', label: '外部4' },
        { id: 'ext-5', label: '外部5' },
      ],
      edges: [
        ...subEdges,
        { source: 'sub', target: 'ext-1' },
        { source: 'ext-2', target: 'ext-3' },
        { source: 'ext-3', target: 'ext-4' },
        { source: 'ext-4', target: 'ext-5' },
        { source: 'ext-5', target: 'ext-2' },
        { source: 'ext-1', target: 'ext-3' },
      ],
      subgraphs: [subgraph],
    };
    const opts = { folding: true, foldChainMin: 3, naturalLength: 6, seed: 42 };
    const a = new ForceLayout(sparse, opts);
    a.run();
    const b = new ForceLayout(crowd, opts);
    b.run();
    const rel = (l: ForceLayout) => {
      const ms = ['in-a', 'in-b', 'in-c', 'in-d'].map(
        (id) => l.nodeViews.find((v) => v.id === id)!,
      );
      return ms.map((m) => `${(m.x - ms[0]!.x).toFixed(6)},${(m.y - ms[0]!.y).toFixed(6)}`).join('|');
    };
    // 成员相对坐标只由子作用域布局决定：外部拓扑变化不改写
    expect(rel(b)).toBe(rel(a));
    // 空转防护：外部布局确实不同 —— 容器绝对位置随外部布局改变
    const subA = a.subgraphViews.find((v) => v.id === 'sub')!;
    const subB = b.subgraphViews.find((v) => v.id === 'sub')!;
    expect(subA.x === subB.x && subA.y === subB.y).toBe(false);
  });

  it('端到端：groups 图折叠后成员不与容器外元素重叠', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'in-a', label: 'in-a' },
        { id: 'in-b', label: 'in-b' },
        { id: 'in-c', label: 'in-c' },
        { id: 'chain-1', label: '链1' },
        { id: 'chain-2', label: '链2' },
        { id: 'chain-3', label: '链3' },
        { id: 'ext-1', label: '外部1' },
        { id: 'ext-2', label: '外部2' },
      ],
      edges: [
        { source: 'in-a', target: 'in-b' },
        { source: 'in-b', target: 'in-c' },
        { source: 'chain-1', target: 'chain-2' },
        { source: 'chain-2', target: 'chain-3' },
        { source: 'sub', target: 'ext-1' },
        { source: 'ext-2', target: 'sub' },
        { source: 'ext-1', target: 'in-b' },
      ],
      subgraphs: [{ id: 'sub', shape: { kind: 'rect', w: 380, h: 280 }, label: '子图', members: ['in-a', 'in-b', 'in-c'] }],
    };
    const layout = new ForceLayout(spec, { folding: true, foldChainMin: 3, naturalLength: 6, seed: 42 });
    layout.run();
    const nodes = layout.nodeViews;
    const sub = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const els = [...nodes, sub];
    expect(els).toHaveLength(9); // 8 节点 + 1 容器
    // 无重叠：容器与其成员是包含关系（折叠语义使然），跳过该类对
    const memberIds = new Set(sub.children);
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i]!;
        const b = els[j]!;
        const contained = (outer: typeof a, inner: typeof a) =>
          outer.id === sub.id && memberIds.has(inner.id);
        if (contained(a, b) || contained(b, a)) continue;
        expect(overlapping(a, b)).toBe(false);
      }
    }
    // 链还原：链1→链2→链3 相邻（中心距 ~ 2 格内物化尺寸之和）
    const c1 = els.find((v) => v.id === 'chain-1')!;
    const c2 = els.find((v) => v.id === 'chain-2')!;
    const c3 = els.find((v) => v.id === 'chain-3')!;
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(c1, c2)).toBeLessThan(dist(c1, c3)); // 链序相邻性
    expect(dist(c2, c3)).toBeLessThan(dist(c1, c3));
  });
});

describe('链展开的蛇形网格（面积最小 → 周长最小）', () => {
  it('等尺寸成员：面积平局取横向，展开为一条水平线', () => {
    const grid = chainGridLayout(Array.from({ length: 6 }, () => ({ w: 1, h: 1 })));
    // gap=0 时面积 = 成员格数恒定：周长最小 → 3×2 方阵（perim 10 < 7）
    expect(grid.width).toBe(3);
    expect(grid.height).toBe(2);
    expect(grid.positions[0]).toEqual({ x: 0, y: 0 });
    // 蛇形：行1 反序放置 [m5, m4, m3] —— m5 在行首、m3 在行末与 m2 上下相邻
    expect(grid.positions[3]).toEqual({ x: 2, y: 1 });
    expect(grid.positions[5]).toEqual({ x: 0, y: 1 });
  });

  it('宽扁成员：单列堆叠的周长小于并排', () => {
    // [10×1 ×4]：并排面积同为 40，单列 perim 14 < 并排 22 → 单列
    const sizes = Array.from({ length: 4 }, () => ({ w: 10, h: 1 }));
    const grid = chainGridLayout(sizes);
    expect(grid.width).toBe(10);
    expect(grid.height).toBe(4);
    expect(grid.positions[1]).toEqual({ x: 0, y: 1 });
    expect(grid.positions[2]).toEqual({ x: 0, y: 2 });
  });
});

describe('投影锚点（外部质点在子作用域内的固定映射）', () => {
  const mkElements = (n: number): LayoutElement[] =>
    Array.from({ length: n }, (_, i) => ({ id: i })) as unknown as LayoutElement[];

  it('质点放置：锚点只牵引所连项，自身不入占用表、坐标不变', () => {
    // 路径 1—0—2，种子 0 在原点。无锚点时扫描序把 1 放在上方 (0,−1)；
    // 给 1 一个下方锚点 (0,5)：牵引把 1 拉到种子下方 —— 方位偏置生效。
    const adjacency = [new Set([1, 2]), new Set([0]), new Set([0])];
    const heuristics = undirectedHeuristics(adjacency, { directionClass: true });
    const free = coarseGridPlacement(mkElements(3), adjacency, 6, heuristics, { ignorePlaced: true });
    expect(free.posOf[1]!.gy).toBeLessThan(0); // 扫描序基线：上方

    const pulled = coarseGridPlacement(mkElements(3), adjacency, 6, heuristics, {
      ignorePlaced: true,
      anchors: [{ item: 1, at: { gx: 0, gy: 5 } }],
    });
    expect(pulled.posOf[1]!.gy).toBeGreaterThan(0); // 被拉到种子下方
    // 锚点不占格：占用表只有 3 个成员，锚点格 (0,5) 上没有元素
    expect(pulled.grid.occ.size).toBe(3);
    expect(pulled.grid.has(0, 5)).toBe(false);
    // 1×1 质点口径：posOf 无锚点项
    expect(pulled.posOf).toHaveLength(3);
  });

  it('子图投影联动：牵引方向跟随外部质点的实际方位', () => {
    // 子图 = 路径 m1—m2—m3（foldChainMin 高，不折叠）；ext 接 m3。
    // 有 z1：根布局把 ext 顶到容器上方，投影向下 → m3 落到 m2 正下方；
    // 无 z1：ext 落在容器上方 → 投影向上，m3 保持扫描序的上/左方位。
    const mk = (withZ: boolean): GraphSpec => ({
      nodes: [
        { id: 'm1', label: 'm1' },
        { id: 'm2', label: 'm2' },
        { id: 'm3', label: 'm3' },
        { id: 'ext', label: 'ext' },
        ...(withZ ? [{ id: 'z1', label: 'z1' }] : []),
      ],
      edges: [
        { source: 'm1', target: 'm2' },
        { source: 'm2', target: 'm3' },
        { source: 'ext', target: 'm3' },
        ...(withZ ? [{ source: 'z1', target: 'ext' }] : []),
      ],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 100, h: 100 }, label: 'sub', members: ['m1', 'm2', 'm3'] },
      ],
    });
    const opts = { folding: true, foldChainMin: 5, naturalLength: 6, seed: 42 };
    const member = (l: ForceLayout, id: string) => l.nodeViews.find((v) => v.id === id)!;

    const withZ = new ForceLayout(mk(true), opts);
    withZ.run();
    const m3z = member(withZ, 'm3');
    const m2z = member(withZ, 'm2');
    // 投影在下方：m3 被拉到 m2 正下方（同列、严格在下）
    expect(m3z.y).toBeGreaterThan(m2z.y);
    expect(Math.abs(m3z.x - m2z.x)).toBeLessThan(1e-6);

    const alone = new ForceLayout(mk(false), opts);
    alone.run();
    const m3a = member(alone, 'm3');
    const m2a = member(alone, 'm2');
    // 对照：投影方向不同，m3 不在同列下方（扫描序方位）
    expect(m3a.x).not.toBeCloseTo(m2a.x, 6);
  });
});

describe('subgraph 质点化的虚拟连线（跨边界边提升）', () => {
  it('外部节点与内部成员的连线折叠为一条外部质点 ↔ 容器质点的虚拟连线（多连线去重）', () => {
    // ext1 连 m1、m3（两条边）、ext2 连 m2（一条边）：折叠后视图里
    // 只应出现 ext1—容器、ext2—容器 两条虚拟连线，成员端不再出现。
    const store = new GraphStore({
      nodes: [
        { id: 'ext1', label: 'ext1' },
        { id: 'ext2', label: 'ext2' },
        { id: 'm1', label: 'm1' },
        { id: 'm2', label: 'm2' },
        { id: 'm3', label: 'm3' },
      ],
      edges: [
        { source: 'ext1', target: 'm1' },
        { source: 'ext1', target: 'm3' },
        { source: 'ext2', target: 'm2' },
      ],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 100, h: 100 }, label: 'sub', members: ['m1', 'm2', 'm3'] },
      ],
    });
    const plan = buildFoldPlan(store, 3);
    const idx = (id: string) => store.elements.findIndex((e) => e.id === id);
    const ci = idx('sub');
    const root = plan.root;
    // 提升：全部跨边界边的成员端替换为容器元素 —— 视图边只剩 外部↔容器
    for (const [a, b] of root.elementEdges) {
      expect([a, b]).not.toContain(idx('m1'));
      expect([a, b]).not.toContain(idx('m2'));
      expect([a, b]).not.toContain(idx('m3'));
    }
    expect(root.elementEdges).toContainEqual([idx('ext1'), ci]);
    expect(root.elementEdges).toContainEqual([idx('ext2'), ci]);
    // 视图邻接（放置消费的虚拟连线）：容器项与两个外部质点相邻，
    // ext1 的两条连线去重为一条虚拟连线（邻居集只有容器项）
    const ciItem = root.itemOfElement.get(ci)!;
    const ext1Item = root.itemOfElement.get(idx('ext1'))!;
    const ext2Item = root.itemOfElement.get(idx('ext2'))!;
    expect(root.adjacency[ext1Item]!.has(ciItem)).toBe(true);
    expect(root.adjacency[ext1Item]!.size).toBe(1);
    expect(root.adjacency[ext2Item]!.has(ciItem)).toBe(true);
    expect(root.adjacency[ext2Item]!.size).toBe(1);
    expect(root.adjacency[ciItem]!.has(ext1Item)).toBe(true);
    expect(root.adjacency[ciItem]!.has(ext2Item)).toBe(true);
    // 成员归属最深（容器）作用域；容器项只存在于父（root）视图
    const subScope = plan.scopes.find((s) => s.containerIndex === ci);
    expect(plan.scopeOfElement.get(idx('m1'))).toBe(subScope);
    expect(root.itemOfElement.has(idx('m1'))).toBe(false);
    expect(root.itemOfElement.get(ci)).toBe(ciItem);
  });

  it('虚拟连线生效：外部质点与容器质点在放置中相互吸引（集成）', () => {
    // ext1 与容器内 m1、m3 连线：折叠放置后容器应贴邻 ext1 落位
    // （虚拟连线即邻接关系，参与张力/锚点评分），且布局无重叠。
    const spec: GraphSpec = {
      nodes: [
        { id: 'ext1', label: 'ext1' },
        { id: 'ext2', label: 'ext2' },
        { id: 'm1', label: 'm1' },
        { id: 'm2', label: 'm2' },
        { id: 'm3', label: 'm3' },
      ],
      edges: [
        { source: 'ext1', target: 'm1' },
        { source: 'ext1', target: 'm3' },
        { source: 'ext2', target: 'm2' },
      ],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 100, h: 100 }, label: 'sub', members: ['m1', 'm2', 'm3'] },
      ],
    };
    const layout = new ForceLayout(spec, { folding: true, foldChainMin: 99, naturalLength: 6, seed: 5 });
    layout.run();
    const boxes = layout.nodeViews.map((v) => ({
      x: v.x - v.w! / 2,
      y: v.y - v.h! / 2,
      width: v.w!,
      height: v.h!,
    }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlapping(layout.nodeViews[i]!, layout.nodeViews[j]!)).toBe(false);
      }
    }
    // 虚拟连线把容器质点与两个外部质点绑成邻位簇：多连线去重为一条后
    // 两侧引力对等，容器落在 ext1 与 ext2 之间。中心距 = 质点贴邻 1 格
    // + 容器包裹半宽 + 通道余量，上界 4.5 格距。
    const byId = new Map(layout.nodeViews.map((v) => [String(v.id), v]));
    const sub = layout.subgraphViews.find((v) => v.id === 'sub')!;
    const gridDist = 6 * layout.cellScale;
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(sub, byId.get('ext1')!)).toBeLessThanOrEqual(4.5 * gridDist + 1e-6);
    expect(d(sub, byId.get('ext2')!)).toBeLessThanOrEqual(4.5 * gridDist + 1e-6);
  });
});
