/**
 * 贴合方式策略实现：端口点（AABB 侧边上选出）→ 元素真实几何上的最终端点。
 *
 * PortStrategy 回答"连在元素哪个面的哪个位置"，本文件回答"该点如何落到
 * 元素几何上"。四种口径由粗到细：包围圆 → AABB → 声明形状边界 → 不贴合
 * （中心）。非轴向贴合点的法向取径向（圆心指向贴合点），保证 breakout
 * 沿边界外法向伸出。
 */

import { boundingRadius, rayShapeExit } from '../geometry.js';
import type { EdgeEndpointBox, EndpointFitStrategy, PortWithNormal } from './types.js';

/** 中心 → 端口方向的单位向量（端口在中心时退回端口法向）。 */
function portDirection(port: PortWithNormal, box: EdgeEndpointBox): { x: number; y: number } {
  const dx = port.x - box.x;
  const dy = port.y - box.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: port.nx, y: port.ny };
  return { x: dx / len, y: dy / len };
}

/** AABB 边界：端口点即最终端点（现状口径，端口本来就选在 AABB 侧边上）。 */
export class AabbEndpointFitStrategy implements EndpointFitStrategy {
  readonly name = 'aabb';

  fit(port: PortWithNormal, _box: EdgeEndpointBox): PortWithNormal {
    return port;
  }
}

/** 声明形状边界：沿中心 → 端口射线求真实形状交点（rayShapeExit）。 */
export class ShapeEndpointFitStrategy implements EndpointFitStrategy {
  readonly name = 'shape';

  fit(port: PortWithNormal, box: EdgeEndpointBox): PortWithNormal {
    const u = portDirection(port, box);
    const dist = rayShapeExit(box.shape, u.x, u.y);
    return { x: box.x + u.x * dist, y: box.y + u.y * dist, nx: u.x, ny: u.y };
  }
}

/** 包围圆边界：等效包围圆半径处的点（最宽松的贴合，端点离形状最远）。 */
export class CircleEndpointFitStrategy implements EndpointFitStrategy {
  readonly name = 'circle';

  fit(port: PortWithNormal, box: EdgeEndpointBox): PortWithNormal {
    const u = portDirection(port, box);
    const r = boundingRadius(box.shape);
    return { x: box.x + u.x * r, y: box.y + u.y * r, nx: u.x, ny: u.y };
  }
}

/** 不贴合：端点 = 元素中心（线体伸入节点内部，供特殊渲染口径）。 */
export class CenterEndpointFitStrategy implements EndpointFitStrategy {
  readonly name = 'center';

  fit(port: PortWithNormal, box: EdgeEndpointBox): PortWithNormal {
    return { x: box.x, y: box.y, nx: port.nx, ny: port.ny };
  }
}
