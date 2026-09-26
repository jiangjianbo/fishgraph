/**
 * 质点网格粗布局（doc/布局核心原则.md 流水线的阶段 2）。
 *
 * 主流程（波纹连通生长 → 环形扩搜 → 死锁插行列）与方向无关，全部在此
 * 实现；与"放置美学"相关的四个决策点抽为 CoarseHeuristics 钩子（搜索
 * 锚点 / 候选评分 / 死锁判定 / 死锁解法），由具体模式提供：
 *  - undirectedHeuristics（本文件）：无向 —— 邻居均值锚点、
 *    张力−环周长评分（环内方位分类平局项）、四方向最小移动插行列；
 *  - directedHeuristics（directed-placement.ts）：有向 —— 层级行锚点、
 *    软层级惩罚评分、优先插列。
 *
 * 阶段 2（质点弹性网格放置）：所有节点一律视为 1×1 无面积质点，碰撞检查
 * 退化为格子占用查询（O(1)）。节点按「波纹连通生长」（BFS 层序队列）
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
export type GridPos = Array<Cell | null>;

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
 *
 * posOf 必传：被推开的每个节点其在 posOf 中的格坐标必须同步平移——
 * 否则后续放置按过期邻居坐标评分、grid-first 流水线按过期锚点膨胀
 * （两个节点可占进同一格，实测导致矩阵图折叠成 5×6）。
 */
export function insertLine(
  grid: PointGrid,
  ux: number,
  uy: number,
  posOf: GridPos,
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
    const p = posOf[index];
    if (p) {
      p.gx = gx;
      p.gy = gy;
    }
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
  /**
   * 死锁解法：以最近邻居格为锚整体推开已放置节点，返回挤出的新格。
   * posOf 必须随推挤同步平移（见 insertLine）。
   */
  deadlock(grid: PointGrid, anchor: Cell, posOf: GridPos): Cell;
  /**
   * 新分量种子的落格（可选）。缺省 placeOrphan：紧凑落格（贴靠已放置
   * 区域最紧的空格）。有向算法覆写它把种子放到自己的层级行上 —— 否则
   * 微调期的流动弹簧要把种子从任意落点硬拉回层级，拉不到位就在上游
   * 行卡住（逆流）。
   */
  placeSeed?(grid: PointGrid, v: number): Cell;
}

/**
 * 无向图放置美学（默认实现，doc/布局核心原则.md 无向图阶段 2）：
 *  - 锚点 = 已放置邻居的格坐标均值；
 *  - 评分 = 张力项（到全部已放置邻居的曼哈顿距离和，连线像橡皮筋）
 *    − 环周长奖励（与候选格 8 邻接且图上相邻的邻居对，把节点拉进
 *    "夹角"里消灭长边穿透）+ 方位分类项（可选，
 *    见 UndirectedHeuristicsOptions）；
 *  - 死锁 = 最佳得分超过 2×邻居数+2；解法 = 四方向最小移动插行列。
 */
export interface UndirectedHeuristicsOptions {
  /**
   * 环内方位分类项（grid-undirected 启用，默认关）：边的走向优先落在
   * 邻居的十字（水平/垂直）方位，45° 对角次之，其他方位再次 —— 在张力
   * 同分的候选之间，正交 > 45° > 杂角。距离维全权由张力项承担（分类
   * 能力量级 < 张力的每格 1），本项只做环内平局裁决。力导向流水线默认
   * 关闭：该项改变粗拓扑，弛豫+吸附管线有自己的形状契约基线。
   */
  directionClass?: boolean;
}

export function undirectedHeuristics(
  adjacency: Array<Set<number>>,
  options: UndirectedHeuristicsOptions = {},
): CoarseHeuristics {
  const RING_BONUS = 0.5;
  const DEADLOCK_TENSION_FACTOR = 2;
  const DEADLOCK_TENSION_EXTRA = 2;
  // 方位分类能量：十字 0 < 对角 0.25 < 杂角 0.5（量级压在张力每格 1 之下）。
  const DIAGONAL_COST = 0.25;
  const OBLIQUE_COST = 0.5;

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

  /**
   * 单条边的方位分类成本（dx/dy = 候选格相对邻居格的位移）。
   * 十字折扣只给贴邻（曼哈顿距离 1）：距离 >1 的十字方向属张力维，已由
   * 张力项按格计价，不再享受平局折扣——否则「远距离十字长边」以 0 成本
   * 压过「近距离对角短边」（张力同分时），把环类图拉成共线（实测回归：
   * 四边环塌成直线）。折扣只裁决「贴邻该选哪个方位」这一件事。
   */
  const directionCost = (dx: number, dy: number): number => {
    if (Math.abs(dx) + Math.abs(dy) === 1) return 0;
    return Math.abs(dx) === Math.abs(dy) ? DIAGONAL_COST : OBLIQUE_COST;
  };
  const directionClass = options.directionClass ?? false;

  return {
    anchor(_v, neighbors) {
      return {
        gx: Math.round(neighbors.reduce((s, p) => s + p.gx, 0) / neighbors.length),
        gy: Math.round(neighbors.reduce((s, p) => s + p.gy, 0) / neighbors.length),
      };
    },
    score(v, gx, gy, neighbors, neighborIndices) {
      let cost = tension(gx, gy, neighbors) - ringBonus(gx, gy, neighbors, neighborIndices);
      if (directionClass) {
        for (const u of neighbors) cost += directionCost(gx - u.gx, gy - u.gy);
      }
      return cost;
    },
    isDeadlock(_v, bestScore, _theoreticalMin, neighborCount, bestCell) {
      return (
        bestCell === null ||
        bestScore > DEADLOCK_TENSION_FACTOR * neighborCount + DEADLOCK_TENSION_EXTRA
      );
    },
    deadlock(grid, anchor, posOf) {
      return insertLine(grid, anchor.gx, anchor.gy, posOf);
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

  // 环 0：锚点格本身（邻居均值的取整格）为空时直接参评——两个已放置
  // 邻居分居其对角/两侧时，均值格恰是张力最小的理想位（环搜从 1 起步
  // 会永远错过它，实测把网格图的末行挤出去一行）。
  if (!grid.has(cx, cy)) {
    bestCell = { gx: cx, gy: cy };
    bestScore = heuristics.score(v, cx, cy, neighbors, placedNeighborIdx);
  }

  for (let ring = 1; ring <= SEARCH_RING_CAP; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // 只看环缘
        const gx = cx + dx;
        const gy = cy + dy;
        if (grid.has(gx, gy)) continue;
        const score = heuristics.score(v, gx, gy, neighbors, placedNeighborIdx);
        // 平局显式裁决为扫描序 (gy, gx) 升序（先填满一行再开新行）：对称
        // 图（网格/环）的镜像候选得分完全相等，遍历序平局会让不同"生长
        // 前锋"朝相反方向分叉，把矩阵图折成 6 行（实测）。显式扫描序让
        // 生长变成系统性填行，与遍历次序解耦（确定性不依赖环遍历细节）。
        const better =
          score < bestScore ||
          (score === bestScore &&
            bestCell !== null &&
            (gy < bestCell.gy || (gy === bestCell.gy && gx < bestCell.gx)));
        if (bestCell === null || better) {
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
    bestCell = heuristics.deadlock(grid, near, posOf);
  }
  return bestCell!;
}

/** 放置孤立节点/新分量首节点：贴着已放置区域右边缘外侧，从顶行向下找空格。 */
/**
 * 无已放置邻居的元素落格（新分量种子、完全孤立节点）。
 *
 * 紧凑落格：在已放置区域外扩一圈的范围内，选「贴靠最紧」的空格 ——
 * 贴靠得分 = 2×边邻接 + 1×角邻接（边共享比角接触更紧凑）；平局取离
 * 区域质心切比雪夫距离最近者，再平局按 (gx, gy) 升序保证确定性。
 *
 * 旧口径「贴已放置区域右缘外侧」会把全部孤立节点排成一行：线形是
 * 弛豫动力学的横向鞍点（横向扰动无恢复力），力学位形无法自行展开，
 * 布局被锁死在一条直线上。3 个不相关节点应成品字、4 个应成器字
 * （tests/shape-baseline.test.ts 基线）。
 */
export function placeOrphan(grid: PointGrid): Cell {
  if (grid.occ.size === 0) return { gx: 0, gy: 0 };
  const cx = (grid.minGx + grid.maxGx) / 2;
  const cy = (grid.minGy + grid.maxGy) / 2;
  let best: Cell | null = null;
  let bestTouch = -1;
  let bestRing = Infinity;
  let bestManhattan = Infinity;
  for (let gy = grid.minGy - 1; gy <= grid.maxGy + 1; gy++) {
    for (let gx = grid.minGx - 1; gx <= grid.maxGx + 1; gx++) {
      if (grid.has(gx, gy)) continue;
      // 8 邻接贴靠计分：边共享（4 邻）权重 2，角接触权重 1
      let touch = 0;
      if (grid.has(gx - 1, gy)) touch += 2;
      if (grid.has(gx + 1, gy)) touch += 2;
      if (grid.has(gx, gy - 1)) touch += 2;
      if (grid.has(gx, gy + 1)) touch += 2;
      if (grid.has(gx - 1, gy - 1)) touch += 1;
      if (grid.has(gx + 1, gy - 1)) touch += 1;
      if (grid.has(gx - 1, gy + 1)) touch += 1;
      if (grid.has(gx + 1, gy + 1)) touch += 1;
      const ring = Math.max(Math.abs(gx - cx), Math.abs(gy - cy));
      const manhattan = Math.abs(gx - cx) + Math.abs(gy - cy);
      const better =
        touch > bestTouch ||
        (touch === bestTouch &&
          (ring < bestRing ||
            (ring === bestRing &&
              (manhattan < bestManhattan ||
                (manhattan === bestManhattan &&
                  best !== null &&
                  (gx < best.gx || (gx === best.gx && gy < best.gy)))))));
      if (better) {
        best = { gx, gy };
        bestTouch = touch;
        bestRing = ring;
        bestManhattan = manhattan;
      }
    }
  }
  return best!;
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
 * 用户显式定位（placed）的元素预先反算占格；其余元素按「波纹
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

  // 波纹连通生长（BFS 层序）：从全局度数最高的节点开始，候选集按先进
  // 先出出队（到种子的跳数序）。波纹让放置沿已填区域的边界一圈圈向外
  // 扩张 —— 网格图逐行填满成严格方阵、星形叶逐个落十字位、链沿直线延
  // 伸；度数优先序则会在对称图上形成多个朝相反方向生长的前锋，把矩阵
  // 折叠（实测 5×5 → 6×6）。每个非种子节点放置时都有已放置邻居（其
  // BFS 前驱）可贴近，骨架连续性同 Prim。候选队列耗尽后，剩余节点取
  // 度数最高者作为新分量的种子（孤儿放置）。
  const deg = (i: number): number => adjacency[i].size;
  const done = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) done[i] = !!posOf[i];
  const queue: number[] = [];
  const queued = new Set<number>();
  const enqueueNeighbors = (v: number): void => {
    for (const u of adjacency[v]) {
      if (!done[u] && !queued.has(u)) {
        queued.add(u);
        queue.push(u);
      }
    }
  };

  let remaining = n;
  for (let i = 0; i < n; i++) {
    if (done[i]) remaining--;
  }
  while (remaining > 0) {
    // 种子：队列为空时，从剩余节点取度数最高者（平局按下标升序）。
    if (queue.length === 0) {
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
    // 队首出队（FIFO 波纹序，入队序确定）。
    const v = queue.shift()!;
    queued.delete(v);
    if (done[v]) continue;
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
