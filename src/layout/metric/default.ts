/**
 * 尺寸映射策略的缺省实现（现状口径平移，矩形格）。
 *
 *  - measureBox：形状声明 ∨ 文字盒取大（文字盒按 estimateLabelBox 面积
 *    最小折行，0.75 字宽比例估算）—— 周长平局 / 行距系数 / 字体族测量
 *    为预留扩展点，接入时替换本实现或注入自定义策略；
 *  - grade：宽/高独立锚定聚类（gradeBoxes，容差 1.25），最小级上界即
 *    基准格；格数 = 盒 ÷ 基准格向上取整 —— 最小级元素恰好 1×1 格；
 *  - render：1 格 = 基准格（x 轴 cellW、y 轴 cellH，各向异性）；元素
 *    AABB 中心写回 + 全体质心归零；边走线格点按格心 (p+0.5)·格距换算
 *    （退化直线用精确端点）；容器 shape = 格 AABB × 格距 + 两侧 padding。
 */

import { estimateLabelBox } from '../../label.js';
import { halfExtentsOf } from '../../geometry.js';
import { gradeBoxes, type BoxSize, type GradeBasis } from '../grade.js';
import { registerMetricStrategy } from './registry.js';
import type { GridCellMetric, LayoutSolution, MetricElementInfo, MetricStrategy, RenderGraph } from './types.js';

export class DefaultMetricStrategy implements MetricStrategy {
  readonly name = 'default';

  measureBox(el: MetricElementInfo): BoxSize {
    const he = halfExtentsOf(el.shape);
    let w = 2 * he.hw;
    let h = 2 * he.hh;
    if (el.label !== null) {
      const box = estimateLabelBox(el.label, el.font.size, el.font.padding);
      w = Math.max(w, 2 * box.hw);
      h = Math.max(h, 2 * box.hh);
    }
    return { w, h };
  }

  grade(boxes: readonly BoxSize[]): GradeBasis {
    return gradeBoxes(boxes);
  }

  render(solution: LayoutSolution, cells: GridCellMetric): RenderGraph {
    const { cellW, cellH } = cells;
    const { boxes } = solution;
    // 质心归零：AABB 中心的均值平移到原点（渲染端自由缩放，不感知网格）。
    let sx = 0;
    let sy = 0;
    for (const b of boxes) {
      sx += (b.x + b.width / 2) * cellW;
      sy += (b.y + b.height / 2) * cellH;
    }
    const ox = boxes.length > 0 ? -sx / boxes.length : 0;
    const oy = boxes.length > 0 ? -sy / boxes.length : 0;
    const nodes = boxes.map((b) => ({
      x: b.x * cellW + ox,
      y: b.y * cellH + oy,
      w: b.width * cellW,
      h: b.height * cellH,
    }));
    const toPhys = (p: { x: number; y: number }) => ({ x: p.x * cellW + ox, y: p.y * cellH + oy });
    const toCellCenter = (p: { x: number; y: number }) => ({
      x: (p.x + 0.5) * cellW + ox,
      y: (p.y + 0.5) * cellH + oy,
    });
    const edges = solution.routes.map((r) => ({
      source: r.source,
      target: r.target,
      waypoints: r.exact ? [toPhys(r.exact[0]), toPhys(r.exact[1])] : r.cells.map(toCellCenter),
    }));
    const containerShapes = solution.containerPaddings.map((pad, i) =>
      pad === null
        ? null
        : { kind: 'rect' as const, w: boxes[i]!.width * cellW + pad * 2, h: boxes[i]!.height * cellH + pad * 2 },
    );
    return { nodes, containerShapes, edges };
  }
}

registerMetricStrategy('default', new DefaultMetricStrategy());
