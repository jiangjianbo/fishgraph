import { it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { treeGraph, starCrossGraph } from '../demo/graphs.js';

it('trace tree', () => {
  (globalThis as any).DBG_STAGE = true;
  const layout = new ForceLayout(treeGraph(), {
    algorithm: 'grid-undirected', direction: 'none',
    naturalLength: 6, channelMargin: 1, labelCollision: true, folding: true, seed: 42,
  });
  layout.run();
});
it('trace starCross', () => {
  const layout = new ForceLayout(starCrossGraph(), {
    algorithm: 'grid-undirected', direction: 'none',
    naturalLength: 6, channelMargin: 1, labelCollision: true, folding: true, seed: 42,
  });
  layout.run();
});
