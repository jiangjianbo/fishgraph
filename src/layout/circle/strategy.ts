/**
 * CircleLayoutStrategy —— 最小的"另一种布局算法"，用于验证策略接缝。
 *
 * 把每个连通分量摆成一个正多边形环：环半径按 √n 缩放使弧间距与
 * naturalLength 同量级；多个分量沿大环排开、互不重叠。
 * 无力学、无迭代：构造即完成（step 恒返回 false）。
 */

import type { GraphStore } from '../../graph/store.js';
import { registerStrategy, type LayoutStrategy, type ResolvedLayoutOptions } from '../strategy.js';
import type { RunOptions, RunResult } from '../../types.js';

export class CircleLayoutStrategy implements LayoutStrategy {
  readonly name = 'circle';

  private store: GraphStore;
  private options: ResolvedLayoutOptions;

  constructor(store: GraphStore, options: ResolvedLayoutOptions) {
    this.store = store;
    this.options = options;
    this.place();
  }

  refresh(options: ResolvedLayoutOptions): void {
    const radiusChanged =
      options.naturalLength !== this.options.naturalLength ||
      options.seed !== this.options.seed;
    this.options = options;
    if (radiusChanged) this.place();
  }

  invalidate(): void {
    // 无力学：外部挪动节点后无需重算。
  }

  rebuild(): void {
    this.place();
  }

  step(): boolean {
    return false;
  }

  run(opts: RunOptions = {}): RunResult {
    void opts;
    return { iterations: 0, converged: true, energy: 0 };
  }

  get energy(): number {
    return 0;
  }

  get iterations(): number {
    return 0;
  }

  get converged(): boolean {
    return true;
  }

  get energyHistory(): number[] {
    return [];
  }

  get stage(): 3 {
    return 3;
  }

  /** 连通分量 → 正多边形环；分量中心沿大环排开。 */
  private place(): void {
    const { nodes, adj } = this.store;
    const n = nodes.length;
    if (n === 0) return;
    const L = this.options.naturalLength;
    // 连通分量（BFS）
    const comp = new Array<number>(n).fill(-1);
    const comps: number[][] = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] !== -1) continue;
      const members: number[] = [];
      const queue = [i];
      comp[i] = comps.length;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        members.push(cur);
        for (const j of adj[cur]) {
          if (comp[j] === -1) {
            comp[j] = comps.length;
            queue.push(j);
          }
        }
      }
      comps.push(members);
    }
    // 分量中心沿大环排开（间距按最大分量直径估算）
    const maxDiameter = Math.max(...comps.map((m) => L * Math.max(2, Math.sqrt(m.length))));
    const orbitRadius = comps.length > 1 ? (maxDiameter * comps.length) / (Math.PI * 2) + L : 0;
    comps.forEach((members, ci) => {
      const angle = (ci / comps.length) * Math.PI * 2;
      const cx = Math.cos(angle) * orbitRadius;
      const cy = Math.sin(angle) * orbitRadius;
      const radius = (L * Math.max(2, Math.sqrt(members.length))) / 2;
      members.forEach((idx, k) => {
        const a = (k / members.length) * Math.PI * 2 - Math.PI / 2;
        const nd = nodes[idx];
        if (nd.placed) return; // 显式定位的节点不动
        nd.x = cx + Math.cos(a) * radius;
        nd.y = cy + Math.sin(a) * radius;
      });
    });
  }
}

registerStrategy('circle', (store, options) => new CircleLayoutStrategy(store, options));
