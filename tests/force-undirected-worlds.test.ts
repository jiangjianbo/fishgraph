/**
 * force-undirected 世界分块专项测试。
 *
 * 设计约定（worlds.ts）：每个 subgraph 容器内部是独立力学世界 ——
 *   - 容器对内部成员没有力作用；
 *   - 容器外元素对容器内元素没有影响（跨世界零力耦合，严格双向）；
 *   - 跨世界连线提升为容器本体间的连线；
 *   - 根层 = 无限大容器，行为与无分组时一致。
 */
import { describe, expect, it } from 'vitest';
import '../src/index.js'; // 副作用：内置策略自注册
import { ForceLayout } from '../src/layout';
import { shapeSdf } from '../src/geometry.js';
import type { ElementId, GraphSpec } from '../src/types';

const PARAMS = {
  linkLength: 120,
  energy: 0.003,
  gravity: 'pairwise' as const,
  accuracy: 'exact' as const,
  seed: 42,
  algorithm: 'force-undirected' as never,
};

/** 测试辅助：ForceLayout 未公开策略实例与 store，此处类型安全地取用。 */
interface Snapshot {
  fx: Float64Array;
  fy: Float64Array;
  energy: number;
}
const snapshot = (l: ForceLayout): Snapshot =>
  (l as unknown as { strategy: { forceSnapshot(a: 'exact'): Snapshot } }).strategy.forceSnapshot('exact');
const storeOf = (l: ForceLayout): { indexOf(id: ElementId): number } =>
  (l as unknown as { store: { indexOf(id: ElementId): number } }).store;
/** id → 坐标（物理节点 + 容器视图合并）。 */
const idPos = (l: ForceLayout): Map<ElementId, { x: number; y: number }> => {
  const pos = new Map<ElementId, { x: number; y: number }>();
  for (const v of l.nodeViews) pos.set(v.id, v);
  for (const v of l.subgraphViews) pos.set(v.id, v);
  return pos;
};

/** 容器 C(300×300) + 成员 m1-m2（内部边）+ 外部节点 x。 */
function worldGraph(): GraphSpec {
  return {
    nodes: [
      { id: 'm1', label: 'm1' },
      { id: 'm2', label: 'm2' },
      { id: 'x', label: 'x' },
    ],
    edges: [{ source: 'm1', target: 'm2' }],
    subgraphs: [
      { id: 'C', shape: { kind: 'rect', w: 300, h: 300 }, label: 'C', members: ['m1', 'm2'] },
    ],
  };
}

describe('force-undirected 世界分块', () => {
  it('跨世界零力耦合：外部节点移动不改变成员受力（单向）', () => {
    const layout = new ForceLayout(worldGraph(), PARAMS);
    const s1 = snapshot(layout);
    const m1 = storeOf(layout).indexOf('m1');
    const m2 = storeOf(layout).indexOf('m2');
    layout.setNodePosition('x', 500, 0);
    const s2 = snapshot(layout);
    expect(s2.fx[m1]).toBeCloseTo(s1.fx[m1], 9);
    expect(s2.fy[m1]).toBeCloseTo(s1.fy[m1], 9);
    expect(s2.fx[m2]).toBeCloseTo(s1.fx[m2], 9);
    expect(s2.fy[m2]).toBeCloseTo(s1.fy[m2], 9);
  });

  it('跨世界零力耦合：成员移动不改变外部节点受力（双向）', () => {
    const layout = new ForceLayout(worldGraph(), PARAMS);
    const s1 = snapshot(layout);
    layout.setNodePosition('m1', -40, 30);
    const s2 = snapshot(layout);
    const x = storeOf(layout).indexOf('x');
    expect(s2.fx[x]).toBeCloseTo(s1.fx[x], 9);
    expect(s2.fy[x]).toBeCloseTo(s1.fy[x], 9);
  });

  it('容器对成员没有力作用：成员在容器内任意位置时容器力为零', () => {
    const graph: GraphSpec = {
      nodes: [{ id: 'only', label: 'only' }],
      edges: [],
      subgraphs: [
        { id: 'C', shape: { kind: 'rect', w: 300, h: 300 }, label: 'C', members: ['only'] },
      ],
    };
    const layout = new ForceLayout(graph, PARAMS);
    const C = storeOf(layout).indexOf('C');
    const s1 = snapshot(layout);
    expect(s1.fx[C]).toBe(0);
    expect(s1.fy[C]).toBe(0);
    // 成员在容器内换个位置：容器仍不受力（无力作用，也无反作用）。
    layout.setNodePosition('only', 60, -50);
    const s2 = snapshot(layout);
    expect(s2.fx[C]).toBe(0);
    expect(s2.fy[C]).toBe(0);
  });

  it('跨世界连线提升：弹力作用于容器本体与外部，成员不受力', () => {
    const graph: GraphSpec = {
      nodes: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      edges: [{ source: 'a', target: 'b' }],
      subgraphs: [
        { id: 'C', shape: { kind: 'rect', w: 300, h: 300 }, label: 'C', members: ['a'] },
      ],
    };
    const layout = new ForceLayout(graph, PARAMS);
    const a = storeOf(layout).indexOf('a');
    const b = storeOf(layout).indexOf('b');
    const C = storeOf(layout).indexOf('C');
    const s = snapshot(layout);
    // 成员 a：世界内无边无邻居，跨世界弹力已提升 → 完全不受力。
    expect(s.fx[a]).toBe(0);
    expect(s.fy[a]).toBe(0);
    // 容器 C 与外部 b 之间有弹力（提升边）。
    expect(Math.abs(s.fx[C]) + Math.abs(s.fy[C])).toBeGreaterThan(0);
    expect(Math.abs(s.fx[b]) + Math.abs(s.fy[b])).toBeGreaterThan(0);
  });

  it('groups 图收敛后成员落在容器声明矩形内', () => {
    const graph: GraphSpec = {
      nodes: [
        { id: 'in-a', label: 'in-a' },
        { id: 'in-b', label: 'in-b' },
        { id: 'in-c', label: 'in-c' },
        { id: 'ext-1', label: 'ext-1' },
        { id: 'ext-2', label: 'ext-2' },
      ],
      edges: [
        { source: 'in-a', target: 'in-b' },
        { source: 'in-b', target: 'in-c' },
        { source: 'sub', target: 'ext-1' },
        { source: 'ext-2', target: 'sub' },
        { source: 'ext-1', target: 'in-b' },
      ],
      subgraphs: [
        {
          id: 'sub',
          shape: { kind: 'rect', w: 380, h: 280 },
          label: '子图',
          members: ['in-a', 'in-b', 'in-c'],
        },
      ],
    };
    const layout = new ForceLayout(graph, { ...PARAMS, direction: 'TB' as never });
    layout.run();
    const pos = idPos(layout);
    const sub = pos.get('sub')!;
    for (const id of ['in-a', 'in-b', 'in-c']) {
      const n = pos.get(id)!;
      const dx = Math.abs(n.x - sub.x);
      const dy = Math.abs(n.y - sub.y);
      expect(dx, `${id} 水平偏移 ${dx}`).toBeLessThanOrEqual(190);
      expect(dy, `${id} 垂直偏移 ${dy}`).toBeLessThanOrEqual(140);
    }
  });

  it('逐帧模式：step() 驱动收敛后成员对齐容器（demo 动画路径）', () => {
    const layout = new ForceLayout(worldGraph(), PARAMS);
    let guard = 20000;
    while (!layout.converged && guard-- > 0) layout.step();
    expect(layout.converged).toBe(true);
    const pos = idPos(layout);
    const c = pos.get('C')!;
    for (const id of ['m1', 'm2']) {
      const n = pos.get(id)!;
      expect(Math.abs(n.x - c.x), `${id} 相对容器水平偏移`).toBeLessThanOrEqual(150);
      expect(Math.abs(n.y - c.y), `${id} 相对容器垂直偏移`).toBeLessThanOrEqual(150);
    }
  });

  it('mermaidSub 架构图收敛后 4 容器成员全部在声明矩形内', () => {
    const graph: GraphSpec = {
      nodes: [
        { id: 'CORE', label: 'ui-core' },
        { id: 'EVENT', label: 'ui-event' },
        { id: 'I18N', label: 'ui-i18n' },
        { id: 'THEME', label: 'ui-theme' },
        { id: 'BASE', label: 'ui-base' },
        { id: 'BUSINESS', label: 'ui-business' },
        { id: 'PROJECT', label: 'ui-project' },
        { id: 'PNPM', label: 'pnpm workspace' },
        { id: 'REG', label: 'registry' },
        { id: 'WEB', label: 'Web' },
        { id: 'ANDROID', label: 'Android' },
        { id: 'OTHER', label: 'Other' },
      ],
      edges: [
        { source: 'CORE', target: 'BASE' },
        { source: 'EVENT', target: 'BASE' },
        { source: 'I18N', target: 'BASE' },
        { source: 'THEME', target: 'BASE' },
        { source: 'BASE', target: 'BUSINESS' },
        { source: 'BUSINESS', target: 'PROJECT' },
        { source: 'PNPM', target: 'CORE' },
        { source: 'PNPM', target: 'BASE' },
        { source: 'PNPM', target: 'BUSINESS' },
        { source: 'PNPM', target: 'PROJECT' },
        { source: 'BASE', target: 'REG' },
        { source: 'BUSINESS', target: 'REG' },
        { source: 'REG', target: 'WEB' },
        { source: 'REG', target: 'ANDROID' },
        { source: 'REG', target: 'OTHER' },
      ],
      subgraphs: [
        {
          id: 'SOURCE',
          shape: { kind: 'rect', w: 1500, h: 950 },
          label: '源码层',
          members: ['CORE', 'EVENT', 'I18N', 'THEME', 'BASE', 'BUSINESS', 'PROJECT'],
        },
        { id: 'DEV', shape: { kind: 'rect', w: 340, h: 220 }, label: '开发协作层', members: ['PNPM'] },
        { id: 'REPO', shape: { kind: 'rect', w: 380, h: 240 }, label: '制品层', members: ['REG'] },
        {
          id: 'CONSUMER',
          shape: { kind: 'rect', w: 760, h: 460 },
          label: '消费层',
          members: ['WEB', 'ANDROID', 'OTHER'],
        },
      ],
    };
    const layout = new ForceLayout(graph, PARAMS);
    layout.run();
    const pos = idPos(layout);
    const boxes: Record<string, { hw: number; hh: number; members: string[] }> = {
      SOURCE: { hw: 750, hh: 475, members: ['CORE', 'EVENT', 'I18N', 'THEME', 'BASE', 'BUSINESS', 'PROJECT'] },
      DEV: { hw: 170, hh: 110, members: ['PNPM'] },
      REPO: { hw: 190, hh: 120, members: ['REG'] },
      CONSUMER: { hw: 380, hh: 230, members: ['WEB', 'ANDROID', 'OTHER'] },
    };
    for (const [cid, box] of Object.entries(boxes)) {
      const c = pos.get(cid)!;
      for (const m of box.members) {
        const n = pos.get(m)!;
        const dx = Math.abs(n.x - c.x);
        const dy = Math.abs(n.y - c.y);
        expect(dx, `${m} 相对 ${cid} 水平偏移 ${dx}`).toBeLessThanOrEqual(box.hw);
        expect(dy, `${m} 相对 ${cid} 垂直偏移 ${dy}`).toBeLessThanOrEqual(box.hh);
      }
    }
  });

  it('确定性：同图同参两次布局逐位一致', () => {
    const a = new ForceLayout(worldGraph(), PARAMS);
    const b = new ForceLayout(worldGraph(), PARAMS);
    a.run();
    b.run();
    for (const va of a.nodeViews) {
      const vb = b.nodeViews.find((v) => v.id === va.id)!;
      expect(va.x).toBe(vb.x);
      expect(va.y).toBe(vb.y);
    }
  });
});

describe('force-undirected 弛豫边界钳制（交互拖拽连带场景）', () => {
  /** 成员是否完全落在所属容器边界内（含有效半径 margin）。 */
  function insideBox(l: ForceLayout, id: ElementId): boolean {
    const hub = l.containerOf(id)!;
    const v = l.nodeViews.find((n) => n.id === id)!;
    const s = shapeSdf(hub.shape, v.x - hub.x, v.y - hub.y);
    return s.dist <= -v.r + 1e-6;
  }

  it('拖拽贴边的成员固定后，其余成员每步弛豫都被压回容器内', () => {
    const layout = new ForceLayout(worldGraph(), PARAMS);
    layout.setNodePosition('C', 0, 0);
    const box = layout.subgraphViews.find((v) => v.id === 'C')!;
    const hw = (box.shape as { kind: 'rect'; w: number }).w / 2;
    const m1 = layout.nodeViews.find((v) => v.id === 'm1')!;
    // 模拟拖拽：m1 固定在左边界贴边点；m2 位于容器外、与 m1 距 36 < L，
    // 边弹力与斥力同向把 m2 继续往外推（修复前持续出界）。
    layout.setNodePosition('m1', box.x - hw + m1.r, 0);
    layout.fix('m1');
    layout.setNodePosition('m2', box.x - hw - 36, 0);
    let guard = 60;
    while (!layout.converged && guard-- > 0) {
      layout.step();
      expect(insideBox(layout, 'm2'), `step 后 m2 应在容器内（残余 guard=${guard}）`).toBe(true);
    }
    expect(insideBox(layout, 'm2')).toBe(true);
  });

  it('收敛终态：成员全部落在容器边界内（对齐后钳制兜底）', () => {
    const layout = new ForceLayout(worldGraph(), PARAMS);
    layout.run();
    for (const id of ['m1', 'm2']) {
      expect(insideBox(layout, id), `${id} 终态应在容器边界内`).toBe(true);
    }
  });
});
