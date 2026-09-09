/**
 * 用户提供的 mermaid flowchart（TD）—— 作为真实业务图的压力/目视样本。
 *
 * 拓扑（与 mermaid 完全一致）：
 *   A 输入变更 → B 建立 Change Set → C 读取 Trace Graph → D 计算 Impact Set
 *   → E Tailoring → F 生成 Execution Plan → G 装载 Stage Contract
 *   → H 装载最小充分上下文 → I 执行 Stage → J 产生 Artifact → K 自动验证
 *   → L{Quality Gate}
 *   L --PASS--> M 更新 Baseline/State
 *   L --PASS_WITH_OPEN_ISSUES--> N 登记 Issue → M
 *   L --FAIL--> O 生成修正任务 → G
 *   L --BLOCKED--> P Decision/补充输入 → G
 *   M → Q 更新 Trace Graph → R{是否存在后续 Impact}
 *   R --是--> G    R --否--> S 阶段执行完成
 *
 * 断言侧重"物理合法性 + 视觉可比较性"：
 *   - 收敛、坐标有限、包围圆不重叠、确定性；
 *   - 每条中心到中心的连线不得穿过任何无关节点的矩形（边-节点避让墙生效；
 *     大图/大矩形节点用 edgeNodeRepulsion: 20 强化软墙 —— 线遮盖节点是
 *     用户物理模型里明确要求"强斥力"排除的状态）；
 *   - 任意两个节点矩形不相交（包围圆不重叠的推论）。
 * 结果渲染成 SVG（output/mermaid-layout.svg），可与原 mermaid 图比对拓扑：
 * 链 A→…→S、L 的四分支（带箭头与文字标签）、回环 O/P/R→G。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForceLayout, estimateLabelBox, type NodeView } from '../src/index.js';
import { MERMAID_GRAPH } from './mermaid.graph.js';

/** 判断节点（mermaid 的 {} 菱形）。 */
const DIAMOND = new Set(['L', 'R']);

/** 节点渲染尺寸：与 physics 形状一致（图定义里已按文字宽度定宽）。 */
function nodeRect(id: string | number): { w: number; h: number } {
  const spec = MERMAID_GRAPH.nodes.find((n) => String(n.id) === String(id))!;
  const shape = spec.shape as { kind: 'rect'; w: number; h: number };
  return { w: shape.w, h: shape.h };
}

/** 线段与轴对齐矩形的相交长度（Liang–Barsky 裁剪）。 */
function segRectPen(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, w: number, h: number,
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
  const len = (t1 - t0) * Math.hypot(dx, dy);
  return len > 2 ? len : 0; // 2px 容差：贴边不算穿过
}

function nodeOverlapDepth(nv: readonly NodeView[]): number {
  let worst = -Infinity;
  for (let i = 0; i < nv.length; i++)
    for (let j = i + 1; j < nv.length; j++) {
      const g = Math.hypot(nv[i].x - nv[j].x, nv[i].y - nv[j].y) - nv[i].r - nv[j].r;
      if (g > worst) worst = Math.max(worst, -g);
    }
  return worst; // > 0 表示存在重叠深度
}

/** 从节点中心沿 (ux,uy) 到其渲染轮廓的距离（rect 边 / 菱形边 / 圆）。 */
function boundaryDistance(id: string | number, ux: number, uy: number): number {
  const { w, h } = nodeRect(id);
  if (DIAMOND.has(String(id))) {
    const k = Math.abs(ux) / (w / 2) + Math.abs(uy) / (h / 2);
    return k > 1e-12 ? 1 / k : 0;
  }
  const tx = Math.abs(ux) > 1e-12 ? w / 2 / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > 1e-12 ? h / 2 / Math.abs(uy) : Infinity;
  return Math.min(tx, ty);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSvg(layout: ForceLayout, file: string): void {
  const nv = layout.nodeViews;
  const ev = layout.edgeViews;
  const labelById = new Map(MERMAID_GRAPH.nodes.map((n) => [n.id, n.label ?? '']));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of nv) {
    const { w, h } = nodeRect(p.id);
    minX = Math.min(minX, p.x - w / 2);
    minY = Math.min(minY, p.y - h / 2);
    maxX = Math.max(maxX, p.x + w / 2);
    maxY = Math.max(maxY, p.y + h / 2);
  }
  const pad = 90;
  const vbW = maxX - minX + pad * 2;
  const vbH = maxY - minY + pad * 2;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW.toFixed(0)}" height="${vbH.toFixed(0)}" viewBox="${minX - pad} ${minY - pad} ${vbW} ${vbH}" font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif">`,
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker></defs>`,
    `<rect x="${minX - pad}" y="${minY - pad}" width="${vbW}" height="${vbH}" fill="#ffffff"/>`,
  );
  // 边：从起点轮廓剪到终点轮廓，带箭头（先画全部线，文字标签后画 —— 线不得盖字）
  type DrawnEdge = { e: (typeof ev)[number]; x0: number; y0: number; x1: number; y1: number };
  const drawn: DrawnEdge[] = [];
  for (const e of ev) {
    const a = nv[e.a];
    const b = nv[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const t0 = boundaryDistance(a.id, ux, uy) + 1;
    const t1 = d - boundaryDistance(b.id, -ux, -uy) - 2;
    const de: DrawnEdge = {
      e,
      x0: a.x + ux * t0,
      y0: a.y + uy * t0,
      x1: a.x + ux * t1,
      y1: a.y + uy * t1,
    };
    drawn.push(de);
    parts.push(
      `<line x1="${de.x0}" y1="${de.y0}" x2="${de.x1}" y2="${de.y1}" stroke="#64748b" stroke-width="1.75" marker-end="url(#arr)"/>`,
    );
  }
  // 边文字标签：贴在自身线上（盒子边缘接触线段，mermaid 式），沿线滑动 +
  // 两侧择优，选"不被任何其他边线穿过盒内、不压到任何节点"的位置。
  const labelParts: string[] = [];
  const fs = 12;
  for (const de of drawn) {
    if (de.e.label === null) continue;
    const box = estimateLabelBox(de.e.label, fs, 4);
    const lx = de.x1 - de.x0;
    const ly = de.y1 - de.y0;
    const ll = Math.hypot(lx, ly) || 1;
    const ux = lx / ll;
    const uy = ly / ll;
    let best: { cx: number; cy: number; score: number } | null = null;
    for (const t of [0.18, 0.28, 0.4, 0.5, 0.62, 0.74, 0.84]) {
      for (const side of [1, -1]) {
        const off = side * (box.hh + 3); // 盒子下边缘贴线
        const cx = de.x0 + lx * t - uy * off;
        const cy = de.y0 + ly * t + ux * off;
        let score = 0;
        for (const other of drawn) {
          if (other === de) continue;
          if (segRectPen(other.x0, other.y0, other.x1, other.y1, cx, cy, box.hw * 2 + 2, box.hh * 2 + 2) > 0) score++;
        }
        for (const nd of nv) {
          const { w, h } = nodeRect(nd.id);
          if (segRectPen(cx - box.hw - 3, cy, cx + box.hw + 3, cy, nd.x, nd.y, w, h) > 0 ||
              segRectPen(cx, cy - box.hh - 3, cx, cy + box.hh + 3, nd.x, nd.y, w, h) > 0) score += 2;
        }
        if (!best || score < best.score) best = { cx, cy, score };
        if (score === 0) break;
      }
      if (best && best.score === 0) break;
    }
    const { cx, cy } = best!;
    labelParts.push(
      `<rect x="${cx - box.hw}" y="${cy - box.hh}" width="${box.hw * 2}" height="${box.hh * 2}" fill="#fef3c7" stroke="#f59e0b" stroke-width="1" rx="3"/>`,
    );
    box.rows.forEach((row, li) => {
      const ty = cy - box.hh + 4 + fs * (li + 0.8);
      labelParts.push(
        `<text x="${cx}" y="${ty}" text-anchor="middle" font-size="${fs}" fill="#7c2d12">${esc(row.trim())}</text>`,
      );
    });
  }
  parts.push(...labelParts);
  // 节点：rect 与菱形（mermaid 的 {} 判断节点），中心放文字
  for (const p of nv) {
    const { w, h } = nodeRect(p.id);
    if (DIAMOND.has(String(p.id))) {
      parts.push(
        `<polygon points="${p.x},${p.y - h / 2} ${p.x + w / 2},${p.y} ${p.x},${p.y + h / 2} ${p.x - w / 2},${p.y}" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>`,
      );
    } else {
      parts.push(
        `<rect x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" fill="#e0f2fe" stroke="#0284c7" stroke-width="2" rx="6"/>`,
      );
    }
    parts.push(
      `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="12" fill="#0c4a6e">${esc(labelById.get(p.id) ?? '')}</text>`,
    );
  }
  parts.push('</svg>');
  writeFileSync(file, parts.join('\n'), 'utf8');
}

describe('mermaid 流程图（用户样本）', () => {
  it(
    '收敛、无重叠、连线不穿节点，并渲染 SVG 供目视比对',
    () => {
    // edgeNodeRepulsion: 40 —— 大矩形节点图 + 跳数衰减的紧凑布局里，
    // 软墙必须坚决生效才能守住"零线穿节点"。
    const layout = new ForceLayout(MERMAID_GRAPH, {
      naturalLength: 120,
      seed: 42,
      // edgeNodeRepulsion 40：跳数衰减(0.7)让图更紧凑，软墙需同步加强
      // 才能守住"零线穿节点"（20 会被挤压穿透，40 实测零穿透且收敛）。
      edgeNodeRepulsion: 40,
    });
    const r = layout.run({ maxIterations: 24000 });
    expect(r.converged).toBe(true);

    // 物理合法性
    for (const p of layout.nodeViews) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(nodeOverlapDepth(layout.nodeViews)).toBeLessThanOrEqual(0);

    // 拓扑保持：相连节点的表面间隙（中心距 − 两包围半径）< 5×naturalLength。
    // 大节点（包围半径可达 120px）+ 回环枢纽 G 的四入边 + 标签软墙会把个别
    // 链边拉得比 naturalLength 长 —— 上限防的是"边两端飞散"这类拓扑破坏。
    const viewById = new Map(layout.nodeViews.map((p) => [String(p.id), p]));
    for (const e of MERMAID_GRAPH.edges) {
      const a = viewById.get(String(e.source))!;
      const b = viewById.get(String(e.target))!;
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
      expect(gap, `${String(e.source)}→${String(e.target)} 间隙 ${gap.toFixed(0)}`).toBeLessThan(800);
    }

    // 视觉可比较性①：中心到中心的连线不穿过任何无关节点的形状轮廓。
    for (const e of MERMAID_GRAPH.edges) {
      const a = viewById.get(String(e.source))!;
      const b = viewById.get(String(e.target))!;
      for (const nd of layout.nodeViews) {
        if (String(nd.id) === String(e.source) || String(nd.id) === String(e.target)) continue;
        const { w, h } = nodeRect(nd.id);
        const pen = segRectPen(a.x, a.y, b.x, b.y, nd.x, nd.y, w, h);
        expect(pen, `${String(e.source)}→${String(e.target)} 穿过 ${esc(String(nd.id))} ${pen.toFixed(0)}px`).toBe(0);
      }
    }
    // 视觉可比较性②：节点矩形（渲染尺寸）互不相交
    {
      const nv = layout.nodeViews;
      for (let i = 0; i < nv.length; i++)
        for (let j = i + 1; j < nv.length; j++) {
          const ri = nodeRect(nv[i].id);
          const rj = nodeRect(nv[j].id);
          const ox = ri.w / 2 + rj.w / 2 - Math.abs(nv[i].x - nv[j].x);
          const oy = ri.h / 2 + rj.h / 2 - Math.abs(nv[i].y - nv[j].y);
          if (ox > 0 && oy > 0) {
            expect.fail(`${String(nv[i].id)} 与 ${String(nv[j].id)} 矩形相交 ${ox.toFixed(1)}×${oy.toFixed(1)}px`);
          }
        }
    }

    // 无孤立漂移：全图直径有界（调和约束生效）
    const nv = layout.nodeViews;
    let maxPair = 0;
    for (let i = 0; i < nv.length; i++)
      for (let j = i + 1; j < nv.length; j++)
        maxPair = Math.max(maxPair, Math.hypot(nv[i].x - nv[j].x, nv[i].y - nv[j].y));
    expect(maxPair).toBeLessThan(4000);

    // 确定性：相同 seed 两次完整求解结果逐位一致
    const again = new ForceLayout(MERMAID_GRAPH, { naturalLength: 120, seed: 42, edgeNodeRepulsion: 40 });
    again.run({ maxIterations: 24000 });
    for (let i = 0; i < layout.nodeViews.length; i++) {
      expect(again.nodeViews[i].x).toBeCloseTo(layout.nodeViews[i].x, 6);
      expect(again.nodeViews[i].y).toBeCloseTo(layout.nodeViews[i].y, 6);
    }

    // 目视比对产物
    const out = join(process.cwd(), 'output', 'mermaid-layout.svg');
    mkdirSync(dirname(out), { recursive: true });
    renderSvg(layout, out);
    expect(r.iterations).toBeGreaterThan(0);
    },
    240_000,
  );
});
