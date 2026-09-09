/**
 * 初始摆放策略。
 *
 * 'bfs'（默认，推荐）：按"连线数从多到少"确定核心，逐层环状增量放置 ——
 * 先放度数最高的节点及其邻居形成中心结构，再依次加入次级节点及其邻居。
 * 增量顺序天然打破对称，产出的初始结构与图拓扑同构，收敛快且稳定。
 */

import type { LayoutNode } from '../../graph/store.js';
import { mulberry32 } from '../../rng.js';
import type { InitMode } from '../../types.js';

/** 度数优先的 BFS 增量放置。nodes 为全量节点，仅 movable 且未放置的会被摆放。
 *
 * 平面扇形展开（三遍式）：
 *   1. 度数优先 BFS 建生成树（父指针 + 访问顺序）；
 *   2. 自底向上统计每节点的子树规模；
 *   3. 锚点的角窗按子树规模比例切分给孩子，孩子在"背离父"方向的角窗内放置。
 * 子树角域递归不相交 → 树/森林初值即平面嵌入（无交叉）；配合交叉能量罚
 * 与能量单调下降，初值无交叉则弛豫全程无交叉。
 * （跳数斥力衰减后远程斥力不再能自动拉开交叉，初值平面性成为关键。） */
function placeByBfs(
  nodes: LayoutNode[],
  adjacency: Array<Set<number>>,
  L: number,
  strangerD: number,
  rng: () => number,
): void {
  const n = nodes.length;
  const placed = nodes.map((nd) => nd.placed);
  const movable = nodes.map((nd) => !nd.placed);
  const degree = adjacency.map((s) => s.size);

  // ── 1. 生成树：每个连通分量取"树中心"（剥叶法，偏心距最小）为根 ——
  // 结构中心的节点先放（排列原则 1），放射形态与直觉一致；BFS 建父指针。──
  const parent = new Array<number>(n).fill(-1);
  const order: number[] = [];
  let components = 0;
  for (let round = 0; round < n; round++) {
    // 未分配分量的任一节点作为该分量的种子
    let seed = -1;
    for (let i = 0; i < n; i++) {
      if (movable[i] && !placed[i] && parent[i] === -1) { seed = i; break; }
    }
    if (seed === -1) break;
    // 种子 BFS 收集分量成员
    const members: number[] = [];
    const seen = new Uint8Array(n);
    seen[seed] = 1;
    members.push(seed);
    for (let head = 0; head < members.length; head++) {
      for (const j of adjacency[members[head]]) {
        if (!seen[j]) { seen[j] = 1; members.push(j); }
      }
    }
    // 剥叶法找树中心：反复剥当前度为 1 的节点，最后 1~2 个即中心
    const deg = new Map<number, number>();
    const alive = new Set<number>(members);
    for (const m of members) deg.set(m, adjacency[m].size);
    while (alive.size > 2) {
      const leaves = [...alive].filter((m) => deg.get(m)! <= 1);
      if (leaves.length === 0) break;
      for (const lf of leaves) {
        alive.delete(lf);
        for (const nb of adjacency[lf]) {
          if (alive.has(nb)) deg.set(nb, deg.get(nb)! - 1);
        }
      }
    }
    // 中心（可能 1~2 个）取度数最大者为分量根
    let root = -1;
    for (const m of alive) {
      if (root === -1 || degree[m] > degree[root] || (degree[m] === degree[root] && m < root)) root = m;
    }
    parent[root] = -2; // 分量根标记
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      order.push(cur);
      for (const j of adjacency[cur]) {
        if (movable[j] && !placed[j] && parent[j] === -1) {
          parent[j] = cur;
          queue.push(j);
        }
      }
    }
    for (const q of queue) placed[q] = true;
    components++;
  }

  // ── 2. 自底向上子树规模（order 是 BFS 序，逆序保证孩子先于父）──
  const subtree = new Array<number>(n).fill(1);
  for (let i = order.length - 1; i >= 0; i--) {
    const cur = order[i];
    const p = parent[cur];
    if (p >= 0) subtree[p] += subtree[cur];
  }

  // ── 3. 放置：分量根就位后，逐锚点按子树规模切分角窗 ──
  let placedComponents = 0;
  // 队列元素：[节点, 来路方向角, 角窗配额]
  const queue: Array<[number, number, number]> = [];
  const done = new Uint8Array(n);
  for (let round = 0; round < n; round++) {
    // 找尚未摆放的分量根（parent=-2）
    let root = -1;
    for (let i = 0; i < n; i++) {
      if (parent[i] === -2 && !done[i]) root = i;
    }
    if (root === -1) break;
    if (placedComponents === 0) {
      nodes[root].x = 0;
      nodes[root].y = 0;
    } else {
      const angle = placedComponents * 2.399963 + (rng() - 0.5) * 0.3;
      const radius = strangerD * (1 + 0.25 * (placedComponents - 1));
      nodes[root].x = Math.cos(angle) * radius;
      nodes[root].y = Math.sin(angle) * radius;
    }
    placedComponents++;
    done[root] = 1;
    queue.push([root, 0, Math.PI * 2]);

    for (let head = 0; head < queue.length; head++) {
      const [anchor, incoming, slice] = queue[head];
      const children: number[] = [];
      for (const j of adjacency[anchor]) {
        if (parent[j] === anchor) children.push(j);
      }
      if (children.length === 0) continue;
      // 子树规模降序排列（与生成树的度数优先一致），窗口按规模比例切分
      children.sort((a, b) => subtree[b] - subtree[a]);
      const isComponentRoot = parent[anchor] === -2;
      // 展开中心 = 自己的角窗中心（放置时的方向角）。若以"背向父"为中心，
      // 窗宽 >180° 的大子树会包到来路方向、横跨父边 —— 必须与角窗一致。
      const spread = Math.min(isComponentRoot ? Math.PI * 2 : Math.PI * 1.8, slice);
      const base = incoming;
      const total = children.reduce((sum, c) => sum + subtree[c], 0);
      let acc = 0;
      for (const c of children) {
        const width = (spread * subtree[c]) / total;
        const angle =
          base - spread / 2 + acc + width / 2 + (rng() - 0.5) * width * 0.3;
        acc += width;
        const ringRadius = Math.max(
          L * 1.15,
          (L * 0.85 * Math.max(1, subtree[c])) / (2 * Math.PI),
        );
        const radius = ringRadius * (0.85 + rng() * 0.3);
        nodes[c].x = nodes[anchor].x + Math.cos(angle) * radius;
        nodes[c].y = nodes[anchor].y + Math.sin(angle) * radius;
        done[c] = 1;
        queue.push([c, angle, width]);
      }
    }
    queue.length = 0;
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
