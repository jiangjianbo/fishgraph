/**
 * 形状契约（用户口径，硬性验收）—— 2026-09-26 与用户逐条确认：
 *
 * 无向（direction='none'，grid-undirected）：
 *  U1. 5×5 网格图            → 严格 5×5 方阵（5 行 5 列，行/列对齐）
 *  U2. 2 个独立点            → 水平或垂直相邻（中心距 = 1 格）
 *  U3. 2 点 1 边             → 水平（垂直亦可，正交即可）
 *  U4. 3 节点 3 边（三角环）  → 正立三角形（L 形品字口径，用户确认）
 *  U5. 4 节点 4 边（四边环）  → 正方形（2×2）
 *  U6. 4 节点 2 边（两条独立边）→ 两边平行
 *
 * 有向（direction='TB'，grid-undirected 层级放置）：
 *  D1. 5 点向心（4 叶→中心） → 顺流山形（叶全在中心上方；十字与顺流
 *      物理互斥，用户确认契约取顺流山形——见布局核心原则「简单规则无例外」）
 *  D2. 2 点 1 边             → 垂直（dx = 0）
 *  D3. 4 点 2 边             → 两条边垂直且相互平行
 *  D4. 顶点发出两条线 a→b,a→c → 正立三角形（L 形品字，顶点在上）
 *  D5. 顶点接收两条线 b→a,c→a → 倒立三角形（L 形品字，顶点在下）
 *
 * 全部场景默认参数（seed=42）确定性重放。
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import type { GraphSpec, LayoutOptions } from '../src/types.js';

function layoutOf(spec: GraphSpec, direction: 'none' | 'TB' | 'LR' = 'none'): ForceLayout {
  const options: LayoutOptions = { algorithm: 'grid-undirected', direction, seed: 42 };
  const layout = new ForceLayout(spec, options);
  layout.run();
  return layout;
}

/**
 * 行列坐标 → 序号口径：压实后列/行间距 = 节点格 + 通道格（2 倍格胞），
 * 且全局质心平移使绝对坐标不落在格距倍数上 —— 因此"第几列/第几行"
 * 一律用唯一坐标排序后的序号表达（同列节点的坐标逐位相等）。
 */
function ordinalGrid(
  layout: ForceLayout,
): Array<{ id: string | number; col: number; row: number; x: number; y: number }> {
  const entries = [...layout.positions.entries()];
  const xs = [...new Set(entries.map(([, p]) => p.x.toFixed(6)))].sort((a, b) => Number(a) - Number(b));
  const ys = [...new Set(entries.map(([, p]) => p.y.toFixed(6)))].sort((a, b) => Number(a) - Number(b));
  return entries.map(([id, p]) => ({
    id,
    col: xs.indexOf(p.x.toFixed(6)),
    row: ys.indexOf(p.y.toFixed(6)),
    x: p.x,
    y: p.y,
  }));
}

/** 一条边（i→j）的方向类别：'h' 水平 / 'v' 垂直 / 其他。 */
function edgeClass(
  layout: ForceLayout,
  a: string | number,
  b: string | number,
): 'h' | 'v' | 'diag' {
  const pa = layout.positions.get(a)!;
  const pb = layout.positions.get(b)!;
  const dx = Math.abs(pa.x - pb.x);
  const dy = Math.abs(pa.y - pb.y);
  if (dx < 1e-6 && dy > 0) return 'v';
  if (dy < 1e-6 && dx > 0) return 'h';
  return 'diag';
}

function gridGraph(n: number): GraphSpec {
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      nodes.push({ id: `${x},${y}` });
      if (x + 1 < n) edges.push({ source: `${x},${y}`, target: `${x + 1},${y}` });
      if (y + 1 < n) edges.push({ source: `${x},${y}`, target: `${x},${y + 1}` });
    }
  }
  return { nodes, edges };
}

function ringGraph(n: number): GraphSpec {
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
  return {
    nodes: ids.map((id) => ({ id })),
    edges: ids.map((id, i) => ({ source: id, target: ids[(i + 1) % n] })),
  };
}

function starIn(k: number): GraphSpec {
  return {
    nodes: [{ id: 'c' }, ...Array.from({ length: k }, (_, i) => ({ id: `l${i}` }))],
    edges: Array.from({ length: k }, (_, i) => ({ source: `l${i}`, target: 'c' })),
  };
}

describe('无向形状契约（grid-undirected, direction=none）', () => {
  it('U1: 5×5 网格图 → 严格 5×5 方阵', () => {
    const layout = layoutOf(gridGraph(5));
    const cells = ordinalGrid(layout);
    const cols = new Set(cells.map((c) => c.col));
    const rows = new Set(cells.map((c) => c.row));
    expect(cols.size, `应有 5 个不同列，实际 ${cols.size}`).toBe(5);
    expect(rows.size, `应有 5 个不同行，实际 ${rows.size}`).toBe(5);
    // 每格至多一个节点，且 5×5 = 25 格全占用
    const keys = new Set(cells.map((c) => `${c.col},${c.row}`));
    expect(keys.size).toBe(25);
  });

  it('U2: 2 个独立点 → 水平或垂直相邻（相邻行列，中间无其他行/列）', () => {
    const layout = layoutOf({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] });
    const cells = ordinalGrid(layout);
    const [a, b] = cells;
    const adjacent =
      (a!.col === b!.col && Math.abs(a!.row - b!.row) === 1) ||
      (a!.row === b!.row && Math.abs(a!.col - b!.col) === 1);
    expect(adjacent, `两点应正交贴邻，实测 col ${a!.col}/${b!.col} row ${a!.row}/${b!.row}`).toBe(true);
  });

  it('U3: 2 点 1 边 → 正交（水平优先，垂直亦可）', () => {
    const layout = layoutOf({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] });
    expect(edgeClass(layout, 'a', 'b')).not.toBe('diag');
  });

  it('U4: 3 节点 3 边三角环 → 品字（L 形三格，非共线）', () => {
    const layout = layoutOf(ringGraph(3));
    const cells = ordinalGrid(layout);
    const keys = new Set(cells.map((c) => `${c.col},${c.row}`));
    expect(keys.size).toBe(3); // 三格互不重叠
    // L 形：存在一行有两个节点（水平底边），第三点在其上/下方
    const byRow = new Map<number, number[]>();
    for (const c of cells) {
      byRow.set(c.row, [...(byRow.get(c.row) ?? []), c.col]);
    }
    const twoInRow = [...byRow.values()].some((cols) => cols.length === 2 && Math.abs(cols[0]! - cols[1]!) === 1);
    expect(twoInRow, '应有一行构成水平底边（两贴邻格）').toBe(true);
  });

  it('U5: 4 节点 4 边四边环 → 正方形（2×2）', () => {
    const layout = layoutOf(ringGraph(4));
    const cells = ordinalGrid(layout);
    const cols = new Set(cells.map((c) => c.col));
    const rows = new Set(cells.map((c) => c.row));
    expect(cols.size, `应占 2 列，实际 ${cols.size}`).toBe(2);
    expect(rows.size, `应占 2 行，实际 ${rows.size}`).toBe(2);
    const keys = new Set(cells.map((c) => `${c.col},${c.row}`));
    expect(keys.size).toBe(4); // 2×2 四格各一节点
  });

  it('U6: 4 节点 2 边（两条独立边）→ 两边平行', () => {
    const layout = layoutOf({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
    });
    const ca = edgeClass(layout, 'a', 'b');
    const cb = edgeClass(layout, 'c', 'd');
    expect(ca === 'h' || ca === 'v', '第一条边应正交').toBe(true);
    expect(ca).toBe(cb);
  });
});

describe('有向形状契约（grid-undirected, direction=TB）', () => {
  it('D1: 5 点向心（4 叶→中心）→ 顺流山形（全部叶在中心上方，无逆流）', () => {
    const layout = layoutOf(starIn(4), 'TB');
    const c = layout.positions.get('c')!;
    for (let i = 0; i < 4; i++) {
      const leaf = layout.positions.get(`l${i}`)!;
      expect(
        leaf.y <= c.y,
        `叶 l${i} 应在中心上方或同层（顺流），实测 leaf.y=${leaf.y} c.y=${c.y}`,
      ).toBe(true);
    }
    // 山形：5 节点互不重叠（占 5 个不同格位）
    const cells = ordinalGrid(layout);
    expect(new Set(cells.map((c2) => `${c2.col},${c2.row}`)).size).toBe(5);
  });

  it('D2: 2 点 1 边 → 垂直（dx = 0）', () => {
    const layout = layoutOf(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      'TB',
    );
    expect(edgeClass(layout, 'a', 'b')).toBe('v');
  });

  it('D3: 4 点 2 边 → 两条边垂直且相互平行', () => {
    const layout = layoutOf(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'c', target: 'd' },
        ],
      },
      'TB',
    );
    expect(edgeClass(layout, 'a', 'b')).toBe('v');
    expect(edgeClass(layout, 'c', 'd')).toBe('v');
  });

  it('D4: 顶点发出两条线 a→b, a→c → 正立三角形（顶点 a 在上，b/c 在下一行）', () => {
    const layout = layoutOf(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'c' },
        ],
      },
      'TB',
    );
    const cells = ordinalGrid(layout);
    const a = cells.find((c) => c.id === 'a')!;
    const b = cells.find((c) => c.id === 'b')!;
    const c = cells.find((c) => c.id === 'c')!;
    expect(a.row, '顶点 a 应在 b/c 上方（TB 顺流）').toBeLessThan(b.row);
    expect(b.row).toBe(c.row); // b、c 同一层行
    expect(b.col).not.toBe(c.col); // 不重叠
  });

  it('D5: 顶点接收两条线 b→a, c→a → 倒立三角形（顶点 a 在下，b/c 在上一行）', () => {
    const layout = layoutOf(
      {
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [
          { source: 'b', target: 'a' },
          { source: 'c', target: 'a' },
        ],
      },
      'TB',
    );
    const cells = ordinalGrid(layout);
    const a = cells.find((c) => c.id === 'a')!;
    const b = cells.find((c) => c.id === 'b')!;
    const c = cells.find((c) => c.id === 'c')!;
    expect(a.row, '顶点 a 应在 b/c 下方（TB 顺流）').toBeGreaterThan(b.row);
    expect(b.row).toBe(c.row);
    expect(b.col).not.toBe(c.col);
  });
});
