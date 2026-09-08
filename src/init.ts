/**
 * 初始摆放策略。
 *
 * 'bfs'（默认，推荐）：按"连线数从多到少"确定核心，逐层环状增量放置 ——
 * 先放度数最高的节点及其邻居形成中心结构，再依次加入次级节点及其邻居。
 * 增量顺序天然打破对称，产出的初始结构与图拓扑同构，收敛快且稳定。
 */

import type { LayoutNode } from './forces.js';
import { mulberry32 } from './rng.js';
import type { InitMode } from './types.js';

/** 度数优先的 BFS 增量放置。nodes 为全量节点，仅 movable 且未放置的会被摆放。 */
function placeByBfs(
  nodes: LayoutNode[],
  adjacency: Array<Set<number>>,
  L: number,
  strangerD: number,
  rng: () => number,
): void {
  const n = nodes.length;
  // placed：已有位置（显式给定或本函数已摆放）；movable：允许本函数移动。
  const placed = nodes.map((nd) => nd.placed);
  const movable = nodes.map((nd) => !nd.placed);
  const degree = adjacency.map((s) => s.size);
  // 黄金角：让同一锚点的多个邻居均匀散开
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const childCount = new Array<number>(n).fill(0);
  // 每个连通分量一个根；分量根之间的间距按"陌生节点平衡距离"标定，
  // 否则弱引力来不及把挤在一起的分量重排开。
  let components = 0;

  for (let round = 0; round < n; round++) {
    // 找尚未放置（且可移动）的最高度数节点作为分量种子
    let root = -1;
    for (let i = 0; i < n; i++) {
      if (movable[i] && !placed[i] && (root === -1 || degree[i] > degree[root])) root = i;
    }
    if (root === -1) break;

    const componentQueue = [root];
    placed[root] = true;
    if (components === 0) {
      nodes[root].x = 0;
      nodes[root].y = 0;
    } else {
      const angle = components * 2.399963 + (rng() - 0.5) * 0.3;
      const radius = strangerD * (1 + 0.25 * (components - 1));
      nodes[root].x = Math.cos(angle) * radius;
      nodes[root].y = Math.sin(angle) * radius;
    }
    components++;

    while (componentQueue.length > 0) {
      const anchor = componentQueue.shift()!;
      // 邻居按度数从高到低加入
      const neighbors = [...adjacency[anchor]]
        .filter((j) => movable[j] && !placed[j])
        .sort((a, b) => degree[b] - degree[a]);
      // 环半径按邻居数量扩展，避免高密度锚点的子环自身重叠
      const ringRadius = Math.max(
        L * 1.15,
        (L * 0.85 * neighbors.length) / (2 * Math.PI),
      );
      for (const j of neighbors) {
        placed[j] = true;
        componentQueue.push(j);
        const k = childCount[anchor]++;
        const angle = k * GOLDEN + rng() * 0.35;
        const radius = ringRadius * (0.85 + rng() * 0.3);
        nodes[j].x = nodes[anchor].x + Math.cos(angle) * radius;
        nodes[j].y = nodes[anchor].y + Math.sin(angle) * radius;
      }
    }
  }
}

/**
 * 给未显式指定位置的节点一个初始布局。
 * 好的初值能显著减少收敛迭代数；'bfs'（度数优先增量放置）对各类拓扑都最稳健。
 */
export function applyInitPlacement(
  nodes: LayoutNode[],
  adjacency: Array<Set<number>>,
  mode: InitMode,
  L: number,
  seed: number,
  strangerD: number,
): void {
  const free = nodes.filter((nd) => !nd.placed);
  const n = free.length;
  if (n === 0) return;
  const rng = mulberry32(seed);

  switch (mode) {
    case 'bfs': {
      // 全量节点 + 全量邻接参与 BFS（显式放置的节点可作锚点），但只移动 free 节点。
      placeByBfs(nodes, adjacency, L, strangerD, rng);
      break;
    }
    case 'circle': {
      // 半径随 √n 增长，保持圆周上相邻节点的弧间距与 L 同量级。
      const radius = L * Math.max(2, Math.sqrt(n));
      free.forEach((nd, k) => {
        // 确定性抖动：打破完美对称（否则正多边形鞍点会锁死对称破缺）。
        // 幅度按槽间距缩放（≤30% 弧间距），保证相邻节点不会互相挤过。
        const angle = (k / n) * Math.PI * 2 + (rng() - 0.5) * ((Math.PI * 2) / n) * 0.3;
        const r = radius * (1 + (rng() - 0.5) * 0.04);
        nd.x = Math.cos(angle) * r;
        nd.y = Math.sin(angle) * r;
      });
      break;
    }
    case 'grid': {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const spacing = L * 1.5;
      const ox = (-(cols - 1) / 2) * spacing;
      const rows = Math.ceil(n / cols);
      const oy = (-(rows - 1) / 2) * spacing;
      free.forEach((nd, k) => {
        const col = k % cols;
        const row = Math.floor(k / cols);
        nd.x = ox + col * spacing + (rng() - 0.5) * spacing * 0.1;
        nd.y = oy + row * spacing + (rng() - 0.5) * spacing * 0.1;
      });
      break;
    }
    case 'random': {
      const span = L * Math.sqrt(n) * 1.2;
      for (const nd of free) {
        nd.x = (rng() - 0.5) * 2 * span;
        nd.y = (rng() - 0.5) * 2 * span;
      }
      break;
    }
  }
}
