import {
  ForceLayout,
  estimateLabelBox,
  halfExtentsOf,
  EdgeStyleRenderer,
  FixedPortStrategy,
  DistributedPortStrategy,
  AabbEndpointFitStrategy,
  ShapeEndpointFitStrategy,
  CircleEndpointFitStrategy,
  CenterEndpointFitStrategy,
  NoneEndCapStrategy,
  ArrowEndCapStrategy,
  OpenEndCapStrategy,
  DotEndCapStrategy,
  OrthogonalPolylinePathStrategy,
  StraightLinePathStrategy,
  CubicBezierPathStrategy,
  ObliqueDistributedPathStrategy,
  SharpCornerStrategy,
  RoundCornerStrategy,
  PlainCrossingStrategy,
  BridgeCrossingStrategy,
  pathLength,
} from '../src/index.js';
import type {
  ShapeSpec,
  SubgraphView,
  EdgeGeometry,
  EdgePath,
} from '../src/index.js';

// ── 示例图（构造函数与测试共享：demo/graphs.ts）──────────

import { GRAPHS } from './graphs.js';

// ── UI 元素 ───────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewCanvas = $<HTMLCanvasElement>('view');
const statusEl = $('status');
const graphSel = $<HTMLSelectElement>('graph');
const directionSel = $<HTMLSelectElement>('direction');
const sliders = {
  L: $<HTMLInputElement>('L'),
  cm: $<HTMLInputElement>('cm'),
};
const outs = {
  L: $<HTMLOutputElement>('Lv'),
  cm: $<HTMLOutputElement>('cmv'),
};
const labelCollision = $<HTMLInputElement>('lc');
const foldToggle = $<HTMLInputElement>('fold');
const edgeStyle = {
  path: $<HTMLSelectElement>('pathStyle'),
  port: $<HTMLSelectElement>('portStyle'),
  fit: $<HTMLSelectElement>('fitStyle'),
  capSource: $<HTMLSelectElement>('capSource'),
  capTarget: $<HTMLSelectElement>('capTarget'),
  corner: $<HTMLSelectElement>('cornerStyle'),
  cr: $<HTMLInputElement>('cr'),
  crossing: $<HTMLSelectElement>('crossingStyle'),
};
const edgeStyleOuts = {
  cr: $<HTMLOutputElement>('crv'),
};

function buildOptions() {
  return {
    algorithm: 'grid-undirected' as const,
    direction: directionSel.value as 'none' | 'TB' | 'LR',
    naturalLength: Number(sliders.L.value),
    channelMargin: Number(sliders.cm.value),
    labelCollision: labelCollision.checked,
    folding: foldToggle.checked,
    seed: 42,
  };
}

function syncOutputs(): void {
  outs.L.value = sliders.L.value;
  outs.cm.value = sliders.cm.value;
  edgeStyleOuts.cr.value = edgeStyle.cr.value;
}

// ── 连线风格（策略装配）───────────────────────────────────

/** 立交跳线半径：随相机缩放自适应，屏幕上保持约 5px（clamp 2.5..14 世界单位）。 */
function bridgeGap(): number {
  return Math.min(14, Math.max(2.5, 5 / cam.k));
}

/** 按控件取值装配风格策略（两端独立：端口 + 贴合 + 端帽各按端配置）。 */
function buildEdgeRenderer(): EdgeStyleRenderer {
  const path = edgeStyle.path.value;
  const makeEndpoint = (capValue: string) => ({
    ports:
      edgeStyle.port.value === 'distributed'
        ? new DistributedPortStrategy()
        : new FixedPortStrategy(),
    fit:
      edgeStyle.fit.value === 'shape'
        ? new ShapeEndpointFitStrategy()
        : edgeStyle.fit.value === 'circle'
          ? new CircleEndpointFitStrategy()
          : edgeStyle.fit.value === 'center'
            ? new CenterEndpointFitStrategy()
            : new AabbEndpointFitStrategy(),
    cap:
      capValue === 'arrow'
        ? new ArrowEndCapStrategy()
        : capValue === 'open'
          ? new OpenEndCapStrategy()
          : capValue === 'dot'
            ? new DotEndCapStrategy()
            : new NoneEndCapStrategy(),
  });
  return new EdgeStyleRenderer({
    source: makeEndpoint(edgeStyle.capSource.value),
    target: makeEndpoint(edgeStyle.capTarget.value),
    path:
      path === 'straight'
        ? new StraightLinePathStrategy()
        : path === 'bezier'
          ? new CubicBezierPathStrategy()
          : path === 'oblique'
            ? new ObliqueDistributedPathStrategy()
            : new OrthogonalPolylinePathStrategy(),
    corners:
      edgeStyle.corner.value === 'round'
        ? new RoundCornerStrategy(Number(edgeStyle.cr.value))
        : new SharpCornerStrategy(),
    crossings:
      edgeStyle.crossing.value === 'bridge'
        ? new BridgeCrossingStrategy(bridgeGap())
        : new PlainCrossingStrategy(),
  });
}

// 边几何缓存：布局重算或风格参数变化才重算，平移/缩放只做坐标变换
// （例外：立交跳线半径随缩放自适应，缩放时通过 key 变化触发重算）。
let edgeCache: { stamp: number; key: string; geos: EdgeGeometry[] } | null = null;
let layoutStamp = 0;

function edgeGeometries(): EdgeGeometry[] {
  if (!layout) return [];
  const key = [
    edgeStyle.path.value,
    edgeStyle.port.value,
    edgeStyle.fit.value,
    edgeStyle.capSource.value,
    edgeStyle.capTarget.value,
    edgeStyle.corner.value,
    edgeStyle.crossing.value,
    edgeStyle.cr.value,
    bridgeGap().toFixed(1),
  ].join('|');
  if (!edgeCache || edgeCache.stamp !== layoutStamp || edgeCache.key !== key) {
    edgeCache = {
      stamp: layoutStamp,
      key,
      geos: buildEdgeRenderer().render({
        nodeViews: layout.nodeViews,
        subgraphViews: layout.subgraphViews,
        edgeViews: layout.edgeViews,
      }),
    };
  }
  return edgeCache.geos;
}

// ── 布局实例 ──────────────────────────────────────────────

let layout: ForceLayout | null = null;

function rebuild(): void {
  layout = new ForceLayout(GRAPHS[graphSel.value](), buildOptions());
  layout.run();
  layoutStamp++; // 布局坐标重算：边几何缓存失效
  fitToView();
  drawView();
  const nv = layout.nodeViews.length;
  const ev = layout.edgeViews.length;
  statusEl.textContent = `${nv} 节点 · ${ev} 边 · 纯网格布局（确定性，构造期完成）`;
}

for (const el of [...Object.values(sliders), labelCollision, foldToggle]) {
  el.addEventListener('input', () => {
    syncOutputs();
    if (!layout) return;
    layout.updateOptions(buildOptions());
    layout.run();
    layoutStamp++;
    fitToView();
    drawView();
    statusEl.textContent = `${layout.nodeViews.length} 节点 · ${layout.edgeViews.length} 边 · 纯网格布局（确定性，构造期完成）`;
  });
}
graphSel.addEventListener('change', rebuild);
directionSel.addEventListener('change', () => {
  if (!layout) return;
  layout.updateOptions(buildOptions());
  layout.run();
  layoutStamp++;
  fitToView();
  drawView();
});
// 连线风格只影响绘制几何：切换后仅重绘（布局不动）
for (const el of [
  edgeStyle.path,
  edgeStyle.port,
  edgeStyle.fit,
  edgeStyle.capSource,
  edgeStyle.capTarget,
  edgeStyle.corner,
  edgeStyle.crossing,
]) {
  el.addEventListener('change', drawView);
}
edgeStyle.cr.addEventListener('input', () => {
  syncOutputs();
  drawView();
});
$('restart').addEventListener('click', rebuild);
$('fitView').addEventListener('click', () => {
  fitToView();
  drawView();
});

// ── 视图变换（world ↔ screen）：平移 + 缩放 ───────────────

const cam = { x: 0, y: 0, k: 1 };

function worldToScreen(wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.k + viewCanvas.clientWidth / 2, (wy - cam.y) * cam.k + viewCanvas.clientHeight / 2];
}
function screenToWorld(sx: number, sy: number): [number, number] {
  return [(sx - viewCanvas.clientWidth / 2) / cam.k + cam.x, (sy - viewCanvas.clientHeight / 2) / cam.k + cam.y];
}

/** 视图适配：把布局包围盒平移缩放到画布中央（四周留 40px）。 */
function fitToView(): void {
  if (!layout) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const nd of layout.nodeViews) {
    const hw = nd.w !== undefined ? nd.w / 2 : nd.r;
    const hh = nd.h !== undefined ? nd.h / 2 : nd.r;
    x0 = Math.min(x0, nd.x - hw);
    x1 = Math.max(x1, nd.x + hw);
    y0 = Math.min(y0, nd.y - hh);
    y1 = Math.max(y1, nd.y + hh);
  }
  for (const sg of layout.subgraphViews) {
    const he = halfExtentsOf(sg.shape);
    x0 = Math.min(x0, sg.x - he.hw);
    x1 = Math.max(x1, sg.x + he.hw);
    y0 = Math.min(y0, sg.y - he.hh);
    y1 = Math.max(y1, sg.y + he.hh);
  }
  if (!Number.isFinite(x0)) return;
  const pad = 40;
  const k = Math.min(
    2,
    Math.max(
      0.05,
      Math.min(
        (viewCanvas.clientWidth - pad * 2) / (x1 - x0),
        (viewCanvas.clientHeight - pad * 2) / (y1 - y0),
      ),
    ),
  );
  cam.k = k;
  cam.x = (x0 + x1) / 2;
  cam.y = (y0 + y1) / 2;
}

// ── 交互：平移 / 缩放 ─────────────────────────────────────

type Drag = { kind: 'pan'; sx: number; sy: number; camX: number; camY: number } | null;
let drag: Drag = null;

function eventPos(ev: MouseEvent): [number, number] {
  const rect = viewCanvas.getBoundingClientRect();
  return [ev.clientX - rect.left, ev.clientY - rect.top];
}

viewCanvas.addEventListener('pointerdown', (ev) => {
  const [sx, sy] = eventPos(ev);
  drag = { kind: 'pan', sx, sy, camX: cam.x, camY: cam.y };
  viewCanvas.setPointerCapture(ev.pointerId);
});

viewCanvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const [sx, sy] = eventPos(ev);
  cam.x = drag.camX - (sx - drag.sx) / cam.k;
  cam.y = drag.camY - (sy - drag.sy) / cam.k;
  drawView();
});

viewCanvas.addEventListener('pointerup', () => {
  drag = null;
});

viewCanvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const [sx, sy] = eventPos(ev);
  const [wx, wy] = screenToWorld(sx, sy);
  cam.k = Math.min(8, Math.max(0.05, cam.k * Math.pow(1.0015, -ev.deltaY)));
  cam.x = wx - (sx - viewCanvas.clientWidth / 2) / cam.k;
  cam.y = wy - (sy - viewCanvas.clientHeight / 2) / cam.k;
  drawView();
});

// ── 绘制 ──────────────────────────────────────────────────

/** 按形状声明描出轮廓路径（画布特化；尺寸 = 声明尺寸 × 相机缩放）。 */
function shapePath(
  g: CanvasRenderingContext2D,
  shape: ShapeSpec,
  sx: number, sy: number,
  k: number, cornerRadius: number,
): void {
  if (shape.kind === 'circle') {
    g.arc(sx, sy, shape.r * k, 0, Math.PI * 2);
  } else if (shape.kind === 'ellipse') {
    g.ellipse(sx, sy, shape.rx * k, shape.ry * k, 0, 0, Math.PI * 2);
  } else {
    const w = shape.w * k;
    const h = shape.h * k;
    g.roundRect(sx - w / 2, sy - h / 2, w, h, cornerRadius);
  }
}

/** 容器嵌套深度表（绘制排序：浅的先画、在底层）。 */
function subgraphDepthMap(views: readonly SubgraphView[]): Map<string, number> {
  const byId = new Map(views.map((v) => [String(v.id), v] as const));
  const depth = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const v = byId.get(id);
    if (!v || path.has(id)) return 0;
    path.add(id);
    let d = 0;
    for (const c of v.children) {
      const cid = String(c);
      if (byId.has(cid)) d = Math.max(d, visit(cid, path) + 1);
    }
    path.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const v of views) visit(String(v.id), new Set());
  return depth;
}

function fitCanvas(cv: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
    return true;
  }
  return false;
}

/** 把策略产出的段序列翻译成画布路径命令（world → screen 变换在各项点做）。 */
function traceEdgePath(g: CanvasRenderingContext2D, path: EdgePath): void {
  const [sx, sy] = worldToScreen(path.start.x, path.start.y);
  g.moveTo(sx, sy);
  for (const seg of path.segments) {
    if (seg.kind === 'line') {
      const [x, y] = worldToScreen(seg.to.x, seg.to.y);
      g.lineTo(x, y);
    } else if (seg.kind === 'arc') {
      // 相机只有平移缩放（无旋转），圆心转屏幕、半径乘缩放、角度不变
      const [cx, cy] = worldToScreen(seg.center.x, seg.center.y);
      g.arc(cx, cy, seg.radius * cam.k, seg.startAngle, seg.endAngle, seg.ccw);
    } else {
      const [c1x, c1y] = worldToScreen(seg.cp1.x, seg.cp1.y);
      const [c2x, c2y] = worldToScreen(seg.cp2.x, seg.cp2.y);
      const [x, y] = worldToScreen(seg.to.x, seg.to.y);
      g.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    }
  }
}

/** 绘制两端端帽装饰（填充多边形 / 圆点 / 描边折线）。 */
function drawEndCaps(g: CanvasRenderingContext2D, geo: EdgeGeometry): void {
  for (const cap of [geo.caps.source, geo.caps.target]) {
    g.fillStyle = '#64748b';
    g.strokeStyle = '#64748b';
    g.lineWidth = 1.5;
    for (const poly of cap.fills ?? []) {
      g.beginPath();
      poly.points.forEach((p, i) => {
        const [x, y] = worldToScreen(p.x, p.y);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
      g.fill();
    }
    for (const dot of cap.dots ?? []) {
      const [cx, cy] = worldToScreen(dot.center.x, dot.center.y);
      g.beginPath();
      g.arc(cx, cy, dot.radius * cam.k, 0, Math.PI * 2);
      g.fill();
    }
    for (const stroke of cap.strokes ?? []) {
      g.beginPath();
      traceEdgePath(g, stroke.path);
      g.stroke();
    }
  }
}

function drawView(): void {
  fitCanvas(viewCanvas);
  const dpr = window.devicePixelRatio || 1;
  const g = viewCanvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, viewCanvas.clientWidth, viewCanvas.clientHeight);
  if (!layout) return;

  // 淡色网格背景：格线 = 矩形基准格（横向 cellW、纵向 cellH），与节点格位对齐。
  {
    const latticeX = layout.cellW;
    const latticeY = layout.cellH;
    const [wx0, wy0] = screenToWorld(0, 0);
    const [wx1, wy1] = screenToWorld(viewCanvas.clientWidth, viewCanvas.clientHeight);
    const startX = Math.floor(wx0 / latticeX) * latticeX;
    const startY = Math.floor(wy0 / latticeY) * latticeY;
    g.strokeStyle = '#e2e8f0';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = startX; x <= wx1; x += latticeX) {
      const [sx] = worldToScreen(x, 0);
      g.moveTo(sx, 0);
      g.lineTo(sx, viewCanvas.clientHeight);
    }
    for (let y = startY; y <= wy1; y += latticeY) {
      const [, sy] = worldToScreen(0, y);
      g.moveTo(0, sy);
      g.lineTo(viewCanvas.clientWidth, sy);
    }
    g.stroke();
  }

  const nv = layout.nodeViews;

  // 背景层 0：subgraph 容器（嵌套按深度升序绘制）
  const hubDepth = subgraphDepthMap(layout.subgraphViews);
  const hubs = [...layout.subgraphViews].sort(
    (a, b) => (hubDepth.get(String(a.id)) ?? 0) - (hubDepth.get(String(b.id)) ?? 0),
  );
  for (const nd of hubs) {
    const [sx, sy] = worldToScreen(nd.x, nd.y);
    const sh = nd.shape;
    const he = halfExtentsOf(sh);
    const w = he.hw * 2 * cam.k;
    const h = he.hh * 2 * cam.k;
    g.beginPath();
    shapePath(g, sh, sx, sy, cam.k, Math.min(10, h / 4));
    g.fillStyle = '#f1f5f9';
    g.fill();
    g.strokeStyle = '#94a3b8';
    g.lineWidth = 1.5;
    g.stroke();
    if (nd.label && cam.k > 0.35) {
      g.fillStyle = '#475569';
      g.font = `600 ${Math.max(9, 14 * cam.k)}px system-ui, 'PingFang SC', sans-serif`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(String(nd.label), sx - w / 2 + 12 * cam.k, sy - h / 2 + 14 * cam.k);
    }
  }

  // 边：连线风格策略管线（端口 → 贴合 → 路径 → 转弯 → 交叉）产出几何段；
  // 渲染端只负责把 line/arc/bezier 段与两端端帽翻译成画布命令，标签锚点
  // 已由管线算好。
  for (const geo of edgeGeometries()) {
    if (pathLength(geo.path) < 1) continue; // 两元素贴邻、端口重合：无可绘路径
    g.strokeStyle = '#64748b';
    g.lineWidth = 1.5;
    g.beginPath();
    traceEdgePath(g, geo.path);
    g.stroke();
    drawEndCaps(g, geo);

    if (geo.label !== null && geo.label !== '') {
      const box = estimateLabelBox(geo.label, 12, 3);
      const [smx, smy] = worldToScreen(geo.labelAnchor.x, geo.labelAnchor.y);
      const bw = Math.max(30, box.hw * 2 * cam.k);
      const bh = Math.max(14, box.hh * 2 * cam.k);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.fillRect(smx - bw / 2, smy - bh / 2, bw, bh);
      g.fillStyle = '#334155';
      g.font = `${Math.max(9, 12 * cam.k)}px system-ui, 'PingFang SC', sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const rows = box.rows.length > 1 && cam.k > 0.6 ? box.rows : [geo.label];
      rows.forEach((row, li) => {
        g.fillText(row.trim(), smx, smy + ((li - (rows.length - 1) / 2) * 13 * cam.k));
      });
    }
  }

  // 节点层：物化节点（nd.w/h 存在）按实占 AABB 矩形画，其余按声明形状
  for (const nd of nv) {
    const [sx, sy] = worldToScreen(nd.x, nd.y);
    const sh = nd.shape;
    g.beginPath();
    let labelTopOffset: number | null = null;
    if (nd.w !== undefined && nd.h !== undefined) {
      const w = nd.w * cam.k;
      const h = nd.h * cam.k;
      // 物化节点的轮廓跟声明 kind：circle/ellipse 画物化盒内切椭圆
      // （布局尺寸由文字阶梯决定，与声明 r/rx/ry 无关），rect 画圆角矩形。
      if (sh.kind === 'circle' || sh.kind === 'ellipse') {
        g.ellipse(sx, sy, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else {
        g.roundRect(sx - w / 2, sy - h / 2, w, h, Math.min(8, h / 4));
      }
    } else {
      const he = halfExtentsOf(sh);
      shapePath(g, sh, sx, sy, cam.k, Math.min(8, (he.hh * 2 * cam.k) / 4));
      if (sh.kind === 'rect' && sh.w >= 200) labelTopOffset = sh.h / 2 - 10;
    }
    g.fillStyle = '#e0f2fe';
    g.fill();
    g.strokeStyle = '#0284c7';
    g.lineWidth = 1.5;
    g.stroke();
    if (nd.label && cam.k > 0.35) {
      g.fillStyle = '#0c4a6e';
      g.font = `${Math.max(8, 12 * cam.k)}px system-ui, 'PingFang SC', sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // 与布局端同口径回绕（measureBox = estimateLabelBox(label, 12, 4)）：
      // 节点盒按回绕行数物化，绘制按同一 rows 分行，显示与计算联动。
      const box = estimateLabelBox(String(nd.label), 12, 4);
      const rows = box.rows.length > 1 && cam.k > 0.6 ? box.rows : [String(nd.label)];
      const baseY = labelTopOffset !== null ? sy - labelTopOffset * cam.k : sy;
      rows.forEach((row, li) => {
        g.fillText(row.trim(), sx, baseY + (li - (rows.length - 1) / 2) * 12 * cam.k);
      });
    }
  }
}

syncOutputs();
rebuild();
