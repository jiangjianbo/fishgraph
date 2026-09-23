/**
 * 容器世界分块 —— "容器内部是独立世界"的力场语义支撑。
 *
 * 设计约定（2026-09-22）：每个 subgraph 容器的内部是一个独立力学世界：
 *   - 容器对内部成员没有力作用；
 *   - 容器外元素对容器内元素没有影响（跨世界零力耦合，严格双向）；
 *   - 根层（不属于任何容器的元素）视为"无限大容器"的世界 —— 边界在
 *     无穷远，包含约束恒满足，无需物化根容器节点。
 *
 * 落地方式：
 *   1. world[i] = 元素 i 所属的最内层容器下标（非成员 -1；嵌套容器的
 *      本体 = 其父容器）；
 *   2. 同世界元素间力学如常；跨世界节点对在力场入口短路（forces.ts）；
 *   3. 跨世界的连线提升为容器本体之间的连线（外部世界通过容器感知
 *      连接，内部世界不被侵扰）—— 提升只改力学端点，渲染仍画原始边；
 *   4. 成员块与容器本体的对齐用纯平移（不缩放、不改内部相对构型，
 *      与 group-undirected 的 settleGroup 同一口径）：粗布局后种入一次
 *      （alignMembersToContainers），弛豫收敛 + 坐标系修正后再对齐一次。
 *      弛豫期两世界零耦合、各自独立收敛，能量不受末次平移影响。
 */

import type { GraphStore } from '../../graph/store.js';
import { elementsAABB } from '../../graph/store.js';
import type { InternalEdge } from '../../graph/store.js';
import { clampPointToShape } from '../../geometry.js';

/** 一张世界分块表（有 subgraph 声明时才构建）。 */
export interface WorldPartition {
  /** 元素物理下标 → 所属最内层容器物理下标（非成员 -1）。 */
  readonly world: Int32Array;
  /** 提升后的边（跨世界边端点替换为容器本体；世界内边原样保留）。 */
  readonly liftedEdges: InternalEdge[];
  /** 每条提升边的世界：世界内边 = 该世界下标；提升边/根层边 = -1。 */
  readonly edgeWorld: Int32Array;
  /** 提升后的邻接（粗布局放置与 hopScale 的拓扑口径）。 */
  readonly liftedAdj: Array<Set<number>>;
}

/** 从 store 的 subgraph 物化结构构建世界分块表。 */
export function buildWorldPartition(store: GraphStore): WorldPartition {
  const n = store.elements.length;
  const world = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    world[i] = store.hubOfMember(i);
  }

  const liftedEdges: InternalEdge[] = [];
  const edgeWorld: number[] = [];
  for (const e of store.edges) {
    const ws = world[e.sourceIndex];
    const wt = world[e.targetIndex];
    if (ws === wt) {
      // 同世界边（含根-根边）：原样保留。
      liftedEdges.push(e);
      edgeWorld.push(ws);
      continue;
    }
    // 跨世界边：端点提升为其世界的容器本体（根侧端点保持原元素）。
    liftedEdges.push({
      ...e,
      sourceIndex: ws >= 0 ? ws : e.sourceIndex,
      targetIndex: wt >= 0 ? wt : e.targetIndex,
    });
    edgeWorld.push(-1);
  }

  const liftedAdj: Array<Set<number>> = store.elements.map(() => new Set<number>());
  for (const e of liftedEdges) {
    liftedAdj[e.sourceIndex].add(e.targetIndex);
    liftedAdj[e.targetIndex].add(e.sourceIndex);
  }

  return {
    world,
    liftedEdges,
    edgeWorld: Int32Array.from(edgeWorld),
    liftedAdj,
  };
}

/**
 * 成员边界钳制（运动学约束，非力）：把越界成员沿容器形状 SDF 压回
 * （margin = 成员有效半径）。弛豫每步调用——世界内弹力（尤其交互拖拽
 * 贴边时）会把其他成员推出边界，压回保证成员任何时刻都在自己的世界内；
 * 零力耦合语义不变，容器对成员仍无力作用。
 *
 * 嵌套容器跑两遍（声明序子先父后）：第一遍外层压子容器本体，第二遍
 * 修正子容器本体移动后其成员的残余越界。
 */
export function clampMembersToContainers(store: GraphStore, partition: WorldPartition): void {
  const { world } = partition;
  for (let pass = 0; pass < 2; pass++) {
    for (const g of store.subgraphNodes) {
      const hubIdx = store.indexOf(g.id);
      if (hubIdx < 0) continue;
      for (let i = 0; i < world.length; i++) {
        if (world[i] !== hubIdx) continue;
        const el = store.elements[i];
        if (!el) continue;
        const p = clampPointToShape(g.declaredShape, g.x, g.y, el.x, el.y, el.r);
        el.x = p.x;
        el.y = p.y;
      }
    }
  }
}

/**
 * 成员块 → 容器本体对齐（纯平移）：把 world === 容器 的元素块按包围盒
 * 中心平移到容器本体当前位置。嵌套按声明序自顶向下生效（父容器声明需
 * 先于子容器）：父轮平移带动子容器本体，子轮以子容器新位置为锚。
 * 末尾统一刷新容器有效半径（包裹成员 + padding）。
 *
 * 两处调用：粗布局后（种入，成员块从粗布局位置搬进容器）与
 * 弛豫收敛 + 坐标系修正后（终局对齐，容器在弛豫中移动过）。
 */
export function alignMembersToContainers(store: GraphStore, partition: WorldPartition): void {
  const { world } = partition;
  for (const g of store.subgraphNodes) {
    const hubIdx = store.indexOf(g.id);
    if (hubIdx < 0) continue;
    const members: number[] = [];
    for (let i = 0; i < world.length; i++) {
      if (world[i] === hubIdx) members.push(i);
    }
    const bounds = elementsAABB(store.elements, members);
    if (!bounds) continue;
    const dx = g.x - (bounds.minX + bounds.maxX) / 2;
    const dy = g.y - (bounds.minY + bounds.maxY) / 2;
    for (const i of members) {
      const el = store.elements[i];
      if (!el) continue;
      el.x += dx;
      el.y += dy;
    }
  }
  // 对齐平移后个别成员可能仍越界（弛豫中弹力拉扯出的构型），压回容器
  // 内再刷新容器几何，保证终局态成员完全落在边界内。
  clampMembersToContainers(store, partition);
  // 容器有效半径按成员几何刷新：种入后外层弛豫按新半径隔开外部元素；
  // 终局对齐后刷新渲染口径。
  for (const sg of store.subgraphNodes) {
    sg.updateBoundsFromChildren(store.elements);
  }
}
