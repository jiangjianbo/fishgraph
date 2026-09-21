/**
 * ForceGroupStrategy —— 支持 group（subgraph / hidden-group）的力导向布局。
 *
 * 从纯力导向（ForceDirectedStrategy）派生：基础力场（节点对斥力/边弹力/
 * 避让/求解器）完全复用，group 语义通过基类的受保护扩展缝接入：
 *   - configureContext()：向 ForceContext.extensions 注入三组 group 力学 ——
 *       · extraForces：hidden-group 聚集束缚 + subgraph 成员锚定与半径自适应；
 *       · edgeAttraction：跨容器张力传导（实验开关，默认关）；
 *       · repulsionExempt：容器 vs 成员的斥力豁免（成员在容器内是期望状态）；
 *   - onRefresh()：groupCohesion 变化时重建聚集束缚系数；
 *   - refineLayout()：整体收敛后的"组内精修"（冻结组外节点，只让组成员
 *     弛豫；hidden-group 形状变化超 15% 时引发一轮重新整体布局）；
 *   - coordinateRegion()：坐标系修正时成员吸附区域钳制在其容器内部。
 *
 * 布局流程遵循"先整体、后组内、形状变化再整体"（见 README 分组章节）。
 */

import type { ForceContext } from '../force/forces.js';
import { ForceDirectedStrategy } from '../force/strategy.js';
import type { CoordinateNode } from '../coordinates.js';
import { registerStrategy, type ResolvedLayoutOptions } from '../strategy.js';
import {
  applyGroupForces,
  conductEdgeTension,
  hubExempt,
} from './groupForces.js';

export class ForceGroupStrategy extends ForceDirectedStrategy {
  readonly name: string = 'force-group';

  // ── 扩展缝实现 ──────────────────────────────────────────

  /** 注入 group 力学扩展点，并派生聚集束缚系数。 */
  protected override configureContext(): void {
    this.ctx.extensions = {
      extraForces: (ctx) => this.groupForces(ctx),
      edgeAttraction: (ctx, edgeIndex, f, e, ux, uy) =>
        this.tensionHook(ctx, edgeIndex, f, e, ux, uy),
      repulsionExempt: (ctx, i, j) => hubExempt(ctx.elements, i, j),
    };
    this.refreshClusterK();
  }

  /** groupCohesion 变化时重建聚集束缚系数。 */
  protected override onRefresh(previous: ResolvedLayoutOptions): void {
    if (this.options.groupCohesion !== previous.groupCohesion) {
      this.refreshClusterK();
    }
  }

  /** 组内精修：整体收敛后冻结组外节点、组内成员弛豫（分组原则 4）。 */
  protected override refineLayout(maxIterations: number, onTick?: () => void): void {
    if (this.store.subgraphs.length + this.store.hiddenGroups.length === 0 || maxIterations <= 0) {
      return;
    }
    const before = this.hiddenGroupBoxes();
    this.refineGroups(Math.max(150, Math.floor(maxIterations * 0.1)), onTick);
    const after = this.hiddenGroupBoxes();
    // hidden-group 形状（成员包围盒）变化超过 15% → 引发一轮重新整体布局。
    const changed = before.some((b, i) => {
      const a = after[i];
      return a && (Math.abs(a.w - b.w) > b.w * 0.15 || Math.abs(a.h - b.h) > b.h * 0.15);
    });
    if (changed) {
      this.solver.invalidate();
      this.runBudget(Math.max(200, Math.floor(maxIterations * 0.3)), onTick);
    }
  }

  /** 成员的格点吸附区域钳制在其容器的内切区域（包含语义保持）。 */
  protected override coordinateRegion(index: number): CoordinateNode['region'] {
    const hub = this.store.hubOfMember(index);
    if (hub < 0) return undefined;
    const anchor = this.store.elements[hub];
    return { anchorId: anchor.id, rIn: anchor.r * 0.55 };
  }

  // ── group 力学接线 ──────────────────────────────────────

  /** 附加力项：hidden-group 聚集束缚 + subgraph 成员锚定与半径自适应。 */
  private groupForces(ctx: ForceContext): number {
    return applyGroupForces(
      ctx.elements,
      this.store.clusterConstraints,
      this.store.subgraphNodes,
      this.kin,
    );
  }

  /** 边弹力钩子：跨容器张力传导（实验开关，默认关时为无操作）。 */
  private tensionHook(
    ctx: ForceContext,
    edgeIndex: number,
    f: number,
    e: number,
    ux: number,
    uy: number,
  ): number {
    if (!this.options.tensionConduction) return 0;
    return conductEdgeTension(
      ctx.elements,
      (index) => this.store.hubOfMember(index),
      ctx.edges[edgeIndex],
      f,
      e,
      ux,
      uy,
      ctx.params.forceUnit,
    );
  }

  /** subgraph 容器表面张力：k_in = 8·k_a/L³（成员出界每 1px 拉回 8·k_a/L³）。 */
  private get kin(): number {
    const L = this.params.L;
    return 8 / (L * L * L);
  }

  /** 聚集约束的每成员束缚系数：k = 强度/(L²·n)（k_a/L² 尺度、按成员数归一）。 */
  private refreshClusterK(): void {
    const L2 = this.options.naturalLength * this.options.naturalLength;
    for (const c of this.store.clusterConstraints) {
      const strength = c.strength ?? this.options.groupCohesion;
      c.k = strength / (L2 * Math.max(c.memberIndices.length, 1));
    }
  }

  // ── 组内精修 ────────────────────────────────────────────

  /** hidden-group 的成员包围盒（形状 = 成员组成的形状）。 */
  private hiddenGroupBoxes(): Array<{ w: number; h: number }> {
    return this.store.clusterConstraints.map((c) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const idx of c.memberIndices) {
        const nd = this.store.elements[idx];
        minX = Math.min(minX, nd.x);
        minY = Math.min(minY, nd.y);
        maxX = Math.max(maxX, nd.x);
        maxY = Math.max(maxY, nd.y);
      }
      return { w: maxX - minX, h: maxY - minY };
    });
  }

  /** 组内精修：冻结全部组外节点（含 subgraph 容器），只让组成员弛豫。 */
  private refineGroups(budget: number, onTick?: () => void): void {
    const isMember = new Uint8Array(this.store.elements.length);
    for (const sg of this.store.subgraphNodes) {
      for (const idx of sg.memberIndices) isMember[idx] = 1;
    }
    for (const c of this.store.clusterConstraints) {
      for (const idx of c.memberIndices) isMember[idx] = 1;
    }
    // subgraph 容器代表组的全局位置：组内精修期间固定
    // （嵌套时子容器会被外层标记为成员，此处强制保持冻结）。
    for (const sg of this.store.subgraphNodes) isMember[this.store.indexOf(sg.id)] = 0;
    const frozen: number[] = [];
    for (let i = 0; i < isMember.length; i++) if (!isMember[i]) frozen.push(i);
    for (const i of frozen) this.store.elements[i].fixed = true;
    this.solver.invalidate();
    this.runBudget(budget, onTick);
    for (const i of frozen) this.store.elements[i].fixed = false;
    this.solver.invalidate();
  }
}

registerStrategy('force-group', (store, options) => new ForceGroupStrategy(store, options));
