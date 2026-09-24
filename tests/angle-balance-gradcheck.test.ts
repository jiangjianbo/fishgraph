import { describe, expect, it } from 'vitest';
import { ForceLayout } from '../src/index.js';
import { useIdentityCoordinateSystem } from './helpers.js';

/** 三叶星：hub 在原点，叶子 i 在极坐标 (radius, angles[i]°)，
 *  which/offset 用于给单个叶子做坐标扰动（中心差分）。 */
function starLayout(
  angles: readonly number[],
  balance: number,
  which = -1,
  dx = 0,
  dy = 0,
): ForceLayout {
  return new ForceLayout(
    {
      nodes: [
        { id: 'c', x: 0, y: 0 },
        ...angles.map((deg, i) => ({
          id: `l${i}`,
          x:
            100 * Math.cos((deg * Math.PI) / 180) +
            (i === which ? dx : 0),
          y:
            100 * Math.sin((deg * Math.PI) / 180) +
            (i === which ? dy : 0),
        })),
      ],
      edges: angles.map((_, i) => ({ source: 'c', target: `l${i}` })),
    },
    {
      accuracy: 'exact',
      naturalLength: 120,
      angleBalance: balance,
      labelCollision: false,
      gravity: 'pairwise',
      weakGravityRatio: 0,
      coordinateSystem: useIdentityCoordinateSystem(),
    },
  );
}

function snapshot(l: ForceLayout): { fx: Float64Array; fy: Float64Array; energy: number } {
  return (
    l as unknown as {
      strategy: { forceSnapshot(a: 'exact'): { fx: Float64Array; fy: Float64Array; energy: number } };
    }
  ).strategy.forceSnapshot('exact');
}

describe('同顶点连线角向均布（angleBalance）梯度一致性', () => {
  // 力 = −∇E 纪律（线搜索合法性的前提）：中心差分逐节点校验解析力。
  // 配置覆盖：60° 拥挤对（梯度大）、120° 近均匀（梯度小）、关闭（对照）。
  it('总力 = −∇E：中心差分与 forceSnapshot 解析力一致', () => {
    const h = 1e-4;
    for (const [angles, balance] of [
      [[0, 60, 200], 1],
      [[0, 120, 240], 1],
      [[0, 60, 200], 0],
    ] as const) {
      const sp = snapshot(starLayout(angles, balance));
      for (let ni = 0; ni < angles.length; ni++) {
        const exp = snapshot(starLayout(angles, balance, ni, h, 0)).energy;
        const em = snapshot(starLayout(angles, balance, ni, -h, 0)).energy;
        const epy = snapshot(starLayout(angles, balance, ni, 0, h)).energy;
        const emy = snapshot(starLayout(angles, balance, ni, 0, -h)).energy;
        const fxNum = -(exp - em) / (2 * h);
        const fyNum = -(epy - emy) / (2 * h);
        const fx = sp.fx[ni + 1];
        const fy = sp.fy[ni + 1];
        const tol = 1e-6 + 1e-4 * Math.max(Math.abs(fxNum), Math.abs(fyNum));
        expect(
          Math.abs(fxNum - fx),
          `l${ni}.fx @${angles}°,ab=${balance}: 数值 ${fxNum} vs 解析 ${fx}`,
        ).toBeLessThan(tol);
        expect(Math.abs(fyNum - fy)).toBeLessThan(tol);
      }
    }
  });

  it('开启相对关闭的力差 = 角向均布项：60° 拥挤对受张开力矩', () => {
    // 两叶 60°：角向项的切向分量应沿角度增加方向（把拥挤对推开）。
    // 用 on/off 力差隔离本项（弹簧/斥力为径向+叶间互斥，两配置相同抵消）。
    const off = snapshot(starLayout([0, 60], 0));
    const on = snapshot(starLayout([0, 60], 1));
    // 60° 叶（下标 2）处 θ̂ = (−sin60, cos60) = (−0.866, 0.5) 为角度增加方向
    const tOff = off.fy[2] * 0.5 - off.fx[2] * 0.866;
    const tOn = on.fy[2] * 0.5 - on.fx[2] * 0.866;
    expect(tOn - tOff, '角向项应提供正向（张开）切向力').toBeGreaterThan(0);
  });
});
