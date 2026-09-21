/** Barnes-Hut 四叉树：把 O(n²) 的节点-节点力近似为 O(n log n)。
 *
 * 一致性约定（力必须是能量泛函的精确梯度，线搜索才总有下降方向）：
 *  1. 双树遍历（dual traversal）：每个无序对/节点×远块交互恰好访问一次。
 *     旧的"每个节点各自查询"写法会让同一对节点在一个方向被逐点计算、
 *     另一个方向被块聚合 —— 两种近似混合出来的力场不是保守场，
 *     线搜索在任何步长下都找不到下降方向（收敛到重叠的死局）。
 *  2. 节点 p × 远块 c：能量按"块质量集中在质心"的聚合势算一次；
 *     p 受完整聚合力，等大反向的反作用力以"每单位质量的常力"挂在块上
 *     （聚合势对成员位置的梯度恰是均摊常力），全部遍历结束后由
 *     distributeReactions 摊派给成员节点。
 *  3. theta 开块判据用"块到块的最短距离"：短程力核（1/g³）下，
 *     质心距判据会把紧挨查询点的块误判为远块，整块聚合吞掉近距斥力，
 *     导致重叠不被推开。
 */

export interface BHPoint {
  index: number;
  x: number;
  y: number;
  mass: number;
  radius: number;
}

export interface QuadCell {
  x0: number;
  y0: number;
  size: number;
  mass: number;
  comX: number;
  comY: number;
  avgR: number;
  /** 块内最大包围圆半径（分离判据用它，avgR 会低估大块边界）。 */
  maxR: number;
  count: number;
  /** 代表成员下标（聚合交互里做逐对查表，如跳数斥力系数）。 */
  repIndex: number;
  /** 对质心的转动惯量 Σᵢ mᵢ|xᵢ−COM|²（远块聚合能量的低阶修正）。 */
  inertia: number;
  /**
   * 反作用力累加器：外部聚合交互分摊给块内每单位质量的常力。
   * 常力场的均摊恰是聚合势对成员位置的精确梯度。
   */
  aAccX: number;
  aAccY: number;
  /** 叶子节点持有原始点；内部节点为 4 个象限。 */
  points: BHPoint[] | null;
  children: QuadCell[] | null;
}

const LEAF_CAPACITY = 8;
const MAX_DEPTH = 48;

function newCell(x0: number, y0: number, size: number): QuadCell {
  return {
    x0,
    y0,
    size,
    mass: 0,
    comX: 0,
    comY: 0,
    avgR: 0,
    maxR: 0,
    count: 0,
    repIndex: -1,
    inertia: 0,
    aAccX: 0,
    aAccY: 0,
    points: [],
    children: null,
  };
}

function quadrantIndex(cell: QuadCell, x: number, y: number): number {
  const mx = cell.x0 + cell.size / 2;
  const my = cell.y0 + cell.size / 2;
  return (x >= mx ? 1 : 0) + (y >= my ? 2 : 0);
}

export class QuadTree {
  root: QuadCell;

  constructor(points: BHPoint[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    const size = Math.max(maxX - minX, maxY - minY) * 1.05 + 1e-6;
    this.root = newCell(minX - (size - (maxX - minX)) / 2, minY - (size - (maxY - minY)) / 2, size);
    for (const p of points) this.insert(this.root, p, 0);
    this.aggregate(this.root);
  }

  private insert(cell: QuadCell, p: BHPoint, depth: number): void {
    // 深度兜底：完全重合的点无法用细分区分，允许叶子溢出。
    if (depth >= MAX_DEPTH) {
      cell.points!.push(p);
      return;
    }
    if (cell.points) {
      if (cell.points.length < LEAF_CAPACITY || cell.size / 2 < 1e-9) {
        cell.points.push(p);
        return;
      }
      this.subdivide(cell);
    }
    this.insert(cell.children![quadrantIndex(cell, p.x, p.y)], p, depth + 1);
  }

  private subdivide(cell: QuadCell): void {
    const half = cell.size / 2;
    cell.children = [
      newCell(cell.x0, cell.y0, half),
      newCell(cell.x0 + half, cell.y0, half),
      newCell(cell.x0, cell.y0 + half, half),
      newCell(cell.x0 + half, cell.y0 + half, half),
    ];
    const old = cell.points!;
    cell.points = null;
    for (const p of old) {
      // 全部挤进同一象限时（重合坐标）也没关系：子象限溢出后会继续细分，
      // 直到 MAX_DEPTH 兜底。
      cell.children[quadrantIndex(cell, p.x, p.y)].points!.push(p);
    }
  }

  /** 自底向上聚合质量、质心、平均半径与转动惯量。 */
  private aggregate(cell: QuadCell): void {
    if (cell.points) {
      let m = 0, sx = 0, sy = 0, sr = 0, mr = 0;
      for (const p of cell.points) {
        m += p.mass;
        sx += p.mass * p.x;
        sy += p.mass * p.y;
        sr += p.radius;
        if (p.radius > mr) mr = p.radius;
      }
      cell.count = cell.points.length;
      // 细分后可能留下空叶（所有点挤进同一象限）：repIndex 置 -1 由调用方兜底
      cell.repIndex = cell.points.length > 0 ? cell.points[0].index : -1;
      cell.mass = m;
      cell.comX = m > 0 ? sx / m : cell.x0 + cell.size / 2;
      cell.comY = m > 0 ? sy / m : cell.y0 + cell.size / 2;
      cell.avgR = cell.count > 0 ? sr / cell.count : 0;
      cell.maxR = mr;
      let inC = 0;
      for (const p of cell.points) {
        const dx = p.x - cell.comX;
        const dy = p.y - cell.comY;
        inC += p.mass * (dx * dx + dy * dy);
      }
      cell.inertia = inC;
      return;
    }
    let m = 0, sx = 0, sy = 0, sr = 0, count = 0, mr = 0;
    const children = cell.children!;
    for (const c of children) {
      this.aggregate(c);
      m += c.mass;
      sx += c.mass * c.comX;
      sy += c.mass * c.comY;
      sr += c.avgR * c.count;
      count += c.count;
      if (c.maxR > mr) mr = c.maxR;
    }
    cell.count = count;
    cell.repIndex = children.find((c) => c.count > 0)!.repIndex;
    cell.mass = m;
    cell.comX = m > 0 ? sx / m : cell.x0 + cell.size / 2;
    cell.comY = m > 0 ? sy / m : cell.y0 + cell.size / 2;
    cell.avgR = count > 0 ? sr / count : 0;
    cell.maxR = mr;
    let inC = 0;
    for (const c of children) {
      const dx = c.comX - cell.comX;
      const dy = c.comY - cell.comY;
      inC += c.inertia + c.mass * (dx * dx + dy * dy);
    }
    cell.inertia = inC;
  }

  /**
   * 双树遍历：每个无序节点对恰好访问一次。
   *  - 两叶相遇（或同一叶内）：逐点回调 onLeafPair（同叶内自动 i<j 去重）；
   *  - 已分离的区域：成员 × 聚合块回调 onNodeCell（较小侧展开为点，
   *    较大侧作为聚合块 —— 每对交互只归一次管辖）。
   */
  forEachPairInteraction(
    theta: number,
    onLeafPair: (a: BHPoint, b: BHPoint) => void,
    onNodeCell: (p: BHPoint, cell: QuadCell) => void,
  ): void {
    const separated = (a: QuadCell, b: QuadCell): boolean => {
      const dx = Math.max(a.x0 - b.x0 - b.size, b.x0 - a.x0 - a.size, 0);
      const dy = Math.max(a.y0 - b.y0 - b.size, b.y0 - a.y0 - a.size, 0);
      const dmin = Math.hypot(dx, dy);
      // 判据用"间隙"而不仅是中心距：斥力核是 1/g³（g = 中心距 − 半径），
      // 两个包围块中心距可以很大、表面间隙却接近 0 —— 此时整块聚合
      // 会把近距接触吞掉，重叠永远推不开。
      const gap = dmin - a.maxR - b.maxR;
      if (gap <= 0) return false;
      return Math.max(a.size, b.size) / gap < theta;
    };
    const enumerate = (cell: QuadCell, cb: (p: BHPoint) => void): void => {
      if (cell.points) {
        for (const p of cell.points) cb(p);
        return;
      }
      for (const c of cell.children!) enumerate(c, cb);
    };
    const walk = (a: QuadCell, b: QuadCell): void => {
      if (a.count === 0 || b.count === 0) return;
      if (a === b) {
        if (a.points) {
          const pts = a.points;
          for (let i = 0; i < pts.length; i++)
            for (let j = i + 1; j < pts.length; j++) onLeafPair(pts[i], pts[j]);
        } else {
          const ch = a.children!;
          for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) walk(ch[i], ch[j]);
        }
        return;
      }
      if (separated(a, b)) {
        // 聚合方向：展开较小的一侧，另一侧整块。
        if (!a.points && (b.points || a.count > b.count)) {
          enumerate(b, (q) => onNodeCell(q, a));
        } else if (!b.points) {
          enumerate(a, (p) => onNodeCell(p, b));
        } else {
          for (const p of a.points!) onNodeCell(p, b);
        }
        return;
      }
      if (a.points && b.points) {
        for (const p of a.points) for (const q of b.points) onLeafPair(p, q);
        return;
      }
      if (!a.points && (b.points || a.size >= b.size)) {
        for (const c of a.children!) walk(c, b);
        return;
      }
      if (!b.points) {
        for (const c of b.children!) walk(a, c);
      }
    };
    walk(this.root, this.root);
  }

  /**
   * 查询全部结束后调用：把挂在各块上的常力场自上而下摊派到叶内节点。
   * 常力场的均摊恰是聚合势对成员位置的精确梯度（见文件头约定 2）。
   */
  distributeReactions(out: (index: number, fx: number, fy: number) => void): void {
    const walk = (cell: QuadCell, aX: number, aY: number): void => {
      const ax = aX + cell.aAccX;
      const ay = aY + cell.aAccY;
      if (cell.points) {
        for (const p of cell.points) out(p.index, p.mass * ax, p.mass * ay);
        return;
      }
      for (const c of cell.children!) walk(c, ax, ay);
    };
    walk(this.root, 0, 0);
  }
}
