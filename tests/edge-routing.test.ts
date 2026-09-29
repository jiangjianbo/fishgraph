/**
 * 连线装配回归（布局走线 → 渲染折线的管线级契约）。
 *
 * 固化四类已修复缺陷的不变式，防回归：
 *  1. 折线单调与缝合不新增碎步（锚点口径修复：A* 端点外移一格 +
 *     锚点格靠对端侧）；
 *  2. 箭头「尾巴」：末端贴边段为长直线，长度 ≥ 箭头长度
 *     （appendApproach 切向先接入）；
 *  3. 正对位成员连线为直线（正对位直线升级为端口中线 exact 直线）；
 *  4. 文字盒折行口径（demo 节点标签绘制按同一 estimateLabelBox rows
 *     回绕的布局侧锚点）。
 *
 * 参数与 demo 默认一致（seed 固定，布局确定性逐位一致）。
 */
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
  dominantSide,
} from '../src/index.js';
import type { EdgePath, GraphSpec, Vec2 } from '../src/index.js';
import { estimateLabelBox } from '../src/label.js';

/** demo 终点箭头默认长度（ArrowEndCapStrategy 缺省 size）。 */
const ARROW_SIZE = 8;

function treeGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [{ id: 'root', label: 'root' }];
  const edges: GraphSpec['edges'] = [];
  const level1: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = `b${i}`;
    nodes.push({ id, label: id });
    edges.push({ source: 'root', target: id });
    level1.push(id);
  }
  level1.forEach((p, pi) => {
    for (let j = 0; j < 4; j++) {
      const id = `l${pi}-${j}`;
      nodes.push({ id, label: id });
      edges.push({ source: p, target: id });
    }
  });
  return { nodes, edges };
}

function groupsGraph(): GraphSpec {
  return {
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
      { id: 'sub', shape: { kind: 'rect', w: 380, h: 280 }, label: '子图', members: ['in-a', 'in-b', 'in-c'] },
    ],
  };
}

const mkRenderer = () =>
  new EdgeStyleRenderer({
    source: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new NoneEndCapStrategy() },
    // 终点箭头与「尾巴 ≥ 箭头长」断言语义一致（minStub 随箭头 tipLength 生效）
    target: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new ArrowEndCapStrategy() },
    path: new OrthogonalPolylinePathStrategy(),
    corners: new SharpCornerStrategy(),
    crossings: new PlainCrossingStrategy(),
  });

/** 折线顶点序列（line 段逐个展开）。 */
function ptsOf(geo: { path: EdgePath }): Vec2[] {
  const pts: Vec2[] = [geo.path.start];
  for (const seg of geo.path.segments) {
    if (seg.kind === 'line') pts.push(seg.to);
  }
  return pts;
}

/** 拐点数（方向变化处）。 */
function cornerCount(pts: Vec2[]): number {
  let n = 0;
  for (let k = 2; k < pts.length; k++) {
    const ax = pts[k - 1]!.x - pts[k - 2]!.x;
    const ay = pts[k - 1]!.y - pts[k - 2]!.y;
    const bx = pts[k]!.x - pts[k - 1]!.x;
    const by = pts[k]!.y - pts[k - 1]!.y;
    if (ax * by - ay * bx !== 0) n++;
  }
  return n;
}

/** 渲染树图并返回逐边信息（demo 同参：seed 42，确定性布局）。 */
function renderTree() {
  const layout = new ForceLayout(treeGraph(), {
    algorithm: 'grid-undirected',
    direction: 'none',
    naturalLength: 6,
    channelMargin: 1,
    labelCollision: true,
    folding: true,
    seed: 42,
  });
  layout.run();
  const views = [...layout.nodeViews];
  const evs = [...layout.edgeViews];
  const geos = mkRenderer().render({
    nodeViews: views,
    subgraphViews: [...layout.subgraphViews],
    edgeViews: evs,
  });
  return { views, evs, geos };
}

describe('连线装配回归（树 21 节点）', () => {
  const { views, evs, geos } = renderTree();
  const idOf = (i: number) => String(views[i]!.id);
  const ptsOfEdge = (i: number) => ptsOf(geos[i]!);
  const indexOf = (sid: string, tid: string) =>
    evs.findIndex((e) => idOf(e.sourceIndex) === sid && idOf(e.targetIndex) === tid);

  it('全边无 180° 回折（箭头与临近线段连贯的前提）', () => {
    for (let i = 0; i < evs.length; i++) {
      const pts = ptsOfEdge(i);
      for (let k = 2; k < pts.length; k++) {
        const ax = pts[k - 1]!.x - pts[k - 2]!.x;
        const ay = pts[k - 1]!.y - pts[k - 2]!.y;
        const bx = pts[k]!.x - pts[k - 1]!.x;
        const by = pts[k]!.y - pts[k - 1]!.y;
        expect(ax * by - ay * bx === 0 && ax * bx + ay * by < 0, `${idOf(evs[i]!.sourceIndex)}->${idOf(evs[i]!.targetIndex)} 段${k - 2} 回折`).toBe(false);
      }
    }
  });

  it('全边渲染拐点数 ≤ 骨架拐点数 + 2（缝合不新增碎步）', () => {
    for (let i = 0; i < evs.length; i++) {
      const rendered = cornerCount(ptsOfEdge(i));
      const skel = cornerCount(evs[i]!.waypoints ?? []);
      expect(rendered, `${idOf(evs[i]!.sourceIndex)}->${idOf(evs[i]!.targetIndex)}`).toBeLessThanOrEqual(skel + 2);
    }
  });

  it('全边末端贴边段 ≥ 箭头长度（箭头之后有「尾巴」才转向）', () => {
    for (let i = 0; i < evs.length; i++) {
      const pts = ptsOfEdge(i);
      const tail = Math.hypot(
        pts[pts.length - 1]!.x - pts[pts.length - 2]!.x,
        pts[pts.length - 1]!.y - pts[pts.length - 2]!.y,
      );
      expect(tail, `${idOf(evs[i]!.sourceIndex)}->${idOf(evs[i]!.targetIndex)} 末段 ${tail.toFixed(1)}`).toBeGreaterThanOrEqual(ARROW_SIZE);
    }
  });

  it('root→b1：居中对齐后同列，连线为向上垂直直线（无反向段）', () => {
    const i = indexOf('root', 'b1');
    expect(i).toBeGreaterThanOrEqual(0);
    const s = views[evs[i]!.sourceIndex]!;
    const t = views[evs[i]!.targetIndex]!;
    // 行列居中对齐（阶段 7.5 + 物理化格心吸附）后 root 与 b1 中心同列：
    // 连线升级为垂直直线（回归口径更新：旧几何为左上斜折线）
    expect(t.x!).toBe(s.x!);
    expect(t.y!).toBeLessThan(s.y!); // 对端在上（dy < 0）
    // 全部顶点都在 source→target 的单调象限内：不向右、不向下
    // （屏幕坐标向上 = y 减小；回归：曾有先向右 13px 的反向段）
    for (const p of ptsOfEdge(i)) {
      expect(p.x).toBeLessThanOrEqual(s.x! + 1e-9);
      expect(p.y).toBeLessThanOrEqual(s.y! + 1e-9);
    }
  });

  it('root→b3：居中对齐后同行，连线为单段水平直线', () => {
    const i = indexOf('root', 'b3');
    expect(i).toBeGreaterThanOrEqual(0);
    const s = views[evs[i]!.sourceIndex]!;
    const t = views[evs[i]!.targetIndex]!;
    // 行列居中对齐（阶段 7.5 + 物理化格心吸附）后 root 与 b3 中心同行：
    // 连线为严格水平直线 —— 这正是"同行列节点连线不歪斜"的需求语义
    expect(t.y!).toBe(s.y!);
    const pts = ptsOfEdge(i);
    expect(pts, '水平直线应为单段').toHaveLength(2);
    expect(pts[0]!.y).toBe(pts[1]!.y);
  });

  it('b3→l3-3：居中对齐后同列，连线为单段垂直直线', () => {
    const i = indexOf('b3', 'l3-3');
    expect(i).toBeGreaterThanOrEqual(0);
    const s = views[evs[i]!.sourceIndex]!;
    const t = views[evs[i]!.targetIndex]!;
    expect(t.x!).toBe(s.x!);
    const pts = ptsOfEdge(i);
    expect(pts, '垂直直线应为单段').toHaveLength(2);
    expect(pts[0]!.x).toBe(pts[1]!.x);
  });

  it('b2→l2-3：箭头处拐弯之外留有尾巴（回归：末段曾是 6px 短段）', () => {
    const i = indexOf('b2', 'l2-3');
    expect(i).toBeGreaterThanOrEqual(0);
    const pts = ptsOfEdge(i);
    const tail = Math.hypot(
      pts[pts.length - 1]!.x - pts[pts.length - 2]!.x,
      pts[pts.length - 1]!.y - pts[pts.length - 2]!.y,
    );
    expect(tail).toBeGreaterThanOrEqual(ARROW_SIZE);
    // 修复前末尾结构为「下4 → 右13 → 上6」三段碎步：现在末两段之内
    // 不再出现与末段反向的短臂 —— 倒数第二段长度同样 ≥ 箭头长度
    const prev = Math.hypot(
      pts[pts.length - 2]!.x - pts[pts.length - 3]!.x,
      pts[pts.length - 2]!.y - pts[pts.length - 3]!.y,
    );
    expect(prev).toBeGreaterThanOrEqual(ARROW_SIZE);
  });

  it('全边末段沿端口法向（端点垂直，回归：曾沿盒边切进端口成椭圆切线）', () => {
    for (let i = 0; i < evs.length; i++) {
      const s = views[evs[i]!.sourceIndex]!;
      const t = views[evs[i]!.targetIndex]!;
      const pts = ptsOfEdge(i);
      const a = pts[pts.length - 2]!;
      const b = pts[pts.length - 1]!;
      // 端口侧 = 目标端「指向对端」的主导轴（与端口策略同一 dominantSide 口径）；
      // 左右侧端口 → 末段水平，上下侧端口 → 末段垂直。
      const horizontal = ((side) => side === 'right' || side === 'left')(
        dominantSide(s.x! - t.x!, s.y! - t.y!),
      );
      const label = `${idOf(evs[i]!.sourceIndex)}->${idOf(evs[i]!.targetIndex)} 末段 (${a.x.toFixed(1)},${a.y.toFixed(1)})→(${b.x.toFixed(1)},${b.y.toFixed(1)})`;
      if (horizontal) {
        expect(Math.abs(b.y - a.y), `${label} 应垂直于左右侧端口`).toBeLessThan(1e-9);
        expect(Math.abs(b.x - a.x), `${label} 末段退化为 0 长`).toBeGreaterThan(1e-9);
      } else {
        expect(Math.abs(b.x - a.x), `${label} 应垂直于上下侧端口`).toBeLessThan(1e-9);
        expect(Math.abs(b.y - a.y), `${label} 末段退化为 0 长`).toBeGreaterThan(1e-9);
      }
    }
  });

  it('走线段不与任何节点盒边线共线重叠（车道贴盒回归：偶数格盒物理越界切线）', () => {
    const eps = 1e-6;
    for (let i = 0; i < evs.length; i++) {
      const pts = ptsOfEdge(i);
      const label = `${idOf(evs[i]!.sourceIndex)}->${idOf(evs[i]!.targetIndex)}`;
      for (let k = 1; k < pts.length; k++) {
        const p1 = pts[k - 1]!;
        const p2 = pts[k]!;
        for (const t of views) {
          const b = { minX: t.x! - t.w! / 2, maxX: t.x! + t.w! / 2, minY: t.y! - t.h! / 2, maxY: t.y! + t.h! / 2 };
          // 水平段与盒上/下边线共线，且 x 区间与盒 x 区间有正长度重叠
          let tangent = false;
          if (Math.abs(p1.y - p2.y) < eps) {
            const lo = Math.min(p1.x, p2.x);
            const hi = Math.max(p1.x, p2.x);
            tangent =
              (Math.abs(p1.y - b.minY) < eps || Math.abs(p1.y - b.maxY) < eps) &&
              lo < b.maxX - eps && b.minX + eps < hi;
          }
          // 垂直段与盒左/右边线共线，且 y 区间与盒 y 区间有正长度重叠
          if (!tangent && Math.abs(p1.x - p2.x) < eps) {
            const lo = Math.min(p1.y, p2.y);
            const hi = Math.max(p1.y, p2.y);
            tangent =
              (Math.abs(p1.x - b.minX) < eps || Math.abs(p1.x - b.maxX) < eps) &&
              lo < b.maxY - eps && b.minY + eps < hi;
          }
          expect(tangent, `${label} 段${k - 1} 与节点 ${String(t.id)} 盒边线共线重叠（贴边）`).toBe(false);
        }
      }
    }
  });

  it('同端点同向 sibling 共线优先：b3→l3-0 与 l3-1/l3-2 共用干线拐点（回归：曾提前拐离干线）', () => {
    // 折线第 2 点 = 离开源端口后的首个拐点（分岔点）：三条左出 sibling
    // 边的分岔点应同 x —— 干线从端口延伸到通道中央车道后才各自分岔。
    const branchX = (sid: string, tid: string) => {
      const i = indexOf(sid, tid);
      expect(i, `${sid}->${tid} 存在`).toBeGreaterThanOrEqual(0);
      const pts = ptsOfEdge(i);
      expect(pts.length, `${sid}->${tid} 有分岔点`).toBeGreaterThan(2);
      // 分岔点在源端口的行线上（干线与端口侧同轴）
      expect(pts[1]!.y, `${sid}->${tid} 干线沿端口行`).toBe(pts[0]!.y);
      return pts[1]!.x;
    };
    const trunk = branchX('b3', 'l3-1');
    expect(branchX('b3', 'l3-0'), 'b3→l3-0 与 sibling 共用干线拐点').toBe(trunk);
    expect(branchX('b3', 'l3-2'), 'b3→l3-2 与 sibling 共用干线拐点').toBe(trunk);
  });
});

describe('连线装配回归（分组子图）', () => {
  it('正对位成员连线（in-a→in-b、in-b→in-c）为单段直线（回归：曾是 C 形）', () => {
    const layout = new ForceLayout(groupsGraph(), {
      algorithm: 'grid-undirected',
      direction: 'none',
      naturalLength: 6,
      channelMargin: 1,
      labelCollision: true,
      folding: true,
      seed: 42,
    });
    layout.run();
    const views = [...layout.nodeViews];
    const evs = [...layout.edgeViews];
    const geos = mkRenderer().render({
      nodeViews: views,
      subgraphViews: [...layout.subgraphViews],
      edgeViews: evs,
    });
    for (const [sid, tid] of [['in-a', 'in-b'], ['in-b', 'in-c']] as const) {
      const i = evs.findIndex(
        (e) => String(views[e.sourceIndex]!.id) === sid && String(views[e.targetIndex]!.id) === tid,
      );
      expect(i).toBeGreaterThanOrEqual(0);
      const pts = ptsOf(geos[i]!);
      expect(pts, `${sid}->${tid}`).toHaveLength(2); // 单段
      // 垂直直线：同 x，且从 source 底边直下到 target 顶边
      expect(pts[0]!.x).toBeCloseTo(pts[1]!.x, 9);
    }
  });
});

describe('文字盒折行口径（demo 节点标签绘制的布局侧锚点）', () => {
  it('宽高比约束回绕：≤8 字单行，超限折到满足约束的最少行数', () => {
    // 布局端 measureBox 口径：fontSize 12、padding 4、maxAspect 4
    // 单行盒 = 字数×9+8 宽 × 20 高：8 字 80/20 = 4.0 恰好满足 → 单行。
    const four = estimateLabelBox('读取输入', 12, 4);
    expect(four.rows).toEqual(['读取输入']); // 4 字比 2.2 ≤ 4 → 单行
    const two = estimateLabelBox('开始', 12, 4);
    expect(two.rows).toEqual(['开始']);
    const eight = estimateLabelBox('字'.repeat(8), 12, 4);
    expect(eight.rows).toEqual(['字字字字字字字字']); // 比 4.0 边界内
    // 9 字单行 89/20 = 4.45 > 4 → 折 2 行（5+4），53/32 = 1.66 满足。
    const nine = estimateLabelBox('字'.repeat(9), 12, 4);
    expect(nine.rows).toEqual(['字字字字字', '字字字字']);
    expect(nine.hw * 2 / (nine.hh * 2)).toBeLessThanOrEqual(4);
    // 单行盒更宽更高（4 字单行 44×20 vs 2 字 26×20）——节点物化按
    // 此盒；绘制若不折行即出现「框窄高而文字单行」的联动缺失（已修复
    // 的 demo 缺陷）。
    expect(four.hw).toBeGreaterThan(two.hw);
    expect(four.hh).toBeCloseTo(two.hh, 9);
  });

  it('maxAspect 参数生效：收紧到 2 时 4 字也回绕为两行', () => {
    const tight = estimateLabelBox('读取输入', 12, 4, 2);
    // 单行 44/20 = 2.2 > 2 → 2 行 26/32 = 0.81 满足
    expect(tight.rows).toEqual(['读取', '输入']);
    const loose = estimateLabelBox('读取输入', 12, 4, 4);
    expect(loose.rows).toEqual(['读取输入']);
  });

  it('兜底：全部行数超比（断点后每段仍超长）取宽高比最小的行数', () => {
    // 20 字 + "_" + 20 字：词内部不可折断，任何行数下每段都单独成行
    // （最短 2 行、最宽 21 字符）→ 全部行数都超比，取比值最小的 2 行。
    const long = estimateLabelBox(`${'x'.repeat(20)}_${'x'.repeat(20)}`, 12, 4);
    expect(long.rows).toHaveLength(2);
    expect((long.hw * 2) / (long.hh * 2)).toBeGreaterThan(4); // 约束确实无解
    expect(long.rows[0]).toHaveLength(21); // 段内不折断：行宽 = 段长
  });
});
