import { ForceLayout, estimateLabelBox, halfExtentsOf, rayShapeExit, shapeContains } from '../src/index.js';
import type { GraphSpec, LayoutOptions, NodeId, ShapeSpec, SubgraphView } from '../src/index.js';

// ── 示例图 ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
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
      nodes.push({ id: `${x},${y}`, label: `${x},${y}` });
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
    hiddenGroups: [
      { id: 'hidden', members: ['chain-1', 'chain-2', 'chain-3'] },
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
  groups: groupsGraph,
  mermaidSub: mermaidSubgraphGraph,
};

// ── UI 元素 ───────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewCanvas = $<HTMLCanvasElement>('view');
const energyCanvas = $<HTMLCanvasElement>('energy');
const statusEl = $('status');
const graphSel = $<HTMLSelectElement>('graph');
const algorithmSel = $<HTMLSelectElement>('algorithm');
const directionSel = $<HTMLSelectElement>('direction');
const gravitySel = $<HTMLSelectElement>('gravity');
const accuracySel = $<HTMLSelectElement>('accuracy');
const sliders = {
  L: $<HTMLInputElement>('L'),
  en: $<HTMLInputElement>('en'),
  wg: $<HTMLInputElement>('wg'),
  kt: $<HTMLInputElement>('kt'),
  cs: $<HTMLInputElement>('cs'),
  hd: $<HTMLInputElement>('hd'),
};
const outs = {
  L: $<HTMLOutputElement>('Lv'),
  en: $<HTMLOutputElement>('env'),
  wg: $<HTMLOutputElement>('wgv'),
  kt: $<HTMLOutputElement>('ktv'),
  cs: $<HTMLOutputElement>('csv'),
  hd: $<HTMLOutputElement>('hdv'),
};
const labelCollision = $<HTMLInputElement>('lc');
const gsSlider = $<HTMLInputElement>('gs');
const gsOut = $<HTMLOutputElement>('gsv');

function optionsFromUi(): LayoutOptions {
  return {
    algorithm: algorithmSel.value,
    direction: directionSel.value as LayoutOptions['direction'],
    naturalLength: Number(sliders.L.value),
    edgeNodeRepulsion: Number(sliders.en.value),
    weakGravityRatio: Number(sliders.wg.value) / 100,
    edgeTension: Number(sliders.kt.value) / 10,
    crossingShrink: Number(sliders.cs.value) / 100,
    hopRepulsionDecay: Number(sliders.hd.value) / 100,
    gridSize: Number(gsSlider.value),
    labelCollision: labelCollision.checked,
    gravity: gravitySel.value as LayoutOptions['gravity'],
    accuracy: accuracySel.value as LayoutOptions['accuracy'],
    seed: 42,
  };
}

function syncOutputs(): void {
  outs.L.value = sliders.L.value;
  outs.en.value = sliders.en.value;
  outs.wg.value = `${(Number(sliders.wg.value) / 100).toFixed(2)}`;
  outs.kt.value = (Number(sliders.kt.value) / 10).toFixed(1);
  outs.cs.value = (Number(sliders.cs.value) / 100).toFixed(2);
  outs.hd.value = (Number(sliders.hd.value) / 100).toFixed(2);
  gsOut.value = gsSlider.value;
}

// ── 布局实例与动画状态 ────────────────────────────────────

let layout: ForceLayout | null = null;
let converged = false;
let paused = false;
let iterations = 0;
/** 布局（重）开始后待执行的视图适配标记：收敛时 fit 一次后清除，
 *  用户交互（拖拽/缩放）引发的再收敛不重复触发。 */
let needFit = false;

function rebuild(): void {
  layout = new ForceLayout(GRAPHS[graphSel.value](), optionsFromUi());
  converged = false;
  iterations = 0;
  needFit = true;
  cam.x = 0;
  cam.y = 0;
  cam.k = 1;
  // 粗布局在构造期已完成，坐标可用：立即适配一次，弛豫收敛后再精调一次
  fitToView();
}

// ── 视图变换（world ↔ screen）─────────────────────────────

const cam = { x: 0, y: 0, k: 1 };

function worldToScreen(wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.k + viewCanvas.clientWidth / 2, (wy - cam.y) * cam.k + viewCanvas.clientHeight / 2];
}
function screenToWorld(sx: number, sy: number): [number, number] {
  return [(sx - viewCanvas.clientWidth / 2) / cam.k + cam.x, (sy - viewCanvas.clientHeight / 2) / cam.k + cam.y];
}

/**
 * 视图适配（fit-to-view）：把布局包围盒平移缩放到画布中央。包围盒口径 =
 * 节点实占（物化 w/h，无则包围圆 r）∪ subgraph 容器形状，四周留 40px；
 * 缩放钳制在与滚轮一致的 [0.1, 2]。重建与算法切换时自动触发（收敛时
 * 再精调一次），也可用"适应视图"按钮手动触发。
 */
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
  if (!Number.isFinite(x0)) return; // 空图无可适配
  const pad = 40;
  const k = Math.min(
    2,
    Math.max(
      0.1,
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

// ── 交互：拖节点 / 拖容器 / 平移 / 缩放 ────────────────────

type Drag =
  | { kind: 'node'; id: NodeId }
  | { kind: 'subgraph'; id: NodeId; members: NodeId[]; lastX: number; lastY: number }
  | { kind: 'pan'; sx: number; sy: number; camX: number; camY: number }
  | null;
let drag: Drag = null;

function eventPos(ev: MouseEvent): [number, number] {
  const rect = viewCanvas.getBoundingClientRect();
  return [ev.clientX - rect.left, ev.clientY - rect.top];
}

/** 点是否落在容器形状内（dx/dy 为相对容器中心的偏移；几何口径统一走 geometry）。 */
function pointInSubgraph(v: SubgraphView, dx: number, dy: number): boolean {
  return shapeContains(v.shape, 0, 0, dx, dy);
}

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

viewCanvas.addEventListener('pointerdown', (ev) => {
  if (!layout) return;
  const [sx, sy] = eventPos(ev);
  const [wx, wy] = screenToWorld(sx, sy);
  let hit: NodeId | null = null;
  let bestDist = Infinity;
  for (const nd of layout.nodeViews) {
    const d = Math.hypot(nd.x - wx, nd.y - wy);
    if (d <= Math.max(nd.r, 14 / cam.k) && d < bestDist) {
      bestDist = d;
      hit = nd.id;
    }
  }
  if (hit !== null) {
    drag = { kind: 'node', id: hit };
    layout.fix(hit);
    viewCanvas.classList.add('dragging');
  } else {
    // 容器命中：嵌套时取最深的容器（视觉上在最上层）
    const views = layout.subgraphViews;
    if (views.length > 0) {
      const depth = subgraphDepthMap(views);
      let best: SubgraphView | null = null;
      let bestDepth = -1;
      for (const v of views) {
        if (!pointInSubgraph(v, wx - v.x, wy - v.y)) continue;
        const d = depth.get(String(v.id)) ?? 0;
        if (d > bestDepth) {
          bestDepth = d;
          best = v;
        }
      }
      if (best) {
        const members: NodeId[] = [best.id, ...layout.subgraphMemberIds(best.id)];
        drag = { kind: 'subgraph', id: best.id, members, lastX: wx, lastY: wy };
        for (const m of members) layout.fix(m);
        viewCanvas.classList.add('dragging');
      }
    }
  }
  if (!drag) drag = { kind: 'pan', sx, sy, camX: cam.x, camY: cam.y };
  viewCanvas.setPointerCapture(ev.pointerId);
});

viewCanvas.addEventListener('pointermove', (ev) => {
  if (!drag || !layout) return;
  const [sx, sy] = eventPos(ev);
  if (drag.kind === 'node') {
    const [wx, wy] = screenToWorld(sx, sy);
    const p = layout.clampToContainer(drag.id, wx, wy);
    layout.setNodePosition(drag.id, p.x, p.y);
    layout.fix(drag.id, p.x, p.y);
    converged = false; // 拖拽持续弛豫，实时看力场响应
  } else if (drag.kind === 'subgraph') {
    const [wx, wy] = screenToWorld(sx, sy);
    const dx = wx - drag.lastX;
    const dy = wy - drag.lastY;
    drag.lastX = wx;
    drag.lastY = wy;
    // 容器带动全部成员（含嵌套）刚性平移，连线随端点走
    const pos = layout.positions;
    for (const m of drag.members) {
      const cur = pos.get(m);
      if (!cur) continue;
      layout.setNodePosition(m, cur.x + dx, cur.y + dy);
      layout.fix(m, cur.x + dx, cur.y + dy);
    }
    converged = false;
  } else {
    cam.x = drag.camX - (sx - drag.sx) / cam.k;
    cam.y = drag.camY - (sy - drag.sy) / cam.k;
  }
});

viewCanvas.addEventListener('pointerup', () => {
  if (layout && drag?.kind === 'node') layout.unfix(drag.id);
  if (layout && drag?.kind === 'subgraph') {
    for (const m of drag.members) layout.unfix(m);
  }
  drag = null;
  viewCanvas.classList.remove('dragging');
});

viewCanvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const [sx, sy] = eventPos(ev);
  const [wx, wy] = screenToWorld(sx, sy);
  cam.k = Math.min(8, Math.max(0.1, cam.k * Math.pow(1.0015, -ev.deltaY)));
  // 保持鼠标下的世界坐标不动
  cam.x = wx - (sx - viewCanvas.clientWidth / 2) / cam.k;
  cam.y = wy - (sy - viewCanvas.clientHeight / 2) / cam.k;
});

// 参数滑条：实时换参数继续弛豫
for (const el of [...Object.values(sliders), labelCollision, gsSlider]) {
  el.addEventListener('input', () => {
    syncOutputs();
    layout?.updateOptions(optionsFromUi());
    converged = false;
  });
}
graphSel.addEventListener('change', () => rebuild()); // 切换图需要整体重建布局实例
for (const el of [algorithmSel, directionSel, gravitySel, accuracySel]) {
  el.addEventListener('change', () => {
    layout?.updateOptions(optionsFromUi());
    converged = false;
    // 换算法/方向会整体重排（新策略或 rebuild），坐标全部失效：立即适配
    // 新布局，收敛后再由 needFit 精调一次
    needFit = true;
    fitToView();
  });
}
$('restart').addEventListener('click', rebuild);
$('fitView').addEventListener('click', fitToView);
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
});

// ── 绘制 ──────────────────────────────────────────────────

/**
 * 容器嵌套深度表：children 引用其它容器 id 视为嵌套，深度 = 1 +
 * 最深子容器深度（子为物理节点计 0）。供绘制排序使用——深度浅的
 * 容器先画（更靠底层），内层容器框才不会被外层填充盖住。
 */
function subgraphDepthMap(views: readonly SubgraphView[]): Map<string, number> {
  const byId = new Map(views.map((v) => [String(v.id), v] as const));
  const depth = new Map<string, number>();
  const visit = (id: string, path: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const v = byId.get(id);
    if (!v || path.has(id)) return 0; // path 防环（store 构造已拒绝环，双保险）
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

  // 淡色网格背景（吸附参考线）：格线画在格胞边界 i·lattice 上，
  // 节点吸附在格胞中心 (i+0.5)·lattice —— 格线从节点之间穿过。
  // 间距读布局实际使用的格距（自适应后可能与滑杆值不同），未修正时
  // 回退滑杆值。
  {
    const lattice = layout.gridLattice ?? (Number(gsSlider.value) || 120);
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
  // 边端点下标基于 elements 数组（物理节点在前、subgraph 容器按声明序
  // 追加在后）：以容器 id 为端点的边在 nodeViews（仅物理节点）中越界，
  // 需要拼上容器视图才能解析端点坐标。
  const edgeEnds = [...nv, ...layout.subgraphViews];

  // 背景层 0：subgraph 容器 —— z-order 硬约束：容器是画面最底层，
  // 必须先于所有连线与节点绘制，不得遮掩任何节点和连线（连线与节点
  // 在后续层统一绘制，永远位于容器之上）；嵌套容器按深度升序绘制
  // （外层先画、内层后画），保证内层容器框不被外层填充盖住。
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


  // 边：优先按走线拐点画折线（grid-undirected 的 A* 正交走线），
  // 无 waypoints 时退化为直线；两端按各自真实形状贴合求交（圆/矩形/
  // 椭圆轮廓的精确出射点），末端画箭头；标签画在折线路径长度中点
  for (const e of layout.edgeViews) {
    const a = edgeEnds[e.sourceIndex];
    const b = edgeEnds[e.targetIndex];
    // 走线点序列（含首末中心）；无 waypoints（连续布局）时即直线两端
    const wps = e.waypoints && e.waypoints.length >= 2 ? e.waypoints : [a, b];
    // 首段方向：从 a 中心贴形状出射
    const d0 = Math.hypot(wps[1]!.x - a.x, wps[1]!.y - a.y) || 1;
    const u0x = (wps[1]!.x - a.x) / d0;
    const u0y = (wps[1]!.y - a.y) / d0;
    const t0 = rayShapeExit(a.shape, u0x, u0y);
    // 末段方向：贴 b 形状入射；末端回退量 = 形状出射距离 + 3px 箭头余量
    const last = wps[wps.length - 2]!;
    const d1 = Math.hypot(b.x - last.x, b.y - last.y) || 1;
    const u1x = (b.x - last.x) / d1;
    const u1y = (b.y - last.y) / d1;
    const t1 = rayShapeExit(b.shape, -u1x, -u1y) + 3;
    const isLine = wps.length === 2;
    // 直线时两端贴合点交叠（贴邻节点）则无可画长度
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
    // 箭头按末段方向
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
      // 路径长度中点：累计折线段长取一半，定位标签（正交走线时落在
      // 中间走廊段上，不压节点）
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

  // 节点层：普通节点（subgraph 容器已在背景层绘制）。
  // grid-undirected 物化节点（nd.w/nd.h 存在）按实占 AABB 矩形画，
  // 其余按声明形状画。
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
      // subgraph（大矩形）的标签画在矩形顶部内侧，不遮挡内部成员
      if (sh.kind === 'rect' && sh.w >= 200) labelTopOffset = sh.h / 2 - 10;
    }
    g.fillStyle = nd.fixed ? '#fef9c3' : '#e0f2fe';
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

function drawEnergy(): void {
  fitCanvas(energyCanvas);
  const dpr = window.devicePixelRatio || 1;
  const g = energyCanvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, energyCanvas.clientWidth, energyCanvas.clientHeight);
  const hist = layout?.energyHistory ?? [];
  if (hist.length < 2) return;
  const w = energyCanvas.clientWidth;
  const h = energyCanvas.clientHeight;
  // 对数尺度（能量恒正时），负值段画 0 线以下
  const samples = hist.filter((_, i) => i % Math.max(1, Math.floor(hist.length / 2400)) === 0);
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of samples) {
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  if (hi - lo < 1e-12) {
    hi = lo + 1;
  }
  g.strokeStyle = '#0ea5e9';
  g.lineWidth = 1.25;
  g.beginPath();
  samples.forEach((e, i) => {
    const x = (i / (samples.length - 1)) * (w - 16) + 8;
    const y = h - 8 - ((e - lo) / (hi - lo)) * (h - 28);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#94a3b8';
  g.font = '10px system-ui';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText(`E ∈ [${lo.toFixed(1)}, ${hi.toFixed(1)}]`, 8, 14);
}

// ── 主循环 ────────────────────────────────────────────────

const STEPS_PER_FRAME = 3;

function frame(): void {
  if (layout && !paused && !converged) {
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      if (!layout.step()) break;
      iterations++;
    }
    if (layout.converged) converged = true;
  }
  // 布局收敛后的视图适配（重建/换算法置位，fit 一次即清除）
  if (converged && needFit) {
    needFit = false;
    fitToView();
  }
  drawView();
  drawEnergy();
  const nv = layout?.nodeViews.length ?? 0;
  const ev = layout?.edgeViews.length ?? 0;
  const e = layout ? layout.energy : null;
  statusEl.textContent =
    `${nv} 节点 · ${ev} 边\n迭代 ${iterations} · ${converged ? '已收敛 ✓' : paused ? '已暂停' : '弛豫中…'}` +
    (e !== null ? `\n能量 ${e.toExponential(3)}` : '');
  requestAnimationFrame(frame);
}

syncOutputs();
rebuild();
requestAnimationFrame(frame);
