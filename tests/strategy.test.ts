/**
 * 策略模式测试：布局算法可替换、节点管理与算法分离。
 *
 * 覆盖角度：
 *  1. 注册表：内置策略自注册、未知策略报错并列出可用项
 *  2. 以 algorithm 选项选用非默认策略（circle：无迭代、立即收敛、环形构型）
 *  3. setStrategy 运行时热切换：图数据保留，重新布局
 *  4. 节点/边管理（GraphStore 透传）：增删节点/边后策略 rebuild，布局仍合法
 */

import { describe, expect, it } from 'vitest';
import { ForceLayout, listStrategies } from '../src/index.js';

describe('布局策略（策略模式）', () => {
  it('注册表：内置策略已自注册；未知策略抛错并提示可用项', () => {
    expect(listStrategies()).toContain('grid-undirected');
    expect(listStrategies()).toContain('circle');
    expect(() => new ForceLayout({ nodes: [{ id: 1 }], edges: [] }, { algorithm: 'nope' })).toThrow(
      /nope.*grid-undirected/s,
    );
  });

  it('algorithm 选项直接选用策略：circle 无迭代、立即收敛、节点成环', () => {
    const layout = new ForceLayout(
      { nodes: Array.from({ length: 6 }, (_, i) => ({ id: i })), edges: [] },
      { algorithm: 'circle', naturalLength: 100, seed: 1 },
    );
    expect(layout.strategyName).toBe('circle');
    const r = layout.run();
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
    expect(layout.step()).toBe(false);

    const views = layout.nodeViews;
    const cx = views.reduce((s, p) => s + p.x, 0) / views.length;
    const cy = views.reduce((s, p) => s + p.y, 0) / views.length;
    const radii = views.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const mean = radii.reduce((s, x) => s + x, 0) / radii.length;
    for (const x of radii) expect(Math.abs(x - mean)).toBeLessThan(mean * 0.12);
  });

  it('setStrategy 热切换：数据保留，新策略重新初始化位置，切回后仍弛豫到合法布局', () => {
    const layout = new ForceLayout(
      {
        nodes: Array.from({ length: 8 }, (_, i) => ({ id: i })),
        edges: Array.from({ length: 7 }, (_, i) => ({ source: i, target: i + 1 })),
      },
      { naturalLength: 6, seed: 3 },
    );
    layout.run();
    expect(layout.edgeViews.length).toBe(7); // 切换不丢图数据

    layout.setStrategy('circle');
    expect(layout.strategyName).toBe('circle');
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }

    layout.setStrategy('grid-undirected');
    layout.run();
    // 网格布局物化为 AABB（w/h），用实占矩形口径断言无重叠
    const boxes = layout.nodeViews.map((nd) => ({
      x: nd.x - nd.w! / 2,
      y: nd.y - nd.h! / 2,
      w: nd.w!,
      h: nd.h!,
    }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `节点 ${i} 与 ${j} 的物化 AABB 重叠`).toBe(false);
      }
    }
  });

  it('节点/边管理：增删后策略自动 rebuild，布局仍收敛、视图一致', () => {
    const layout = new ForceLayout(
      { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] },
      { naturalLength: 6, seed: 1 },
    );
    layout.addNode({ id: 'c' });
    layout.addEdge({ source: 'b', target: 'c' });
    expect(layout.nodeViews.length).toBe(3);
    expect(layout.edgeViews.length).toBe(2);
    layout.run();
    for (const p of layout.positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }

    layout.removeEdge('a', 'b');
    expect(layout.edgeViews.length).toBe(1);
    layout.removeNode('c');
    expect(layout.nodeViews.length).toBe(2);
    expect(layout.edgeViews.length).toBe(0);
    expect(layout.positions.has('c')).toBe(false);
    expect(() => layout.removeNode('ghost')).toThrow(/unknown node/);
  });
});
