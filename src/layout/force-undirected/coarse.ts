/**
 * 质点网格粗布局 + 膨胀压实（doc/布局核心原则.md 流水线的阶段 2/3）。
 *
 * 主流程（连通生长 → 环形扩搜 → 死锁插行列 → 压实映射）与方向无关，
 * 全部在此实现；与"放置美学"相关的四个决策点抽为 CoarseHeuristics
 * 钩子（搜索锚点 / 候选评分 / 死锁判定 / 死锁解法），由具体算法提供：
 *  - undirectedHeuristics（本文件）：无向图 —— 邻居均值锚点、
 *    张力−环周长评分、四方向最小移动插行列；
 *  - 有向图（layout/force-directed/）：层级行锚点、软层级惩罚评分、
 *    优先插列 —— 见 doc/布局核心原则.md 有向图流水线。
 *
 * 阶段 2（质点弹性网格放置）：所有节点一律视为 1×1 无面积质点，碰撞检查
 * 退化为格子占用查询（O(1)）。节点按「度数优先连通生长」（Prim 式候选集）
 * 逐个放置：度数最高者占据网格中心 (0,0)；后续节点以 heuristics.anchor
 * 为中心环形扩搜空格，按 heuristics.score 择优。搜索预算内无合格空格时
 * 触发死锁机制：heuristics.deadlock 把已放置节点整体推开一格，强行挤出
 * 新空间 —— 保障放置 100% 不死锁。
 *
 * 阶段 3（轴向膨胀与压实）：压实阶段收集占用行/列并删除全部空行空列
 * （推箱子式消灭大片空白），再按行/列上的最大包围半径计算相邻占用行/列
 * 的物理间距 —— 任意相邻占用行（列）的物理距离 ≥ 两侧最大半径和 + 目标
 * 间隙，因此任何两个节点的中心距都不小于半径和 + 间隙（无重叠由构造
 * 保证，不依赖弛豫兜底）。最后把网格坐标映射为连续坐标写回 x/y。
 *
 * 确定性：放置顺序、环扩展次序、死锁方向选择全部使用固定规则，
 * 同一组输入（含 seed 派生的 placed 反算）产出逐位一致的结果。
 */

import type { LayoutElement } from '../../graph/store.js';

/** 邻居环形扩搜的半径上限（格）。超出仍无合格空格即触发死锁机制。 */
const SEARCH_RING_CAP = 5;
/** 压实后相邻占用行/列的目标表面间隙（× naturalLength）。 */
const COMPACTION_GAP_RATIO = 0.3;

/** 格坐标键（列, 行）。 */
function cellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

/**
 * 粗布局的可选行为开关。
 */
export interface CoarsePlacementOptions {
  /**
   * 忽略用户显式定位（placed）：分组布局的组内层级在自身的局部坐标系中
   * 运行，成员上残留的外层世界坐标不具备"用户定位"语义 —— 视全部元素
   * 为未定位（否则 placed 成员会被留在局部布局之外，污染块包围盒）。
   */
  ignorePlaced?: boolean;
}

export interface Cell {
  gx: number;
  gy: number;
}

/** 已放置节点的格坐标（下标 → 格）。 */
type GridPos = Array<Cell | null>;

/** 插行列的方向（沿该方向把占用格整体推开一格）。 */
export interface PushDir {
  dx: 0 | 1 | -1;
  dy: 0 | 1 | -1;
}

/** 四方向（+x/−x/+y/−y）：无向图死锁的候选方向集。 */
export const PUSH_DIRS_ALL: readonly PushDir[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

/** 质点网格：占用格（键 → 元素下标）+ 包围盒。 */
export class PointGrid {
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

/**
 * 死锁机制：在锚点 (ux, uy) 的 dirs 中某一侧插入一行/列，把该侧所有
 * 已放置节点整体推开一格，挤出新空格并返回其坐标。方向取需要移动的
 * 占用格最少的一侧（平局按 dirs 给定序），保证确定性。
 */
export function insertLine(
  grid: PointGrid,
  ux: number,
  uy: number,
  dirs: readonly PushDir[] = PUSH_DIRS_ALL,
): Cell {
  let bestDir = dirs[0]!;
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
  // 推开条件含锚点本身（>=），锚点的占用者总被移走 —— 挤出的新格就是
  // 锚点格自己（锚点本来为空时同样成立）。绝不能返回推挤方向上的相邻格：
  // 那是锚点占用者的新位置，写回时会把已放置节点从占用表里覆盖掉。
  return { gx: ux, gy: uy };
}

/** 放置差异钩子：主流程在四个决策点上向具体算法征求答案。 */
export interface CoarseHeuristics {
  /** 搜索锚点（环形扩搜的中心格）。 */
  anchor(v: number, neighbors: readonly Cell[]): Cell;
  /**
   * 候选格评分（越小越优）。neighbors 与 neighborIndices 平行：
   * 已放置邻居的格坐标及其元素下标（可查 adjacency 判断图上相邻）。
   */
  score(
    v: number,
    gx: number,
    gy: number,
    neighbors: readonly Cell[],
    neighborIndices: readonly number[],
  ): number;
  /**
   * 死锁判定：是否已差到该触发插列。v 为正在放置的元素；theoreticalMin
   * 为全部邻居贴邻时的得分下界（主流程计算）；bestCell 为当前最佳空格
   * （搜索预算内一个空格都没有时为 null —— 这总是死锁）。综合分差大但
   * 空格尚可的候选不一定算死锁（插列是"挤出新空间"的手段，要不要推挤
   * 由具体算法的放置美学决定）。
   */
  isDeadlock(
    v: number,
    bestScore: number,
    theoreticalMin: number,
    neighborCount: number,
    bestCell: Cell | null,
  ): boolean;
  /** 死锁解法：以最近邻居格为锚整体推开已放置节点，返回挤出的新格。 */
  deadlock(grid: PointGrid, anchor: Cell): Cell;
  /**
   * 新分量种子的落格（可选）。缺省 placeOrphan：贴已放置区域右缘外侧。
   * 有向算法覆写它把种子放到自己的层级行上 —— 否则微调期的流动弹簧
   * 要把种子从任意落点硬拉回层级，拉不到位就在上游行卡住（逆流）。
   */
  placeSeed?(grid: PointGrid, v: number): Cell;
}

/**
 * 无向图放置美学（默认实现，doc/布局核心原则.md 无向图阶段 2）：
 *  - 锚点 = 已放置邻居的格坐标均值；
 *  - 评分 = 张力项（到全部已放置邻居的曼哈顿距离和，连线像橡皮筋）
 *    − 环周长奖励（与候选格 8 邻接且图上相邻的邻居对，把节点拉进
 *    "夹角"里消灭长边穿透）；
 *  - 死锁 = 最佳得分超过 2×邻居数+2；解法 = 四方向最小移动插行列。
 */
export function undirectedHeuristics(adjacency: Array<Set<number>>): CoarseHeuristics {
  const RING_BONUS = 0.5;
  const DEADLOCK_TENSION_FACTOR = 2;
  const DEADLOCK_TENSION_EXTRA = 2;

  /** 计算候选格的张力项。 */
  const tension = (gx: number, gy: number, neighbors: readonly Cell[]): number => {
    let sum = 0;
    for (const u of neighbors) {
      sum += Math.abs(gx - u.gx) + Math.abs(gy - u.gy);
    }
    return sum;
  };

  /**
   * 环周长奖励：与候选格 8 邻接的已放置邻居中，图上相邻的对构成环 ——
   * 每一对奖励一个 RING_BONUS（三角形环的周长 3 格已接近下限）。
   */
  const ringBonus = (
    gx: number,
    gy: number,
    neighborCells: readonly Cell[],
    neighborIdx: readonly number[],
  ): number => {
    const touching: number[] = [];
    for (let k = 0; k < neighborIdx.length; k++) {
      const p = neighborCells[k]!;
      if (Math.max(Math.abs(p.gx - gx), Math.abs(p.gy - gy)) === 1) touching.push(neighborIdx[k]!);
    }
    let bonus = 0;
    for (let a = 0; a < touching.length; a++) {
      for (let b = a + 1; b < touching.length; b++) {
        if (adjacency[touching[a]!].has(touching[b]!)) bonus += RING_BONUS;
      }
    }
    return bonus;
  };

  return {
    anchor(_v, neighbors) {
      return {
        gx: Math.round(neighbors.reduce((s, p) => s + p.gx, 0) / neighbors.length),
        gy: Math.round(neighbors.reduce((s, p) => s + p.gy, 0) / neighbors.length),
      };
    },
    score(v, gx, gy, neighbors, neighborIndices) {
      return tension(gx, gy, neighbors) - ringBonus(gx, gy, neighbors, neighborIndices);
    },
    isDeadlock(_v, bestScore, _theoreticalMin, neighborCount, bestCell) {
      return (
        bestCell === null ||
        bestScore > DEADLOCK_TENSION_FACTOR * neighborCount + DEADLOCK_TENSION_EXTRA
      );
    },
    deadlock(grid, anchor) {
      return insertLine(grid, anchor.gx, anchor.gy);
    },
  };
}

/** 放置一个已放置邻居的节点：环形扩搜 + 评分择优，必要时走死锁机制。 */
function placeWithHeuristics(
  grid: PointGrid,
  v: number,
  placedNeighborIdx: number[],
  posOf: GridPos,
  heuristics: CoarseHeuristics,
): Cell {
  const neighbors = placedNeighborIdx.map((u) => posOf[u]!);
  const anchor = heuristics.anchor(v, neighbors);
  const cx = anchor.gx;
  const cy = anchor.gy;
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
        const score = heuristics.score(v, gx, gy, neighbors, placedNeighborIdx);
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

  if (
    !bestCell ||
    heuristics.isDeadlock(v, bestScore, theoreticalMin, neighbors.length, bestCell)
  ) {
    // 候选点周围被完全占满：按最近邻居格为锚插行列挤出新空间。
    let near = neighbors[0]!;
    let nearDist = Infinity;
    for (const p of neighbors) {
      const d = Math.abs(p.gx - cx) + Math.abs(p.gy - cy);
      if (d < nearDist) {
        nearDist = d;
        near = p;
      }
    }
    bestCell = heuristics.deadlock(grid, near);
  }
  return bestCell!;
}

/** 放置孤立节点/新分量首节点：贴着已放置区域右边缘外侧，从顶行向下找空格。 */
export function placeOrphan(grid: PointGrid): Cell {
  if (grid.occ.size === 0) return { gx: 0, gy: 0 };
  const gx = grid.maxGx + 1;
  for (let gy = grid.minGy; gy <= grid.maxGy; gy++) {
    if (!grid.has(gx, gy)) return { gx, gy };
  }
  return { gx, gy: grid.maxGy + 1 };
}

/**
 * 纯质点网格放置的结果（阶段 2 产物，不含压实与坐标写回）。
 * grid-first 流水线（grid-undirected）消费本结果做后续的 AABB 膨胀、
 * 通道压实与走线；力导向流水线则继续走 coarsePlacement 的压实映射。
 */
export interface CoarsePlacementGrid {
  /** 已放置完成的占用网格（每格一元素）。 */
  grid: PointGrid;
  /** 每元素的格坐标（放置 100% 不死锁，无 null 项）。 */
  posOf: GridPos;
  /** 格距（物理 px）。 */
  cell: number;
  /** 放置顺序（元素下标；placed 反算在前，其余按连通生长/种子序）。 */
  order: number[];
}

/**
 * 阶段 2：纯质点网格放置（不压实、不写回坐标）。
 *
 * 用户显式定位（placed）的元素预先反算占格；其余元素按「度数优先
 * 连通生长」放置。详见文件头与 doc/布局核心原则.md 无向图阶段 2。
 */
export function coarseGridPlacement(
  elements: readonly LayoutElement[],
  adjacency: Array<Set<number>>,
  naturalLength: number,
  heuristics: CoarseHeuristics = undirectedHeuristics(adjacency),
  options: CoarsePlacementOptions = {},
): CoarsePlacementGrid {
  const n = elements.length;
  if (n === 0) return { grid: new PointGrid(), posOf: [], cell: Math.max(naturalLength, 1e-3), order: [] };
  const cell = Math.max(naturalLength, 1e-3);
  const grid = new PointGrid();
  const posOf: GridPos = new Array(n).fill(null);
  const order: number[] = [];
  const ignorePlaced = options.ignorePlaced ?? false;

  // 用户显式定位的元素：连续坐标反算占格（冲突时向右找相邻空格）。
  for (let i = 0; i < n; i++) {
    const el = elements[i];
    if (!el.placed || ignorePlaced) continue;
    let gx = Math.round(el.x / cell);
    const gy = Math.round(el.y / cell);
    while (grid.has(gx, gy)) gx++;
    grid.place({ gx, gy }, i);
    posOf[i] = { gx, gy };
    order.push(i);
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
      const cellPos = heuristics.placeSeed
        ? heuristics.placeSeed(grid, seed)
        : placeOrphan(grid);
      grid.place(cellPos, seed);
      posOf[seed] = cellPos;
      done[seed] = true;
      remaining--;
      order.push(seed);
      enqueueNeighbors(seed);
      continue;
    }
    // 候选集中度数最高者（平局按下标升序，保证确定性）。
    let v = -1;
    for (const c of candidates) {
      if (v < 0 || deg(c) > deg(v) || (deg(c) === deg(v) && c < v)) v = c;
    }
    candidates.delete(v);
    const placed = [...adjacency[v]].filter((u) => posOf[u]);
    const cellPos =
      placed.length > 0
        ? placeWithHeuristics(grid, v, placed, posOf, heuristics)
        : placeOrphan(grid);
    grid.place(cellPos, v);
    posOf[v] = cellPos;
    done[v] = true;
    remaining--;
    order.push(v);
    enqueueNeighbors(v);
  }

  return { grid, posOf, cell, order };
}

/**
 * 质点网格粗布局 + 膨胀压实（就地写回 elements[i].x/y）。
 *
 * 用户显式定位（placed）的元素预先反算占格且最终不被移动；
 * 其余元素按「度数优先连通生长」放置。整体平移使布局质心位于原点
 * （有 placed 元素时改为对齐 placed 的实际坐标均值）。
 * heuristics 缺省为无向图放置美学；有向图算法传入层级引导实现。
 */
export function coarsePlacement(
  elements: readonly LayoutElement[],
  adjacency: Array<Set<number>>,
  naturalLength: number,
  heuristics: CoarseHeuristics = undirectedHeuristics(adjacency),
  options: CoarsePlacementOptions = {},
): void {
  const n = elements.length;
  if (n === 0) return;
  const ignorePlaced = options.ignorePlaced ?? false;
  const { grid, posOf, cell } = coarseGridPlacement(elements, adjacency, naturalLength, heuristics, options);

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
    if (ignorePlaced || !elements[i].placed) continue;
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
    if (el.placed && !ignorePlaced) continue; // 用户显式定位的元素不移动
    el.x = xs[colAt.get(gx)!] + ox;
    el.y = ys[rowAt.get(gy)!] + oy;
  }
}
