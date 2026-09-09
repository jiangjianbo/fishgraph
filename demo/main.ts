import { ForceLayout, estimateLabelBox } from '../src/index.js';
import type { GraphSpec, LayoutOptions, NodeId } from '../src/index.js';

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

const GRAPHS: Record<string, () => GraphSpec> = {
  tree: treeGraph,
  grid: gridGraph,
  star: starGraph,
  mixed: mixedGraph,
  random: randomGraph,
  shapes: shapesGraph,
};

// ── UI 元素 ───────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const viewCanvas = $<HTMLCanvasElement>('view');
const energyCanvas = $<HTMLCanvasElement>('energy');
const statusEl = $('status');
const graphSel = $<HTMLSelectElement>('graph');
const algorithmSel = $<HTMLSelectElement>('algorithm');
const gravitySel = $<HTMLSelectElement>('gravity');
const accuracySel = $<HTMLSelectElement>('accuracy');
const initSel = $<HTMLSelectElement>('init');
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

function optionsFromUi(): LayoutOptions {
  return {
    algorithm: algorithmSel.value,
    naturalLength: Number(sliders.L.value),
    edgeNodeRepulsion: Number(sliders.en.value),
    weakGravityRatio: Number(sliders.wg.value) / 100,
    edgeTension: Number(sliders.kt.value) / 10,
    crossingShrink: Number(sliders.cs.value) / 100,
    hopRepulsionDecay: Number(sliders.hd.value) / 100,
    labelCollision: labelCollision.checked,
    gravity: gravitySel.value as LayoutOptions['gravity'],
    accuracy: accuracySel.value as LayoutOptions['accuracy'],
    init: initSel.value as LayoutOptions['init'],
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
}

// ── 布局实例与动画状态 ────────────────────────────────────

let layout: ForceLayout | null = null;
let converged = false;
let paused = false;
let iterations = 0;

function rebuild(): void {
  layout = new ForceLayout(GRAPHS[graphSel.value](), optionsFromUi());
  converged = false;
  iterations = 0;
  cam.x = 0;
  cam.y = 0;
  cam.k = 1;
}

// ── 视图变换（world ↔ screen）─────────────────────────────

const cam = { x: 0, y: 0, k: 1 };

function worldToScreen(wx: number, wy: number): [number, number] {
  return [(wx - cam.x) * cam.k + viewCanvas.clientWidth / 2, (wy - cam.y) * cam.k + viewCanvas.clientHeight / 2];
}
function screenToWorld(sx: number, sy: number): [number, number] {
  return [(sx - viewCanvas.clientWidth / 2) / cam.k + cam.x, (sy - viewCanvas.clientHeight / 2) / cam.k + cam.y];
}

// ── 交互：拖节点 / 平移 / 缩放 ────────────────────────────

type Drag =
  | { kind: 'node'; id: NodeId }
  | { kind: 'pan'; sx: number; sy: number; camX: number; camY: number }
  | null;
let drag: Drag = null;

function eventPos(ev: MouseEvent): [number, number] {
  const rect = viewCanvas.getBoundingClientRect();
  return [ev.clientX - rect.left, ev.clientY - rect.top];
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
    drag = { kind: 'pan', sx, sy, camX: cam.x, camY: cam.y };
  }
  viewCanvas.setPointerCapture(ev.pointerId);
});

viewCanvas.addEventListener('pointermove', (ev) => {
  if (!drag || !layout) return;
  const [sx, sy] = eventPos(ev);
  if (drag.kind === 'node') {
    const [wx, wy] = screenToWorld(sx, sy);
    layout.setNodePosition(drag.id, wx, wy);
    layout.fix(drag.id, wx, wy);
    converged = false; // 拖拽持续弛豫，实时看力场响应
  } else {
    cam.x = drag.camX - (sx - drag.sx) / cam.k;
    cam.y = drag.camY - (sy - drag.sy) / cam.k;
  }
});

viewCanvas.addEventListener('pointerup', () => {
  if (drag?.kind === 'node' && layout) layout.unfix(drag.id);
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
for (const el of [...Object.values(sliders), labelCollision]) {
  el.addEventListener('input', () => {
    syncOutputs();
    layout?.updateOptions(optionsFromUi());
    converged = false;
  });
}
for (const el of [algorithmSel, gravitySel, accuracySel]) {
  el.addEventListener('change', () => {
    layout?.updateOptions(optionsFromUi());
    converged = false;
  });
}
$('restart').addEventListener('click', rebuild);
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
});

// ── 绘制 ──────────────────────────────────────────────────

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

  const nv = layout.nodeViews;

  // 边：剪到起点/终点轮廓，末端画箭头；中点画白底文字
  for (const e of layout.edgeViews) {
    const a = nv[e.a];
    const b = nv[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const t0 = a.r * 0.9;
    const t1 = d - b.r * 0.9 - 3;
    if (t1 <= t0) continue;
    const x0 = a.x + ux * t0;
    const y0 = a.y + uy * t0;
    const x1 = a.x + ux * t1;
    const y1 = a.y + uy * t1;
    const [sx0, sy0] = worldToScreen(x0, y0);
    const [sx1, sy1] = worldToScreen(x1, y1);
    g.strokeStyle = '#64748b';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(sx0, sy0);
    g.lineTo(sx1, sy1);
    g.stroke();
    const ang = Math.atan2(sy1 - sy0, sx1 - sx0);
    g.fillStyle = '#64748b';
    g.beginPath();
    g.moveTo(sx1, sy1);
    g.lineTo(sx1 - 8 * Math.cos(ang - 0.4), sy1 - 8 * Math.sin(ang - 0.4));
    g.lineTo(sx1 - 8 * Math.cos(ang + 0.4), sy1 - 8 * Math.sin(ang + 0.4));
    g.closePath();
    g.fill();

    if (e.label !== null && e.label !== '') {
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
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

  // 节点
  for (const nd of nv) {
    const [sx, sy] = worldToScreen(nd.x, nd.y);
    const sh = nd.shape;
    g.beginPath();
    if (sh.kind === 'circle') {
      g.arc(sx, sy, sh.r * cam.k, 0, Math.PI * 2);
    } else if (sh.kind === 'ellipse') {
      g.ellipse(sx, sy, sh.rx * cam.k, sh.ry * cam.k, 0, 0, Math.PI * 2);
    } else {
      const w = sh.w * cam.k;
      const h = sh.h * cam.k;
      g.roundRect(sx - w / 2, sy - h / 2, w, h, Math.min(8, h / 4));
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
      g.fillText(String(nd.label), sx, sy);
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
