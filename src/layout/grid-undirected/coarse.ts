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
 * 为中心环形扩搜空格，按 heuristics.score 择优；候选格另受两道连线禁令
 * 约束 ——「同起点零共线」（isCollinearRay：u 的两条连线在 u 端夹角不得
 * 为 0，即视觉重叠成 A→B→C 一条线）与「节点压线」（liesBetween /
 * segmentBlocked：任何节点不得落在两节点连线线段上、线段不得穿过第三
 * 节点，与划线风格无关）。搜索预算内无合格空格时
 * 触发死锁机制：heuristics.deadlock 把已放置节点整体推开一格，强行挤出
 * 新空间 —— 保障放置 100% 不死锁。
 *
 * 子作用域放置可携带固定投影锚点（CoarsePlacementOptions.anchors）：
 * 外部质点在子作用域内的映射，只对所连节点产生牵引（heuristics.anchorTerm
 * 偏置，不计入死锁判定）；锚点不入占用表 —— 不占格、不参与插行列推挤，
 * 自身坐标全程不变。
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

/** 非负整数辗转相除。 */
function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * 线段 a→b 的中间格点（gcd 步进）：仅 gcd(|dx|,|dy|) > 1 的线段存在中
 * 间格点，贴邻边（距离 1）与互质方向线段（如 (2,1)）天然无中间点。
 */
export function midCells(a: Cell, b: Cell): Cell[] {
  const dx = b.gx - a.gx;
  const dy = b.gy - a.gy;
  const g = gcd(Math.abs(dx), Math.abs(dy));
  const cells: Cell[] = [];
  for (let k = 1; k < g; k++) {
    cells.push({ gx: a.gx + (dx / g) * k, gy: a.gy + (dy / g) * k });
  }
  return cells;
}

/**
 * 点 p 是否共线且严格位于线段 a–b 之间（节点压线判定）：压线 = 第三
 * 节点落在两节点的直线连线途经处；线段端点的延长线不算（共线但不居
 * 中），那是零共线禁令（isCollinearRay）的管辖范围。
 */
export function liesBetween(a: Cell, b: Cell, p: Cell): boolean {
  const abx = b.gx - a.gx;
  const aby = b.gy - a.gy;
  const apx = p.gx - a.gx;
  const apy = p.gy - a.gy;
  if (abx * apy - aby * apx !== 0) return false;
  const dot = apx * abx + apy * aby;
  return dot > 0 && dot < abx * abx + aby * aby;
}

/** 线段 a→b 是否穿过某个已放置节点（中间格点查占用表）。 */
export function segmentBlocked(a: Cell, b: Cell, grid: PointGrid): boolean {
  for (const m of midCells(a, b)) {
    if (grid.has(m.gx, m.gy)) return true;
  }
  return false;
}
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
  /**
   * 矩形格距（px）：placed 连续坐标反算占格的分母（x÷cellW、y÷cellH）。
   * 缺省 = naturalLength 方格。矩形基准格口径由尺寸映射策略分级产出。
   */
  cellW?: number;
  cellH?: number;
  /**
   * 固定投影锚点（子图坐标系隔离联动）：外部质点在子作用域网格中的
   * 映射。锚点只对所连视图项产生牵引（评分加项），不进占用表 ——
   * 不占格、可被成员踏过，且永不参与插行列推挤（投影坐标固定不变，
   * 只有子图内节点位置可动）。
   */
  anchors?: readonly ProjectionAnchor[];
}

/** 固定投影锚点：外部质点在子作用域坐标系中的映射。 */
export interface ProjectionAnchor {
  /** 被牵引的视图项下标（本次放置输入的下标域）。 */
  item: number;
  /** 投影固定格。 */
  at: Cell;
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
  /**
   * 投影锚点牵引项（可选，缺省 0）：候选格相对固定投影锚点的偏好成本，
   * 越小越被吸引。只参与候选比较，**不参与死锁判定** —— 投影在容器
   * 边界之外，成员够不着投影是常态而非拥堵，计入死锁会误触插行列。
   */
  anchorTerm?(gx: number, gy: number, anchors: readonly Cell[]): number;
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
  /** 投影牵引权重：每格 0.5 —— 方位级偏置（同方向冲突时让位于张力维）。 */
  const ANCHOR_PULL = 0.5;

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
    anchorTerm(gx, gy, anchors) {
      let sum = 0;
      for (const a of anchors) sum += Math.abs(gx - a.gx) + Math.abs(gy - a.gy);
      return ANCHOR_PULL * sum;
    },
  };
}

/**
 * 同起点连线零共线禁令（doc/布局核心原则.md 无向图阶段 2 规则 4）：
 * 候选格落在 u 的某条已有连线射线上（同起点夹角为 0）则不合格 ——
 * 否则两条边视觉上重叠成 A→B→C 一条线。u 为 v 的已放置邻居，w 为 u
 * 的另一个已放置邻居：candidate−u 与 w−u 同向平行（叉积为 0 且点积
 * > 0）即共线。adjacency 为无向邻接，同起点/同终点对称适用 —— 几何
 * 重叠只取决于 u 的两个邻居落在同一射线，与边的有向语义无关；反向
 * （180°）共线是两条边对冲，不算重叠。
 */
export function isCollinearRay(
  adjacency: Array<Set<number>>,
  posOf: GridPos,
  v: number,
  u: number,
  posU: Cell,
  gx: number,
  gy: number,
): boolean {
  const dx = gx - posU.gx;
  const dy = gy - posU.gy;
  if (dx === 0 && dy === 0) return false;
  for (const w of adjacency[u]) {
    if (w === v) continue;
    const p = posOf[w];
    if (!p) continue;
    const wx = p.gx - posU.gx;
    const wy = p.gy - posU.gy;
    if (dx * wy - dy * wx === 0 && dx * wx + dy * wy > 0) return true;
  }
  return false;
}

/**
 * 放置一个已放置邻居的节点：环形扩搜 + 评分择优，必要时走死锁机制。
 *
 * anchors 为 v 的固定投影锚点（可空）：牵引项加进候选比较，但不进
 * 死锁判定（见 CoarseHeuristics.anchorTerm）；有锚点时禁用「已达理论
 * 最优提前收工」—— 同分候选仍要按牵引方向裁决。
 *
 * 零共线禁令作用于全部候选格（含环 0 锚点格）：被禁格直接出局，搜索
 * 预算内无合格空格时走既有死锁机制（插行列推挤）。死锁落位后不做二
 * 次共线复查 —— 死锁解法优先保证放置完成性（拥堵处允许放弃部分美学
 * 约束保无重叠，与软层级的拥堵语义一致），二次复查会造成推挤-复查
 * 死循环。
 *
 * 压线禁令（节点压边 / 边压节点）与零共线同层作用：候选格落在某条
 * 已放长边（线段含中间格点的边）线段上，或新边 v–u 的线段穿过已放
 * 置节点，均不合格。与零共线互补：零共线管「u 的邻居在 u→v 射线上」
 * （两条边重叠成 A→B→C），压线管「线段途经任意已放置节点」（与邻接
 * 无关）—— 长边列表由 coarseGridPlacement 在边两端就位时登记。
 */
function placeWithHeuristics(
  grid: PointGrid,
  v: number,
  placedNeighborIdx: number[],
  posOf: GridPos,
  heuristics: CoarseHeuristics,
  adjacency: Array<Set<number>>,
  longEdges: ReadonlyArray<readonly [number, number]>,
  anchors: readonly Cell[] = [],
): Cell {
  /** v 的候选格是否命中同起点零共线禁令。 */
  const collides = (gx: number, gy: number): boolean => {
    for (const u of placedNeighborIdx) {
      if (isCollinearRay(adjacency, posOf, v, u, posOf[u]!, gx, gy)) return true;
    }
    return false;
  };
  /** v 的候选格是否命中压线禁令（候选压在已有长边上 / 新边穿过节点）。 */
  const crossesLine = (gx: number, gy: number): boolean => {
    const cand = { gx, gy };
    for (const [a, b] of longEdges) {
      if (liesBetween(posOf[a]!, posOf[b]!, cand)) return true;
    }
    for (const u of placedNeighborIdx) {
      if (segmentBlocked(posOf[u]!, cand, grid)) return true;
    }
    return false;
  };
  /** 候选格是否不合格（占用 / 零共线 / 压线）。 */
  const ineligible = (gx: number, gy: number): boolean =>
    grid.has(gx, gy) || collides(gx, gy) || crossesLine(gx, gy);
  const neighbors = placedNeighborIdx.map((u) => posOf[u]!);
  const anchor = heuristics.anchor(v, neighbors);
  const cx = anchor.gx;
  const cy = anchor.gy;
  const theoreticalMin = neighbors.length;
  const hasAnchors = anchors.length > 0 && !!heuristics.anchorTerm;
  const pull = (gx: number, gy: number): number =>
    hasAnchors ? heuristics.anchorTerm!(gx, gy, anchors) : 0;
  let bestCell: Cell | null = null;
  let bestScore = Infinity;
  let bestGraphScore = Infinity;

  // 环 0：锚点格本身（邻居均值的取整格）为空且不违规时直接参评——两个
  // 已放置邻居分居其对角/两侧时，均值格恰是张力最小的理想位（环搜从 1
  // 起步会永远错过它，实测把网格图的末行挤出去一行）。
  if (!ineligible(cx, cy)) {
    bestCell = { gx: cx, gy: cy };
    bestScore = heuristics.score(v, cx, cy, neighbors, placedNeighborIdx);
    bestGraphScore = bestScore;
    bestScore += pull(cx, cy);
  }

  for (let ring = 1; ring <= SEARCH_RING_CAP; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // 只看环缘
        const gx = cx + dx;
        const gy = cy + dy;
        if (ineligible(gx, gy)) continue;
        const graphScore = heuristics.score(v, gx, gy, neighbors, placedNeighborIdx);
        const score = graphScore + pull(gx, gy);
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
          bestGraphScore = graphScore;
        }
      }
    }
    // 已达理论最优（全部邻居贴邻）提前收工（有投影锚点时同分候选仍需
    // 按牵引方向裁决，不提前收工）；前几环后不再扩大搜索。
    if (!hasAnchors && bestScore <= theoreticalMin) break;
    if (ring >= 3 && bestCell) break;
  }

  if (
    !bestCell ||
    heuristics.isDeadlock(v, bestGraphScore, theoreticalMin, neighbors.length, bestCell)
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
 * avoid 为可选禁令过滤（压线禁令的种子路径接入）：被禁格不参评。全
 * 部空格都被禁时退回无过滤结果 —— 放置完成性优先（与死锁解法同一取
 * 舍），宁可压线也不让放置失败。
 *
 * 旧口径「贴已放置区域右缘外侧」会把全部孤立节点排成一行：线形是
 * 弛豫动力学的横向鞍点（横向扰动无恢复力），力学位形无法自行展开，
 * 布局被锁死在一条直线上。3 个不相关节点应成品字、4 个应成器字
 * （tests/shape-baseline.test.ts 基线）。
 */
export function placeOrphan(grid: PointGrid, avoid?: (cell: Cell) => boolean): Cell {
  if (grid.occ.size === 0) return { gx: 0, gy: 0 };
  const pick = (skip: (cell: Cell) => boolean): Cell | null => {
    const cx = (grid.minGx + grid.maxGx) / 2;
    const cy = (grid.minGy + grid.maxGy) / 2;
    let best: Cell | null = null;
    let bestTouch = -1;
    let bestRing = Infinity;
    let bestManhattan = Infinity;
    for (let gy = grid.minGy - 1; gy <= grid.maxGy + 1; gy++) {
      for (let gx = grid.minGx - 1; gx <= grid.maxGx + 1; gx++) {
        if (grid.has(gx, gy) || skip({ gx, gy })) continue;
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
    return best;
  };
  const filtered = pick((c) => !!avoid?.(c));
  return filtered ?? pick(() => false)!;
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
  const cellW = Math.max(options.cellW ?? naturalLength, 1e-3);
  const cellH = Math.max(options.cellH ?? naturalLength, 1e-3);
  const grid = new PointGrid();
  const posOf: GridPos = new Array(n).fill(null);
  const order: number[] = [];
  const ignorePlaced = options.ignorePlaced ?? false;
  // 投影锚点按视图项归组（只牵引，不入占用表，永不移动）。
  const anchorsOf: Cell[][] = Array.from({ length: n }, () => []);
  for (const a of options.anchors ?? []) {
    if (a.item >= 0 && a.item < n) anchorsOf[a.item]!.push(a.at);
  }

  // 已放长边（线段含中间格点的边）：压线禁令的查询基准。存元素下标对、
  // 查询时读 posOf 当前坐标 —— 插行列推挤平移坐标后天然保持有效。
  const longEdges: Array<[number, number]> = [];
  /** v 与其已放置邻居之间的新边若线段含中间格点，登记为长边。 */
  const registerLongEdges = (v: number, placedNbrs: readonly number[]): void => {
    for (const u of placedNbrs) {
      if (u !== v && posOf[u] && midCells(posOf[u]!, posOf[v]!).length > 0) longEdges.push([u, v]);
    }
  };
  /** 种子落格的压线回避：不落在任何已放长边的线段上（有向 placeSeed
   *  钩子自行落格，不经此过滤 —— 有向种子的层级行落位是另一套边界）。 */
  const avoidCrossed = (c: Cell): boolean =>
    longEdges.some(([a, b]) => liesBetween(posOf[a]!, posOf[b]!, c));

  // 用户显式定位的元素：连续坐标反算占格（冲突时向右找相邻空格）。
  for (let i = 0; i < n; i++) {
    const el = elements[i];
    if (!el.placed || ignorePlaced) continue;
    let gx = Math.round(el.x / cellW);
    const gy = Math.round(el.y / cellH);
    while (grid.has(gx, gy)) gx++;
    grid.place({ gx, gy }, i);
    posOf[i] = { gx, gy };
    order.push(i);
    registerLongEdges(i, [...adjacency[i]]);
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
        : placeOrphan(grid, avoidCrossed);
      grid.place(cellPos, seed);
      posOf[seed] = cellPos;
      done[seed] = true;
      remaining--;
      order.push(seed);
      registerLongEdges(seed, [...adjacency[seed]]);
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
        ? placeWithHeuristics(
            grid,
            v,
            placed,
            posOf,
            heuristics,
            adjacency,
            longEdges,
            anchorsOf[v]!,
          )
        : placeOrphan(grid, avoidCrossed);
    grid.place(cellPos, v);
    posOf[v] = cellPos;
    done[v] = true;
    remaining--;
    order.push(v);
    registerLongEdges(v, placed);
    enqueueNeighbors(v);
  }

  return { grid, posOf, cell, order };
}
