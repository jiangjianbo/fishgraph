/**
 * 端点对接策略实现。
 *
 * 侧选择共用一条规则（dominantSide）：按「本端中心 → 对端中心」的主导轴
 * 选边（水平位移大走左右侧，垂直位移大走上下侧），平局归水平轴 ——
 * renderer 的同侧分组与本文件的端口定位由此保持同一口径。
 */

import type { EdgeEndpointBox, PortStrategy, PortWithNormal } from './types.js';

/** 元素边界的四个对接侧（y 向下为正的屏幕坐标语义）。 */
export type Side = 'right' | 'left' | 'bottom' | 'top';

/** 按「指向对端的方向」选主导侧（平局归水平轴，规则固定 → 确定性）。 */
export function dominantSide(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** 侧 → 端口外法向（单位向量，离开元素的方向）。 */
function sideNormal(side: Side): { nx: number; ny: number } {
  switch (side) {
    case 'right': return { nx: 1, ny: 0 };
    case 'left': return { nx: -1, ny: 0 };
    case 'bottom': return { nx: 0, ny: 1 };
    case 'top': return { nx: 0, ny: -1 };
  }
}

/** slot 序号 → 侧边上的偏移（沿边均匀分布，两端各留 inset）。 */
function slotOffset(
  side: Side,
  end: EdgeEndpointBox,
  slot: number,
  slotCount: number,
  inset: number,
): number {
  // 竖侧（左右）沿 y 展开、横侧（上下）沿 x 展开；
  // slot 0 恒在负方向端（上/左），递增走向正方向端 —— 与 renderer 的
  // 组内方位角排序配合，形成"从上到下/从左到右"的稳定次序。
  const half = side === 'right' || side === 'left' ? end.hh : end.hw;
  const span = Math.max(0, half * 2 - inset * 2);
  const t = slotCount <= 1 ? 0.5 : slot / (slotCount - 1);
  return -half + inset + span * t;
}

/** 组装端口结果（侧上偏移 + 外法向）。 */
function makePort(side: Side, end: EdgeEndpointBox, along: number): PortWithNormal {
  const { nx, ny } = sideNormal(side);
  return side === 'right' || side === 'left'
    ? { x: end.x + nx * end.hw, y: end.y + along, nx, ny }
    : { x: end.x + along, y: end.y + ny * end.hh, nx, ny };
}

/**
 * 固定四点：每侧只对接在边界中点（slot 无效）。
 * 同侧多条边重叠 —— 即"固定点"语义，与旧版 demo 的中心射出相对，
 * 本策略给出真正的边界贴点。
 */
export class FixedPortStrategy implements PortStrategy {
  readonly name = 'fixed';

  port(end: EdgeEndpointBox, toward: { x: number; y: number }, _slot: number, _slotCount: number): PortWithNormal {
    const side = dominantSide(toward.x, toward.y);
    return makePort(side, end, 0);
  }
}

/**
 * 同侧均匀分布：仍按主导方向选侧，但同侧多条边按 slot 均匀铺开、
 * 两端留 inset —— 避免全部挤在侧中点。
 */
export class DistributedPortStrategy implements PortStrategy {
  readonly name = 'distributed';

  constructor(
    /** 端口离侧边两端的留白（布局坐标，默认 6）。 */
    private inset = 6,
  ) {}

  port(end: EdgeEndpointBox, toward: { x: number; y: number }, slot: number, slotCount: number): PortWithNormal {
    const side = dominantSide(toward.x, toward.y);
    return makePort(side, end, slotOffset(side, end, slot, slotCount, this.inset));
  }
}
