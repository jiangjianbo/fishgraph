import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import type { GraphSpec } from '../src/types.js';
import { estimateLabelBox } from '../src/label.js';

const CELL = 100; // naturalLength 即格距

/** 无向链图。 */
function chain(n: number): GraphSpec {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: i })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ source: i, target: i + 1 })),
  };
}

/** 节点视图的物理 AABB（左上角 + 宽高）。 */
function aabb(nv: { x: number; y: number; w?: number; h?: number }) {
  return { x: nv.x - nv.w! / 2, y: nv.y - nv.h! / 2, width: nv.w!, height: nv.h! };
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('grid-undirected（grid-first 纯网格流水线）', () => {
  it('注册为可切换策略；run 即完成（零迭代收敛）', () => {
    const layout = new ForceLayout(chain(4), {
      algorithm: 'grid-undirected',
      naturalLength: CELL,
      labelCollision: false,
    });
    expect(layout.strategyName).toBe('grid-undirected');
    const r = layout.run();
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
    expect(layout.converged).toBe(true);
  });

  it('网格解成行成列：节点中心坐标差为格宽整数倍，且物化 w/h', () => {
    const layout = new ForceLayout(chain(5), {
      algorithm: 'grid-undirected',
      naturalLength: CELL,
      labelCollision: false,
    });
    layout.run();
    const nv = [...layout.nodeViews];
    for (const v of nv) {
      expect(v.w).toBeGreaterThan(0);
      expect(v.h).toBeGreaterThan(0);
    }
    for (let i = 0; i + 1 < nv.length; i++) {
      // 无文字默认圆（r=10 → 20px ≤ 1 格）：全为 1×1 格，中心差恰 = 格距
      const dx = Math.abs(nv[i]!.x - nv[i + 1]!.x);
      const dy = Math.abs(nv[i]!.y - nv[i + 1]!.y);
      const gx = dx / CELL;
      const gy = dy / CELL;
      expect(Math.abs(gx - Math.round(gx))).toBeLessThan(1e-9);
      expect(Math.abs(gy - Math.round(gy))).toBeLessThan(1e-9);
    }
  });

  it('全部节点 AABB 两两无重叠（含文字物化节点）', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'a', label: '开始' },
        { id: 'b', label: '处理 very long label text' },
        { id: 'c' },
        { id: 'd', label: '结束节点' },
        { id: 'e' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'e' },
        { source: 'd', target: 'e' },
      ],
    };
    const layout = new ForceLayout(spec, {
      algorithm: 'grid-undirected',
      naturalLength: CELL,
    });
    layout.run();
    const boxes = [...layout.nodeViews].map(aabb);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it('文字物化：带文字节点的 AABB 覆盖文字盒（格化向上取整）', () => {
    const layout = new ForceLayout(
      { nodes: [{ id: 0, label: '字'.repeat(40) }, { id: 1 }], edges: [{ source: 0, target: 1 }] },
      { algorithm: 'grid-undirected', naturalLength: CELL },
    );
    layout.run();
    const [a] = layout.nodeViews;
    const box = estimateLabelBox('字'.repeat(40), 12, 4);
    expect(a!.w! / CELL).toBeGreaterThanOrEqual((2 * box.hw) / CELL - 1e-9);
    expect(a!.w! * a!.h!).toBeGreaterThanOrEqual(2 * box.hw * 2 * box.hh - 1e-9);
    // 默认圆节点保持 1 格
    const b = [...layout.nodeViews][1]!;
    expect(b.w!).toBeCloseTo(CELL, 9);
  });

  it('通道约束压实：同行相邻节点间空隙恰为 channelMargin 格（默认 1，可调）', () => {
    const run = (margin: number) => {
      const layout = new ForceLayout(chain(4), {
        algorithm: 'grid-undirected',
        naturalLength: CELL,
        labelCollision: false,
        channelMargin: margin,
      });
      layout.run();
      return [...layout.nodeViews];
    };
    // 同一行带（y 相同）上找相邻对，断言物理空隙 = margin × 格距
    for (const margin of [0, 1, 3]) {
      const nv = run(margin);
      const rows = new Map<number, typeof nv>();
      for (const v of nv) {
        const key = Math.round(v.y);
        rows.set(key, [...(rows.get(key) ?? []), v]);
      }
      let pairs = 0;
      for (const row of rows.values()) {
        row.sort((p, q) => p.x - q.x);
        for (let i = 0; i + 1 < row.length; i++) {
          const gap = row[i + 1]!.x - row[i + 1]!.w! / 2 - (row[i]!.x + row[i]!.w! / 2);
          expect(Math.abs(gap - margin * CELL)).toBeLessThan(1e-9);
          pairs++;
        }
      }
      expect(pairs).toBeGreaterThan(0);
    }
  });

  it('膨胀推挤：大文字节点扩张时把邻居整体推开且不重叠', () => {
    const layout = new ForceLayout(
      {
        nodes: [{ id: 0, label: '字'.repeat(40) }, { id: 1 }, { id: 2 }],
        edges: [
          { source: 0, target: 1 },
          { source: 1, target: 2 },
        ],
      },
      { algorithm: 'grid-undirected', naturalLength: CELL, channelMargin: 1 },
    );
    layout.run();
    const [a, b] = [...layout.nodeViews].map(aabb);
    expect(overlaps(a, b)).toBe(false);
  });

  it('A* 走线：每条边有正交 waypoints，首尾为两端中心，不穿第三方 AABB', () => {
    const spec: GraphSpec = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      edges: [
        { source: 'a', target: 'd' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
        { source: 'a', target: 'b' },
      ],
    };
    const layout = new ForceLayout(spec, {
      algorithm: 'grid-undirected',
      naturalLength: CELL,
      channelMargin: 2,
    });
    layout.run();
    const views = [...layout.nodeViews];
    const boxes = views.map(aabb);
    const byId = new Map(views.map((v) => [v.id, v]));

    for (const ev of layout.edgeViews) {
      const wp = ev.waypoints!;
      expect(wp).toBeDefined();
      expect(wp.length).toBeGreaterThanOrEqual(2);
      const s = byId.get(views[ev.sourceIndex]!.id)!;
      const t = byId.get(views[ev.targetIndex]!.id)!;
      expect(wp[0]!.x).toBeCloseTo(s.x, 9);
      expect(wp[0]!.y).toBeCloseTo(s.y, 9);
      expect(wp[wp.length - 1]!.x).toBeCloseTo(t.x, 9);
      expect(wp[wp.length - 1]!.y).toBeCloseTo(t.y, 9);
      // 正交折线：相邻拐点共享 x 或 y
      for (let i = 1; i < wp.length; i++) {
        expect(wp[i]!.x === wp[i - 1]!.x || wp[i]!.y === wp[i - 1]!.y).toBe(true);
      }
      // 路径中段不穿第三方节点 AABB（首尾段连接两端中心，允许离开自身包围盒）
      for (let i = 1; i < wp.length - 1; i++) {
        for (let j = 0; j < boxes.length; j++) {
          const isEndpointBox = boxes[j] === aabb(s) || boxes[j] === aabb(t);
          if (isEndpointBox) continue;
          const p = wp[i]!;
          const bx = boxes[j]!;
          const inside =
            p.x > bx.x && p.x < bx.x + bx.width && p.y > bx.y && p.y < bx.y + bx.height;
          expect(inside).toBe(false);
        }
      }
    }
  });

  it('确定性：同图同参两次布局逐位一致', () => {
    const run = () => {
      const layout = new ForceLayout(chain(6), {
        algorithm: 'grid-undirected',
        naturalLength: CELL,
        channelMargin: 2,
      });
      layout.run();
      return {
        pos: layout.positions,
        wp: [...layout.edgeViews].map((e) => e.waypoints?.map((p) => [p.x, p.y])),
      };
    };
    const r1 = run();
    const r2 = run();
    expect(r2.pos).toEqual(r1.pos);
    expect(r2.wp).toEqual(r1.wp);
  });

  it('图结构变化后 rebuild 重放整条流水线', () => {
    const layout = new ForceLayout(chain(3), {
      algorithm: 'grid-undirected',
      naturalLength: CELL,
    });
    layout.run();
    layout.addNode({ id: 3 });
    layout.addEdge({ source: 2, target: 3 });
    layout.run();
    expect([...layout.nodeViews]).toHaveLength(4);
    expect([...layout.edgeViews]).toHaveLength(3);
    for (const v of layout.nodeViews) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    }
  });
});
