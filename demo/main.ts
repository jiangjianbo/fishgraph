import { ForceLayout, estimateLabelBox, halfExtentsOf, rayShapeExit } from '../src/index.js';
import type { GraphSpec, ShapeSpec, SubgraphView } from '../src/index.js';

// ── 示例图 ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + 0x6d2b79f5) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function gridGraph(): GraphSpec {
  const n = 5;
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      nodes.push({ id: `${x},${y}` });
      if (x + 1 < n) edges.push({ source: `${x},${y}`, target: `${x + 1},${y}` });
      if (y + 1 < n) edges.push({ source: `${x},${y}`, target: `${x},${y + 1}` });
    }
  }
  return { nodes, edges };
}

function starGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [{ id: 'hub', label: 'hub' }];
  const edges: GraphSpec['edges'] = [];
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `s${i}`, label: `s${i}` });
    edges.push({ source: 'hub', target: `s${i}` });
  }
  return { nodes, edges };
}

function mixedGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  // 两个成群团块（K4 与 K3）+ 4 个离散点
  for (let i = 0; i < 4; i++) nodes.push({ id: `c1-${i}`, label: `c1-${i}` });
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      edges.push({ source: `c1-${i}`, target: `c1-${j}` });
  for (let i = 0; i < 3; i++) nodes.push({ id: `c2-${i}`, label: `c2-${i}` });
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      edges.push({ source: `c2-${i}`, target: `c2-${j}` });
  for (let i = 0; i < 4; i++) nodes.push({ id: `iso-${i}`, label: `iso-${i}` });
  return { nodes, edges };
}

function randomGraph(): GraphSpec {
  const rnd = mulberry32(7);
  const n = 80;
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  for (let i = 0; i < n; i++) nodes.push({ id: i, label: String(i) });
  const seen = new Set<string>();
  for (let k = 0; k < 120; k++) {
    const a = Math.floor(rnd() * n);
    const b = Math.floor(rnd() * n);
    if (a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: a, target: b });
  }
  return { nodes, edges };
}

function shapesGraph(): GraphSpec {
  return {
    nodes: [
      { id: 'req', shape: { kind: 'rect', w: 150, h: 46 }, label: '需求评审' },
      { id: 'dev', shape: { kind: 'rect', w: 150, h: 46 }, label: '开发实现' },
      { id: 'qa', shape: { kind: 'rect', w: 150, h: 46 }, label: '测试验收' },
      { id: 'ok', shape: { kind: 'circle', r: 26 }, label: '发布' },
      { id: 'gate', shape: { kind: 'ellipse', rx: 52, ry: 30 }, label: '质量门禁' },
      { id: 'fix', shape: { kind: 'rect', w: 120, h: 40 }, label: '回归修复' },
    ],
    edges: [
      { source: 'req', target: 'dev', label: '排期确认' },
      { source: 'dev', target: 'gate', label: '提交检入' },
      { source: 'gate', target: 'qa', label: 'PASS' },
      { source: 'gate', target: 'fix', label: 'FAIL 打回' },
      { source: 'fix', target: 'dev', label: '修复后重新提交' },
      { source: 'qa', target: 'ok', label: '通过' },
    ],
  };
}

function flowGraph(): GraphSpec {
  // 有向流程图（direction=TB/LR 时展示层级布局）
  return {
    nodes: [
      { id: 'start', label: '开始' },
      { id: 'input', label: '读取输入' },
      { id: 'check', label: '校验' },
      { id: 'work', label: '处理' },
      { id: 'retry', label: '重试' },
      { id: 'done', label: '完成' },
    ],
    edges: [
      { source: 'start', target: 'input' },
      { source: 'input', target: 'check' },
      { source: 'check', target: 'work' },
      { source: 'work', target: 'done' },
      { source: 'check', target: 'retry', label: '失败' },
      { source: 'retry', target: 'work' },
    ],
  };
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

function mermaidSubgraphGraph(): GraphSpec {
  return {
    nodes: [
      { id: 'CORE', label: 'ui-core' },
      { id: 'EVENT', label: 'ui-event' },
      { id: 'I18N', label: 'ui-i18n' },
      { id: 'THEME', label: 'ui-theme' },
      { id: 'BASE', label: 'ui-button/ui-input/ui-dialog/ui-table/…' },
      { id: 'BUSINESS', label: 'ui-business-user/ui-business-data/ui-business-permission' },
      { id: 'PROJECT', label: 'ui-web-project/ui-android-project/ui-desktop-project' },
      { id: 'PNPM', label: 'pnpm workspace' },
      { id: 'REG', label: 'Private npm Registry/Verdaccio' },
      { id: 'WEB', label: 'Web Project' },
      { id: 'ANDROID', label: 'Android Project' },
      { id: 'OTHER', label: 'Other Projects' },
    ],
    edges: [
      { source: 'CORE', target: 'BASE' },
      { source: 'EVENT', target: 'BASE' },
      { source: 'I18N', target: 'BASE' },
      { source: 'THEME', target: 'BASE' },
      { source: 'BASE', target: 'BUSINESS' },
      { source: 'BUSINESS', target: 'PROJECT' },
      { source: 'PNPM', target: 'CORE', label: '管理' },
      { source: 'PNPM', target: 'BASE', label: '管理' },
      { source: 'PNPM', target: 'BUSINESS', label: '管理' },
      { source: 'PNPM', target: 'PROJECT', label: '管理' },
      { source: 'BASE', target: 'REG', label: 'publish' },
      { source: 'BUSINESS', target: 'REG', label: 'publish' },
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
}

const GRAPHS: Record<string, () => GraphSpec> = {
  tree: treeGraph,
  grid: gridGraph,
  star: starGraph,
  mixed: mixedGraph,
  random: randomGraph,
  shapes: shapesGraph,
  flow: flowGraph,
  groups: groupsGraph,
  mermaidSub: mermaidSubgraphGraph,
};

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

function buildOptions() {
  return {
    algorithm: 'grid-undirected' as const,
    direction: directionSel.value as 'none' | 'TB' | 'LR',
    naturalLength: Number(sliders.L.value),
    channelMargin: Number(sliders.cm.value),
    labelCollision: labelCollision.checked,
    seed: 42,
  };
}

function syncOutputs(): void {
  outs.L.value = sliders.L.value;
  outs.cm.value = sliders.cm.value;
}

// ── 布局实例 ──────────────────────────────────────────────

let layout: ForceLayout | null = null;

function rebuild(): void {
  layout = new ForceLayout(GRAPHS[graphSel.value](), buildOptions());
  layout.run();
  fitToView();
  drawView();
  const nv = layout.nodeViews.length;
  const ev = layout.edgeViews.length;
  statusEl.textContent = `${nv} 节点 · ${ev} 边 · 纯网格布局（确定性，构造期完成）`;
}

for (const el of [...Object.values(sliders), labelCollision]) {
  el.addEventListener('input', () => {
    syncOutputs();
    if (!layout) return;
    layout.updateOptions(buildOptions());
    layout.run();
    fitToView();
    drawView();
    statusEl.textContent = `${layout.nodeViews.length} 节点 · ${layout.edgeViews.length} 边 · 纯网格布局（确定性，构造期完成）`;
  });
}
graphSel.addEventListener('change', rebuild);
directionSel.addEventListener('change', () => {
  layout?.updateOptions(buildOptions());
  layout?.run();
  fitToView();
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

function drawView(): void {
  fitCanvas(viewCanvas);
  const dpr = window.devicePixelRatio || 1;
  const g = viewCanvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, viewCanvas.clientWidth, viewCanvas.clientHeight);
  if (!layout) return;

  // 淡色网格背景：格线 = 粗布局格胞（L × 比例尺），与节点格位对齐。
  {
    const lattice = Number(sliders.L.value) * layout.cellScale;
    const [wx0, wy0] = screenToWorld(0, 0);
    const [wx1, wy1] = screenToWorld(viewCanvas.clientWidth, viewCanvas.clientHeight);
    const startX = Math.floor(wx0 / lattice) * lattice;
    const startY = Math.floor(wy0 / lattice) * lattice;
    g.strokeStyle = '#e2e8f0';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = startX; x <= wx1; x += lattice) {
      const [sx] = worldToScreen(x, 0);
      g.moveTo(sx, 0);
      g.lineTo(sx, viewCanvas.clientHeight);
    }
    for (let y = startY; y <= wy1; y += lattice) {
      const [, sy] = worldToScreen(0, y);
      g.moveTo(0, sy);
      g.lineTo(viewCanvas.clientWidth, sy);
    }
    g.stroke();
  }

  const nv = layout.nodeViews;
  const edgeEnds = [...nv, ...layout.subgraphViews];

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

  // 边：按走线拐点画折线（A* 正交走线）；两端按真实形状贴合，末端箭头；
  // 标签画在折线路径长度中点
  for (const e of layout.edgeViews) {
    const a = edgeEnds[e.sourceIndex];
    const b = edgeEnds[e.targetIndex];
    const wps = e.waypoints && e.waypoints.length >= 2 ? e.waypoints : [a, b];
    const d0 = Math.hypot(wps[1]!.x - a.x, wps[1]!.y - a.y) || 1;
    const u0x = (wps[1]!.x - a.x) / d0;
    const u0y = (wps[1]!.y - a.y) / d0;
    const t0 = rayShapeExit(a.shape, u0x, u0y);
    const last = wps[wps.length - 2]!;
    const d1 = Math.hypot(b.x - last.x, b.y - last.y) || 1;
    const u1x = (b.x - last.x) / d1;
    const u1y = (b.y - last.y) / d1;
    const t1 = rayShapeExit(b.shape, -u1x, -u1y) + 3;
    const isLine = wps.length === 2;
    if (isLine && d1 - t1 <= t0) continue;
    const pts = [
      { x: a.x + u0x * t0, y: a.y + u0y * t0 },
      ...wps.slice(1, -1),
      { x: b.x - u1x * t1, y: b.y - u1y * t1 },
    ];
    const scr = pts.map((p) => worldToScreen(p.x, p.y));
    g.strokeStyle = '#64748b';
    g.lineWidth = 1.5;
    g.beginPath();
    scr.forEach(([sx, sy], i) => (i === 0 ? g.moveTo(sx, sy) : g.lineTo(sx, sy)));
    g.stroke();
    const [sx1, sy1] = scr[scr.length - 1]!;
    const ang = Math.atan2(sy1 - scr[scr.length - 2]![1], sx1 - scr[scr.length - 2]![0]);
    g.fillStyle = '#64748b';
    g.beginPath();
    g.moveTo(sx1, sy1);
    g.lineTo(sx1 - 8 * Math.cos(ang - 0.4), sy1 - 8 * Math.sin(ang - 0.4));
    g.lineTo(sx1 - 8 * Math.cos(ang + 0.4), sy1 - 8 * Math.sin(ang + 0.4));
    g.closePath();
    g.fill();

    if (e.label !== null && e.label !== '') {
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      }
      let remain = total / 2;
      let mx = pts[0]!.x;
      let my = pts[0]!.y;
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        if (seg >= remain) {
          const r = seg === 0 ? 0 : remain / seg;
          mx = pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * r;
          my = pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * r;
          break;
        }
        remain -= seg;
      }
      const box = estimateLabelBox(e.label, 12, 3);
      const [smx, smy] = worldToScreen(mx, my);
      const bw = Math.max(30, box.hw * 2 * cam.k);
      const bh = Math.max(14, box.hh * 2 * cam.k);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.fillRect(smx - bw / 2, smy - bh / 2, bw, bh);
      g.fillStyle = '#334155';
      g.font = `${Math.max(9, 12 * cam.k)}px system-ui, 'PingFang SC', sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const rows = box.rows.length > 1 && cam.k > 0.6 ? box.rows : [e.label];
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
      g.roundRect(sx - w / 2, sy - h / 2, w, h, Math.min(8, h / 4));
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
      g.fillText(String(nd.label), sx, labelTopOffset !== null ? sy - labelTopOffset * cam.k : sy);
    }
  }
}

syncOutputs();
rebuild();
