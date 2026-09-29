/**
 * 通道车道分配（阶段 8.5）—— 跨边平行走线的等距分流。
 *
 * 阶段 8 的 A* 走线逐边独立寻路、互不感知：同一通道格线上的平行段
 * 会重合（doc/布局核心原则.md §8 待办「跨边共通道等距分流」）。本
 * 模块在骨架定型后做一次纯几何的跨边分配：
 *   1. 骨架格序列压缩为拐点序列，中间段按轴登记到格线（垂直段 →
 *      列线，水平段 → 行线）；首末段是端口法向贴边段（及其同轴延续
 *      段）恒不偏移（终点垂直原则）；
 *   2. 同一条边在同一条格线上的多段（U 形绕行）合并为一个分配单位
 *      —— 同边同通道全程占同一车道（位置固定原则）；
 *   3. 同一格线上按端点关系先聚车道簇、再连冲突组：恰共享一个端点的
 *      边（sibling）倾向共用路径 —— 区间重叠不算冲突，聚成同簇共享
 *      同一车道；两端都相同的重合边（bundle）与无端点关系的边照常
 *      错开；簇间区间重叠连成冲突组（相交不冲突 —— 只有共线重叠才算
 *      重叠；相触即冲突：两段共用格心），簇是占位原子；
 *   4. 组内按簇（代表 = 簇内最长边）总长降序（长线相邻共存时间最长，
 *      优先挑位）从中央向外蛇形分配等差车道；偏移序列尽量以格心线为
 *      中心，整体钳入该线的可用偏移区间。存在交叉嵌套约束（端点完全
 *      不同的两边在共用端点行/列上正交段反向延伸）时改为约束感知分配：
 *      拓扑序（rank 优先）铺升序槽位，保证拐点嵌套、正交段不交叠。
 *
 * 可用偏移区间由障碍盒决定：盒的物理边界依格宽奇偶呈半格相位（偶数
 * 格宽盒的边界落在格心线上，奇数格宽盒的边界落在格线上），偏移必须
 * 与两侧盒的物理边界保持安全距（GAP）—— 偏移超出格心线 ±半格时实际
 * 是利用了节点间更宽的物理自由空间，正交性不受影响。
 *
 * 骨架拓扑完全不变 —— 偏移只在物理化时表达为拐点处相邻段车道线的
 * 交点（见 metric/default.ts render），拐折数不变。独占通道的边偏移
 * 0 = 现状格心线，坐标逐位不变。
 */

import type { LayoutRoute } from '../metric/types.js';
import type { Box, Point } from './space-types.js';

/** 偏移线与障碍盒物理边界的安全距（格）。 */
const GAP = 0.25;
/** 偏移线与所属边端点盒物理边界的间距（格，半格 = 渲染端 breakout/箭头接入长度）。 */
const END_GAP = 0.5;

/** 骨架格序列压缩为拐点序列（合并共线中间格；顺带去相邻重复点）。 */
export function compressCorners(cells: readonly Point[]): Point[] {
  const out: Point[] = [cells[0]!];
  const guardHi = cells.length - 2;
  for (let i = 1; i < cells.length - 1; i++) {
    const c = cells[i]!;
    const last = out[out.length - 1]!;
    if (last.x === c.x && last.y === c.y) continue;
    if (i === 1 || i === guardHi) {
      out.push(c);
      continue;
    }
    const n = cells[i + 1]!;
    const collinear = (last.x === c.x && c.x === n.x) || (last.y === c.y && c.y === n.y);
    if (!collinear) out.push(c);
  }
  const last = cells[cells.length - 1]!;
  if (out[out.length - 1]!.x !== last.x || out[out.length - 1]!.y !== last.y) out.push(last);
  return out;
}

/** 车道分配单位：同一条边在同一条格线上的全部区间（共享同一车道）。 */
interface LaneUnit {
  /** 所属边（routes 下标）。 */
  edge: number;
  /** true = 垂直段（固定 x 列线）；false = 水平段（固定 y 行线）。 */
  vertical: boolean;
  /** 格线的固定坐标（列 x / 行 y，格下标）。 */
  line: number;
  /** 该边在此格线上的全部占用区间（格下标，闭区间）。 */
  intervals: Array<{ lo: number; hi: number }>;
  /**
   * 单位各段两端在端点行/列上的正交延伸方向（交叉嵌套约束用）：at =
   * 端点行（垂直单位）/ 列（水平单位）格下标，dir = 所属边在该端点处
   * 的正交段相对拐点的延伸方向（±1，沿偏移轴）。
   */
  ends: Array<{ at: number; dir: number }>;
  /** 分配结果：沿段法向的车道偏移（格单位，物理化时 × 格距）。 */
  offset: number;
}

/** 两单位在同一格线上是否冲突（任一区间对重叠；相触即共用格心）。 */
function conflicts(a: LaneUnit, b: LaneUnit): boolean {
  for (const ra of a.intervals) {
    for (const rb of b.intervals) {
      if (ra.lo <= rb.hi && rb.lo <= ra.hi) return true;
    }
  }
  return false;
}

/** 两边的端点关系：bundle = 两端都相同（无向含反向）；sibling = 恰共享一端。 */
function edgeRelation(a: LayoutRoute, b: LayoutRoute): 'bundle' | 'sibling' | 'other' {
  if ((a.source === b.source && a.target === b.target) || (a.source === b.target && a.target === b.source)) {
    return 'bundle';
  }
  if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) {
    return 'sibling';
  }
  return 'other';
}

/** 边走线总长（格步数；长线优先的度量口径）。 */
function routeLength(route: LayoutRoute): number {
  return Math.max(0, route.cells.length - 1);
}

/**
 * 盒在格线轴上的物理区间（格单位）：物理盒边界相对格系统的相位由格宽
 * 奇偶决定（中心吸附中心格格心 = 左上格 + ⌊尺寸/2⌋，见 metric/default
 * render centerX/centerY）—— 奇数格盒边界 = 格线 (lo / lo+size)，
 * 偶数格盒几何中心吸附后整体右移半格，边界 = 格心线 (lo+0.5 / lo+size+0.5)。
 */
function boxExtent(lo: number, size: number): [number, number] {
  return size % 2 === 1 ? [lo, lo + size] : [lo + 0.5, lo + size + 0.5];
}

/** 单位的穿越区间与障碍盒的横向区间是否重叠（格半开区间口径）。 */
function spanOverlaps(u: LaneUnit, b: Box): boolean {
  for (const r of u.intervals) {
    const blo = u.vertical ? b.y : b.x;
    const bhi = u.vertical ? b.y + b.height : b.x + b.width;
    if (r.lo < bhi && blo < r.hi + 1) return true;
  }
  return false;
}

/**
 * 就地为每条路由计算车道偏移（写 laneOffsets；无偏移的边不设字段，
 * 物理化保持现状格心线路径）。marginCells = 名义通道宽（格），boxes =
 * 全量元素格盒（下标与 routes[].source/target 对齐），obstacleIdx =
 * 走线障碍盒下标集合（非容器节点，与 A* 同口径）；margin 0 时无通道
 * 空间，不做分配。
 */
export function assignLanes(
  routes: LayoutRoute[],
  marginCells: number,
  boxes: readonly Box[] = [],
  obstacleIdx: ReadonlySet<number> = new Set(),
): void {
  if (marginCells <= 0) return;
  const obstacles = boxes.filter((_, i) => obstacleIdx.has(i));

  const units: LaneUnit[] = [];
  // segUnits[边][段] = 该段所属单位（首末段与未登记段为 null）。
  const segUnits: Array<Array<LaneUnit | null>> = [];
  routes.forEach((route, ei) => {
    if (route.exact || route.cells.length < 2) {
      segUnits.push([]);
      return;
    }
    const corners = compressCorners(route.cells);
    const segCount = corners.length - 1;
    const refs: Array<LaneUnit | null> = new Array(segCount).fill(null);
    // 首末段（0 与 segCount-1）是端口法向贴边段，不登记（终点垂直）。
    // 端口延伸段：与首/末段同轴同线的中段（compressCorners 强制保留
    // 端口段端点产生的伪拐点两侧的延续段）仍属贴边段 —— 偏移会与
    // 端口段错轴断裂，恒 0 且不登记冲突。
    for (let i = 1; i < segCount - 1; i++) {
      const a = corners[i]!;
      const b = corners[i + 1]!;
      const vertical = a.x === b.x;
      if (i === 1 && (vertical ? corners[0]!.x === a.x : corners[0]!.y === a.y)) continue;
      if (
        i === segCount - 2 &&
        (vertical ? corners[segCount]!.x === b.x : corners[segCount]!.y === b.y)
      ) {
        continue;
      }
      const line = vertical ? a.x : a.y;
      const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
      const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
      let unit = units.find((u) => u.edge === ei && u.vertical === vertical && u.line === line);
      if (!unit) {
        unit = { edge: ei, vertical, line, intervals: [], ends: [], offset: 0 };
        units.push(unit);
      }
      unit.intervals.push({ lo, hi });
      // 端点行/列上的正交延伸方向：段起点处的正交段向 corners[i-1] 侧
      // 延伸、段终点处向 corners[i+2] 侧延伸（相邻段必转轴，已登记段
      // 的同轴邻接情形均在端口延伸段跳检中排除）。
      unit.ends.push(
        vertical
          ? { at: a.y, dir: Math.sign(corners[i - 1]!.x - a.x) }
          : { at: a.x, dir: Math.sign(corners[i - 1]!.y - a.y) },
        vertical
          ? { at: b.y, dir: Math.sign(corners[i + 2]!.x - b.x) }
          : { at: b.x, dir: Math.sign(corners[i + 2]!.y - b.y) },
      );
      refs[i] = unit;
    }
    segUnits.push(refs);
  });
  if (units.length === 0) return;

  // 同一格线内两步归类（不跨线）：
  //   车道簇 —— sibling 对（恰共享一端）区间重叠聚成同簇：倾向共用
  //     路径，簇内全程共享同一车道偏移；
  //   冲突组 —— 簇间区间重叠连成冲突连通分量（簇是占位原子：同簇的
  //     单位必须一起参与错开，否则簇内共享车道会被拆散）。
  const sib = units.map((_, i) => i);
  const sibFind = (x: number): number => (sib[x] === x ? x : (sib[x] = sibFind(sib[x]!)));
  const indexOf = new Map<LaneUnit, number>(units.map((u, i) => [u, i]));
  const byLine = new Map<string, LaneUnit[]>();
  for (const u of units) {
    const key = `${u.vertical ? 'v' : 'h'}:${u.line}`;
    const list = byLine.get(key);
    if (list) list.push(u);
    else byLine.set(key, [u]);
  }
  for (const list of byLine.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (!conflicts(a, b)) continue;
        if (edgeRelation(routes[a.edge]!, routes[b.edge]!) === 'sibling') {
          sib[sibFind(indexOf.get(a)!)] = sibFind(indexOf.get(b)!);
        }
      }
    }
  }
  const clusterOf = new Map<number, number>();
  const clusters: LaneUnit[][] = [];
  units.forEach((u, i) => {
    const root = sibFind(i);
    const cid = clusterOf.get(root);
    if (cid === undefined) {
      clusterOf.set(root, clusters.length);
      clusters.push([u]);
    } else {
      clusters[cid]!.push(u);
    }
  });
  const parent = clusters.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  // 簇与单位一样按格线分桶（同簇单位必然同格线）。
  const byLineClusters = new Map<string, number[]>();
  clusters.forEach((cl, cid) => {
    const u = cl[0]!;
    const key = `${u.vertical ? 'v' : 'h'}:${u.line}`;
    const list = byLineClusters.get(key);
    if (list) list.push(cid);
    else byLineClusters.set(key, [cid]);
  });
  for (const list of byLineClusters.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ca = clusters[list[i]!]!;
        const cb = clusters[list[j]!]!;
        let hit = false;
        for (const ua of ca) {
          for (const ub of cb) {
            if (conflicts(ua, ub)) {
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) parent[find(list[i]!)] = find(list[j]!);
      }
    }
  }
  const groups = new Map<number, number[]>();
  clusters.forEach((_, cid) => {
    const root = find(cid);
    const list = groups.get(root);
    if (list) list.push(cid);
    else groups.set(root, [cid]);
  });

  for (const group of groups.values()) {
    const members = group.map((cid) => clusters[cid]!);
    if (members.length < 2) continue; // 独占通道（单簇）：偏移 0 = 格心线
    const vertical = members[0]![0]!.vertical;
    const line = members[0]![0]!.line;
    const t0 = line + 0.5; // 格心线相对格系统的位置
    // 组公共可用偏移区间：先收集组员穿越区间重叠的障碍盒真实约束
    // （盒物理边界相位由格宽奇偶决定；组员所属边的端点盒用半格间距，
    // 保证渲染端 breakout/箭头的接入长度），无约束的一侧退回名义通
    // 道半宽留安全距，并保证足以容纳组内均分铺放 —— 真实边界不与默
    // 认值取交（贴格心线的盒一侧推开偏移后，另一侧的开阔空间不应被
    // 名义半宽遮蔽；行/列区间不重叠的盒与线永不相交，偏移侧空间由
    // 障碍约束全覆盖，兜底放宽不引入穿盒）。
    const half = marginCells / 2 - GAP;
    const n = members.length;
    let lo = -Infinity;
    let hi = Infinity;
    for (const cl of members) {
      const endBoxes = new Set<Box>();
      for (const u of cl) {
        endBoxes.add(boxes[routes[u.edge]!.source]!);
        endBoxes.add(boxes[routes[u.edge]!.target]!);
      }
      for (const u of cl) {
        for (const b of obstacles) {
          if (!spanOverlaps(u, b)) continue;
          const [bl, br] = vertical ? boxExtent(b.x, b.width) : boxExtent(b.y, b.height);
          const gap = endBoxes.has(b) ? END_GAP : GAP;
          if (br <= t0) lo = Math.max(lo, br - t0 + gap);
          else if (bl >= t0) hi = Math.min(hi, bl - t0 - gap);
        }
      }
    }
    const span0 = (n - 1) * (marginCells / n);
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) {
      lo = -half;
      hi = half;
    } else if (!Number.isFinite(lo)) {
      lo = Math.min(-half, hi - span0);
    } else if (!Number.isFinite(hi)) {
      hi = Math.max(half, lo + span0);
    }
    if (lo > hi) {
      const mid = (lo + hi) / 2;
      lo = mid;
      hi = mid;
    }
    // 等差铺放：间距取「均分」与「可用宽度均分」的较小者（超容量时
    // 铺满可用区）；序列尽量以格心线为中心（shift 钳入可用区间）。
    const spacing = Math.min(marginCells / n, (hi - lo) / (n - 1));
    const mid = (n - 1) / 2;
    const base = Array.from({ length: n }, (_, k) => (k - mid) * spacing);
    const shift = Math.min(Math.max(0, lo - base[0]!), hi - base[n - 1]!);
    const kOrder = Array.from({ length: n }, (_, k) => k).sort(
      (a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b,
    );
    // 长线优先：簇代表边总长降序（代表 = 簇内最长边，平局按簇内最小
    // 边序保证确定性），从中央向外蛇形挑位 —— rank 0 的最长簇最贴近
    // 格心线（通道中央）；簇内单位共享同一车道。
    const clusterLen = (cl: LaneUnit[]) => Math.max(...cl.map((u) => routeLength(routes[u.edge]!)));
    const clusterMinEdge = (cl: LaneUnit[]) => Math.min(...cl.map((u) => u.edge));
    const ranked = [...members].sort(
      (a, b) => clusterLen(b) - clusterLen(a) || clusterMinEdge(a) - clusterMinEdge(b),
    );
    // 交叉嵌套约束（端点完全不同的边任何部分不得重叠）：同线两簇（所属
    // 边无共享端点）在共用端点行/列上各有一段反向延伸的正交段（一条向
    // +偏移轴、另一条向 −）时，两拐点必须嵌套 —— 向 + 延伸者的车道槽位
    // 必须大于向 − 延伸者，否则两条正交段在共用行/列线上交叠（槽位差
    // = 组内间距，即规则要求的最小空隙）。共享端点的边（sibling/bundle）
    // 允许共线共用，不参与约束。
    const predOf = new Map<LaneUnit[], Set<LaneUnit[]>>();
    const linkBefore = (a: LaneUnit[], b: LaneUnit[]): void => {
      const set = predOf.get(b);
      if (set) set.add(a);
      else predOf.set(b, new Set([a]));
    };
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        for (const u of members[i]!) {
          for (const v of members[j]!) {
            if (edgeRelation(routes[u.edge]!, routes[v.edge]!) !== 'other') continue;
            for (const eu of u.ends) {
              for (const ev of v.ends) {
                if (eu.at !== ev.at) continue;
                if (eu.dir === 1 && ev.dir === -1) linkBefore(members[j]!, members[i]!);
                else if (eu.dir === -1 && ev.dir === 1) linkBefore(members[i]!, members[j]!);
              }
            }
          }
        }
      }
    }
    if (predOf.size === 0) {
      ranked.forEach((cl, rank) => {
        const off = shift + base[kOrder[rank]!]!;
        cl.forEach((u) => {
          u.offset = off;
        });
      });
    } else {
      // 约束感知分配：rank 优先的拓扑序 → 升序槽位（base 随 k 升序）；
      // 约束成环时按 rank 序破开（兜底，保证确定性终止）。
      const order: LaneUnit[][] = [];
      const remaining = new Set(members);
      while (remaining.size > 0) {
        let pick: LaneUnit[] | null = null;
        for (const cl of ranked) {
          if (!remaining.has(cl)) continue;
          const preds = predOf.get(cl);
          let blocked = false;
          if (preds) {
            for (const p of preds) {
              if (remaining.has(p)) {
                blocked = true;
                break;
              }
            }
          }
          if (!blocked) {
            pick = cl;
            break;
          }
        }
        if (!pick) pick = ranked.find((cl) => remaining.has(cl))!;
        order.push(pick);
        remaining.delete(pick);
      }
      order.forEach((cl, k) => {
        const off = shift + base[k]!;
        cl.forEach((u) => {
          u.offset = off;
        });
      });
    }
  }

  // 写回段偏移：只有存在非零偏移的边才设置（无偏移边走现状物理化路径）。
  routes.forEach((route, ei) => {
    const refs = segUnits[ei]!;
    if (refs.every((u) => u === null || u.offset === 0)) return;
    route.laneOffsets = refs.map((u) => (u ? u.offset : 0));
  });
}
