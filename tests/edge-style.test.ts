/**
 * 连线风格策略测试：端点对接 / 路径 / 转弯 / 交叉 四接缝独立可换。
 *
 * 覆盖角度：
 *  1. 端点对接：固定四点贴边界中点；同侧均匀分布按 slot 铺开
 *  2. 路径风格：直线单段；贝塞尔控制点沿端口法向；正交折线全程共轴；
 *     斜折线平行边分散不重叠
 *  3. 转弯风格：直角保留尖点；圆角切点落在本段上、弧半径受限
 *  4. 交叉风格：平交无跳线；立交在交点处插入跳线弧且路径首尾不变
 *  5. 装配器：EdgeStyleRenderer 端到端产出可绘制段（含箭头/标签锚点）
 */

import { describe, expect, it } from 'vitest';
import {
  BridgeCrossingStrategy,
  CubicBezierPathStrategy,
  DistributedPortStrategy,
  EdgeStyleRenderer,
  FixedPortStrategy,
  ObliqueDistributedPathStrategy,
  OrthogonalPolylinePathStrategy,
  PlainCrossingStrategy,
  RoundCornerStrategy,
  SharpCornerStrategy,
  StraightLinePathStrategy,
  dominantSide,
  endArrow,
  pathLength,
} from '../src/index.js';
import type { EdgeEndpointBox, EdgePath, EdgeRouteContext, Vec2 } from '../src/index.js';

const BOX: EdgeEndpointBox = { x: 0, y: 0, hw: 10, hh: 5 };

/** 正交折线路径的顶点序列（line 段逐个展开）。 */
function vertices(path: EdgePath): Vec2[] {
  const pts: Vec2[] = [path.start];
  for (const seg of path.segments) {
    if (seg.kind !== 'line') throw new Error('unexpected non-line segment');
    pts.push(seg.to);
  }
  return pts;
}

function routeCtx(partial: Partial<EdgeRouteContext>): EdgeRouteContext {
  return {
    source: { x: 0, y: 0, nx: 1, ny: 0 },
    target: { x: 40, y: 0, nx: -1, ny: 0 },
    sourceBox: { x: 0, y: 0, hw: 10, hh: 5 },
    targetBox: { x: 40, y: 0, hw: 10, hh: 5 },
    waypoints: [],
    bundle: { slot: 0, count: 1 },
    ...partial,
  };
}

describe('端点对接策略', () => {
  it('dominantSide：主导轴选侧，平局归水平轴', () => {
    expect(dominantSide(30, 1)).toBe('right');
    expect(dominantSide(-1, 30)).toBe('bottom');
    expect(dominantSide(0, -3)).toBe('top');
    expect(dominantSide(-30, -1)).toBe('left');
    expect(dominantSide(5, 5)).toBe('right'); // 平局归水平
  });

  it('固定四点：端口贴元素边界中点，法向指向离开元素', () => {
    const ports = new FixedPortStrategy();
    const right = ports.port(BOX, { x: 40, y: 0 }, 0, 1);
    expect([right.x, right.y, right.nx, right.ny]).toEqual([10, 0, 1, 0]);
    const top = ports.port(BOX, { x: 0, y: -40 }, 0, 1);
    expect([top.x, top.y, top.nx, top.ny]).toEqual([0, -5, 0, -1]);
  });

  it('同侧均匀分布：slot 0 在上端、slot 递增向下，slotCount=1 时居中', () => {
    const ports = new DistributedPortStrategy(0);
    const p0 = ports.port(BOX, { x: 40, y: 0 }, 0, 3);
    const p1 = ports.port(BOX, { x: 40, y: 0 }, 1, 3);
    const p2 = ports.port(BOX, { x: 40, y: 0 }, 2, 3);
    expect(p1.x).toBe(10); // 都在右边界上
    expect(p0.y).toBeLessThan(p1.y);
    expect(p1.y).toBeLessThan(p2.y);
    expect(p1.y).toBe(0); // 中位 slot 居中
    const solo = ports.port(BOX, { x: 40, y: 0 }, 0, 1);
    expect([solo.x, solo.y]).toEqual([10, 0]);
  });
});

describe('路径风格策略', () => {
  it('直线：端口直连单段', () => {
    const path = new StraightLinePathStrategy().route(routeCtx({}));
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0]).toMatchObject({ kind: 'line', to: { x: 40, y: 0 } });
  });

  it('贝塞尔：控制点沿两端端口外法向伸出', () => {
    const seg = new CubicBezierPathStrategy().route(routeCtx({})).segments[0]!;
    expect(seg.kind).toBe('bezier');
    if (seg.kind !== 'bezier') return;
    expect([seg.cp1.x, seg.cp1.y]).toEqual([14, 0]); // 0 + 40*0.35 沿右法向
    expect([seg.cp2.x, seg.cp2.y]).toEqual([26, 0]); // 40 - 40*0.35
  });

  it('正交折线：走线骨架保留，端口 breakout 后全程共轴', () => {
    const path = new OrthogonalPolylinePathStrategy().route(
      routeCtx({
        waypoints: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 30 },
          { x: 40, y: 30 },
        ],
      }),
    );
    const pts = vertices(path);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 0 });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      expect(a.x === b.x || a.y === b.y).toBe(true); // 每段正交
    }
    expect(pts.some((p) => p.y === 30)).toBe(true); // 经过走线骨架所在行
  });

  it('正交折线：裁掉走线骨架中处于两端 AABB 内部的段（不穿回节点）', () => {
    // 模拟 A* 输出：从 source 中心出发的前两格仍在 source AABB 内，
    // 末尾两格在 target AABB 内 —— 内部段必须被裁掉。
    const path = new OrthogonalPolylinePathStrategy().route(
      routeCtx({
        source: { x: 0, y: -12, nx: 0, ny: -1 },
        target: { x: 40, y: 52, nx: 0, ny: 1 },
        sourceBox: { x: 0, y: 0, hw: 12, hh: 12 },
        targetBox: { x: 40, y: 40, hw: 12, hh: 12 },
        waypoints: [
          { x: 0, y: 0 },
          { x: 0, y: 10 }, // source AABB 内部
          { x: 0, y: 30 }, // 外部（自由通道）
          { x: 40, y: 30 }, // 外部
          { x: 40, y: 34 }, // target AABB 内部
          { x: 40, y: 40 },
        ],
      }),
    );
    const pts = vertices(path);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
    // 端口 breakout 沿法向出盒；骨架内部点不得出现在路径中
    expect(pts[1]).toEqual({ x: 0, y: -18 });
    expect(pts.some((p) => p.x === 0 && p.y === 10)).toBe(false);
    expect(pts.some((p) => p.x === 40 && p.y === 34)).toBe(false);
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 52 });
  });

  it('斜折线分散：平行边沿法向错开、互不重叠', () => {
    const strategy = new ObliqueDistributedPathStrategy(10);
    const p0 = strategy.route(routeCtx({ bundle: { slot: 0, count: 2 } }));
    const p1 = strategy.route(routeCtx({ bundle: { slot: 1, count: 2 } }));
    const v0 = vertices(p0);
    const v1 = vertices(p1);
    expect(v0.length).toBe(v1.length);
    let minGap = Infinity;
    for (let i = 0; i < v0.length; i++) {
      const dx = v1[i]!.x - v0[i]!.x;
      const dy = v1[i]!.y - v0[i]!.y;
      minGap = Math.min(minGap, Math.hypot(dx, dy));
    }
    expect(minGap).toBeCloseTo(10); // 相邻平行边间距 = spacing
  });
});

describe('转弯风格策略', () => {
  const L: EdgePath = {
    start: { x: 0, y: 0 },
    segments: [{ kind: 'line', to: { x: 20, y: 0 } }, { kind: 'line', to: { x: 20, y: 20 } }],
  };

  it('直角：恒等变换（尖点保留）', () => {
    const out = new SharpCornerStrategy().apply(L);
    expect(out).toBe(L);
  });

  it('圆角：切点落在本段上，弧半径与切点距一致', () => {
    const out = new RoundCornerStrategy(5).apply(L);
    const arc = out.segments.find((s) => s.kind === 'arc');
    expect(arc).toBeDefined();
    if (arc?.kind !== 'arc') return;
    expect(arc.radius).toBe(5);
    // 圆心到两切点等距（相切）
    const ends: Vec2[] = [];
    let from = out.start;
    for (const s of out.segments) {
      if (s.kind === 'line') {
        ends.push(s.to);
        from = s.to;
      } else if (s.kind === 'arc') {
        ends.push(from, {
          x: s.center.x + s.radius * Math.cos(s.endAngle),
          y: s.center.y + s.radius * Math.sin(s.endAngle),
        });
        from = ends[ends.length - 1]!;
      }
    }
    const [t1, t2] = ends;
    expect(Math.hypot(t1!.x - arc.center.x, t1!.y - arc.center.y)).toBeCloseTo(5);
    expect(Math.hypot(t2!.x - arc.center.x, t2!.y - arc.center.y)).toBeCloseTo(5);
    // 路径首尾不变
    expect(out.start).toEqual(L.start);
    expect(pathLength(out)).toBeGreaterThan(30); // 弧替代尖点后总长仍接近 40
  });

  it('圆角半径超过半段长时被钳制，不会越过相邻拐点', () => {
    const short: EdgePath = {
      start: { x: 0, y: 0 },
      segments: [{ kind: 'line', to: { x: 4, y: 0 } }, { kind: 'line', to: { x: 4, y: 40 } }],
    };
    const out = new RoundCornerStrategy(50).apply(short);
    const arc = out.segments.find((s) => s.kind === 'arc');
    if (arc?.kind !== 'arc') throw new Error('expected arc');
    expect(arc.radius).toBe(2); // min(50, 4/2, 40/2)
  });
});

describe('交叉风格策略', () => {
  const H: EdgePath = {
    start: { x: -20, y: 0 },
    segments: [{ kind: 'line', to: { x: 20, y: 0 } }],
  };
  const V: EdgePath = {
    start: { x: 0, y: -20 },
    segments: [{ kind: 'line', to: { x: 0, y: 20 } }],
  };

  it('平交：无跳线弧，路径原样', () => {
    const out = new PlainCrossingStrategy().apply(V, [H]);
    expect(out.segments.every((s) => s.kind === 'line')).toBe(true);
  });

  it('立交：交点处断开并插入跳线弧，路径首尾不变', () => {
    const out = new BridgeCrossingStrategy(4).apply(V, [H]);
    const arcs = out.segments.filter((s) => s.kind === 'arc');
    expect(arcs).toHaveLength(1);
    expect(out.start).toEqual(V.start);
    // 末段终点仍为原终点
    const last = out.segments[out.segments.length - 1]!;
    expect(last.kind === 'line' && last.to.y === 20).toBe(true);
    // 弧圆心 = 交点 (0,0)
    if (arcs[0]?.kind !== 'arc') throw new Error('unreachable');
    expect([arcs[0].center.x, arcs[0].center.y]).toEqual([0, 0]);
    expect(arcs[0].radius).toBe(4);
    // 断开处两侧各让出 gap：直线净长 32 + 半圆周长
    expect(pathLength(out)).toBeCloseTo(32 + Math.PI * 4, 1);
  });

  it('立交：无交叉时路径不变', () => {
    const parallel: EdgePath = {
      start: { x: 30, y: -20 },
      segments: [{ kind: 'line', to: { x: 30, y: 20 } }],
    };
    const out = new BridgeCrossingStrategy(4).apply(parallel, [H]);
    expect(out.segments.filter((s) => s.kind === 'arc')).toHaveLength(0);
  });
});

describe('EdgeStyleRenderer 装配', () => {
  it('端到端：固定四点 + 正交折线产出可绘制段与箭头', () => {
    const renderer = new EdgeStyleRenderer({
      ports: new FixedPortStrategy(),
      path: new OrthogonalPolylinePathStrategy(),
      corners: new SharpCornerStrategy(),
      crossings: new PlainCrossingStrategy(),
    });
    // 两个 2 格 AABB 元素：(0,0) 与 (100,60)，中心间 L 形关系由调用方
    // 的 waypoints 模拟（真实布局中由走线层给出）
    const geos = renderer.render({
      nodeViews: [
        { x: 0, y: 0, shape: { kind: 'rect', w: 20, h: 20 }, r: 14, hw: 10, hh: 10, label: 'a' },
        { x: 100, y: 60, shape: { kind: 'rect', w: 20, h: 20 }, r: 14, hw: 10, hh: 10, label: 'b' },
      ] as never,
      subgraphViews: [],
      edgeViews: [
        {
          sourceIndex: 0,
          targetIndex: 1,
          label: '连接',
          labelHw: 10,
          labelHh: 6,
          waypoints: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 60 },
          ],
        },
      ],
    });
    expect(geos).toHaveLength(1);
    const geo = geos[0]!;
    expect(pathLength(geo.path)).toBeGreaterThan(150);
    // 端口贴元素边界（固定四点：对端主导轴为水平 → 左侧中点）
    expect(geo.path.start).toEqual({ x: 10, y: 0 });
    const arrow = endArrow(geo.path);
    expect(arrow.tip).toEqual({ x: 90, y: 60 });
    expect(geo.label).toBe('连接');
    expect(Number.isFinite(geo.labelAnchor.x)).toBe(true);
  });
});
