import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import type { GraphSpec } from '../src/types.js';
import { estimateLabelBox } from '../src/label.js';
import { ExpansionGrid } from '../src/layout/grid-undirected/expansion.js';

const CELL = 100; // 粗布局格胞 px 值（断言用）；naturalLength 以格数传入

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
      naturalLength: CELL / 20,
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
      naturalLength: CELL / 20,
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
      naturalLength: CELL / 20,
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
      { algorithm: 'grid-undirected', naturalLength: CELL / 20 },
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
        naturalLength: CELL / 20,
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
      { algorithm: 'grid-undirected', naturalLength: CELL / 20, channelMargin: 1 },
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
      naturalLength: CELL / 20,
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
        naturalLength: CELL / 20,
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
      naturalLength: CELL / 20,
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

  it('切换布局算法后旧策略产物（waypoints/物化 w/h）失效清除', () => {
    const layout = new ForceLayout(chain(5), {
      algorithm: 'grid-undirected',
      naturalLength: CELL / 20,
      labelCollision: false,
    });
    layout.run();
    expect(layout.edgeViews.length).toBeGreaterThan(0);
    expect(layout.edgeViews.every((e) => (e.waypoints?.length ?? 0) >= 2)).toBe(true);
    expect([...layout.nodeViews].every((v) => v.w !== undefined && v.h !== undefined)).toBe(true);
    // demo 的换算法路径（updateOptions）：旧拐点绑定旧坐标，必须作废；
    // 物化 w/h 同理，否则节点被画成旧网格矩形、fit 包围盒偏大
    layout.updateOptions({ algorithm: 'circle' });
    expect(layout.edgeViews.every((e) => e.waypoints === undefined)).toBe(true);
    expect([...layout.nodeViews].every((v) => v.w === undefined && v.h === undefined)).toBe(true);
    // setStrategy 路径同样清除
    layout.setStrategy('grid-undirected');
    layout.run();
    expect(layout.edgeViews.every((e) => (e.waypoints?.length ?? 0) >= 2)).toBe(true);
    expect([...layout.nodeViews].every((v) => v.w !== undefined && v.h !== undefined)).toBe(true);
    layout.setStrategy('circle');
    expect(layout.edgeViews.every((e) => e.waypoints === undefined)).toBe(true);
    expect([...layout.nodeViews].every((v) => v.w === undefined && v.h === undefined)).toBe(true);
  });
});

describe('ExpansionGrid 中心对称膨胀', () => {
  /** AABB 的格中心（物理中心 / 格宽）。 */
  const centerOf = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x + b.width / 2,
    y: b.y + b.height / 2,
  });

  it('奇数尺寸：质点格恰为 AABB 几何中心', () => {
    const g = new ExpansionGrid(1);
    g.place(0, 7, -3);
    g.expand(0, 5, 3);
    const [b] = g.boxes();
    expect(b).toEqual({ x: 7 - 2, y: -3 - 1, width: 5, height: 3 });
    expect(centerOf(b!)).toEqual({ x: 7.5, y: -2.5 }); // 质点格中心 (7+0.5, -3+0.5)
  });

  it('偶数尺寸：固定向左/上多配一格（半格配平），质点格保持为中心格', () => {
    const g = new ExpansionGrid(1);
    g.place(0, 0, 0);
    g.expand(0, 4, 2);
    const [b] = g.boxes();
    expect(b).toEqual({ x: -2, y: -1, width: 4, height: 2 });
    // 质点格 (0,0) 是两中间格的右/下格：物理中心差半格，格上无精确中心
    expect(centerOf(b!)).toEqual({ x: 0, y: 0 });
    // A* 中心格口径 b.x+⌊w/2⌋ 恒等于质点格
    expect(b!.x + Math.floor(b!.width / 2)).toBe(0);
    expect(b!.y + Math.floor(b!.height / 2)).toBe(0);
  });

  it('竖直相邻边在横向膨胀后保持竖直：质点为 AABB 中心', () => {
    const g = new ExpansionGrid(2);
    g.place(0, 0, 0); // A
    g.place(1, 0, 1); // B 在 A 正下方（粗布局竖直边）
    g.expand(1, 3, 1); // B 横向膨胀 3×1
    const [a, b] = g.boxes();
    expect(a).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(b).toEqual({ x: -1, y: 1, width: 3, height: 1 });
    expect(centerOf(b!).x).toBe(centerOf(a!).x); // 中心 x 对齐 → 边仍竖直
    expect(g.sizeOf[0]).toEqual({ w: 1, h: 1 });
  });

  it('膨胀推挤保序：四周邻居被插行/插列让位且 AABB 互不重叠', () => {
    const g = new ExpansionGrid(5);
    g.place(0, 0, 0); // 中心
    g.place(1, -3, 0); // 左
    g.place(2, 3, 0); // 右
    g.place(3, 0, -3); // 上
    g.place(4, 0, 3); // 下
    g.expand(0, 5, 5);
    const boxes = g.boxes();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
    // 中心 AABB 覆盖 [-2,3)×[-2,3)：质点格 (0,0) 为中心格
    expect(boxes[0]).toEqual({ x: -2, y: -2, width: 5, height: 5 });
  });

  it('带内推挤：向右扩张只推目标行带内的右侧元素，其他行不受扰动', () => {
    const g = new ExpansionGrid(3);
    g.place(0, 0, 0); // 中心
    g.place(1, 3, 0); // 右侧、与中心同行（行带内 → 被推）
    g.place(2, 3, 4); // 右侧、但在其他行（行带外 → 不动）
    g.expand(0, 3, 1); // 仅横向扩张，行带 = 第 0 行
    const boxes = g.boxes();
    expect(boxes[0]).toEqual({ x: -1, y: 0, width: 3, height: 1 });
    expect(boxes[1]).toEqual({ x: 4, y: 0, width: 1, height: 1 }); // 同行右邻让位
    expect(boxes[2]).toEqual({ x: 3, y: 4, width: 1, height: 1 }); // 异行右侧不连带
  });

  it('带内推挤级联：高元素被推时，其带外延展扫掠撞到的元素一并让位', () => {
    const g = new ExpansionGrid(4);
    g.place(0, 0, 0); // 中心
    g.place(1, 2, 0);
    g.expand(1, 1, 5); // 高元素：行 [-2,2] 的右侧立柱，跨越中心所在行
    g.place(2, 3, 2); // 立柱延展行上的右邻（扫掠路径上 → 级联入组）
    g.place(3, 3, 6); // 立柱行带外的右邻（扫掠不到 → 不动）
    g.expand(0, 3, 1); // 中心向右扩张 1 格，行带 = 第 0 行
    const boxes = g.boxes();
    expect(boxes[0]).toEqual({ x: -1, y: 0, width: 3, height: 1 });
    expect(boxes[1]).toEqual({ x: 3, y: -2, width: 1, height: 5 }); // 立柱被推
    expect(boxes[2]).toEqual({ x: 4, y: 2, width: 1, height: 1 }); // 延展行右邻级联
    expect(boxes[3]).toEqual({ x: 3, y: 6, width: 1, height: 1 }); // 带外不受扰动
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it('横跨锚点列的宽元素不属于任一侧：由垂直推挤整体让位，不被撕裂', () => {
    const g = new ExpansionGrid(2);
    g.place(0, 0, -1);
    g.expand(0, 7, 1); // 宽元素：列 [-3,3]，横跨原点正上方
    g.place(1, 0, 0); // 中心质点在宽元素正下方
    g.expand(1, 5, 5); // 中心膨胀 5×5，目标区含宽元素中段
    const boxes = g.boxes();
    // 宽元素不属左/右任一侧，水平推挤不动它；垂直推挤（列带相交且完全
    // 在上方）把它整体上推 —— AABB 保持 7×1 完整
    expect(boxes[0]).toEqual({ x: -3, y: -3, width: 7, height: 1 });
    expect(boxes[1]).toEqual({ x: -2, y: -2, width: 5, height: 5 });
  });

  it('随机场景：带内推挤 + 压实后全部 AABB 两两无重叠（固定种子）', () => {
    let seed = 20260927;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let iter = 0; iter < 300; iter++) {
      const n = 2 + rand(8);
      const g = new ExpansionGrid(n);
      const taken = new Set<string>();
      for (let i = 0; i < n; i++) {
        // 质点互不重合地随机放置（1×1 天然无重叠）
        let gx = 0;
        let gy = 0;
        do {
          gx = rand(15) - 7;
          gy = rand(15) - 7;
        } while (taken.has(`${gx},${gy}`));
        taken.add(`${gx},${gy}`);
        g.place(i, gx, gy);
      }
      for (let i = 0; i < n; i++) {
        g.expand(i, 1 + rand(5), 1 + rand(5));
      }
      g.compact(rand(3));
      const boxes = g.boxes();
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlap =
            a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
          if (overlap) {
            throw new Error(`iter ${iter}: boxes ${i} 与 ${j} 重叠：${JSON.stringify([a, b])}`);
          }
        }
      }
    }
  });
});
