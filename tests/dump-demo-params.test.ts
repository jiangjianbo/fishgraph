import { it } from 'vitest';
import {
  AabbEndpointFitStrategy, EdgeStyleRenderer, FixedPortStrategy, ForceLayout,
  NoneEndCapStrategy, OrthogonalPolylinePathStrategy, PlainCrossingStrategy, SharpCornerStrategy,
} from '../src/index.js';
import type { GraphSpec, Vec2 } from '../src/types.js';

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

const groupsSpec: GraphSpec = {
  nodes: [
    { id: 'in-a', label: 'in-a' }, { id: 'in-b', label: 'in-b' }, { id: 'in-c', label: 'in-c' },
    { id: 'chain-1', label: '链1' }, { id: 'chain-2', label: '链2' }, { id: 'chain-3', label: '链3' },
    { id: 'ext-1', label: '外部1' }, { id: 'ext-2', label: '外部2' },
  ],
  edges: [
    { source: 'in-a', target: 'in-b' }, { source: 'in-b', target: 'in-c' },
    { source: 'chain-1', target: 'chain-2' }, { source: 'chain-2', target: 'chain-3' },
    { source: 'sub', target: 'ext-1' }, { source: 'ext-2', target: 'sub' },
    { source: 'ext-1', target: 'in-b' },
  ],
  subgraphs: [
    { id: 'sub', shape: { kind: 'rect', w: 380, h: 280 }, label: '子图', members: ['in-a', 'in-b', 'in-c'] },
  ],
};

const mk = () => new EdgeStyleRenderer({
  source: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new NoneEndCapStrategy() },
  target: { ports: new FixedPortStrategy(), fit: new AabbEndpointFitStrategy(), cap: new NoneEndCapStrategy() },
  path: new OrthogonalPolylinePathStrategy(),
  corners: new SharpCornerStrategy(),
  crossings: new PlainCrossingStrategy(),
});
const ptsOf = (g: { path: { start: { x: number; y: number }; segments: unknown[] } }): Vec2[] =>
  [g.path.start, ...g.path.segments.map((s: any) => (s.kind === 'line' ? s.to : null)).filter((p): p is Vec2 => p !== null)];

it('tree with demo params', () => {
  const layout = new ForceLayout(treeGraph(), {
    algorithm: 'grid-undirected', direction: 'none', naturalLength: 6,
    channelMargin: 1, labelCollision: true, folding: true, seed: 42,
  });
  layout.run();
  const views = [...layout.nodeViews];
  const byId = new Map(views.map((v) => [String(v.id), v]));
  for (const id of ['root', 'b1', 'b3', 'b2', 'l3-2', 'l2-3']) {
    const v = byId.get(id)!;
    console.log(`NODE ${id}: (${v.x!.toFixed(1)},${v.y!.toFixed(1)}) ${v.w}x${v.h}`);
  }
  const evs = [...layout.edgeViews];
  const geos = mk().render({ nodeViews: views, subgraphViews: [...layout.subgraphViews], edgeViews: evs });
  let minTail = Infinity;
  let minTailEdge = '';
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]!;
    const sid = String(views[ev.sourceIndex]!.id);
    const tid = String(views[ev.targetIndex]!.id);
    const pts = ptsOf(geos[i]!);
    const tail = Math.hypot(pts[pts.length-1]!.x - pts[pts.length-2]!.x, pts[pts.length-1]!.y - pts[pts.length-2]!.y);
    if (tail < minTail) { minTail = tail; minTailEdge = `${sid}->${tid}`; }
    if ((sid === 'root' && tid === 'b1') || (sid === 'b3' && tid === 'l3-2') || (sid === 'b2' && tid === 'l2-3')) {
      console.log(`EDGE ${sid}->${tid}: ${pts.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(' -> ')} [tail=${tail.toFixed(1)}]`);
    }
  }
  console.log(`MIN_TAIL ${minTail.toFixed(1)} at ${minTailEdge}`);
});

it('groups with demo params', () => {
  const layout = new ForceLayout(groupsSpec, {
    algorithm: 'grid-undirected', direction: 'none', naturalLength: 6,
    channelMargin: 1, labelCollision: true, folding: true, seed: 42,
  });
  layout.run();
  const views = [...layout.nodeViews];
  const evs = [...layout.edgeViews];
  const geos = mk().render({ nodeViews: views, subgraphViews: [...layout.subgraphViews], edgeViews: evs });
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]!;
    const si = ev.sourceIndex, ti = ev.targetIndex;
    if (si > 7 || ti > 7) continue;
    const sid = String(views[si]!.id), tid = String(views[ti]!.id);
    if (!(sid === 'in-a' && tid === 'in-b') && !(sid === 'in-b' && tid === 'in-c')) continue;
    const pts = ptsOf(geos[i]!);
    console.log(`EDGE ${sid}->${tid}: ${pts.length} pts ${pts.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(' -> ')}`);
  }
});
