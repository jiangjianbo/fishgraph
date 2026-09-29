/**
 * 网格 A* 避障寻路（带拐点惩罚）—— GridSpaceContext.routeEdge 的引擎。
 *
 * 在 4 邻域正交网格上寻找从 source 到 target 的最短正交折线路径：
 *  - 障碍 AABB 栅格化后不可通行（占据 [x, x+w) × [y, y+h) 格）；
 *  - 代价 = 移动步数 + turnCost × 转向次数 + hugCost × 贴边相切数
 *    − laneBonus 折扣（启发函数用曼哈顿距离 × (1 − 折扣率)，各项对启发
 *    的可采纳性成立，保证最优；贴边 = 车道线与偶数格障碍盒物理越界边
 *    重合，见 GridRouteOptions）；
 *  - 搜索界从「端点+障碍包围盒外扩 margin」起步，找不到时逐轮加倍外扩，
 *    超过 maxExpand 仍无路径则返回 null（显式失败）；
 *  - 全程固定规则（堆序、方向序、扩展序），同输入逐位一致。
 *
 * 路径输出为拐点序列（方向变化处），首尾为 source/target 本身。
 */

import type { Box, Point } from './space-types.js';

/**
 * 同向 sibling 车道折扣（策略层二次寻路注入）：移动沿 cols 中的列线
 * （垂直移动）或 rows 中的行线（水平移动）时，每步按 rate 折扣。rate
 * 必须小于 1（引擎钳到 0.5）—— 单位步长为正，纯绕远路径永远无法凭
 * 折扣胜出，只在代价相当的路径间向共用车道倾斜（共线距离越长越好）。
 */
export interface LaneBonus {
  cols: ReadonlySet<number>;
  rows: ReadonlySet<number>;
  rate: number;
}

export interface GridRouteOptions {
  /** 每次转向的附加代价（格）。默认 1：直行一步与转一次弯等价。 */
  turnCost?: number;
  /**
   * 贴边代价（格）：进入「车道线与偶数格障碍盒物理越界边重合」的格时，
   * 每个相切盒的附加代价。偶数格盒中心吸附中心格格心（半格相位），物理
   * 边界落在行进侧相邻格的格心线上（与 metric render、lane boxExtent 同
   * 口径）—— 沿该格心线走线在物理上正好贴着盒边，连线成为节点轮廓的
   * 切线。本代价让等价路径优先走通道中央（通道走中间优先），通道容量
   * 不足时照常贴边兜底（软代价，不影响可行性）。默认 2（贴边比多转一次
   * 弯更差）；0 关闭。
   */
  hugCost?: number;
  /** 同向 sibling 车道折扣（见 LaneBonus；缺省无折扣）。 */
  laneBonus?: LaneBonus;
  /** 搜索区域相对「端点+障碍」包围盒的初始外扩（格）。默认 2。 */
  margin?: number;
  /** 找不到路径时的外扩上限（格）：margin 加倍直到超过该值。默认 16。 */
  maxExpand?: number;
}

/** 四个正交方向的 (dx, dy)（序固定：右、左、下、上 —— 确定性 tie-break 用）。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 贴边相切表：key = 偶数格盒物理越界侧的相邻格线（axis='x' → 右侧列，
 * 相切垂直车道；axis='y' → 下侧行，相切水平车道），value = 该格线上
 * 相切段落在盒内物理覆盖的格区间（闭区间）。物理覆盖口径：奇数格尺寸
 * 盒边界 = 格线（覆盖自身占用的格），偶数格尺寸盒边界 = 格心线（向
 * 越界侧多覆盖一行/列）—— 与 lane.ts boxExtent 同一相位规则。
 */
function buildTangentMap(
  obstacles: Box[],
  axis: 'x' | 'y',
): Map<number, Array<{ lo: number; hi: number }>> {
  const map = new Map<number, Array<{ lo: number; hi: number }>>();
  for (const o of obstacles) {
    const size = axis === 'x' ? o.width : o.height;
    if (size % 2 !== 0) continue; // 奇数格盒边界 = 格线，相邻格心线有半格间隙，不相切
    const other = axis === 'x' ? o.height : o.width;
    const otherLo = axis === 'x' ? o.y : o.x;
    // 物理区间在段轴上覆盖的格：奇数 = [lo, lo+size-1]，偶数多覆盖越界侧一行/列
    const lo = otherLo;
    const hi = otherLo + other - (other % 2 === 0 ? 0 : 1);
    const key = axis === 'x' ? o.x + o.width : o.y + o.height;
    const list = map.get(key);
    if (list) list.push({ lo, hi });
    else map.set(key, [{ lo, hi }]);
  }
  return map;
}

/** 最小二叉堆（比较函数注入；确定性由比较序保证）。 */
class MinHeap<T> {
  private a: T[] = [];

  constructor(private less: (p: T, q: T) => boolean) {}

  get size(): number {
    return this.a.length;
  }

  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* 正交寻路。
 * @param obstacles 障碍 AABB 列表（占据 [x, x+w) × [y, y+h) 格，不可通行）。
 * @returns 拐点序列（含 source/target）；无可行路径返回 null。
 */
export function gridRouteAStar(
  source: Point,
  target: Point,
  obstacles: Box[] = [],
  options: GridRouteOptions = {},
): Point[] | null {
  if (source.x === target.x && source.y === target.y) return [{ ...source }];

  const turnCost = options.turnCost ?? 1;
  const hugCost = options.hugCost ?? 2;
  // 贴边相切表（偶数格盒物理越界侧；hugCost 0 时跳过构建）。
  const vTangent = hugCost > 0 ? buildTangentMap(obstacles, 'x') : null;
  const hTangent = hugCost > 0 ? buildTangentMap(obstacles, 'y') : null;
  // sibling 车道折扣：钳入 (0, 0.5] 保证单位步长恒正（启发函数按
  // (1 - rate) 缩放保持可采纳）。
  const laneBonus = options.laneBonus;
  const bonusRate = laneBonus ? Math.min(Math.max(laneBonus.rate, 0), 0.5) : 0;
  const maxExpand = options.maxExpand ?? 16;
  // 障碍栅格化 + 端点+障碍的整体包围盒（搜索界的基准）。
  let minX = Math.min(source.x, target.x);
  let maxX = Math.max(source.x, target.x);
  let minY = Math.min(source.y, target.y);
  let maxY = Math.max(source.y, target.y);
  for (const o of obstacles) {
    minX = Math.min(minX, o.x);
    maxX = Math.max(maxX, o.x + o.width - 1);
    minY = Math.min(minY, o.y);
    maxY = Math.max(maxY, o.y + o.height - 1);
  }
  // 起终点豁免：走线允许从节点边框出发/进入（端点格本身视为可站立）。
  const passable = (gx: number, gy: number): boolean =>
    (gx === source.x && gy === source.y) ||
    (gx === target.x && gy === target.y) ||
    !isObstacle(gx, gy, obstacles);

  let margin = options.margin ?? 2;
  let result: Point[] | null = null;
  for (; result === null && margin <= maxExpand; margin *= 2) {
    result = searchWithin(
      passable,
      source,
      target,
      turnCost,
      hugCost,
      vTangent,
      hTangent,
      laneBonus && bonusRate > 0 ? { cols: laneBonus.cols, rows: laneBonus.rows, rate: bonusRate } : null,
      minX - margin,
      maxX + margin,
      minY - margin,
      maxY + margin,
    );
  }
  return result;
}

/** 格 (gx, gy) 是否落在任一障碍 AABB 内。 */
function isObstacle(gx: number, gy: number, obstacles: Box[]): boolean {
  for (const o of obstacles) {
    if (gx >= o.x && gx < o.x + o.width && gy >= o.y && gy < o.y + o.height) return true;
  }
  return false;
}

/** 在固定包围盒内跑一次 A*；状态 = (格, 进入方向)，代价含拐点/贴边惩罚与 sibling 车道折扣。 */
function searchWithin(
  passable: (gx: number, gy: number) => boolean,
  source: Point,
  target: Point,
  turnCost: number,
  hugCost: number,
  vTangent: Map<number, Array<{ lo: number; hi: number }>> | null,
  hTangent: Map<number, Array<{ lo: number; hi: number }>> | null,
  laneBonus: LaneBonus | null,
  bx0: number,
  bx1: number,
  by0: number,
  by1: number,
): Point[] | null {
  const key = (gx: number, gy: number, dir: number): string => `${gx},${gy},${dir}`;
  // dist[key] = 到达 (格, dir) 的最小代价；came[key] = 前驱 key（回溯用）。
  const dist = new Map<string, number>();
  const came = new Map<string, string>();
  // 启发按 (1 - rate) 缩放：折扣步长下界 1 - rate，曼哈顿 × 系数仍可采纳。
  const h = (gx: number, gy: number): number =>
    (Math.abs(gx - target.x) + Math.abs(gy - target.y)) *
    (laneBonus ? 1 - laneBonus.rate : 1);

  // 堆序：(f, h, dir, y, x) —— 平局按启发小、方向序、坐标序，确定性。
  const heap = new MinHeap<{
    k: string;
    f: number;
    hh: number;
    dir: number;
    gx: number;
    gy: number;
  }>(
    (p, q) =>
      p.f < q.f ||
      (p.f === q.f &&
        (p.hh < q.hh ||
          (p.hh === q.hh &&
            (p.dir < q.dir || (p.dir === q.dir && (p.gy < q.gy || (p.gy === q.gy && p.gx < q.gx))))))),
  );

  const startKey = key(source.x, source.y, -1);
  dist.set(startKey, 0);
  heap.push({
    k: startKey,
    f: h(source.x, source.y),
    hh: h(source.x, source.y),
    dir: -1,
    gx: source.x,
    gy: source.y,
  });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const dCur = dist.get(cur.k)!;
    if (cur.f - cur.hh > dCur) continue; // 过期条目（懒惰删除）
    if (cur.gx === target.x && cur.gy === target.y) {
      return rebuildPath(came, cur.k);
    }
    for (let nd = 0; nd < 4; nd++) {
      const nx = cur.gx + DIRS[nd]![0];
      const ny = cur.gy + DIRS[nd]![1];
      if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue;
      if (!passable(nx, ny)) continue;
      // 贴边代价：垂直移动的车道线 = 列 nx 格心线（与偶数格宽盒右越界边
      // 相切计价），水平移动 = 行 ny 格心线（与偶数格高盒下越界边相切）。
      let hugs = 0;
      if (nd >= 2) {
        const list = vTangent?.get(nx);
        if (list) for (const r of list) if (ny >= r.lo && ny <= r.hi) hugs++;
      } else {
        const list = hTangent?.get(ny);
        if (list) for (const r of list) if (nx >= r.lo && nx <= r.hi) hugs++;
      }
      // sibling 车道折扣：移动沿同向 sibling 的骨架线时每步折扣
      // （共线距离越长越好；纯绕远无法凭折扣胜出）。
      const bonus =
        laneBonus && (nd >= 2 ? laneBonus.cols.has(nx) : laneBonus.rows.has(ny))
          ? laneBonus.rate
          : 0;
      const ndCost = dCur + 1 + (cur.dir >= 0 && cur.dir !== nd ? turnCost : 0) + hugs * hugCost - bonus;
      const nk = key(nx, ny, nd);
      const dOld = dist.get(nk);
      if (dOld !== undefined && dOld <= ndCost) continue;
      dist.set(nk, ndCost);
      came.set(nk, cur.k);
      heap.push({ k: nk, f: ndCost + h(nx, ny), hh: h(nx, ny), dir: nd, gx: nx, gy: ny });
    }
  }
  return null;
}

/** 回溯状态序列并压缩为拐点序列（方向变化处保留，共线段合并）。 */
function rebuildPath(came: Map<string, string>, endKey: string): Point[] {
  const cells: Point[] = [];
  for (let k: string | undefined = endKey; k !== undefined; k = came.get(k)) {
    const [gx, gy] = k.split(',').map(Number);
    cells.push({ x: gx, y: gy });
  }
  cells.reverse(); // cells[0] 必为 source（startKey 无前驱），末位必为 target
  // 三格窗口压缩：中间格与前/后步同向 → 共线点丢弃；方向变化 → 拐点保留。
  const pts: Point[] = [cells[0]!];
  for (let i = 1; i + 1 < cells.length; i++) {
    const p = cells[i - 1]!;
    const c = cells[i]!;
    const n = cells[i + 1]!;
    if (c.x - p.x === n.x - c.x && c.y - p.y === n.y - c.y) continue;
    pts.push(c);
  }
  pts.push({ ...cells[cells.length - 1]! });
  return pts;
}
