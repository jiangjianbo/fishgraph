/**
 * group 力学（force-group 专属）—— 从纯力导向力场中迁出的全部 group 语义。
 *
 *  - hidden-group（ClusterConstraint）：成员到组质心的简谐束缚（向心力，
 *    保守、总合力零）—— "隐藏组内的节点倾向于聚集在一起"（力钩子在
 *    ClusterConstraint.applyForces 内实现，这里只负责调度）；
 *  - subgraph（LayoutSubgraphNode）：成员锚定弹簧 —— 成员被拉向容器中心，
 *    容器由全局力场定位；求值末尾容器执行 updateBoundsFromChildren()
 *    按成员几何刷新自身半径（最小面积填充）；
 *  - hub-成员斥力豁免：容器是"区域"而非实体，成员位于容器内部是期望
 *    状态，不算穿透（防重叠由成员间互斥与锚定力保证）；
 *  - 跨容器张力传导（实验性，默认关）：跨容器边的弹力按有界比例传导给
 *    容器（hub）。已知问题：简单传导与容器互斥/弱引力平衡后仍可能振荡，
 *    需要专项的引力+阻尼设计。
 *
 * 这些力通过 ForceContext.extensions 注入基础力场（见 force/forces.ts），
 * 全部由势能求导或与能量记账一致，保证与求解器的能量单调下降兼容。
 */

import type {
  ClusterConstraint,
  InternalEdge,
  LayoutElement,
  LayoutSubgraphNode,
} from '../../graph/store.js';

/** subgraph 容器与其成员之间的斥力豁免判定（O(1)，memberSet 查询）。 */
export function hubExempt(elements: readonly LayoutElement[], i: number, j: number): boolean {
  const ei = elements[i];
  if (ei.isSubgraph && (ei as LayoutSubgraphNode).memberSet.has(j)) return true;
  const ej = elements[j];
  if (ej.isSubgraph && (ej as LayoutSubgraphNode).memberSet.has(i)) return true;
  return false;
}

/** 成员到锚点的线性弹力（保守、合力零）。返回该组势能。 */
function pullToAnchor(
  elements: readonly LayoutElement[],
  memberIndices: readonly number[],
  k: number,
  anchorX: number,
  anchorY: number,
): number {
  let e = 0;
  for (const idx of memberIndices) {
    const nd = elements[idx];
    const fx = (k * nd.mass) * (anchorX - nd.x);
    const fy = (k * nd.mass) * (anchorY - nd.y);
    nd.fx += fx;
    nd.fy += fy;
    e += 0.5 * k * nd.mass * ((nd.x - anchorX) ** 2 + (nd.y - anchorY) ** 2);
  }
  return e;
}

/**
 * 组束缚力（精确与 BH 共用，O(成员数)）：
 * hidden-group 聚集束缚 + subgraph 成员锚定与容器半径自适应。
 * 在基础力场求值末尾由 extraForces 扩展点调用。
 */
export function applyGroupForces(
  elements: readonly LayoutElement[],
  constraints: readonly ClusterConstraint[],
  subgraphs: readonly LayoutSubgraphNode[],
  kin: number,
): number {
  let energy = 0;
  // hidden-group：辅助向心引力（约束钩子自己算力与能量）
  for (const c of constraints) {
    energy += c.applyForces(elements);
  }
  // subgraph：成员锚定到容器 + 容器半径按成员几何自适应
  for (const sg of subgraphs) {
    if (sg.memberIndices.length === 0) continue;
    // 锚点 = 容器自身。容器与成员间无斥力（成员在容器内是期望状态）。
    energy += pullToAnchor(elements, sg.memberIndices, kin, sg.x, sg.y);
    sg.updateBoundsFromChildren(elements);
  }
  return energy;
}

/**
 * 跨容器张力传导（有界，实验性）：跨容器边（成员↔free 或 成员↔异组成员）
 * 的弹力按 min(半力, 封顶) 传导给成员所属的容器 —— 容器朝连接方向响应，
 * 而拉力有界，不会把成员拖出容器，也不会发散。返回传导项的记账能量。
 */
export function conductEdgeTension(
  elements: readonly LayoutElement[],
  hubOf: (index: number) => number,
  edge: InternalEdge,
  f: number,
  e: number,
  ux: number,
  uy: number,
  forceUnit: number,
): number {
  const hubA = hubOf(edge.sourceIndex);
  const hubB = hubOf(edge.targetIndex);
  if (hubA < 0 && hubB < 0) return 0;
  const fCap = 60 * forceUnit;
  const fCond = Math.min(0.5 * f, fCap);
  if (hubA >= 0) {
    const ha = elements[hubA];
    ha.fx -= fCond * ux;
    ha.fy -= fCond * uy;
  }
  if (hubB >= 0) {
    const hb = elements[hubB];
    hb.fx += fCond * ux;
    hb.fy += fCond * uy;
  }
  return 0.5 * (fCond / Math.max(f, 1e-9)) * e;
}
