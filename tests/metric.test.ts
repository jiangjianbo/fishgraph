/**
 * 尺寸映射策略测试：逻辑布局 ↔ 现实尺寸的接缝。
 *
 * 覆盖角度：
 *  1. 缺省策略（矩形基准格）：节点物理尺寸 = 格数 × 格距（大小比例真实化）；
 *  2. renderGraph 出口：世界坐标纯数据（节点/容器/边）可独立消费；
 *  3. 自定义策略：measureBox 覆盖度量 → 分级与物理尺寸随之（扩展性）。
 */

import { describe, expect, it } from 'vitest';
import {
  DefaultMetricStrategy,
  ForceLayout,
  gradeBoxes,
  registerMetricStrategy,
  type GraphSpec,
} from '../src/index.js';

describe('尺寸映射策略（逻辑布局 ↔ 现实尺寸）', () => {
  it('缺省策略：矩形基准格下节点物理尺寸按真实比例占格', () => {
    const layout = new ForceLayout(
      {
        nodes: [
          { id: 'small', label: 's' },
          { id: 'big', label: 'x'.repeat(40) },
        ],
        edges: [{ source: 'small', target: 'big' }],
      },
      { algorithm: 'grid-undirected', naturalLength: 6 },
    );
    layout.run();
    const byId = new Map(layout.nodeViews.map((v) => [String(v.id), v]));
    const small = byId.get('small')!;
    const big = byId.get('big')!;
    // 大文字节点占格更多：宽方向严格比例化（40 个 x 不可断行 → 单行
    // 22 格宽）；高方向两轴独立分级，单行文字同级 → 至少不小于。
    expect(big.w!).toBeGreaterThan(small.w!);
    expect(big.h!).toBeGreaterThanOrEqual(small.h!);
    // 物理宽 = 格数 × 基准格宽（格数 = ceil(盒 ÷ 基准格) 向上取整）
    const gw = Math.round(big.w! / layout.cellW);
    expect(big.w!).toBeCloseTo(gw * layout.cellW, 6);
    expect(gw).toBeGreaterThan(1);
  });

  it('renderGraph 出口：世界坐标纯数据（节点/容器/边）可独立消费', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'in-a', label: 'in-a' },
        { id: 'in-b', label: 'in-b' },
        { id: 'ext', label: 'ext' },
      ],
      edges: [
        { source: 'in-a', target: 'in-b' },
        { source: 'sub', target: 'ext' },
      ],
      subgraphs: [
        { id: 'sub', shape: { kind: 'rect', w: 200, h: 120 }, label: 'sub', members: ['in-a', 'in-b'], padding: 3 },
      ],
    };
    const layout = new ForceLayout(spec, { algorithm: 'grid-undirected', folding: true, naturalLength: 6 });
    layout.run();
    const graph = layout.renderGraph;
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(4); // in-a/in-b/ext/sub
    for (const nd of graph!.nodes) {
      expect(nd.w).toBeGreaterThan(0);
      expect(nd.h).toBeGreaterThan(0);
    }
    // 容器实占 shape（格包裹 + 两侧 padding）
    const subShape = graph!.containerShapes[3]!;
    expect(subShape.kind).toBe('rect');
    // 边走线：每条边首尾齐全（正交拐点或退化直线）
    expect(graph!.edges).toHaveLength(2);
    for (const e of graph!.edges) {
      expect(e.waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('自定义策略：measureBox 覆盖度量，分级与物理尺寸随之', () => {
    // 固定 50×50 度量：全部元素同级 → 基准格 50×50，物化恰为 1×1 格 × 50
    registerMetricStrategy('fixed-50', {
      name: 'fixed-50',
      measureBox: () => ({ w: 50, h: 50 }),
      grade: (boxes) => gradeBoxes(boxes),
      render: new DefaultMetricStrategy().render,
    });
    const layout = new ForceLayout(
      {
        nodes: Array.from({ length: 3 }, (_, i) => ({ id: i, label: '字'.repeat(20 * (i + 1)) })),
        edges: [
          { source: 0, target: 1 },
          { source: 1, target: 2 },
        ],
      },
      { algorithm: 'grid-undirected', metric: 'fixed-50', naturalLength: 6 },
    );
    layout.run();
    expect(layout.cellW).toBe(50);
    expect(layout.cellH).toBe(50);
    for (const v of layout.nodeViews) {
      expect(v.w!).toBeCloseTo(50, 6);
      expect(v.h!).toBeCloseTo(50, 6);
    }
  });
});
