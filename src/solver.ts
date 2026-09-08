/**
 * 求解器：能量单调下降的自适应步长弛豫 + 回溯线搜索。
 *
 * 每一步：
 *   1. 在当前位置计算力场与总能量；
 *   2. 沿力方向给每个节点一个试探位移（|位移| ≤ stepSize；弱引力的远场
 *      漂移用下限保障 —— 模拟"无摩擦自由滑动"，没有障碍能卡住节点）；
 *   3. 回溯线搜索：若试探后能量上升，把位移折半重试 —— 总能找到使能量
 *      下降的步长（力方向即负梯度方向），因此收敛平滑、无极限环；
 *   4. 收敛判据是力残差：所有节点的合力趋近 0（力 = −∇E），
 *      即"每个节点都停在自己最合适的位置"。
 */

import { computeForcesBH, computeForcesExact, type ForceContext } from './forces.js';

export interface SolverOptions {
  /** 单步初始试探位移上限（px），接受满步时增长。 */
  maxStep: number;
  /** stepSize 初始值（px）。 */
  initStep: number;
  /** 试探步长下限：低于它时重置步长（能量面在数值精度下已无法下降）。 */
  minStep: number;
  /**
   * 收敛判据：力残差 max|F|/forceUnit 低于该值视为已达平衡
   * （"每个节点都到自己最合适的位置"的物理定义 —— 合力为零）。
   */
  forceEps: number;
  /** 力残差连续达标次数达到后判定收敛。 */
  calmNeeded: number;
  /**
   * 远场漂移阈值（力单位 k_a/L²）：|F| 高于它时初始试探位移不小于
   * driftRatio×stepSize。弱引力 ∝ 1/g² 在远处衰减到极小，纯比例位移会让
   * 孤岛合并得极慢；该下限保证"有意义的力"总能产生可见移动。
   */
  driftForceEps: number;
  /** 远场漂移位移下限（相对 stepSize）。 */
  driftRatio: number;
}

const MAX_BACKTRACK = 8;

export class RelaxationSolver {
  stepSize: number;
  iterations = 0;
  converged = false;
  private forcesValid = false;
  private calm = 0;
  /** 最近接受步的位移衰减平均（px）：衡量布局是否已实质停止移动。 */
  private moveAvg = Infinity;
  private floorHits = 0;
  private saveX: Float64Array;
  private saveY: Float64Array;

  constructor(
    private ctx: ForceContext,
    public opts: SolverOptions,
  ) {
    this.stepSize = opts.initStep;
    this.saveX = new Float64Array(ctx.nodes.length);
    this.saveY = new Float64Array(ctx.nodes.length);
  }

  /** 外部状态（位置/参数）被改动后调用，强制重新计算力场。 */
  invalidate(): void {
    this.forcesValid = false;
    this.converged = false;
    this.calm = 0;
    this.moveAvg = Infinity;
  }

  private computeEnergy(): number {
    if (!this.forcesValid) {
      this.ctx.energy =
        this.ctx.accuracy === 'exact'
          ? computeForcesExact(this.ctx)
          : computeForcesBH(this.ctx);
      this.forcesValid = true;
    }
    return this.ctx.energy;
  }

  get energy(): number {
    return this.computeEnergy();
  }

  /**
   * 一步带线搜索的弛豫。返回 true 表示节点有被接受的移动（驱动动画帧）。
   */
  step(): boolean {
    if (this.converged) return false;
    if (this.ctx.nodes.length === 0) {
      this.converged = true;
      return false;
    }
    const e0 = this.computeEnergy();
    if (this.ctx.maxForceUnit < this.opts.forceEps) {
      // 已在平衡点（可能因参数更新前收敛），确认一次即收敛。
      if (++this.calm >= this.opts.calmNeeded) this.converged = true;
      return false;
    }

    const { nodes, params } = this.ctx;
    const s = this.stepSize;
    const invUnit = 1 / params.forceUnit;
    const sx = this.saveX;
    const sy = this.saveY;

    // 计算试探位移（力方向 × 比例步长，远场漂移下限，整体截断到 stepSize）
    const dxArr = new Float64Array(nodes.length);
    const dyArr = new Float64Array(nodes.length);
    // 信任域下限：防止线搜索把步长压塌成"每步纳米级爬行"。
    const sFloor = this.opts.maxStep * 0.05;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      sx[i] = nd.x;
      sy[i] = nd.y;
      if (nd.fixed) continue;
      const fMag = Math.hypot(nd.fx, nd.fy);
      if (fMag < 1e-12) continue;
      const fUnitMag = fMag * invUnit;
      let mag = fUnitMag * s;
      if (fUnitMag > this.opts.driftForceEps) {
        // 漂移下限随力残差淡出：接近收敛带（forceEps）时下限消失，
        // 否则保底位移会在平衡点附近造成永久过冲（极限环）。
        const fade = Math.min(1, fUnitMag / (10 * this.opts.forceEps));
        mag = Math.max(mag, this.opts.driftRatio * s * fade);
      }
      if (mag > s) mag = s;
      const k = mag / fMag;
      dxArr[i] = nd.fx * k;
      dyArr[i] = nd.fy * k;
    }

    // 回溯线搜索：λ 从 1 起折半，找到使能量下降的最大 λ
    let lambda = 1;
    let accepted = false;
    let e1 = e0;
    for (let attempt = 0; attempt < MAX_BACKTRACK; attempt++) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].fixed) continue;
        nodes[i].x = sx[i] + dxArr[i] * lambda;
        nodes[i].y = sy[i] + dyArr[i] * lambda;
      }
      this.forcesValid = false;
      e1 = this.computeEnergy();
      if (e1 < e0 || Math.abs(e1 - e0) <= 1e-12 * (1 + Math.abs(e0))) {
        accepted = true;
        break;
      }
      lambda *= 0.5;
    }

    if (accepted) {
      this.iterations++;
      // 信任域：满步接受 → 倍增（快速恢复）；线搜索收缩 → 按 λ 收缩但不低于下限。
      this.stepSize =
        lambda >= 1
          ? Math.min(this.stepSize * 2, this.opts.maxStep)
          : Math.max(this.stepSize * lambda, sFloor);
      this.floorHits = 0;
      // 位移停滞检测：接受的步子越来越小 → 布局已实质停止移动。
      // （用最大单节点位移衡量，不随节点数放大。）
      let movedMax = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].fixed) continue;
        const md = Math.hypot(dxArr[i], dyArr[i]) * lambda;
        if (md > movedMax) movedMax = md;
      }
      this.moveAvg = this.moveAvg === Infinity ? movedMax : this.moveAvg * 0.9 + movedMax * 0.1;
      if (this.iterations > 60 && this.moveAvg < 0.01) this.converged = true;
      if (this.ctx.maxForceUnit < this.opts.forceEps) {
        if (++this.calm >= this.opts.calmNeeded) this.converged = true;
      } else {
        this.calm = 0;
      }
      return true;
    }

    // 线搜索失败：能量面在所有缩放下均上升 —— 数值精度下的局部极小。
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].x = sx[i];
      nodes[i].y = sy[i];
    }
    this.forcesValid = false;
    this.stepSize *= 0.5;
    if (this.stepSize <= this.opts.minStep) {
      this.floorHits++;
      this.stepSize = this.opts.initStep * 0.25;
      if (this.floorHits > 24) this.converged = true;
    }
    return false;
  }
}
