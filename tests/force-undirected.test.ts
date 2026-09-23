/**
 * force-undirected（力导向无向图）验收用例。
 *
 * 流水线：质点网格粗布局 → 膨胀压实 → 收敛自适应短弛豫微调
 * （doc/布局核心原则.md 无向图部分）。覆盖角度：
 *  1. 确定性：同 seed 两次布局逐位一致（网格放置与微调全链路）；
 *  2. 无重叠：由粗布局构造保证，微调后不退化（n=100 / n=2000）；
 *  3. 树零交叉：网格放置邻居相邻 → 树边皆为短边（tree21 结构）；
 *  4. mermaid 用户样本：连线零穿节点 + 渲染 SVG 供目视比对；
 *  5. 孤立点不堆叠；分组声明被忽略（纯度）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAllFinite, minSurfaceGap } from './helpers.js';
import { ForceLayout } from '../src/index.js';
import { countEdgeCrossings } from '../src/layout/force-undirected/crossings.js';
import { MERMAID_GRAPH } from './mermaid.graph.js';
import type { GraphSpec, NodeId } from '../src/types.js';

// ── 通用工具 ────────────────────────────────────────────────

/** 连通随机图：随机生成树 + 额外边（确定性 LCG）。 */
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
    edges.push({ source: Math.floor(rand() * n), target: Math.floor(rand() * n) });
  }
  return { nodes, edges };
}

/** tree21 结构（root + 4 分支 × 4 叶，见 tree21.test.ts）。 */
function treeGraph() {
  const nodes: Array<{ id: string; label: string }> = [{ id: 'root', label: 'root' }];
  const edges: Array<{ source: string; target: string }> = [];
  const level1: string[] = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `b${i}`, label: `b${i}` });
    edges.push({ source: 'root', target: `b${i}` });
    level1.push(`b${i}`);
  }
  level1.forEach((p, pi) => {
    for (let j = 0; j < 4; j++) {
      const id = `l${pi}-${j}`;
      nodes.push({ id, label: id });
      edges.push({ source: p, target: id });
    }
  });
  return { nodes, edges } satisfies GraphSpec;
}

/** 线段与轴对齐矩形的相交长度（Liang–Barsky 裁剪，同 mermaid.test.ts）。 */
function segRectPen(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - (cx - w / 2), cx + w / 2 - ax, ay - (cy - h / 2), cy + h / 2 - ay];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return 0;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return 0;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return 0;
      if (t < t1) t1 = t;
    }
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}

// ── 用例 ────────────────────────────────────────────────────

describe('force-undirected：质点网格粗布局流水线', () => {
  it('确定性：同 seed 两次布局逐位一致', () => {
    const build = () =>
      new ForceLayout(treeGraph(), { algorithm: 'force-undirected', seed: 42 });
    const a = build();
    const b = build();
    a.run();
    b.run();
    expect(a.positions.size).toBe(b.positions.size);
    for (const [id, pa] of a.positions) {
      const pb = b.positions.get(id)!;
      expect(pa.x).toBe(pb.x);
      expect(pa.y).toBe(pb.y);
    }
  });

  it('n=100 连通随机图：收敛、无 NaN、无重叠', () => {
    const layout = new ForceLayout(connectedRandomGraph(100, 0.05, 7), {
      algorithm: 'force-undirected',
      seed: 42,
    });
    const r = layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    expect(r.iterations).toBeGreaterThan(0);
  }, 60_000);

  it('树 21 节点：默认预算内收敛，网格粗布局零线段交叉', () => {
    const layout = new ForceLayout(treeGraph(), {
      algorithm: 'force-undirected',
      seed: 42,
    });
    const r = layout.run();
    expect(r.converged, `默认预算内未收敛（iterations=${r.iterations}）`).toBe(true);
    const views = layout.nodeViews;
    const edges = layout.edgeViews.map((e) => ({
      sourceIndex: e.sourceIndex,
      targetIndex: e.targetIndex,
    }));
    const counts = countEdgeCrossings(views, edges);
    const names = views.map((v) => String(v.id));
    const crossed = edges
      .map((e, i) =>
        counts![i] > 0 ? `${names[e.sourceIndex]}-${names[e.targetIndex]}×${counts![i]}` : null,
      )
      .filter(Boolean);
    expect(crossed, `交叉的边：${crossed.join(', ')}`).toEqual([]);
  });

  it('高密度星形（K1,12）：插行列不死锁、无重叠', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({ id: i }));
    const edges = Array.from({ length: 12 }, (_, i) => ({ source: 0, target: i + 1 }));
    const layout = new ForceLayout({ nodes, edges }, {
      algorithm: 'force-undirected',
      seed: 42,
    });
    layout.run();
    assertAllFinite(layout);
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
  });

  it('孤立点不堆叠：链 + 5 个离散点', () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({ id: i }));
    const edges = Array.from({ length: 9 }, (_, i) => ({ source: i, target: i + 1 }));
    const layout = new ForceLayout({ nodes, edges }, {
      algorithm: 'force-undirected',
      seed: 42,
    });
    layout.run();
    expect(minSurfaceGap(layout)).toBeGreaterThan(0);
    // 离散点两两不重合（网格占用唯一性）
    const isolated = Array.from(layout.nodeViews).slice(10);
    for (let i = 0; i < isolated.length; i++) {
      for (let j = i + 1; j < isolated.length; j++) {
        const d = Math.hypot(isolated[i].x - isolated[j].x, isolated[i].y - isolated[j].y);
        expect(d, `离散点 ${i}/${j} 重合`).toBeGreaterThan(0);
      }
    }
  });

  it('纯度：hiddenGroups 声明被忽略（与无声明逐位一致）', () => {
    const base = treeGraph();
    const withGroups: GraphSpec = {
      ...base,
      hiddenGroups: [{ id: 'h1', members: ['b0', 'b1', 'b2'] }],
    };
    const a = new ForceLayout(base, { algorithm: 'force-undirected', seed: 42 });
    const b = new ForceLayout(withGroups, { algorithm: 'force-undirected', seed: 42 });
    a.run();
    b.run();
    for (const [id, pa] of a.positions) {
      const pb = b.positions.get(id as NodeId)!;
      expect(pa.x).toBe(pb.x);
      expect(pa.y).toBe(pb.y);
    }
  });

  it(
    'mermaid 用户样本：连线零穿节点，渲染 SVG 供目视比对',
    () => {
      const layout = new ForceLayout(MERMAID_GRAPH, {
        algorithm: 'force-undirected',
        naturalLength: 120,
        seed: 42,
        edgeNodeRepulsion: 40,
      });
      const r = layout.run({ maxIterations: 24000 });
      assertAllFinite(layout);
      expect(minSurfaceGap(layout)).toBeGreaterThan(0);

      // 零线穿节点：每条边对不相关节点矩形的穿透长度为 0
      const nv = layout.nodeViews;
      const rectById = new Map(
        nv.map((n) => {
          const spec = MERMAID_GRAPH.nodes.find((m) => String(m.id) === String(n.id))!;
          const shape = spec.shape as { kind: 'rect'; w: number; h: number };
          return [n.id, { x: n.x, y: n.y, w: shape.w, h: shape.h }];
        }),
      );
      const penetrations: string[] = [];
      for (const e of layout.edgeViews) {
        const a = nv[e.sourceIndex];
        const b = nv[e.targetIndex];
        for (const n of nv) {
          if (n.id === a.id || n.id === b.id) continue;
          const rc = rectById.get(n.id)!;
          const pen = segRectPen(a.x, a.y, b.x, b.y, rc.x, rc.y, rc.w, rc.h);
          if (pen > 0) penetrations.push(`${String(a.id)}-${String(b.id)} × ${String(n.id)} (${pen.toFixed(1)})`);
        }
      }
      expect(penetrations, `穿节点的边：${penetrations.join('; ')}`).toEqual([]);
      expect(r.converged, '未收敛').toBe(true);

      // 渲染 SVG（目视比对）
      const file = join('output', 'mermaid-undirected.svg');
      mkdirSync(dirname(file), { recursive: true });
      const parts: string[] = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nv) {
        const rc = rectById.get(n.id)!;
        minX = Math.min(minX, rc.x - rc.w / 2);
        minY = Math.min(minY, rc.y - rc.h / 2);
        maxX = Math.max(maxX, rc.x + rc.w / 2);
        maxY = Math.max(maxY, rc.y + rc.h / 2);
      }
      const pad = 90;
      const vbW = maxX - minX + pad * 2;
      const vbH = maxY - minY + pad * 2;
      parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}" viewBox="${minX - pad} ${minY - pad} ${vbW} ${vbH}" font-family="system-ui, sans-serif">`,
        `<rect x="${minX - pad}" y="${minY - pad}" width="${vbW}" height="${vbH}" fill="#ffffff"/>`,
      );
      for (const e of layout.edgeViews) {
        const a = nv[e.sourceIndex];
        const b = nv[e.targetIndex];
        parts.push(
          `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#64748b" stroke-width="1.5"/>`,
        );
      }
      for (const n of nv) {
        const rc = rectById.get(n.id)!;
        parts.push(
          `<rect x="${(rc.x - rc.w / 2).toFixed(1)}" y="${(rc.y - rc.h / 2).toFixed(1)}" width="${rc.w}" height="${rc.h}" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>`,
          `<text x="${rc.x.toFixed(1)}" y="${rc.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="12" fill="#0f172a">${String(n.id)}</text>`,
        );
      }
      parts.push('</svg>');
      writeFileSync(file, parts.join('\n'), 'utf8');
    },
    120_000,
  );

  it(
    'n=2000 压力测试：粗布局 + 短弛豫在有限时间内完成，无 NaN、无重叠',
    () => {
      // barnes-hut 精度 + 限步预算控制用例时长（exact 全程收敛需数千步、分钟级）；
      // 验收点是大规模下全链路不崩、粗布局的无重叠在弛豫后保持。
      const layout = new ForceLayout(connectedRandomGraph(2000, 0.02, 7), {
        algorithm: 'force-undirected',
        accuracy: 'barnes-hut',
        seed: 42,
      });
      const r = layout.run({ maxIterations: 400 });
      assertAllFinite(layout);
      expect(minSurfaceGap(layout)).toBeGreaterThan(0);
      expect(r.iterations).toBeGreaterThan(0);
    },
    300_000,
  );
});
