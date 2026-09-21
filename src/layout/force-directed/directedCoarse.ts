/**
 * 有向图放置美学 —— CoarseHeuristics 的有向实现（doc/布局核心原则.md 有向图
 * 流水线阶段 2「软层级引导网格寻优」）。
 *
 * 与无向实现（undirectedHeuristics）共享主流程（度数优先连通生长、环形
 * 扩搜、压实映射），只替换四个放置决策：
 *  - 锚点：cross 轴取已放置邻居均值，flow 轴钉在理想层级行 level(v)
 *    —— 寻优起点就在自己的层级上（TB：y_ideal 行；LR：x_ideal 列）；
 *  - 评分：无向 base（张力 − 环周长奖励）+ w_level·(flow−level)² 层级
 *    偏离罚 + w_dir·方向罚（候选点放在已放置邻居定义的流向约束之外）：
 *      Score = Score_base + w_level·(flow − level)² + w_dir·DirectionPenalty
 *    开阔处层级罚把节点吸在自己的层级行上（方向流动感）；拥堵处允许
 *    放弃 1~2 行偏移保无重叠（软约束）；
 *  - 死锁判定：最佳候选的层级偏离超过容忍行数（devCap）—— 层级行完全
 *    拥堵时不再向下扩大 flow 偏移，而是触发插列；
 *  - 死锁解法：优先插列（TB 沿 ±x、LR 沿 ±y）—— 只动 cross 轴不动
 *    flow 轴，挤出新空间的同时保持层级行不乱。
 */

import type { InternalEdge, LayoutElement } from '../../graph/store.js';
import {
  insertLine,
  placeOrphan,
  type Cell,
  type CoarseHeuristics,
  type PointGrid,
  type PushDir,
} from '../force-undirected/coarse.js';

/** 层级偏离罚权重：偏 1 行的罚须明显高于同行内候选格的张力差异（每格 1）
 *  —— 否则环扩搜的对称外扩会让贴邻的上/下游行候选（张力 1~2）赢过同行
 *  候选（张力 2~3），节点逃出层级行、行内排序错乱、子树边交叉。
 *  取 3：非拥堵时几乎总选同行；拥堵时同行无空格，偏行成为唯一选择
 *  （软约束的"拥堵才挪行"语义，见 doc 布局核心原则.md 有向图阶段 2）。 */
const W_LEVEL = 3;
/** 方向罚权重：每违反一格流向约束的罚。 */
const W_DIR = 0.5;
/** 死锁判定的层级容忍行数：最佳候选偏离超过它 → 层级行拥堵，插列。 */
const DEV_CAP = 2;

/** TB 死锁插列方向（±x，不动层级行）。 */
const DIRS_COLUMN: readonly PushDir[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
];
/** LR 死锁插行方向（±y，不动层级列）。 */
const DIRS_ROW: readonly PushDir[] = [
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

/**
 * 有向图放置美学工厂。
 * @param adjacency 无向邻接（与 coarsePlacement 主流程一致，环周长奖励用）
 * @param edges 有向边（构建流向约束：出边邻居应在候选点下游、入边在上游）
 * @param levelOf 每元素层级（computeLevels 产出）
 * @param direction 流动方向：'TB' 流动沿 +y（层级行 = 行），'LR' 沿 +x（层级列 = 列）
 */
export function directedHeuristics(
  adjacency: Array<Set<number>>,
  edges: readonly InternalEdge[],
  levelOf: Int32Array,
  direction: 'TB' | 'LR',
): CoarseHeuristics {
  // 流动轴参数化：flow = 流向坐标（层级钉住），cross = 横向坐标（邻居均值）。
  const flowOf = direction === 'TB' ? (p: Cell) => p.gy : (p: Cell) => p.gx;
  const crossOf = direction === 'TB' ? (p: Cell) => p.gx : (p: Cell) => p.gy;
  const deadlockDirs = direction === 'TB' ? DIRS_COLUMN : DIRS_ROW;
  const mkCell = (flow: number, cross: number): Cell =>
    direction === 'TB' ? { gx: cross, gy: flow } : { gx: flow, gy: cross };

  // 流向集合：outOf[v] = v 的（已视为正确的）出边目标下标，inOf 反之。
  // 反馈边被 computeLevels 忽略，但这里不区分 —— 反馈边两端的真实上下游
  // 已由环上其余路径的层级表达，全部按普通约束处理即可。
  const outOf: Array<Set<number>> = Array.from({ length: levelOf.length }, () => new Set());
  const inOf: Array<Set<number>> = Array.from({ length: levelOf.length }, () => new Set());
  for (const e of edges) {
    outOf[e.sourceIndex]?.add(e.targetIndex);
    inOf[e.targetIndex]?.add(e.sourceIndex);
  }

  /** 无向张力项（曼哈顿距离和，连线像橡皮筋）。 */
  const tension = (gx: number, gy: number, neighbors: readonly Cell[]): number => {
    let sum = 0;
    for (const u of neighbors) {
      sum += Math.abs(gx - u.gx) + Math.abs(gy - u.gy);
    }
    return sum;
  };

  /** 环周长奖励：与候选格 8 邻接且图上相邻的已放置邻居对（消灭长边穿透）。 */
  const ringBonus = (
    gx: number,
    gy: number,
    neighborCells: readonly Cell[],
    neighborIndices: readonly number[],
  ): number => {
    const touching: number[] = [];
    for (let k = 0; k < neighborIndices.length; k++) {
      const p = neighborCells[k]!;
      if (Math.max(Math.abs(p.gx - gx), Math.abs(p.gy - gy)) === 1) {
        touching.push(neighborIndices[k]!);
      }
    }
    let bonus = 0;
    for (let a = 0; a < touching.length; a++) {
      for (let b = a + 1; b < touching.length; b++) {
        if (adjacency[touching[a]!].has(touching[b]!)) bonus += 0.5;
      }
    }
    return bonus;
  };

  return {
    anchor(v, neighbors) {
      const cross = Math.round(
        neighbors.reduce((s, p) => s + crossOf(p), 0) / neighbors.length,
      );
      return mkCell(levelOf[v]!, cross);
    },

    score(v, gx, gy, neighbors, neighborIndices) {
      const flowC = direction === 'TB' ? gy : gx;
      let score =
        tension(gx, gy, neighbors) -
        ringBonus(gx, gy, neighbors, neighborIndices) +
        W_LEVEL * (flowC - levelOf[v]!) ** 2;

      // 方向罚：候选点不得逆着已放置邻居定义的流向。
      // inFlow = 已放置入边邻居的最大 flow（v 应在其下游：flow ≥ inFlow）；
      // outFlow = 已放置出边邻居的最小 flow（v 应在其上游：flow ≤ outFlow）。
      let inFlow = -Infinity;
      let outFlow = Infinity;
      for (let k = 0; k < neighborIndices.length; k++) {
        const f = flowOf(neighbors[k]!);
        const u = neighborIndices[k]!;
        if (inOf[v]!.has(u) && f > inFlow) inFlow = f;
        if (outOf[v]!.has(u) && f < outFlow) outFlow = f;
      }
      if (flowC < inFlow) score += W_DIR * (inFlow - flowC);
      if (flowC > outFlow) score += W_DIR * (flowC - outFlow);
      return score;
    },

    isDeadlock(v, _bestScore, _theoreticalMin, _neighborCount, bestCell) {
      // 真死锁（搜索预算内没有空格），或最佳候选偏离层级行超过容忍行数
      // （层级行拥堵：宁可插列也不把节点漂到远处行）。方向罚/张力计入
      // score 但不计入死锁判定 —— 候选格只要还在容忍行数内就照常放置，
      // 不为局部的方向约束推挤全图。
      if (bestCell === null) return true;
      return Math.abs(flowOf(bestCell) - levelOf[v]!) > DEV_CAP;
    },

    deadlock(grid, anchor) {
      return insertLine(grid, anchor.gx, anchor.gy, deadlockDirs);
    },

    /** 种子也钉在自己的层级行上（否则微调期流动弹簧要把它硬拉回层级）。 */
    placeSeed(grid: PointGrid, v: number): Cell {
      const lv = levelOf[v]!;
      for (let ring = 0; ring <= 8; ring++) {
        for (const gx of ring === 0 ? [0] : [ring, -ring]) {
          if (!grid.has(gx, lv)) return { gx, gy: lv };
        }
      }
      return placeOrphan(grid); // 层级行附近极端拥堵时退回默认孤儿放置
    },
  };
}

/**
 * 层内排序（Sugiyama 行内 barycenter）：粗布局后按相邻层邻居的 flow 轴坐标
 * 均值重排每层内部的先后次序，再按「半径和 + 间隙」的最小间距重放坐标。
 *
 * 为什么必须有它：环扩搜是按扫描顺序找空格的，同行内谁先抢到哪个格来自
 * 放置的偶然性而非图结构 —— 相邻子树的叶子向两侧对称扩展时迎面交错，产生
 * 大量可避免的行内交叉，层级罚权重调不出两全（钉死层级反而让行内更挤）。
 * 层内排序让每层顺序由「邻居质心」这一图结构决定：叶子聚到父节点下方、
 * 子树区间连续，行内交叉随之消解。
 *
 * 放在有向算法侧而非共享主流程：有序流动是有向美学的组成部分；无向图的
 * 核心美学是零交叉与有机形态，行序本就不该被钉死。
 *
 * 只动 cross 轴（TB 行内 x / LR 列内 y），层级行（flow 轴）位置不动。
 */
export function orderLayers(
  elements: readonly LayoutElement[],
  adjacency: Array<Set<number>>,
  levelOf: Int32Array,
  direction: 'TB' | 'LR',
  L: number,
): void {
  const crossOf = (el: LayoutElement): number => (direction === 'TB' ? el.x : el.y);
  const setCross = (el: LayoutElement, v: number): void => {
    if (direction === 'TB') el.x = v;
    else el.y = v;
  };

  // 分层，层内以当前 cross 坐标序作为 barycenter 的初值。
  const layers = new Map<number, number[]>();
  for (let v = 0; v < levelOf.length; v++) {
    const lv = levelOf[v]!;
    let layer = layers.get(lv);
    if (!layer) layers.set(lv, (layer = []));
    layer.push(v);
  }
  for (const layer of layers.values()) {
    layer.sort((a, b) => crossOf(elements[a]!) - crossOf(elements[b]!) || a - b);
  }
  const levelOrder = [...layers.keys()].sort((a, b) => a - b);

  // 与粗布局压实的目标间隙一致。
  const GAP = 0.3 * L;
  const keys = new Float64Array(elements.length);

  // 自下而上排子叶、再自上而下排父层，上下交替 4 遍（小图 1~2 遍即收敛）。
  for (let round = 0; round < 4; round++) {
    const sweep = round % 2 === 0 ? [...levelOrder].reverse() : levelOrder;
    for (const lv of sweep) {
      const layer = layers.get(lv)!;
      if (layer.length < 2) continue;

      for (const v of layer) {
        let sum = 0;
        let cnt = 0;
        for (const u of adjacency[v]) {
          if (levelOf[u] === lv - 1 || levelOf[u] === lv + 1) {
            sum += crossOf(elements[u]!);
            cnt++;
          }
        }
        keys[v] = cnt > 0 ? sum / cnt : crossOf(elements[v]!);
      }
      layer.sort((a, b) => keys[a]! - keys[b]! || a - b);

      // 重放：相邻对间距 ≥ max(L, 半径和 + 间隙)，保持该层质心不变。
      const positions: number[] = [];
      let cursor = 0;
      for (let k = 0; k < layer.length; k++) {
        if (k > 0) {
          const ra = elements[layer[k - 1]!].getBoundRadius();
          const rb = elements[layer[k]!].getBoundRadius();
          cursor += Math.max(L, ra + rb + GAP);
        }
        positions.push(cursor);
      }
      let mean = 0;
      for (const p of positions) mean += p;
      mean /= positions.length;
      let centroid = 0;
      for (const v of layer) centroid += crossOf(elements[v]!);
      const shift = centroid / layer.length - mean;
      for (let k = 0; k < layer.length; k++) {
        setCross(elements[layer[k]!]!, positions[k]! + shift);
      }
    }
  }
}
