/**
 * 质点网格粗布局 + 膨胀压实（doc/布局核心原则.md 无向图流水线的阶段 2/3）。
 *
 * 阶段 2（质点弹性网格放置）：所有节点一律视为 1×1 无面积质点，碰撞检查
 * 退化为格子占用查询（O(1)）。节点按度数降序逐个放置：度数最高者占据
 * 网格中心 (0,0)；后续节点以已放置邻居的格坐标为中心环形扩搜空格，
 * 按综合得分择优：
 *     score = 张力项 + w·环周长项
 *   张力项   = Σ 到已放置邻居的曼哈顿距离（连线像橡皮筋把节点拉向邻居）；
 *   环周长项 = 与候选格贴邻且图上相邻的已放置邻居对的环周长奖励 ——
 *              把节点拉进已放置邻居的"夹角"里，消灭长边穿透。
 * 搜索预算内找不到贴近邻居的空格（候选点周围被完全占满）时触发
 * 死锁机制：insertRow/insertColumn 把已放置节点整体推开一格，强行挤出
 * 新空间 —— 保障放置 100% 不死锁。
 *
 * 阶段 3（轴向膨胀与四方向压实）：质点网格坐标不含真实尺寸。压实阶段
 * 收集占用行/列并删除全部空行空列（推箱子式消灭大片空白），再按行/列
 * 上的最大包围半径计算相邻占用行/列的物理间距 —— 任意相邻占用行（列）
 * 的物理距离 ≥ 两侧最大半径和 + 目标间隙，因此任何两个节点的中心距
 * 都不小于半径和 + 间隙（无重叠由构造保证，不依赖弛豫兜底）。最后把
 * 网格坐标映射为连续坐标写回 x/y。
 *
 * 确定性：放置顺序、环扩展次序、死锁方向选择全部使用固定规则，
 * 同一组输入（含 seed 派生的 placed 反算）产出逐位一致的结果。
 */

import type { LayoutElement } from '../../graph/store.js';

/** 环周长奖励权重（相对张力项）：把节点拉进"夹角"的强度。 */
const RING_BONUS = 0.5;
/** 邻居环形扩搜的半径上限（格）。超出仍无合格空格即触发插行列。 */
const SEARCH_RING_CAP = 5;
/** 死锁判定：最佳空格张力超过该阈值视为候选点周围被完全占满。 */
const DEADLOCK_TENSION_FACTOR = 2;
const DEADLOCK_TENSION_EXTRA = 2;
/** 压实后相邻占用行/列的目标表面间隙（× naturalLength）。 */
const COMPACTION_GAP_RATIO = 0.3;

/** 格坐标键（列, 行）。 */
function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

interface Cell {
  gx: number;
  gy: number;
}

/** 已放置节点的格坐标（下标 → 格）。 */
type GridPos = Array<Cell | null>;

/** 质点网格：占用格（键 → 元素下标）+ 包围盒。 */
class PointGrid {
  readonly occ = new Map<string, number>();
  minGx = 0;
  maxGx = 0;
  minGy = 0;
  maxGy = 0;

  place(pos: Cell, index: number): void {
    this.occ.set(cellKey(pos.gx, pos.gy), index);
    this.minGx = Math.min(this.minGx, pos.gx);
    this.maxGx = Math.max(this.maxGx, pos.gx);
    this.minGy = Math.min(this.minGy, pos.gy);
    this.maxGy = Math.max(this.maxGy, pos.gy);
  }

  has(gx: number, gy: number): boolean {
    return this.occ.has(cellKey(gx, gy));
  }
}

/** 计算候选格的张力项：到全部已放置邻居的曼哈顿距离和。 */
function tension(gx: number, gy: number, neighbors: Cell[]): number {
  let sum = 0;
  for (const u of neighbors) {
    sum += Math.abs(gx - u.gx) + Math.abs(gy - u.gy);
  }
  return sum;
}

/**
 * 环周长奖励：与候选格 8 邻接的已放置邻居中，图上相邻的对构成环 ——
 * 每一对奖励一个 RING_BONUS（三角形环的周长 3 格已接近下限）。
 */
function ringBonus(
  gx: number,
  gy: number,
  neighborIdx: number[],
  posOf: GridPos,
  adjacency: Array<Set<number>>,
): number {
  const touching: number[] = [];
  for (const u of neighborIdx) {
    const p = posOf[u]!;
    if (Math.max(Math.abs(p.gx - gx), Math.abs(p.gy - gy)) === 1) touching.push(u);
  }
  let bonus = 0;
  for (let a = 0; a < touching.length; a++) {
    for (let b = a + 1; b < touching.length; b++) {
      if (adjacency[touching[a]].has(touching[b])) bonus += RING_BONUS;
    }
  }
  return bonus;
}

/**
 * 死锁机制：在锚点 (ux, uy) 的某一侧插入一行/列，把该侧所有已放置
 * 节点整体推开一格，挤出新空格并返回其坐标。方向取需要移动的占用格
 * 最少的一侧（平局按 +x/-x/+y/-y 固定序），保证确定性。
 */
function insertLine(grid: PointGrid, ux: number, uy: number): Cell {
  const dirs: Array<{ dx: 0 | 1 | -1; dy: 0 | 1 | -1 }> = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  let bestDir = dirs[0];
  let bestCost = Infinity;
  for (const dir of dirs) {
    let cost = 0;
    for (const key of grid.occ.keys()) {
      const [gx, gy] = key.split(',').map(Number);
      if (dir.dx === 1 && gx >= ux) cost++;
      else if (dir.dx === -1 && gx <= ux) cost++;
      else if (dir.dy === 1 && gy >= uy) cost++;
      else if (dir.dy === -1 && gy <= uy) cost++;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestDir = dir;
    }
  }
  const moved = new Map<string, number>();
  for (const [key, index] of grid.occ) {
    const [gx, gy] = key.split(',').map(Number);
    if (bestDir.dx === 1 && gx >= ux) moved.set(cellKey(gx + 1, gy), index);
    else if (bestDir.dx === -1 && gx <= ux) moved.set(cellKey(gx - 1, gy), index);
    else if (bestDir.dy === 1 && gy >= uy) moved.set(cellKey(gx, gy + 1), index);
    else if (bestDir.dy === -1 && gy <= uy) moved.set(cellKey(gx, gy - 1), index);
    else moved.set(key, index);
  }
  grid.occ.clear();
  grid.minGx = Infinity;
  grid.maxGx = -Infinity;
  grid.minGy = Infinity;
  grid.maxGy = -Infinity;
  for (const [key, index] of moved) {
    grid.occ.set(key, index);
    const [gx, gy] = key.split(',').map(Number);
    grid.minGx = Math.min(grid.minGx, gx);
    grid.maxGx = Math.max(grid.maxGx, gx);
    grid.minGy = Math.min(grid.minGy, gy);
    grid.maxGy = Math.max(grid.maxGy, gy);
  }
  return { gx: ux + bestDir.dx, gy: uy + bestDir.dy };
}

/** 放置一个已放置邻居的节点：环形扩搜 + 评分择优，必要时插行列解死锁。 */
function placeNearNeighbors(
  grid: PointGrid,
  neighborIdx: number[],
  posOf: GridPos,
  adjacency: Array<Set<number>>,
): Cell {
  const neighbors = neighborIdx.map((u) => posOf[u]!);
  const cx = Math.round(neighbors.reduce((s, p) => s + p.gx, 0) / neighbors.length);
  const cy = Math.round(neighbors.reduce((s, p) => s + p.gy, 0) / neighbors.length);
  const theoreticalMin = neighbors.length;
  let bestCell: Cell | null = null;
  let bestScore = Infinity;

  for (let ring = 1; ring <= SEARCH_RING_CAP; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // 只看环缘
        const gx = cx + dx;
        const gy = cy + dy;
        if (grid.has(gx, gy)) continue;
        const score =
          tension(gx, gy, neighbors) - ringBonus(gx, gy, neighborIdx, posOf, adjacency);
        if (score < bestScore) {
          bestCell = { gx, gy };
          bestScore = score;
        }
      }
    }
    // 已达理论最优（全部邻居贴邻）提前收工；前几环后不再扩大搜索。
    if (bestScore <= theoreticalMin) break;
    if (ring >= 3 && bestCell) break;
  }

  const deadlockLimit = DEADLOCK_TENSION_FACTOR * neighbors.length + DEADLOCK_TENSION_EXTRA;
  if (!bestCell || bestScore > deadlockLimit) {
    // 候选点周围被完全占满：插行列挤出新空间。
    let anchor = neighbors[0];
    let anchorDist = Infinity;
    for (const p of neighbors) {
      const d = Math.abs(p.gx - cx) + Math.abs(p.gy - cy);
      if (d < anchorDist) {
        anchorDist = d;
        anchor = p;
      }
    }
    bestCell = insertLine(grid, anchor.gx, anchor.gy);
  }
  return bestCell;
}

/** 放置孤立节点/新分量首节点：贴着已放置区域右边缘外侧，从顶行向下找空格。 */
function placeOrphan(grid: PointGrid): Cell {
  if (grid.occ.size === 0) return { gx: 0, gy: 0 };
  const gx = grid.maxGx + 1;
  for (let gy = grid.minGy; gy <= grid.maxGy; gy++) {
    if (!grid.has(gx, gy)) return { gx, gy };
  }
  return { gx, gy: grid.maxGy + 1 };
}

/**
 * 质点网格粗布局 + 膨胀压实（就地写回 elements[i].x/y）。
 *
 * 用户显式定位（placed）的元素预先反算占格且最终不被移动；
 * 其余元素全部按度数降序放置。整体平移使布局质心位于原点
 * （有 placed 元素时改为对齐 placed 的实际坐标均值）。
 */
export function coarsePlacement(
  elements: readonly LayoutElement[],
  adjacency: Array<Set<number>>,
  naturalLength: number,
): void {
  const n = elements.length;
  if (n === 0) return;
  const cell = Math.max(naturalLength, 1e-3);
  const grid = new PointGrid();
  const posOf: GridPos = new Array(n).fill(null);

  // 用户显式定位的元素：连续坐标反算占格（冲突时向右找相邻空格）。
  for (let i = 0; i < n; i++) {
    const el = elements[i];
    if (!el.placed) continue;
    let gx = Math.round(el.x / cell);
    const gy = Math.round(el.y / cell);
    while (grid.has(gx, gy)) gx++;
    grid.place({ gx, gy }, i);
    posOf[i] = { gx, gy };
  }

  // 度数降序 + 连通生长（Prim 式）：从全局度数最高的节点开始，每次从
  // 「已放置节点的未放置邻居」候选集中取度数最高者放置 —— 骨架连续生长，
  // 每个节点都有已放置邻居可贴近（纯度数排序会让中心节点晚于其邻居
  // 放置，骨架断裂产生长边穿透）。候选集耗尽后，剩余节点取度数最高者
  // 作为新分量的种子（孤儿放置）。
  const deg = (i: number): number => adjacency[i].size;
  const done = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) done[i] = !!posOf[i];
  const candidates = new Set<number>();
  const enqueueNeighbors = (v: number): void => {
    for (const u of adjacency[v]) {
      if (!done[u]) candidates.add(u);
    }
  };

  let remaining = n;
  for (let i = 0; i < n; i++) {
    if (done[i]) remaining--;
  }
  while (remaining > 0) {
    // 种子：候选集为空时，从剩余节点取度数最高者（平局按下标升序）。
    if (candidates.size === 0) {
      let seed = -1;
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        if (seed < 0 || deg(v) > deg(seed)) seed = v;
      }
      const cellPos = placeOrphan(grid);
      grid.place(cellPos, seed);
      posOf[seed] = cellPos;
      done[seed] = true;
      remaining--;
      enqueueNeighbors(seed);
      continue;
    }
    // 候选集中度数最高者（平局按下标升序，保证确定性）。
    let v = -1;
    for (const c of candidates) {
      if (v < 0 || deg(c) > deg(v) || (deg(c) === deg(v) && c < v)) v = c;
    }
    candidates.delete(v);
    const cellPos = placeNearNeighbors(
      grid,
      [...adjacency[v]].filter((u) => posOf[u]),
      posOf,
      adjacency,
    );
    grid.place(cellPos, v);
    posOf[v] = cellPos;
    done[v] = true;
    remaining--;
    enqueueNeighbors(v);
  }

  // ── 压实 + 变距映射：删空行空列，按行/列最大半径拉伸物理间距 ──

  const rows: number[] = [];
  const cols: number[] = [];
  const rowAt = new Map<number, number>();
  const colAt = new Map<number, number>();
  for (const key of grid.occ.keys()) {
    const [gx, gy] = key.split(',').map(Number);
    if (!rowAt.has(gy)) {
      rowAt.set(gy, rows.length);
      rows.push(gy);
    }
    if (!colAt.has(gx)) {
      colAt.set(gx, cols.length);
      cols.push(gx);
    }
  }
  rows.sort((a, b) => a - b);
  cols.sort((a, b) => a - b);
  rows.forEach((gy, t) => rowAt.set(gy, t));
  cols.forEach((gx, s) => colAt.set(gx, s));

  const gap = COMPACTION_GAP_RATIO * cell;
  const maxRowR = new Array<number>(rows.length).fill(0);
  const maxColR = new Array<number>(cols.length).fill(0);
  for (const [key, index] of grid.occ) {
    const [gx, gy] = key.split(',').map(Number);
    const r = elements[index].getBoundRadius();
    const t = rowAt.get(gy)!;
    const s = colAt.get(gx)!;
    if (r > maxRowR[t]) maxRowR[t] = r;
    if (r > maxColR[s]) maxColR[s] = r;
  }
  // 相邻占用行/列的物理间距 ≥ 两侧最大半径和 + 间隙：
  // 任意两个节点至少有一个坐标分量满足表面间隙，无重叠由构造保证。
  const xs = new Array<number>(cols.length);
  xs[0] = 0;
  for (let s = 1; s < cols.length; s++) {
    xs[s] = xs[s - 1] + maxColR[s - 1] + maxColR[s] + gap;
  }
  const ys = new Array<number>(rows.length);
  ys[0] = 0;
  for (let t = 1; t < rows.length; t++) {
    ys[t] = ys[t - 1] + maxRowR[t - 1] + maxRowR[t] + gap;
  }

  // 整体平移：有 placed 对齐其实际坐标均值，否则质心归原点。
  let ox = 0;
  let oy = 0;
  let placedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!elements[i].placed) continue;
    const p = posOf[i]!;
    ox += elements[i].x - xs[colAt.get(p.gx)!];
    oy += elements[i].y - ys[rowAt.get(p.gy)!];
    placedCount++;
  }
  if (placedCount > 0) {
    ox /= placedCount;
    oy /= placedCount;
  } else {
    let sx = 0;
    let sy = 0;
    for (const key of grid.occ.keys()) {
      const [gx, gy] = key.split(',').map(Number);
      sx += xs[colAt.get(gx)!];
      sy += ys[rowAt.get(gy)!];
    }
    ox = -sx / grid.occ.size;
    oy = -sy / grid.occ.size;
  }

  for (const [key, index] of grid.occ) {
    const [gx, gy] = key.split(',').map(Number);
    const el = elements[index];
    if (el.placed) continue; // 用户显式定位的元素不移动
    el.x = xs[colAt.get(gx)!] + ox;
    el.y = ys[rowAt.get(gy)!] + oy;
  }
}
