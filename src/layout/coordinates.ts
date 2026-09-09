/**
 * 坐标系（可替换的坐标修正策略）。
 *
 * 布局完成（弛豫、组内精修、形状重布局）之后，以当前最优布局为基础
 * 做一次坐标修正：`refine`。求解过程完全不感知坐标系 —— 修正策略
 * 通过注册名选择（组合根创建一次实例），布局流程只面向接口。
 *
 * 内置：
 *   'free' —— 恒等（默认，保持自由坐标）；
 *   'grid' —— 网格化：就近吸附到格点；目标格不可用（被占/距离过近/
 *             超出 subgraph 包含区）时 BFS 环形扩搜最近可用格点，
 *             保证吸附后任意两节点不重叠。
 *
 * 自定义坐标系（hex、polar 等）用 registerCoordinateSystem 注册即可。
 */

import type { NodeId } from '../types.js';

export interface CoordinateNode {
  id: NodeId;
  x: number;
  y: number;
  /** 包围半径。 */
  r: number;
  /** 固定节点同样吸附，但优先注册占用（后续节点避开它）。 */
  fixed: boolean;
  /**
   * subgraph 包含区域：吸附后被钳制在锚点（subgraph hub）周围
   * rIn 的格点内 —— 成员保持在其 subgraph 内部。
   */
  region?: { anchorId: NodeId; rIn: number };
}

export interface RefineParams {
  /** 吸附间距（格点间距，px）。 */
  lattice: number;
}

export interface CoordinateSystem {
  readonly name: string;
  /** 布局完成后，以当前最优布局为基础进行坐标修正（就地修改）。 */
  refine(nodes: CoordinateNode[], params: RefineParams): void;
}

export type CoordinateSystemFactory = () => CoordinateSystem;

const registry = new Map<string, CoordinateSystemFactory>();

/** 注册坐标修正策略（同名覆盖）。 */
export function registerCoordinateSystem(name: string, factory: CoordinateSystemFactory): void {
  registry.set(name, factory);
}

/** 按注册名创建坐标修正策略；未知名抛错并列出可用项。 */
export function createCoordinateSystem(name: string): CoordinateSystem {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown coordinate system: ${String(name)}（可用：${listCoordinateSystems().join(', ')}）`);
  }
  return factory();
}

/** 当前已注册的坐标系名。 */
export function listCoordinateSystems(): string[] {
  return [...registry.keys()];
}

/** 恒等修正：保持自由坐标。 */
function freeSystem(): CoordinateSystem {
  return {
    name: 'free',
    refine() {
      // 自由坐标：不做任何修正
    },
  };
}

/** 网格坐标：格点键（格列, 格行）→ 已放置节点下标。 */
type Occupancy = Map<string, number>;

/** 格点是否可用：未被占，且与全部已放节点距离 ≥ 半径和 + 余量。 */
function cellUsable(
  gx: number,
  gy: number,
  lattice: number,
  r: number,
  occ: Occupancy,
  nodes: CoordinateNode[],
  placed: number[],
): boolean {
  const key = `${gx},${gy}`;
  if (occ.has(key)) return false;
  const x = gx * lattice;
  const y = gy * lattice;
  for (const pi of placed) {
    const other = nodes[pi];
    const need = other.r + r + 2;
    if (Math.hypot(other.x - x, other.y - y) < need) return false;
  }
  return true;
}

/** 网格坐标：就近吸附 + 冲突消解（BFS 环形扩搜最近可用格点）。
 *  放置分两遍：先无 region 的节点（含 subgraph hub），再带 region 的成员
 *  （region 以锚点 **吸附后的新位置** 为中心，跟随 hub 移动）。 */
function gridSystem(): CoordinateSystem {
  return {
    name: 'grid',
    refine(nodes: CoordinateNode[], params: RefineParams): void {
      const byId = new Map<NodeId, CoordinateNode>(nodes.map((nd) => [nd.id, nd]));
      const rmax = nodes.reduce((m, nd) => Math.max(m, nd.r), 0);
      // 吸附间距不小于最大直径，保证同格/邻格节点不重叠
      const lattice = Math.max(params.lattice, rmax * 2, 1e-6);
      // 稳定顺序：按 (y, x)（吸附结果与输入顺序无关，确定性）
      const order = nodes
        .map((_, i) => i)
        .sort((a, b) => nodes[a].y - nodes[b].y || nodes[a].x - nodes[b].x || a - b);
      // 固定节点优先：先注册占用，后续节点自动避开
      const sorted = [...order].sort(
        (a, b) =>
          Number(nodes[b].fixed) - Number(nodes[a].fixed) ||
          Number(!!nodes[a].region) - Number(!!nodes[b].region),
      );

      const occ: Occupancy = new Map();
      const placed: number[] = [];
      /** 锚点当前坐标（region 引用的 hub 吸附后的新位置）。 */
      const anchorPos = (nd: CoordinateNode): { x: number; y: number } => {
        const a = byId.get(nd.region!.anchorId);
        return a ? { x: a.x, y: a.y } : { x: nd.x, y: nd.y };
      };

      for (const i of sorted) {
        const nd = nodes[i];
        let gx = Math.round(nd.x / lattice);
        let gy = Math.round(nd.y / lattice);
        // subgraph 成员：目标格钳制在锚点（hub 新位置）附近的包含区内
        if (nd.region) {
          const c = anchorPos(nd);
          gx = Math.round(Math.min(c.x + nd.region.rIn, Math.max(c.x - nd.region.rIn, nd.x)) / lattice);
          gy = Math.round(Math.min(c.y + nd.region.rIn, Math.max(c.y - nd.region.rIn, nd.y)) / lattice);
        }
        if (!cellUsable(gx, gy, lattice, nd.r, occ, nodes, placed)) {
          // BFS 环形扩搜最近可用格点（region 成员限定在包含区内的格窗）
          let found = false;
          const maxRing = 64;
          for (let ring = 1; ring <= maxRing && !found; ring++) {
            let best: { gx: number; gy: number; d2: number } | null = null;
            const c = nd.region ? anchorPos(nd) : { x: nd.x, y: nd.y };
            for (let dx = -ring; dx <= ring; dx++) {
              for (let dy = -ring; dy <= ring; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // 只看环缘
                const cx2 = gx + dx;
                const cy2 = gy + dy;
                if (nd.region) {
                  if (Math.hypot(cx2 * lattice - c.x, cy2 * lattice - c.y) > nd.region.rIn) continue;
                }
                if (!cellUsable(cx2, cy2, lattice, nd.r, occ, nodes, placed)) continue;
                const d2 = (cx2 * lattice - c.x) ** 2 + (cy2 * lattice - c.y) ** 2;
                if (!best || d2 < best.d2) best = { gx: cx2, gy: cy2, d2 };
              }
            }
            if (best) {
              gx = best.gx;
              gy = best.gy;
              found = true;
            }
          }
          if (!found) continue; // 搜索预算内无格可用：保留原坐标（不阻塞布局）
        }
        occ.set(`${gx},${gy}`, i);
        placed.push(i);
        nd.x = gx * lattice;
        nd.y = gy * lattice;
      }
    },
  };
}

registerCoordinateSystem('free', freeSystem);
registerCoordinateSystem('grid', gridSystem);
