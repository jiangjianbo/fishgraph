/**
 * 两端形态（端帽）策略实现：连线起点/终点处的装饰。
 *
 * decorate 只做局部几何：tip 为路径端点、(dx,dy) 为指向路径外部的单位
 * 切向（终点 = 行进方向，起点 = 反方向），与 path 长度无关 —— 线体不为
 * 端帽让位，装饰叠画在端点处（与旧版 demo 箭头行为一致）。
 */

import type { Vec2 } from '../types.js';
import type { EdgePath, EndCapDecoration, EndCapStrategy } from './types.js';

/** 无端帽：起终点无任何装饰。 */
export class NoneEndCapStrategy implements EndCapStrategy {
  readonly name = 'none';
  readonly tipLength = 0;

  decorate(_tip: Vec2, _dx: number, _dy: number, _at: 'source' | 'target'): EndCapDecoration {
    return {};
  }
}

/** 实心三角箭头（尺寸 = 沿切向的长度，半张角固定 0.4rad ≈ 23°）。 */
export class ArrowEndCapStrategy implements EndCapStrategy {
  readonly name = 'arrow';
  readonly tipLength: number;

  constructor(
    /** 箭头沿切向的长度（布局坐标，默认 8）。 */
    private size = 8,
  ) {
    this.tipLength = size;
  }

  decorate(tip: Vec2, dx: number, dy: number, _at: 'source' | 'target'): EndCapDecoration {
    const base = { x: tip.x - dx * this.size, y: tip.y - dy * this.size };
    const nx = -dy;
    const ny = dx;
    const half = this.size * 0.4;
    return {
      fills: [
        {
          points: [
            { ...tip },
            { x: base.x + nx * half, y: base.y + ny * half },
            { x: base.x - nx * half, y: base.y - ny * half },
          ],
        },
      ],
    };
  }
}

/** 开放式箭头（V 形两笔，不闭合不填充）。 */
export class OpenEndCapStrategy implements EndCapStrategy {
  readonly name = 'open';
  readonly tipLength: number;

  constructor(
    /** V 形沿切向的深度（布局坐标，默认 7）。 */
    private size = 7,
  ) {
    this.tipLength = size;
  }

  decorate(tip: Vec2, dx: number, dy: number, _at: 'source' | 'target'): EndCapDecoration {
    const nx = -dy;
    const ny = dx;
    const half = this.size * 0.5;
    const back = { x: tip.x - dx * this.size, y: tip.y - dy * this.size };
    const wing = (sign: number): EdgePath => ({
      start: { ...tip },
      segments: [
        {
          kind: 'line',
          to: { x: back.x + nx * half * sign, y: back.y + ny * half * sign },
        },
      ],
    });
    return { strokes: [{ path: wing(1) }, { path: wing(-1) }] };
  }
}

/**
 * 实心圆点端帽：圆心沿"路径外部"方向偏移一个半径 —— 圆点完整贴在
 * 端点外侧，不嵌入节点（端点本身在元素边界上）。
 */
export class DotEndCapStrategy implements EndCapStrategy {
  readonly name = 'dot';
  readonly tipLength: number;

  constructor(
    /** 圆点半径（布局坐标，默认 3）。 */
    private radius = 3,
  ) {
    // 圆点装饰不占线体（偏移到端点外侧），按半径保守约束贴边段。
    this.tipLength = radius;
  }

  decorate(tip: Vec2, dx: number, dy: number, _at: 'source' | 'target'): EndCapDecoration {
    return {
      dots: [{ center: { x: tip.x + dx * this.radius, y: tip.y + dy * this.radius }, radius: this.radius }],
    };
  }
}
