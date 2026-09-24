/**
 * 坐标系（可替换的坐标修正策略）。
 *
 * 布局完成（弛豫、组内精修、形状重布局）之后，以当前最优布局为基础
 * 做一次坐标修正：`refine`。求解过程完全不感知坐标系 —— 修正策略
 * 通过注册名选择（组合根创建一次实例），布局流程只面向接口。
 *
 * 内置：
 *   'grid'（默认，唯一内置）—— 网格化：就近吸附到格点；目标格不可用
 *             （被占/距离过近/超出 subgraph 包含区）时环形扩搜最近可用
 *             格点，保证吸附后任意两节点不重叠。携带边与方向信息时为
 *             质量感知吸附：放置顺序沿邻接关系从结构中心 BFS 生长（每
 *             条边由较晚放置的端点以两端最终位置做最终检查），格点选择
 *             优先保持方向行序（不逆流）与连线零穿越，预算内无零损伤
 *             格点时就近降级。
 *
 * 自定义坐标系（hex、polar 等）用 registerCoordinateSystem 注册即可。
 */

import { closestPointOnSegment, segmentsProperlyIntersect } from '../geometry.js';
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
   * hw/hh（逐轴半宽高净空）的格点内 —— 成员保持在其 subgraph
   * 声明矩形内部（矩形包含是构造性不变量，格点距离按轴向计）。
   */
  region?: { anchorId: NodeId; hw: number; hh: number };
}

export interface RefineEdge {
  source: NodeId;
  target: NodeId;
}

/** 流向约束：吸附格点选择保持 flow.edges 的 target 严格不逆于 source
 *  （'TB' 格行 / 'LR' 格列），且同层节点聚居同一格行/列（层级感）。
 *  只应携带流向边（有向算法的正向边）——反馈边两端互相矛盾，约束会
 *  污染整个环组件的搜索。 */
export interface RefineFlow {
  direction: 'TB' | 'LR';
  edges: readonly RefineEdge[];
  /**
   * 节点 id → 层级号（与流向同方向递增；缺省或负值 = 无层级，不约束）。
   * 提供时同层节点吸附到同一格行（TB）/格列（LR）—— 分支不与
   * 邻层的叶抢行，层级结构在网格化后仍然可读。
   */
  levels?: ReadonlyMap<NodeId, number>;
}

export interface RefineParams {
  /** 吸附间距（格点间距，px）。 */
  lattice: number;
  /**
   * 格单位比例尺（px/格，来自初始化分级）：格点物理余量（cellUsable/
   * crossOk 的 r+2px）按 S/60 缩放。缺省按 lattice/60 处理（格距=1 格时等价）。
   */
  cellScale?: number;
  /**
   * 全部连接关系（供质量感知吸附）：候选格优先选择不使关联边穿过
   * 第三方节点的格点。缺省按无边处理（只保证不重叠）。
   */
  edges?: readonly RefineEdge[];
  /** 流向约束（见 RefineFlow）；缺省无方向约束。 */
  flow?: RefineFlow;
  /**
   * 容器保留区（锚点周围声明矩形）：非本区成员的候选格不得落在
   * 区内 —— 外部节点避让容器内部，容器矩形内只保留成员。锚点
   * （容器本体）在专门的 hub 批次先于自由节点落格，检查读到的是
   * 吸附后的最终位置。
   */
  zones?: readonly RefineZone[];
}

/** 容器保留区：锚点 + 逐轴半宽高（声明矩形内净空的对外口径）。 */
export interface RefineZone {
  anchorId: NodeId;
  hw: number;
  hh: number;
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

/** 网格坐标：格点键（格列, 格行）→ 已放置节点下标。 */
type Occupancy = Map<string, number>;

/**
 * 容器容量格距上限：净空 hw×hh 内能装下 count 个格胞中心的最大格距。
 * 格胞中心落在净空 [−hw,hw] 内的列数 = 2⌊hw/L⌋+1（行同理），列×行 ≥
 * count 即可全部入区。返回 count=1 或净空非正时的 Infinity（无约束）。
 */
export function zoneLatticeCap(hw: number, hh: number, count: number): number {
  if (count <= 1 || hw <= 0 || hh <= 0) return Infinity;
  // 候选格距取 hw/m 与 hh/m（跨档临界值），从中取满足容量的最大者。
  let best = 0;
  const candidates = new Set<number>();
  for (let m = 1; m <= 256; m++) {
    candidates.add(hw / m);
    candidates.add(hh / m);
  }
  for (const L of candidates) {
    const cols = 2 * Math.floor(hw / L) + 1;
    const rows = 2 * Math.floor(hh / L) + 1;
    if (cols * rows >= count) best = Math.max(best, L);
  }
  return best;
}

/**
 * 格距自适应：用户请求格距与弛豫终态力学平衡间距的稳健估计取大者。
 * 力学平衡间距（节点尺寸 + 斥力/弹簧共同决定）大于格距时，就近量化
 * 必然把总跨度撑大出"洞"（相邻节点落到隔一格，间距在 1L/2L 间跳变）；
 * 格距抬到平衡间距以上后每个节点都能落在自己的格胞、量化应力趋零。
 *
 * 估计取最近邻间距的上中位：格距 ≥ 间距一半即保证相邻对不同格（实距
 * < G/2 才会同格），间距 < 1.5·G 才会量化出两格"洞"，现实分布（±px 级
 * 离散）距两界都有充足裕度。取中位而非最大/高分位，是因为单点离群
 * （超大标签节点、孤立远点）只占最近邻样本至多一份，不应主导全局格距
 * —— 多层折叠布局（group-undirected）的冻结样本常是单个层级（可能只
 * 有几个元素），保守分位会把全部层级的格距抬爆（实测 mermaid 图 321 vs
 * 中位 224）；无组图与折叠布局共用本估计，逐位一致也要求同一口径。
 * 逐点分离不依赖格距 ≥ 最大间距：吸附的占用表 + 逐对距离检查兜底。
 *
 * caps：各 subgraph 容器的容量格距上限（zoneLatticeCap）。格距超过它
 * 时容器净空装不下成员格胞，成员被迫按网格不变量降级出区 —— 包含性
 * 承诺比量化均匀更优先，故自适应值先对 caps 取小再与请求值取大。
 * caps 只依赖图结构（容器/成员实占），不影响吸附态的不动点性质。
 */
export function resolveRefineLattice(
  requested: number,
  nodes: readonly CoordinateNode[],
  caps?: readonly number[],
): number {
  const n = nodes.length;
  if (n < 2) return requested;
  const nearest: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = nodes[j]!.x - nodes[i]!.x;
      const dy = nodes[j]!.y - nodes[i]!.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (Number.isFinite(best)) nearest.push(Math.sqrt(best));
  }
  if (nearest.length === 0) return requested;
  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)]!;
  const cap = caps && caps.length > 0 ? Math.min(...caps) : Infinity;
  return Math.max(requested, Math.min(median, cap));
}

/** 格点是否可用：未被占，且与全部已放节点距离 ≥ 半径和 + 余量。
 *  skipIndex：region 成员对自己的容器锚点（容器本体）豁免 —— 容器是
 *  背景矩形，成员画在其上，二者同格/重叠是期望状态；净空小于半格的
 *  小容器内只有锚点一个格点，不豁免成员就没有合法格。 */
function cellUsable(
  gx: number,
  gy: number,
  lattice: number,
  r: number,
  occ: Occupancy,
  nodes: CoordinateNode[],
  placed: number[],
  skipIndex: number | null,
  marginFloor: number,
): boolean {
  const key = `${gx},${gy}`;
  const holder = occ.get(key);
  if (holder !== undefined && holder !== skipIndex) return false;
  // 格点相位：格索引 g 的实际坐标就是 g·lattice —— 坐标即整数格下标
  // （除以格单位比例尺后为整数），格线从格点正中穿过（2026-09-23 起
  // 半格相位退役，格单位存储要求坐标为格下标本身）。
  const x = gx * lattice;
  const y = gy * lattice;
  for (const pi of placed) {
    if (pi === skipIndex) continue;
    const other = nodes[pi];
    const need = other.r + r + marginFloor;
    if (Math.hypot(other.x - x, other.y - y) < need) return false;
  }
  return true;
}

/** 网格坐标：就近吸附 + 冲突消解 + 质量感知（方向行序、零穿越优先）。
 *  候选格分三层：layer0 = 不重叠且方向合格且无穿越（自己的边不穿第
 *  三方、自己不穿他人已定的边）；layer1 = 不重叠且方向合格；layer2 =
 *  仅仅不重叠。就近格零损伤直接接受；有损时记分层兜底并逐环外扩搜
 *  layer0，连续 qualityRings 环仍无则接受最近的有损格（layer1 优先于
 *  layer2；最小位移仍优先于完全的质量达标）。
 *  放置顺序类内 BFS 生长（固定 → 自由 → region 成员）：边由较晚放置的
 *  端点以两端最终位置做最终交叉检查。region 以锚点 **吸附后的新位置**
 *  为中心，成员跟随 hub 移动。 */
function gridSystem(): CoordinateSystem {
  return {
    name: 'grid',
    refine(nodes: CoordinateNode[], params: RefineParams): void {
      const byId = new Map<NodeId, CoordinateNode>(nodes.map((nd) => [nd.id, nd]));
      // lattice 必须原样采用（分层布局各层 rmax 不同，若按 2·rmax 放大会
      // 导致各层吸到不同网格，平移映射后离格）；不重叠由占用表 + 逐对
      // 距离检查（cellUsable）保证，与格距无关。
      const lattice = Math.max(params.lattice, 1e-6);
      // 格单位比例尺：格点物理余量的缩放基准（缺省按格距=1 格折算）；
      // 余量 = 绝对 px 地板 ∨ 比例尺项取大（S ≤ 120 与旧 2px 一致）。
      const marginFloor = Math.max(2, Math.max(params.cellScale ?? lattice, 1e-9) / 60);
      // 格点坐标：格索引 g 的实际坐标（见 cellUsable 内同式）
      const cellCenter = (g: number): number => g * lattice;
      // 就近格胞索引：实坐标所在格胞 [iL, (i+1)L) 的 i
      const cellIndexOf = (x: number): number => Math.floor(x / lattice);

      const occ: Occupancy = new Map();
      const placed: number[] = [];
      /** 已放节点的格坐标（方向行序检查用）。 */
      const cellOf = new Map<number, { gx: number; gy: number }>();

      // ── 质量感知索引：邻接表、流向约束对与边表 ──
      const idx = new Map<NodeId, number>(nodes.map((nd, i) => [nd.id, i]));
      const adj: number[][] = nodes.map(() => []);
      /** i 作为流向边 target 时的 source 集合 / 作为 source 时的 target 集合。 */
      const incoming: number[][] = nodes.map(() => []);
      const outgoing: number[][] = nodes.map(() => []);
      /** 全部边（节点下标对）：边-边交叉否决用。 */
      const edgePairs: Array<[number, number]> = [];
      const flow = params.flow;
      if (params.edges) {
        for (const e of params.edges) {
          const a = idx.get(e.source);
          const b = idx.get(e.target);
          if (a === undefined || b === undefined || a === b) continue;
          adj[a].push(b);
          adj[b].push(a);
          edgePairs.push([a, b]);
        }
      }
      if (flow) {
        for (const e of flow.edges) {
          const a = idx.get(e.source);
          const b = idx.get(e.target);
          if (a === undefined || b === undefined || a === b) continue;
          incoming[b].push(a);
          outgoing[a].push(b);
        }
      }

      /** 流向行序（严格）：nd 放到 (gx,gy) 后与已放的另一端比较不逆流
       *  （'TB'：target 格行 > source；'LR'：target 格列 > source ——
       *  同行/同列的水平（垂直）边会抹掉流向语义，不允许）。携带
       *  levels 时同层成员还须落在本层锚定行/列上：首见成员以落格
       *  行（TB）/列（LR）锚定该层，其后同层候选偏离该行/列即视为
       *  流向违反（layer 2）—— 分支与邻层的叶不抢行，层级可读。 */
      const levelAxis = new Map<number, number>();
      const dirOk = (i: number, gx: number, gy: number): boolean => {
        for (const a of incoming[i]) {
          const c = cellOf.get(a);
          if (!c) continue;
          if (flow!.direction === 'TB' ? gy <= c.gy : gx <= c.gx) return false;
        }
        for (const b of outgoing[i]) {
          const c = cellOf.get(b);
          if (!c) continue;
          if (flow!.direction === 'TB' ? gy >= c.gy : gx >= c.gx) return false;
        }
        if (flow!.levels) {
          const lv = flow!.levels.get(nodes[i]!.id) ?? -1;
          const axis = levelAxis.get(lv);
          if (
            axis !== undefined &&
            (flow!.direction === 'TB' ? gy !== axis : gx !== axis)
          ) {
            return false;
          }
        }
        return true;
      };

      // ── 放置顺序：类内 BFS 生长 ──
      // 纯空间扫描（y,x）会让叶子先于父节点落格：叶子检查关联边时父端
      // 还在弛豫坐标上（过期几何），父节点后落格时长边横穿已放好的子树
      // 且再无机会修正。改为沿邻接关系从结构中心向外生长：每条边至少有
      // 一个端点较晚放置，该端点落格时以**两端的最终位置**做最后一次
      // 交叉检查，全局无交叉因此可传递成立。孤立/无边图退化为 (y,x)。
      /** 类内 BFS 顺序。播种优先级：与已放节点相邻者（region 成员从
       *  锚点生长）→ 最靠近类质心者（锚定布局中心）；邻居入队按 (y,x)
       *  保证确定性。 */
      const bfsOrder = (classIdx: number[]): number[] => {
        if (classIdx.length === 0) return [];
        const members = new Set(classIdx);
        const byPos = (a: number, b: number) =>
          nodes[a].y - nodes[b].y || nodes[a].x - nodes[b].x || a - b;
        const pending = [...classIdx].sort(byPos);
        const seen = new Uint8Array(nodes.length);
        const result: number[] = [];
        let cx = 0;
        let cy = 0;
        for (const i of classIdx) {
          cx += nodes[i].x;
          cy += nodes[i].y;
        }
        cx /= classIdx.length;
        cy /= classIdx.length;
        while (result.length < classIdx.length) {
          let seed = -1;
          for (const i of pending) {
            if (!seen[i] && adj[i].some((j) => cellOf.has(j))) {
              seed = i;
              break;
            }
          }
          if (seed < 0) {
            let bd = Infinity;
            for (const i of pending) {
              if (seen[i]) continue;
              const d = (nodes[i].x - cx) ** 2 + (nodes[i].y - cy) ** 2;
              if (d < bd) {
                bd = d;
                seed = i;
              }
            }
          }
          const queue = [seed!];
          seen[seed!] = 1;
          for (let head = 0; head < queue.length; head++) {
            const i = queue[head];
            result.push(i);
            const next = adj[i].filter((j) => !seen[j] && members.has(j)).sort(byPos);
            for (const j of next) {
              seen[j] = 1;
              queue.push(j);
            }
          }
        }
        // 有层级约束时按层级升序落格（稳定排序，同层保持 BFS 序）：
        // BFS 生长可能经短链先到达深层汇点（n5→n6 先于 n8→n9 链），
        // 汇点先锚定层级行会把后来的浅层节点挤进「入边要更低、出边要
        // 更高」的无解区间，只能逆流兜底；层级升序即流向拓扑序，深层
        // 节点落格时其全部下层邻居已就位。无层级号（-1/缺省）殿后。
        if (flow?.levels) {
          const lv = (i: number): number => {
            const l = flow.levels!.get(nodes[i]!.id);
            return l !== undefined && l >= 0 ? l : Number.MAX_SAFE_INTEGER;
          };
          result.sort((a, b) => lv(a) - lv(b));
        }
        return result;
      };

      // ── 容器保留区：非成员候选格不得落在任一声明矩形内 ──
      const zones = params.zones ?? [];
      const zoneBlocked = (i: number, x: number, y: number): boolean => {
        if (zones.length === 0) return false;
        const nd = nodes[i]!;
        const own = nd.region?.anchorId;
        for (const z of zones) {
          if (z.anchorId === own) continue; // 本区成员不受本区排斥
          const a = byId.get(z.anchorId);
          if (!a) continue; // 锚点缺失（异常输入）不虚构排斥
          if (Math.abs(x - a.x) <= z.hw && Math.abs(y - a.y) <= z.hh) {
            // 候选落在外来保留区内：若它同时在本成员自己的包含区内，
            // 自己的容器优先 —— 贴近布局下容器矩形互相重叠是常态，
            // 成员必须能落回自己的容器（否则合法格被外来区清空）。
            if (nd.region) {
              const c0 = byId.get(nd.region.anchorId);
              if (
                c0 &&
                Math.abs(x - c0.x) <= nd.region.hw &&
                Math.abs(y - c0.y) <= nd.region.hh
              ) {
                continue;
              }
            }
            return true;
          }
        }
        return false;
      };
      // hub 批次：全部 region/zone 锚点（容器本体）在自由节点之前落格，
      // 后续 region 钳制与 zone 排斥读到的都是吸附后的最终位置。
      const anchorIds = new Set<NodeId>();
      for (const nd of nodes) if (nd.region) anchorIds.add(nd.region.anchorId);
      for (const z of zones) anchorIds.add(z.anchorId);

      // 类别：固定节点优先（先注册占用，后续节点自动避开）；hub（容器
      // 本体）次之（region 钳制与 zone 排斥的锚点基准）；自由节点再次；
      // region 成员最后（目标格依赖锚点吸附后的新位置）。
      const order = nodes
        .map((_, i) => i)
        .sort((a, b) => nodes[a].y - nodes[b].y || nodes[a].x - nodes[b].x || a - b);
      const sorted = [
        ...bfsOrder(order.filter((i) => nodes[i].fixed)),
        ...bfsOrder(order.filter((i) => !nodes[i].fixed && anchorIds.has(nodes[i].id))),
        ...bfsOrder(
          order.filter(
            (i) => !nodes[i].fixed && !nodes[i].region && !anchorIds.has(nodes[i].id),
          ),
        ),
        ...bfsOrder(order.filter((i) => !nodes[i].fixed && !!nodes[i].region)),
      ];

      // 质量否决的计算预算（防大图上 O(度×n)/O(度×E) 检查失控；耗尽放行）
      let crossBudget = 2_000_000;

      /** 无质量损伤：nd 的关联边（候选点→对端）既不穿过第三方节点，
       *  也不与其他边严格相交（口径同 crossings.ts：共享端点不算）。 */
      const crossOk = (i: number, px: number, py: number): boolean => {
        const links = adj[i];
        if (links.length === 0) return true;
        for (const m of links) {
          const q = nodes[m];
          const minx = Math.min(px, q.x);
          const maxx = Math.max(px, q.x);
          const miny = Math.min(py, q.y);
          const maxy = Math.max(py, q.y);
          for (let k = 0; k < nodes.length; k++) {
            if (k === i || k === m) continue;
            const nd3 = nodes[k];
            if (
              nd3.x < minx - nd3.r || nd3.x > maxx + nd3.r ||
              nd3.y < miny - nd3.r || nd3.y > maxy + nd3.r
            ) {
              continue; // 包围盒剪枝
            }
            if (crossBudget-- <= 0) return true;
            // 点到线段距离不足 = 穿越。裕量取 max(半径+余量, 半格)：
            // 半径+余量（S/60 ≈ 2px @ S=120）保物理圆不穿，半格保台面
            // 不被打扰 —— 与 throughOk 同一口径，「节点先落、边后定」
            // 路径才不漏检（否则斥力成果仍会被后定的边抹掉）。
            const c = closestPointOnSegment(nd3.x, nd3.y, px, py, q.x, q.y);
            const dx = nd3.x - c.x;
            const dy = nd3.y - c.y;
            const need = Math.max(nd3.r + marginFloor, lattice / 2);
            if (dx * dx + dy * dy < need * need) return false;
          }
          // 边-边交叉：关联边（候选点→对端）与非邻接边严格相交 = 交叉
          for (const [a2, b2] of edgePairs) {
            if (a2 === i || b2 === i || a2 === m || b2 === m) continue; // 共享端点
            const p2 = nodes[a2];
            const q2 = nodes[b2];
            // 两线段包围盒粗筛
            if (
              Math.max(px, q.x) < Math.min(p2.x, q2.x) || Math.min(px, q.x) > Math.max(p2.x, q2.x) ||
              Math.max(py, q.y) < Math.min(p2.y, q2.y) || Math.min(py, q.y) > Math.max(p2.y, q2.y)
            ) {
              continue;
            }
            if (crossBudget-- <= 0) return true;
            if (segmentsProperlyIntersect(px, py, q.x, q.y, p2.x, p2.y, q2.x, q2.y)) return false;
          }
        }
        return true;
      };

      /** 台面净空：**无关联边**（两端均已落格）不许穿过候选格的谷底
       *  台面（格胞内切圆，半径 = 半格距）。弛豫阶段边-节点斥力已把
       *  节点推离他人边线，但就近量化允许 ±半格位移把节点拍回线上
       *  —— 网格化必须保留斥力成果：候选点距任何已定无关联边不足
       *  半格即视为穿越损伤（layer1），叶子因此让出轴线落到对角格。
       *
       *  两端未定的边不在此检查（几何未定，查了也会被后续移动作废）：
       *  对端落格时其关联边会以 crossOk 对全部第三方（含本节点）做
       *  终局把关 —— 「节点先落、边后定」与「边先定、节点后落」两个
       *  方向互补，覆盖无缝隙。margin 取半格而非 r：r 内的物理穿越由
       *  crossOk 兜底，这里承诺的是格胞中央的稳定台面不被打扰。 */
      const throughOk = (i: number, px: number, py: number): boolean => {
        const half = lattice / 2;
        for (const [a, b] of edgePairs) {
          if (a === i || b === i) continue;
          if (!cellOf.has(a) || !cellOf.has(b)) continue;
          const p = nodes[a]!;
          const q = nodes[b]!;
          if (
            px < Math.min(p.x, q.x) - half || px > Math.max(p.x, q.x) + half ||
            py < Math.min(p.y, q.y) - half || py > Math.max(p.y, q.y) + half
          ) {
            continue; // 包围盒剪枝
          }
          if (crossBudget-- <= 0) return true;
          const c = closestPointOnSegment(px, py, p.x, p.y, q.x, q.y);
          const dx = px - c.x;
          const dy = py - c.y;
          if (dx * dx + dy * dy < half * half) return false;
        }
        return true;
      };

      /** 候选格分层：-1 不可用；2 可用但流向违反；1 流向合格但有穿越；0 全合格。 */
      const evaluate = (i: number, gx: number, gy: number, nd: CoordinateNode): number => {
        if (zoneBlocked(i, cellCenter(gx), cellCenter(gy))) return -1;

        const skip = nd.region ? idx.get(nd.region.anchorId) ?? null : null;
        if (!cellUsable(gx, gy, lattice, nd.r, occ, nodes, placed, skip, marginFloor)) return -1;
        if (flow && !dirOk(i, gx, gy)) return 2;
        const px = cellCenter(gx);
        const py = cellCenter(gy);
        return crossOk(i, px, py) && throughOk(i, px, py) ? 0 : 1;
      };

      /** 锚点当前坐标（region 引用的 hub 吸附后的新位置）。 */
      const anchorPos = (nd: CoordinateNode): { x: number; y: number } => {
        const a = byId.get(nd.region!.anchorId);
        return a ? { x: a.x, y: a.y } : { x: nd.x, y: nd.y };
      };

      const accept = (i: number, cx: number, cy: number) => {
        occ.set(`${cx},${cy}`, i);
        placed.push(i);
        cellOf.set(i, { gx: cx, gy: cy });
        nodes[i]!.x = cellCenter(cx);
        nodes[i]!.y = cellCenter(cy);
        // 首个落格的本层成员锚定该层的格行（TB）/格列（LR）
        if (flow?.levels) {
          const lv = flow.levels.get(nodes[i]!.id) ?? -1;
          if (lv >= 0 && !levelAxis.has(lv)) {
            levelAxis.set(lv, flow.direction === 'TB' ? cy : cx);
          }
        }
      };

      /**
       * 单节点落格搜索：就近格分层评估，零损伤直接接受；有损时记分层
       * 兜底并逐环外扩搜零损伤 layer0，qualityRings 环内仍无则接受最近的
       * 有损格（layer1 优先于 layer2：交叉损伤轻于逆流；最小位移仍优先于
       * 完全的质量达标）。有流向约束时放开到 maxRing —— 格距（≥2·rmax）
       * 常远大于弛豫间距，紧凑图会连锁迁移多格才找到行/列序合格的格点，
       * 小上限会过早兜底接受逆序格；预算由 crossBudget 把守。
       * restricted=true 时 region 成员的候选格钳制在包含区内；返回是否落格。
       */
      const search = (i: number, gx: number, gy: number, restricted: boolean): boolean => {
        const nd = nodes[i];
        // 初始就近格同样受包含区约束（实坐标钳制取整后可落回区外，
        // 不检查就会以"零损伤就近格"的名义直接接受区外格）
        let nearest = -1;
        const c0 = nd.region && restricted ? anchorPos(nd) : null;
        const initialInside =
          !c0 ||
          (Math.abs(cellCenter(gx) - c0.x) <= nd.region!.hw &&
            Math.abs(cellCenter(gy) - c0.y) <= nd.region!.hh);
        if (initialInside) nearest = evaluate(i, gx, gy, nd);
        if (nearest === 0) {
          accept(i, gx, gy);
          return true;
        }
        let fallback1 = nearest === 1 ? { gx, gy, d2: 0 } : null;
        let fallback2 = nearest === 2 ? { gx, gy, d2: 0 } : null;
        const c = c0 ?? { x: nd.x, y: nd.y };
        const maxRing = 64;
        const qualityRings = flow ? maxRing : 8;
        for (let ring = 1; ring <= maxRing; ring++) {
          let best: { gx: number; gy: number; d2: number } | null = null;
          for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // 只看环缘
              const cx2 = gx + dx;
              const cy2 = gy + dy;
              if (restricted && nd.region) {
                // 矩形包含：任一轴超出净空即不可选（与初始钳制同口径）
                if (
                  Math.abs(cellCenter(cx2) - c.x) > nd.region.hw ||
                  Math.abs(cellCenter(cy2) - c.y) > nd.region.hh
                ) {
                  continue;
                }
              }
              const layer = evaluate(i, cx2, cy2, nd);
              if (layer < 0) continue;
              const d2 = (cellCenter(cx2) - c.x) ** 2 + (cellCenter(cy2) - c.y) ** 2;
              if (layer === 0) {
                if (!best || d2 < best.d2) best = { gx: cx2, gy: cy2, d2 };
              } else if (layer === 1) {
                if (!fallback1 || d2 < fallback1.d2) fallback1 = { gx: cx2, gy: cy2, d2 };
              } else if (!fallback2 || d2 < fallback2.d2) {
                fallback2 = { gx: cx2, gy: cy2, d2 };
              }
            }
          }
          if (best) {
            accept(i, best.gx, best.gy);
            return true;
          }
          if (ring >= qualityRings && (fallback1 || fallback2)) {
            const f = fallback1 ?? fallback2!;
            accept(i, f.gx, f.gy);
            return true;
          }
        }
        return false;
      };

      for (const i of sorted) {
        const nd = nodes[i];
        let gx = cellIndexOf(nd.x);
        let gy = cellIndexOf(nd.y);
        // subgraph 成员：目标格钳制在锚点（hub 新位置）附近的包含区内
        //（格点相位：坐标 = g·L，落在净空 [lo,hi] 内 ⇔ g ∈ [lo/L, hi/L]，
        // 先取格区间再夹取）
        if (nd.region) {
          const c = anchorPos(nd);
          const loX = Math.ceil((c.x - nd.region.hw) / lattice - 1e-9);
          const hiX = Math.floor((c.x + nd.region.hw) / lattice + 1e-9);
          const loY = Math.ceil((c.y - nd.region.hh) / lattice - 1e-9);
          const hiY = Math.floor((c.y + nd.region.hh) / lattice + 1e-9);
          gx = Math.min(Math.max(gx, loX), hiX);
          gy = Math.min(Math.max(gy, loY), hiY);
        }

        if (search(i, gx, gy, true)) continue;
        // 包含区内无任何可用格（容量不足：净空内容格数 < 成员数等）：
        // 网格不变量（坐标 = 格胞中心）优先于包含性 —— 放开包含区就近
        // 落格（保留区规则仍然生效），包含性由容器实占矩形（动态贴合）
        // 兜底，成员不会离格。
        if (search(i, cellIndexOf(nd.x), cellIndexOf(nd.y), false)) continue;
        // 全域无任何可用格：保留原坐标（不阻塞布局；防御性分支）
      }
    },
  };
}

registerCoordinateSystem('grid', gridSystem);
