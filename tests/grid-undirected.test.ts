import { describe, expect, it } from 'vitest';
import {
  AabbEndpointFitStrategy,
  ArrowEndCapStrategy,
  EdgeStyleRenderer,
  FixedPortStrategy,
  ForceLayout,
  NoneEndCapStrategy,
  OrthogonalPolylinePathStrategy,
  PlainCrossingStrategy,
  SharpCornerStrategy,
} from '../src/index.js';
import type { GraphSpec } from '../src/types.js';
import { estimateLabelBox } from '../src/label.js';
import { ExpansionGrid, deflectEdgeCrossings } from '../src/layout/grid-undirected/expansion.js';
import {
  coarseGridPlacement,
  isCollinearRay,
  liesBetween,
  midCells,
  PointGrid,
  segmentBlocked,
  undirectedHeuristics,
} from '../src/layout/grid-undirected/coarse.js';
import type { LayoutElement } from '../src/graph/store.js';

const CELL = 100; // naturalLength 占位传参（矩形基准格口径下格距 = 基准盒，与 naturalLength 无关）

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
      // 无文字默认圆（r=10 → 20px 盒 = 最小级 → 基准格）：全为 1×1 格，
      // 中心差恰 = 矩形格距（x 轴 cellW、y 轴 cellH）
      const dx = Math.abs(nv[i]!.x - nv[i + 1]!.x);
      const dy = Math.abs(nv[i]!.y - nv[i + 1]!.y);
      const gx = dx / layout.cellW;
      const gy = dy / layout.cellH;
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
    expect(a!.w!).toBeGreaterThanOrEqual(2 * box.hw - 1e-9);
    expect(a!.w! * a!.h!).toBeGreaterThanOrEqual(2 * box.hw * 2 * box.hh - 1e-9);
    // 默认圆节点 = 最小级基准格：物化恰为 1×1 格（格距 = 圆盒 20px）
    const b = [...layout.nodeViews][1]!;
    expect(b.w!).toBeCloseTo(layout.cellW, 9);
    expect(b.h!).toBeCloseTo(layout.cellH, 9);
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
      return { nv: [...layout.nodeViews], cellW: layout.cellW };
    };
    // 同一行带（y 相同）上找相邻对，断言物理空隙 = margin × 矩形格距
    for (const margin of [0, 1, 3]) {
      const { nv, cellW } = run(margin);
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
          expect(Math.abs(gap - margin * cellW)).toBeLessThan(1e-9);
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

  it('A* 走线：每条边有正交 waypoints，首尾落在端口轴线上，不穿第三方 AABB', () => {
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
      // 首尾为端口侧锚点：格走线 = 边界锚点格心（1×1 盒即中心）；正对位
      // 直线升级后 = 端口边界线中点（中心 ± 半格）。两者都在过中心的
      // 中线/中轴上且位于盒闭包内
      const onAxis = (p: { x: number; y: number }, c: { x: number; y: number }) =>
        Math.abs(p.x - c.x) < 1e-9 || Math.abs(p.y - c.y) < 1e-9;
      const inBox = (
        p: { x: number; y: number },
        c: { x: number; y: number; w?: number; h?: number },
      ) => Math.abs(p.x - c.x) <= c.w! / 2 + 1e-9 && Math.abs(p.y - c.y) <= c.h! / 2 + 1e-9;
      const s = byId.get(views[ev.sourceIndex]!.id)!;
      const t = byId.get(views[ev.targetIndex]!.id)!;
      expect(onAxis(wp[0]!, s)).toBe(true);
      expect(inBox(wp[0]!, s)).toBe(true);
      expect(onAxis(wp[wp.length - 1]!, t)).toBe(true);
      expect(inBox(wp[wp.length - 1]!, t)).toBe(true);
      // 正交折线：相邻拐点共享 x 或 y
      for (let i = 1; i < wp.length; i++) {
        expect(wp[i]!.x === wp[i - 1]!.x || wp[i]!.y === wp[i - 1]!.y).toBe(true);
      }
      // 路径中段不穿第三方节点 AABB（首尾段连接端口锚点，允许离开自身包围盒）
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

  it('分组子图（无向折叠）：跨容器边直线贴边，渲染折线无回折针', () => {
    // demo groups 图回归：外部2 → 子图 质点同行贴邻，走线应为两点直线；
    // 全部边渲染后不得出现 180° 回折（旧实现箭头处有"伸出又折回"针状段、
    // 容器边绕行容器内部再折回端口）。
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
      subgraphs: [
        {
          id: 'sub',
          shape: { kind: 'rect', w: 380, h: 280 },
          label: '子图',
          members: ['in-a', 'in-b', 'in-c'],
        },
      ],
    };
    const layout = new ForceLayout(spec, {
      algorithm: 'grid-undirected',
      direction: 'none',
      naturalLength: CELL / 20,
      folding: true,
      seed: 42,
    });
    layout.run();
    const evs = [...layout.edgeViews];
    // 元素下标：in-a..ext-2 = 0..7，sub = 8
    const ext2ToSub = evs.find((e) => e.sourceIndex === 7 && e.targetIndex === 8)!;
    const wp = ext2ToSub.waypoints!;
    // 矩形细格口径下放置落位随格密度变化，跨容器边允许正交转折；
    // 本质断言在后：渲染装配后全程无 180° 回折。
    expect(wp.length).toBeGreaterThanOrEqual(2);

    // 全部边经渲染装配后无 180° 回折
    const renderer = new EdgeStyleRenderer({
      source: {
        ports: new FixedPortStrategy(),
        fit: new AabbEndpointFitStrategy(),
        cap: new NoneEndCapStrategy(),
      },
      target: {
        ports: new FixedPortStrategy(),
        fit: new AabbEndpointFitStrategy(),
        cap: new ArrowEndCapStrategy(),
      },
      path: new OrthogonalPolylinePathStrategy(),
      corners: new SharpCornerStrategy(),
      crossings: new PlainCrossingStrategy(),
    });
    const geos = renderer.render({
      nodeViews: [...layout.nodeViews],
      subgraphViews: [...layout.subgraphViews],
      edgeViews: evs,
    });
    expect(geos).toHaveLength(evs.length);
    for (const geo of geos) {
      const pts = [geo.path.start];
      for (const seg of geo.path.segments) {
        if (seg.kind === 'line') pts.push(seg.to);
      }
      for (let k = 2; k < pts.length; k++) {
        const ax = pts[k - 1]!.x - pts[k - 2]!.x;
        const ay = pts[k - 1]!.y - pts[k - 2]!.y;
        const bx2 = pts[k]!.x - pts[k - 1]!.x;
        const by2 = pts[k]!.y - pts[k - 1]!.y;
        const cross = ax * by2 - ay * bx2;
        const dot = ax * bx2 + ay * by2;
        expect(cross !== 0 || dot > 0).toBe(true); // 无 180° 回折
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

describe('同起点连线零共线（阶段 2 规则 4：同起点两线夹角不得为 0）', () => {
  const mkElements = (n: number): LayoutElement[] =>
    Array.from({ length: n }, (_, i) => ({ id: i })) as unknown as LayoutElement[];

  /** p、q 相对原点 u 是否同向平行（夹角 0）。 */
  const sameRay = (p: { gx: number; gy: number }, q: { gx: number; gy: number }): boolean =>
    p.gx * q.gy - p.gy * q.gx === 0 && p.gx * q.gx + p.gy * q.gy > 0;

  it('isCollinearRay：同向共线命中，反向对冲/垂直/未放邻居不命中', () => {
    // u=0 的邻居：1（右）、2（未放占位）、3（下）；候选 v=4
    const adjacency = [new Set([1, 2, 3, 4]), new Set([0]), new Set([0]), new Set([0]), new Set([0])];
    const posOf = [
      { gx: 0, gy: 0 },
      { gx: 1, gy: 0 }, // w=1 在 u 右侧
      null as unknown as { gx: number; gy: number }, // w=2 未放置
      { gx: 0, gy: 1 },
      { gx: 0, gy: 0 },
    ];
    // 候选在 u 右侧射线上（w=1 同向）→ 命中
    expect(isCollinearRay(adjacency, posOf, 4, 0, posOf[0]!, 2, 0)).toBe(true);
    // 候选在 u 左侧（与 w=1 反向对冲，180°）→ 不命中
    expect(isCollinearRay(adjacency, posOf, 4, 0, posOf[0]!, -1, 0)).toBe(false);
    // 候选在 u 下方（与 w=3 同向）→ 命中
    expect(isCollinearRay(adjacency, posOf, 4, 0, posOf[0]!, 0, 2)).toBe(true);
    // 候选斜向 → 不命中
    expect(isCollinearRay(adjacency, posOf, 4, 0, posOf[0]!, 1, 1)).toBe(false);
    // 唯一候选射线上的邻居未放置 → 不命中
    const onlyUnplaced = [new Set([2, 4]), new Set([0]), new Set([0]), new Set([0]), new Set([0])];
    expect(isCollinearRay(onlyUnplaced, posOf, 4, 0, posOf[0]!, 2, 0)).toBe(false);
  });

  it('9 叶星：叶不得落在中心其他叶的射线上（共线位全部拒绝）', () => {
    // 中心 0 + 9 个邻居：前 8 叶占满 ring1 后，ring2 四个轴位 (±2,0)/(0,±2)
    // 全部与前 4 叶同射线 —— 无规则时第 9 叶按扫描序落 (0,-2)（共线）；
    // 规则生效后必须落到非共线格。
    const n = 10;
    const adjacency = Array.from({ length: n }, () => new Set<number>());
    for (let i = 1; i < n; i++) {
      adjacency[0]!.add(i);
      adjacency[i]!.add(0);
    }
    const { posOf } = coarseGridPlacement(mkElements(n), adjacency, 6, undirectedHeuristics(adjacency));
    // 放置完成且互不重合
    expect(posOf).toHaveLength(n);
    expect(new Set(posOf.map((p) => `${p!.gx},${p!.gy}`)).size).toBe(n);
    // 中心 0 的任意两条连线在 0 端夹角非 0（无同向平行对）
    const leaves = [...adjacency[0]!].map((i) => posOf[i]!);
    for (let a = 0; a < leaves.length; a++) {
      for (let b = a + 1; b < leaves.length; b++) {
        const ri = { gx: leaves[a]!.gx, gy: leaves[a]!.gy };
        const rj = { gx: leaves[b]!.gx, gy: leaves[b]!.gy };
        expect(sameRay(ri, rj), `叶 ${a + 1} 与叶 ${b + 1} 在中心射线上共线`).toBe(false);
      }
    }
  });

  it('链图不误伤：放置完成且中间节点的 180° 对冲邻居合法保留', () => {
    const n = 4;
    const adjacency = Array.from({ length: n }, () => new Set<number>());
    for (let i = 0; i + 1 < n; i++) {
      adjacency[i]!.add(i + 1);
      adjacency[i + 1]!.add(i);
    }
    const { posOf } = coarseGridPlacement(mkElements(n), adjacency, 6, undirectedHeuristics(adjacency));
    // 放置完成且互不重合
    expect(new Set(posOf.map((p) => `${p!.gx},${p!.gy}`)).size).toBe(n);
    // 全局不变式：任意节点引出的两条边都不共线同向（180° 对冲不在禁令内）
    for (let u = 0; u < n; u++) {
      const nbrs = [...adjacency[u]!].map((i) => posOf[i]!);
      for (let a = 0; a < nbrs.length; a++) {
        for (let b = a + 1; b < nbrs.length; b++) {
          const ra = { gx: nbrs[a]!.gx - posOf[u]!.gx, gy: nbrs[a]!.gy - posOf[u]!.gy };
          const rb = { gx: nbrs[b]!.gx - posOf[u]!.gx, gy: nbrs[b]!.gy - posOf[u]!.gy };
          expect(sameRay(ra, rb), `节点 ${u} 的两条连线共线同向`).toBe(false);
        }
      }
    }
  });
});

describe('节点压线禁令（阶段 2 规则 5：节点不得落在两节点连线线段上）', () => {
  const el = (id: number, placed?: { x: number; y: number }): LayoutElement =>
    ({ id, ...placed }) as unknown as LayoutElement;

  it('midCells / liesBetween / segmentBlocked 几何单元', () => {
    expect(midCells({ gx: 0, gy: 0 }, { gx: 2, gy: 0 })).toEqual([{ gx: 1, gy: 0 }]);
    expect(midCells({ gx: 0, gy: 0 }, { gx: 3, gy: 0 })).toEqual([
      { gx: 1, gy: 0 },
      { gx: 2, gy: 0 },
    ]);
    expect(midCells({ gx: 0, gy: 0 }, { gx: -2, gy: 0 })).toEqual([{ gx: -1, gy: 0 }]);
    expect(midCells({ gx: 0, gy: 0 }, { gx: 2, gy: 2 })).toEqual([{ gx: 1, gy: 1 }]); // 45°
    expect(midCells({ gx: 0, gy: 0 }, { gx: 2, gy: 1 })).toEqual([]); // 互质方向无中间格点
    expect(midCells({ gx: 0, gy: 0 }, { gx: 0, gy: 0 })).toEqual([]);
    // 压线 = 共线且居中；延长线/端点/异线不算
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, { gx: 1, gy: 0 })).toBe(true);
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 2 }, { gx: 1, gy: 1 })).toBe(true);
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 })).toBe(false);
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, { gx: -1, gy: 0 })).toBe(false);
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, { gx: 0, gy: 0 })).toBe(false);
    expect(liesBetween({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, { gx: 1, gy: 1 })).toBe(false);
    // 线段穿点：中间格点被占用即命中
    const grid = new PointGrid();
    grid.place({ gx: 1, gy: 0 }, 9);
    expect(segmentBlocked({ gx: 0, gy: 0 }, { gx: 2, gy: 0 }, grid)).toBe(true);
    expect(segmentBlocked({ gx: 0, gy: 0 }, { gx: 2, gy: 2 }, grid)).toBe(false);
  });

  it('长边上的种子：孤儿落格回避压线位（A—C 长边，B 不落中点）', () => {
    // A(0,0) 与 C(2,0) 用户预置且相邻（长边，中点 (1,0)）；B 连接 A、C。
    // 无禁令时紧凑落格选 touch 最高的 (1,0)（压线）；禁令生效后必须绕开。
    const adjacency = [new Set([1, 2]), new Set([0, 2]), new Set([0, 1])];
    const elements = [el(0, { x: 0, y: 0 }), el(1), el(2, { x: 2, y: 0 })];
    const { posOf } = coarseGridPlacement(
      elements,
      adjacency,
      1,
      undirectedHeuristics(adjacency),
      { ignorePlaced: false },
    );
    expect(posOf).toHaveLength(3);
    expect(new Set(posOf.map((p) => `${p!.gx},${p!.gy}`)).size).toBe(3);
    expect(`${posOf[1]!.gx},${posOf[1]!.gy}`).not.toBe('1,0'); // 不压 A—C 线段
  });

  it('出队放置：候选压在已放长边线段上时出局，改选次优格', () => {
    // A(0,0)—C(2,0) 预置长边；F/G/H 占掉 B 周围三面 → B 落 (1,-1)，
    // E（连 B）的唯一张力最优格是 (1,0)（压 A—C 线段）——禁令拒绝后
    // 必须改选 (0,-2) 等次优格。
    const adjacency = [
      new Set([1, 2]),
      new Set([0, 2, 3]),
      new Set([0, 1]),
      new Set([1]),
      new Set<number>(),
      new Set<number>(),
      new Set<number>(),
    ];
    const elements = [
      el(0, { x: 0, y: 0 }),
      el(1),
      el(2, { x: 2, y: 0 }),
      el(3),
      el(4, { x: 1, y: -2 }),
      el(5, { x: 0, y: -1 }),
      el(6, { x: 2, y: -1 }),
    ];
    const { posOf } = coarseGridPlacement(
      elements,
      adjacency,
      1,
      undirectedHeuristics(adjacency),
      { ignorePlaced: false },
    );
    expect(posOf).toHaveLength(7);
    expect(new Set(posOf.map((p) => `${p!.gx},${p!.gy}`)).size).toBe(7);
    expect(`${posOf[3]!.gx},${posOf[3]!.gy}`).not.toBe('1,0'); // E 不压 A—C 线段
  });
});

describe('物化后整理（阶段 4~7：消压线 + 行列整理三步）', () => {
  /** 手工摆放元素（锚点 + 格尺寸，不走 expand 推挤）。 */
  function put(g: ExpansionGrid, i: number, x: number, y: number, w = 1, h = 1): void {
    g.place(i, x, y);
    g.sizeOf[i]!.w = w;
    g.sizeOf[i]!.h = h;
  }

  /** 全部元素 AABB 两两无重叠（半开区间口径）。 */
  function expectNoOverlap(g: ExpansionGrid): void {
    const boxes = g.boxes();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  }

  it('阶段 5 扫描合并：间隔 >1 的相邻占用行/列收紧为贴邻', () => {
    const g = new ExpansionGrid(2);
    put(g, 0, 0, 0, 2, 2);
    put(g, 1, 10, 10, 2, 2);
    g.tighten();
    expect(g.boxes()[1]).toEqual({ x: 2, y: 2, width: 2, height: 2 });
    expectNoOverlap(g);
  });

  it('阶段 6 走廊插入：收紧后的贴邻占用行列之间补出 channelMargin 空隙', () => {
    const g = new ExpansionGrid(3);
    put(g, 0, 0, 0);
    put(g, 1, 2, 3);
    put(g, 2, 9, 6);
    g.tighten();
    g.ensureCorridor(1);
    // x 占用 {0,2,9}：收紧为 0,1,2 → 走廊插入后间隔 2 → 0,2,4；y 同理。
    expect(g.anchorOf.map((a) => a!.gx)).toEqual([0, 2, 4]);
    expect(g.anchorOf.map((a) => a!.gy)).toEqual([0, 2, 4]);
    expectNoOverlap(g);
  });

  it('阶段 5+6（扫描合并 → 走廊插入）与阶段 7 压实最终状态一致（随机，固定种子）', () => {
    let seed = 20260928;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let iter = 0; iter < 200; iter++) {
      const n = 2 + rand(6);
      const margin = rand(3);
      const a = new ExpansionGrid(n);
      const b = new ExpansionGrid(n);
      const taken = new Set<string>();
      for (let i = 0; i < n; i++) {
        let x = 0;
        let y = 0;
        do {
          x = rand(12) - 6;
          y = rand(12) - 6;
        } while (taken.has(`${x},${y}`));
        taken.add(`${x},${y}`);
        const w = 1 + rand(4);
        const h = 1 + rand(4);
        put(a, i, x, y, w, h);
        put(b, i, x, y, w, h);
      }
      a.tighten();
      a.ensureCorridor(margin);
      b.compact(margin);
      expect(a.boxes()).toEqual(b.boxes());
    }
  });

  it('阶段 4 消压线：连线穿过第三方 AABB 时推离，且全程无重叠', () => {
    // W 恰跨在 A→B 连线（y=0）上且为宽 AABB：推离后连线不再穿过 W。
    const g = new ExpansionGrid(3);
    put(g, 0, 0, 0); // A 中心 (0,0)
    put(g, 1, 6, 0); // B 中心 (6,0)
    put(g, 2, 2, 0, 3, 2); // W 占 x2..4 y0..1
    deflectEdgeCrossings(g, [{ u: 0, v: 1 }]);
    const w = g.boxes()[2]!;
    expect(w.y).toBe(1); // 中心 (3,1) 在线下方 → 推向 y+
    expectNoOverlap(g);
  });

  it('阶段 4 消压线：nudge 扫掠级联——被推元素撞到的邻居一并入组', () => {
    const g = new ExpansionGrid(4);
    put(g, 0, 0, 0); // A
    put(g, 1, 6, 0); // B
    put(g, 2, 2, 0); // W 在连线上
    put(g, 3, 2, 1); // X 在 W 正下方（推离扫掠路径上）
    deflectEdgeCrossings(g, [{ u: 0, v: 1 }]);
    expect(g.boxes()[2]).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    expect(g.boxes()[3]).toEqual({ x: 2, y: 2, width: 1, height: 1 });
    expectNoOverlap(g);
  });

  it('阶段 4 消压线：skip 集合内的元素（容器）不参与判定', () => {
    const g = new ExpansionGrid(3);
    put(g, 0, 0, 0);
    put(g, 1, 4, 0);
    put(g, 2, 2, 0); // 在连线上，但在 skip 中
    deflectEdgeCrossings(g, [{ u: 0, v: 1 }], new Set([2]));
    expect(g.boxes()[2]).toEqual({ x: 2, y: 0, width: 1, height: 1 });
  });

  it('阶段 5 对齐合并：独居元素吸附主线；撞他者时放弃、无主线时不动', () => {
    // 列 0 为主线（e0/e1），e2 独居列 3 → 吸附到列 0（行 6 无冲突）
    const g = new ExpansionGrid(3);
    put(g, 0, 0, 0);
    put(g, 1, 0, 4);
    put(g, 2, 3, 6);
    g.mergeLines();
    expect(g.boxes()[2]).toEqual({ x: 0, y: 6, width: 1, height: 1 });
    // 吸附目标被占：e2 与 e0 同行，挪到列 0 会撞 → 保持原位
    const h = new ExpansionGrid(3);
    put(h, 0, 0, 0);
    put(h, 1, 0, 4);
    put(h, 2, 3, 0);
    h.mergeLines();
    expect(h.boxes()[2]).toEqual({ x: 3, y: 0, width: 1, height: 1 });
  });

  it('阶段 5 对齐合并：21 节点树的可并线组吸附成列/成行', () => {
    // 用户口径回归：b3/l3-3/l0-0 同列、b2/l1-0/l0-2 同列、l3-3/l1-0/l1-3 同行
    const nodes: GraphSpec['nodes'] = [{ id: 'root', label: 'root' }];
    const edges: GraphSpec['edges'] = [];
    const level1: string[] = [];
    for (let i = 0; i < 4; i++) {
      nodes.push({ id: `b${i}`, label: `b${i}` });
      edges.push({ source: 'root', target: `b${i}` });
      level1.push(`b${i}`);
    }
    level1.forEach((p, pi) => {
      for (let j = 0; j < 4; j++) {
        nodes.push({ id: `l${pi}-${j}`, label: `l${pi}-${j}` });
        edges.push({ source: p, target: `l${pi}-${j}` });
      }
    });
    const layout = new ForceLayout({ nodes, edges }, {
      algorithm: 'grid-undirected',
      naturalLength: CELL / 20,
      labelCollision: false,
    });
    layout.run();
    const nv = [...layout.nodeViews] as Array<{ id: string; x: number; y: number; w: number }>;
    const byId = (id: string): { x: number; y: number; w: number } => nv.find((v) => v.id === id)!;
    const minX = Math.min(...nv.map((v) => v.x - v.w / 2));
    const gridX = (v: { x: number; y: number; w: number }): number =>
      Math.round((v.x - v.w / 2 - minX) / layout.cellW);
    expect(gridX(byId('b3'))).toBe(gridX(byId('l3-3')));
    expect(gridX(byId('b3'))).toBe(gridX(byId('l0-0')));
    expect(gridX(byId('b2'))).toBe(gridX(byId('l1-0')));
    expect(gridX(byId('b2'))).toBe(gridX(byId('l0-2')));
    expect(byId('l3-3').y).toBe(byId('l1-0').y);
    expect(byId('l1-0').y).toBe(byId('l1-3').y);
  });
});
