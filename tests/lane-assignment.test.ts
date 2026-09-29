/**
 * 通道车道分配（阶段 8.5）与终点贴边段保障的回归测试。
 *
 * 覆盖五条布线需求中的三条核心：
 *  - 通道内平行走线等距分流、不重叠（共享一端的边倾向共用路径，
 *    两端都相同的边与无关边全程错开）；
 *  - 长线优先占中央车道、同边同通道位置固定；
 *  - 终点贴边段 ≥ 端帽长度（箭头之下有完整线体尾巴）且全折线保持正交。
 *
 * 单元层直接构造格骨架调 assignLanes（纯函数）；管线层跑真实布局验证
 * 集成后的正交性 / 无回折 / 确定性 / 偏移真实发生。
 */
import { describe, expect, it } from 'vitest';
import {
  AabbEndpointFitStrategy,
  EdgeStyleRenderer,
  FixedPortStrategy,
  ForceLayout,
  NoneEndCapStrategy,
  OrthogonalPolylinePathStrategy,
  PlainCrossingStrategy,
  SharpCornerStrategy,
} from '../src/index.js';
import type { EdgePath, EdgeRouteContext, ShapeSpec, Vec2 } from '../src/index.js';
import { assignLanes, compressCorners } from '../src/layout/grid-undirected/lane.js';
import type { LayoutRoute } from '../src/layout/metric/types.js';
import type { Box, Point } from '../src/layout/grid-undirected/space-types.js';
import { GRAPHS } from '../demo/graphs.js';

/** 正交拐点序列 → 逐格格骨架（与 A* 输出同构）。 */
function expand(waypoints: Array<[number, number]>): Point[] {
  const cells: Point[] = [];
  waypoints.forEach(([x, y], i) => {
    if (i === 0) {
      cells.push({ x, y });
      return;
    }
    const [px, py] = waypoints[i - 1]!;
    const sx = Math.sign(x - px);
    const sy = Math.sign(y - py);
    let cx = px;
    let cy = py;
    while (cx !== x || cy !== y) {
      cx += sx;
      cy += sy;
      cells.push({ x: cx, y: cy });
    }
  });
  return cells;
}

function routeOf(waypoints: Array<[number, number]>, source = 0, target = 1): LayoutRoute {
  return { source, target, cells: expand(waypoints) };
}

/** 折线段单轴 + 无 180° 回折断言。 */
function expectOrthogonalNoFoldback(pts: Vec2[], tag: string): void {
  for (let k = 1; k < pts.length; k++) {
    const ax = pts[k]!.x - pts[k - 1]!.x;
    const ay = pts[k]!.y - pts[k - 1]!.y;
    expect(ax === 0 || ay === 0, `${tag} 段 ${k} 非正交`).toBe(true);
  }
  for (let k = 2; k < pts.length; k++) {
    const ax = pts[k - 1]!.x - pts[k - 2]!.x;
    const ay = pts[k - 1]!.y - pts[k - 2]!.y;
    const bx = pts[k]!.x - pts[k - 1]!.x;
    const by = pts[k]!.y - pts[k - 1]!.y;
    if (ax * by - ay * bx === 0) {
      expect(ax * bx + ay * by, `${tag} 拐点 ${k} 回折`).toBeGreaterThan(0);
    }
  }
}

describe('assignLanes（车道分配单元）', () => {
  it('共通道两线：长线与短线对分通道（±margin/4），端口贴边段及其延伸段不偏移', () => {
    // 两边的列 x=5 段区间重叠（[2,9] 与 [1,7]）→ 冲突组；行线互不相同。
    // a 段 1（行 2）与端口段同轴延伸 → 偏移恒 0。
    const a = routeOf([
      [0, 2],
      [1, 2],
      [5, 2],
      [5, 9],
      [10, 9],
      [10, 10],
    ]); // 长 18
    const b = routeOf([
      [3, 0],
      [3, 1],
      [5, 1],
      [5, 7],
      [8, 7],
      [8, 8],
    ]); // 长 13
    assignLanes([a, b], 1);
    expect(a.laneOffsets).toEqual([0, 0, -0.25, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
  });

  it('共通道三线：长线居中（偏移 0 → 不设字段），两条短线对称铺满可用区', () => {
    const a = routeOf([
      [0, 2],
      [1, 2],
      [5, 2],
      [5, 9],
      [10, 9],
      [10, 10],
    ]);
    const b = routeOf([
      [3, 0],
      [3, 1],
      [5, 1],
      [5, 7],
      [8, 7],
      [8, 8],
    ]);
    const c = routeOf([
      [4, 4],
      [4, 5],
      [5, 5],
      [5, 11],
      [7, 11],
      [7, 12],
    ]);
    assignLanes([a, b, c], 1);
    expect(a.laneOffsets).toBeUndefined(); // rank 0 → 中央偏移 0
    // 可用区 = 通道半宽留安全距 ±0.25，三线等差 0.25 铺满（不贴节点边）
    expect(b.laneOffsets).toEqual([0, 0, -0.25, 0, 0]);
    expect(c.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
  });

  it('独占通道的边不偏移（格心线 = 通道中央，坐标逐位不变）', () => {
    const solo = routeOf([
      [0, 0],
      [1, 0],
      [4, 0],
      [4, 6],
      [8, 6],
      [8, 7],
    ]);
    assignLanes([solo], 1);
    expect(solo.laneOffsets).toBeUndefined();
  });

  it('同端点对重合边（bundle）：登记段全部错开，仅端口贴边段重合（偏移 0）', () => {
    const shape: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [4, 0],
      [4, 6],
      [8, 6],
      [8, 7],
    ];
    const e0 = routeOf(shape);
    const e1 = routeOf(shape);
    assignLanes([e0, e1], 1);
    // 列 4 段与行 6 段各成冲突组（首段延伸行 0 不登记）；长线平局按边序。
    // 端口法向贴边段（首末段）物理汇聚于端口，格层无法错开 —— 渲染端
    // 同端点对端口分散是全程不重叠的后续工作。
    expect(e0.laneOffsets).toEqual([0, 0, -0.25, -0.25, 0]);
    expect(e1.laneOffsets).toEqual([0, 0, 0.25, 0.25, 0]);
  });

  it('共享一端的边（sibling）倾向共用路径：重叠段聚成同一车道，与无关边照常错开', () => {
    // a、b 共享 source（端点 0），列 5 段区间重叠 → 同簇共用车道；
    // c 与两者无共享端点 → 独立占位错开。
    const a = routeOf(
      [
        [0, 2],
        [1, 2],
        [5, 2],
        [5, 9],
        [10, 9],
        [10, 10],
      ],
      0,
      1,
    ); // 长 18
    const b = routeOf(
      [
        [3, 0],
        [3, 1],
        [5, 1],
        [5, 7],
        [8, 7],
        [8, 8],
      ],
      0,
      2,
    ); // 长 13
    const c = routeOf(
      [
        [4, 4],
        [4, 5],
        [5, 5],
        [5, 11],
        [7, 11],
        [7, 12],
      ],
      3,
      4,
    ); // 长 12
    assignLanes([a, b, c], 1);
    // 簇 {a,b}（代表长 18）与簇 {c}（长 12）：长簇占中央侧 -0.25
    expect(a.laneOffsets).toEqual([0, 0, -0.25, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, -0.25, 0, 0]);
    expect(c.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
  });

  it('U 形绕行：同边同列两段共享同一车道（位置固定原则）', () => {
    // 边 a 两次经过列 x=5（区间 [2,6] 与 [10,14]），边 b 的列段 [8,11]
    // 与 [10,14] 重叠 → 两单位一组；行线互不冲突。
    const a = routeOf([
      [0, 2],
      [1, 2],
      [5, 2],
      [5, 6],
      [7, 6],
      [7, 10],
      [5, 10],
      [5, 14],
      [9, 14],
      [9, 15],
    ]);
    const b = routeOf([
      [3, 7],
      [3, 8],
      [5, 8],
      [5, 11],
      [7, 11],
      [7, 12],
    ]);
    assignLanes([a, b], 1);
    expect(a.laneOffsets).toEqual([0, 0, -0.25, 0, 0, 0, -0.25, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
  });

  it('区间相触即冲突（共用格心）：更长的边得中央侧', () => {
    // a 列段 [2,5]、b 列段 [4,9]：重叠 → 冲突组；b（长 13）> a（长 12）。
    const a = routeOf([
      [0, 2],
      [1, 2],
      [5, 2],
      [5, 5],
      [8, 5],
      [8, 6],
    ]);
    const b = routeOf([
      [3, 3],
      [3, 4],
      [5, 4],
      [5, 9],
      [1, 9],
      [1, 10],
    ]);
    assignLanes([a, b], 1);
    expect(a.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, -0.25, 0, 0]);
  });

  it('垂直交叉（不共线）不算冲突：双方都不偏移', () => {
    const p = routeOf([
      [0, 4],
      [1, 4],
      [1, 5],
      [9, 5],
      [9, 6],
    ]); // 行 y=5，x∈[1,9]（段 2 登记）
    const q = routeOf([
      [4, 2],
      [4, 3],
      [5, 3],
      [5, 9],
      [6, 9],
    ]); // 列 x=5，y∈[3,9]（段 2 登记），与 p 交叉于 (5,5)
    assignLanes([p, q], 1);
    expect(p.laneOffsets).toBeUndefined();
    expect(q.laneOffsets).toBeUndefined();
  });

  it('margin=0（无通道空间）不做分配', () => {
    const shape: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [4, 0],
      [4, 6],
      [8, 6],
      [8, 7],
    ];
    const e0 = routeOf(shape);
    const e1 = routeOf(shape);
    assignLanes([e0, e1], 0);
    expect(e0.laneOffsets).toBeUndefined();
    expect(e1.laneOffsets).toBeUndefined();
  });

  it('障碍感知：偶数格宽盒物理边界贴格心线（半格相位），组内偏移全部推到盒外', () => {
    // 回归：树图场景垂直列线贴偶宽盒右界（br = t0），旧实现按名义半宽
    // 分配 ±0.25 把线推入盒内（穿第三方节点）。盒 (4,8,2,1) 偶宽物理
    // 区间 = [4.5, 6.5]，列线 L=6 格心线 t0=6.5 恰贴其右界 → lo ≥ GAP。
    const boxes: Box[] = [
      { x: 0, y: 3, width: 1, height: 1 }, // 公共端点盒（远离列线，无约束）
      { x: 4, y: 8, width: 2, height: 1 }, // 第三方障碍盒（贴格心线）
    ];
    // 两边垂直段同在列 6、行区间含行 8（与障碍盒行重叠 → span 命中）
    // 两边端点盒都指回 boxes[0]（障碍盒保持第三方语义）
    const a = routeOf(
      [
        [0, 3],
        [6, 3],
        [6, 9],
        [10, 9],
      ],
      0,
      0,
    ); // 长 13
    const b = routeOf(
      [
        [2, 6],
        [6, 6],
        [6, 8],
        [9, 8],
      ],
      0,
      0,
    ); // 长 9
    assignLanes([a, b], 1, boxes, new Set([1]));
    // lo = 6.5 - 6.5 + 0.25 = 0.25（盒外）；右侧无盒 → 兜底容纳两线均分
    // spacing = 0.5，shift 钳入下界 → offsets {0.25, 0.75}（长线 0.25）
    expect(a.laneOffsets).toEqual([0, 0, 0.25, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, 0.75, 0, 0]);
  });

  it('障碍感知：偏移线与所属边端点盒保持半格间距（渲染端接入长度）', () => {
    // 回归：目标盒（偶宽）右界贴列线格心，偏移 0.25 使末段只剩 6.5px
    // （< 箭头 8px，渲染层外推与来路反向构成回折不可行）。端点盒用
    // END_GAP=0.5 → 偏移线距端口 ≥ 13px。
    const boxes: Box[] = [
      { x: 0, y: 3, width: 1, height: 1 }, // a 的 source 端点盒
      { x: 4, y: 8, width: 2, height: 1 }, // a 的 target 端点盒（贴列线格心）
      { x: 9, y: 8, width: 1, height: 1 }, // b 的 target 端点盒
      { x: 2, y: 0, width: 1, height: 1 }, // b 的 source 端点盒（远离列线）
    ];
    const a = routeOf(
      [
        [0, 3],
        [6, 3],
        [6, 9],
        [10, 9],
      ],
      0,
      1,
    ); // 长 13
    const b = routeOf(
      [
        [2, 6],
        [6, 6],
        [6, 8],
        [9, 8],
      ],
      3,
      2,
    ); // 长 9
    assignLanes([a, b], 1, boxes, new Set([0, 1, 2]));
    // lo = max(a: 6.5-6.5+0.5, b: +0.25) = 0.5；spacing = 0.5、shift 钳下界
    // → offsets {0.5, 1.0}：a（端点贴盒侧）恰得 END_GAP 0.5
    expect(a.laneOffsets).toEqual([0, 0, 0.5, 0, 0]);
    expect(b.laneOffsets).toEqual([0, 0, 1, 0, 0]);
  });

  it('确定性：同输入重复分配结果逐位一致', () => {
    const make = (): LayoutRoute[] => [
      routeOf([
        [0, 2],
        [1, 2],
        [5, 2],
        [5, 9],
        [10, 9],
        [10, 10],
      ]),
      routeOf([
        [3, 0],
        [3, 1],
        [5, 1],
        [5, 7],
        [8, 7],
        [8, 8],
      ]),
      routeOf([
        [4, 4],
        [4, 5],
        [5, 5],
        [5, 11],
        [7, 11],
        [7, 12],
      ]),
    ];
    const first = make();
    const second = make();
    assignLanes(first, 1);
    assignLanes(second, 1);
    expect(JSON.stringify(second.map((r) => r.laneOffsets))).toBe(JSON.stringify(first.map((r) => r.laneOffsets)));
  });

  it('compressCorners：合并共线中间格、强制保留端口段端点（首末 1 格贴边段）', () => {
    const corners = compressCorners([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
    // cells[1] 与 cells[len-2] 是端口段端点，即使共线也保留。
    expect(corners).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
    ]);
  });

  it('交叉嵌套约束：端点完全不同的两边共用拐点行/列时，向 + 延伸者得更大槽位（正交段不交叠）', () => {
    // 树 21 图 root→b2 与 b0→l0-2 的缩影：两边骨架都必经拐点格 (14,6)
    // （b0 的出口格 / root→b2 的转折行），共用列线 x=14。a 在拐点处向
    // +x 延伸（转右进 b2 端口），b 从 −x 侧到达（b0 出口向右）—— 若 a
    // 的槽位小于 b，两端正交段在共用行线上交叠（回归：曾重叠半格）。
    // 约束感知分配：b（向 − 延伸）取小槽位、a（向 + 延伸）取大槽位，
    // 槽位差 = 组内间距 = 最小空隙。
    // cells 与生产 routeInCells 输出同构（A* 压缩拐点 + 两端锚点）——
    // 路由长度（cells.length - 1）同为 4：蛇形排序平局按边序 a 优先、
    // 取小槽位，正是回归的交叉场景。
    const a: LayoutRoute = {
      source: 0,
      target: 1,
      cells: [
        { x: 13, y: 4 },
        { x: 14, y: 4 },
        { x: 14, y: 6 },
        { x: 16, y: 6 },
        { x: 17, y: 6 },
      ],
    };
    const b: LayoutRoute = {
      source: 2,
      target: 3,
      cells: [
        { x: 13, y: 6 },
        { x: 14, y: 6 },
        { x: 14, y: 10 },
        { x: 15, y: 10 },
        { x: 16, y: 10 },
      ],
    };
    const boxes: Box[] = [
      { x: 12, y: 4, width: 2, height: 1 }, // root（偶宽，端点盒约束抬升可用区下界）
      { x: 17, y: 6, width: 1, height: 1 }, // b2
      { x: 13, y: 6, width: 1, height: 1 }, // b0
      { x: 16, y: 10, width: 2, height: 1 }, // l0-2
    ];
    assignLanes([a, b], 1, boxes, new Set([0, 1, 2, 3]));
    expect(a.laneOffsets).toBeDefined();
    expect(b.laneOffsets).toBeDefined();
    const offA = Math.max(...a.laneOffsets!);
    const offB = Math.max(...b.laneOffsets!);
    expect(offA, 'a（向 + 延伸）槽位应大于 b（向 − 延伸）').toBeGreaterThan(offB);
    expect(offA - offB, '槽位差 = 组内间距（最小空隙）').toBeCloseTo(0.5, 9);
  });
});

describe('终点贴边段保障（enforceEndStub 经公开路径行为）', () => {
  const circle: ShapeSpec = { kind: 'circle', r: 10 };
  /** 骨架末拐点距端口 3px（例外二形态）的上下文。 */
  const ctx = (minStub?: number): EdgeRouteContext => ({
    source: { x: 0, y: -10, nx: 0, ny: -1 },
    target: { x: 100, y: 10, nx: 0, ny: 1 },
    sourceBox: { x: 0, y: 0, hw: 10, hh: 10, shape: circle },
    targetBox: { x: 100, y: 0, hw: 10, hh: 10, shape: circle },
    waypoints: [
      { x: 0, y: 0 },
      { x: 6, y: -6 },
      { x: 94, y: 13 },
      { x: 100, y: 13 },
      { x: 100, y: 0 },
    ],
    bundle: { slot: 0, count: 1 },
    ...(minStub !== undefined ? { minStub } : {}),
  });

  const ptsOf = (path: EdgePath): Vec2[] => {
    const pts: Vec2[] = [path.start];
    for (const seg of path.segments) {
      if (seg.kind === 'line') pts.push(seg.to);
    }
    return pts;
  };

  it('minStub=8：末段外推至恰 8px，外推引入的肘点保持全折线正交、无 180° 回折', () => {
    const strategy = new OrthogonalPolylinePathStrategy();
    const pts = ptsOf(strategy.route(ctx(8)));
    expect(pts.length).toBeGreaterThanOrEqual(3);
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    expect(Math.hypot(last.x - prev.x, last.y - prev.y)).toBeCloseTo(8, 9);
    expectOrthogonalNoFoldback(pts, 'minStub=8');
  });

  it('无 minStub 约束时以 breakout（6）为下限外推', () => {
    const strategy = new OrthogonalPolylinePathStrategy();
    const pts = ptsOf(strategy.route(ctx()));
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    expect(Math.hypot(last.x - prev.x, last.y - prev.y)).toBeCloseTo(6, 9);
    expectOrthogonalNoFoldback(pts, 'breakout 下限');
  });
});

describe('管线级：真实布局集成（mixed 图）', () => {
  const demoOptions = {
    algorithm: 'grid-undirected',
    direction: 'none',
    naturalLength: 6,
    channelMargin: 1,
    labelCollision: true,
    folding: true,
    seed: 42,
  } as const;

  const render = () => {
    const layout = new ForceLayout(GRAPHS.mixed!(), demoOptions as never);
    layout.run();
    const geos = new EdgeStyleRenderer({
      source: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new NoneEndCapStrategy() },
      target: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new NoneEndCapStrategy() },
      path: new OrthogonalPolylinePathStrategy(),
      corners: new SharpCornerStrategy(),
      crossings: new PlainCrossingStrategy(),
    }).render({
      nodeViews: [...layout.nodeViews],
      subgraphViews: [...layout.subgraphViews],
      edgeViews: [...layout.edgeViews],
    });
    return { layout, geos };
  };

  /** 折线顶点序列。 */
  const ptsOf = (g: { path: EdgePath }): Vec2[] => {
    const pts: Vec2[] = [g.path.start];
    for (const seg of g.path.segments) {
      if (seg.kind === 'line') pts.push(seg.to);
    }
    return pts;
  };

  it('渲染折线全正交（车道偏移边不破坏单轴性）、无 180° 回折', () => {
    const { geos } = render();
    for (const geo of geos) {
      expectOrthogonalNoFoldback(ptsOf(geo), `边 ${geo.index}`);
    }
  });

  it('车道分配真实发生（存在非格心相位的走线坐标）且确定性逐位一致', () => {
    const first = render();
    const second = render();
    expect(JSON.stringify(second.geos.map((g) => g.path))).toBe(JSON.stringify(first.geos.map((g) => g.path)));
    const cellW = first.layout.cellW;
    const cellH = first.layout.cellH;
    const shifted = first.layout.edgeViews.some((e) =>
      (e.waypoints ?? []).some((p) => {
        const fx = Math.abs((((p.x / cellW) % 1) + 1) % 1 - 0.5);
        const fy = Math.abs((((p.y / cellH) % 1) + 1) % 1 - 0.5);
        return fx > 1e-9 || fy > 1e-9;
      }),
    );
    expect(shifted, 'mixed 图应存在通道冲突并被车道分配偏移').toBe(true);
  });
});
