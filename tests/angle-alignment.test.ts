import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { useIdentityCoordinateSystem } from './helpers.js';
import type { GraphSpec } from '../src/types.js';

/** 两节点布局：节点 0 在 (x0, y0)，节点 1 固定在原点的 (100, deg) 极坐标处。 */
function twoNodeLayout(deg: number, strength: number, x0 = 0, y0 = 0): ForceLayout {
  const t = (deg * Math.PI) / 180;
  return new ForceLayout(
    {
      nodes: [
        { id: 0, x: x0, y: y0 },
        { id: 1, x: 100 * Math.cos(t), y: 100 * Math.sin(t) },
      ],
      edges: [{ source: 0, target: 1 }],
    },
    {
      accuracy: 'exact',
      naturalLength: 100,
      edgeAngleAlignment: strength,
      labelCollision: false,
      gravity: 'pairwise',
      weakGravityRatio: 0,
    },
  );
}

function snapshot(l: ForceLayout): { fx: Float64Array; fy: Float64Array; energy: number } {
  return (l as unknown as { strategy: { forceSnapshot(a: 'exact'): { fx: Float64Array; fy: Float64Array; energy: number } } }).strategy.forceSnapshot('exact');
}

describe('连线方向对齐（edgeAngleAlignment）', () => {
  it('三档能量：水平/垂直最低、±45° 稍高、22.5° 更高（差值与 kAng 成正比）', () => {
    // kAng = strength × k_a = 0.5；E(θ)=kAng·[(1−cos4θ)+(1−cos8θ)]
    // → E(0°)=0、E(45°)=2kAng=1、E(22.5°)=3kAng=1.5（基线能量三档相同：距离恒 100）
    const e0 = snapshot(twoNodeLayout(0, 0.5)).energy;
    const e45 = snapshot(twoNodeLayout(45, 0.5)).energy;
    const e225 = snapshot(twoNodeLayout(22.5, 0.5)).energy;
    expect(e45 - e0).toBeCloseTo(1, 9);
    expect(e225 - e0).toBeCloseTo(1.5, 9);
    expect(e0).toBeLessThan(e45);
    expect(e45).toBeLessThan(e225);
  });

  it('总力 = −∇E：中心差分与 forceSnapshot 解析力一致（含/不含方向项两种配置）', () => {
    const h = 1e-4;
    for (const strength of [0, 0.5]) {
      const sp = snapshot(twoNodeLayout(30, strength)); // 30° 方向力非零
      const exp = snapshot(twoNodeLayout(30, strength, h, 0)).energy;
      const em = snapshot(twoNodeLayout(30, strength, -h, 0)).energy;
      const epy = snapshot(twoNodeLayout(30, strength, 0, h)).energy;
      const emy = snapshot(twoNodeLayout(30, strength, 0, -h)).energy;
      const fxNum = -(exp - em) / (2 * h);
      const fyNum = -(epy - emy) / (2 * h);
      const tol = 1e-6 + 1e-4 * Math.max(Math.abs(fxNum), Math.abs(fyNum));
      expect(Math.abs(fxNum - sp.fx[0])).toBeLessThan(tol);
      expect(Math.abs(fyNum - sp.fy[0])).toBeLessThan(tol);
    }
  });

  it('strength=0 纯度：方向项完全退出，能量旋转不变', () => {
    const z0 = snapshot(twoNodeLayout(0, 0)).energy;
    const z30 = snapshot(twoNodeLayout(30, 0)).energy;
    const z45 = snapshot(twoNodeLayout(45, 0)).energy;
    expect(Math.abs(z30 - z0)).toBeLessThan(1e-12);
    expect(Math.abs(z45 - z0)).toBeLessThan(1e-12);
  });

  it('单边转向：斜置边弛豫后转到最近稳定向（0°/45°/90°）', () => {
    // 135° 与 45° 同线（模 90°），且靠近 45° 盆地分界（~116°/135°+19°）
    const layout = twoNodeLayout(135, 0.5);
    const r = layout.run({ maxIterations: 3000 });
    expect(r.converged).toBe(true);
    const a = layout.positions.get(0)!;
    const b = layout.positions.get(1)!;
    const deg = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 90;
    expect(Math.min(deg, Math.abs(deg - 45), 90 - deg)).toBeLessThan(2); // 终角距最近稳定向（模 90° 的 0°/45°）< 2°
  });

  it('默认强度下稀疏链的排列感可测量：正置边占比显著高于关闭时', () => {
    const chain = (n: number): GraphSpec => ({
      nodes: Array.from({ length: n }, (_, i) => ({ id: i })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ source: i, target: i + 1 })),
    });
    // 统计与最近稳定向（0°/45°/90°，模 90°）的最大偏差
    const worstDeviation = (l: ForceLayout) => {
      const pos = l.positions;
      let worst = 0;
      for (let i = 0; i + 1 < chainN; i++) {
        const a = pos.get(i)!;
        const b = pos.get(i + 1)!;
        const deg = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 90;
        worst = Math.max(worst, Math.min(deg, 90 - deg, Math.abs(deg - 45)));
      }
      return worst;
    };
    const chainN = 6;
    // 默认已关闭（opt-in）：开启侧显式传 0.1，与关闭侧形成对照。
    // identity：角度偏差断言测力学行为，与终点网格化修正解耦
    // （格点吸附会把链边强制成 0°/90° 正交向，角度语义失去测量意义）。
    const on = new ForceLayout(chain(chainN), { accuracy: 'exact', seed: 11, edgeAngleAlignment: 0.1, coordinateSystem: useIdentityCoordinateSystem() });
    const off = new ForceLayout(chain(chainN), { accuracy: 'exact', seed: 11, edgeAngleAlignment: 0, coordinateSystem: useIdentityCoordinateSystem() });
    on.run({ maxIterations: 4000 });
    off.run({ maxIterations: 4000 });
    expect(on.converged).toBe(true);
    expect(off.converged).toBe(true);
    // 方向项开启：每条边都被拉进某个稳定向 15° 邻域；关闭：无此约束
    expect(worstDeviation(on)).toBeLessThan(15);
    expect(worstDeviation(off)).toBeGreaterThan(worstDeviation(on));
  });
});
