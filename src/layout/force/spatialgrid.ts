/** 均匀空间网格：加速"边/标签包围盒 × 节点"候选对检测。 */

export interface GridItem {
  /** 0 = 边（引用 InternalEdge 的下标），1 = 标签包围盒。 */
  kind: 0 | 1;
  /** 归属的 InternalEdge 下标（边和它的标签同源）。 */
  edgeIndex: number;
  /** 去重戳，query 时刷新。 */
  stamp: number;
}

export class SpatialGrid {
  private cell: number;
  private buckets = new Map<number, GridItem[]>();
  private stampCounter = 0;

  /** cell：网格边长（建议与避让影响半径同量级）。 */
  constructor(cell: number) {
    this.cell = Math.max(cell, 1e-6);
  }

  private key(ix: number, iy: number): number {
    // 折叠到 32 位；布局尺度内碰撞概率可忽略，且仅影响候选对数量，不影响正确性。
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) | 0;
  }

  /** 按包围盒插入（包围盒应已外扩节点最大半径）。 */
  insert(minX: number, minY: number, maxX: number, maxY: number, item: GridItem): void {
    const c = this.cell;
    const ix0 = Math.floor(minX / c);
    const iy0 = Math.floor(minY / c);
    const ix1 = Math.floor(maxX / c);
    const iy1 = Math.floor(maxY / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const k = this.key(ix, iy);
        let bucket = this.buckets.get(k);
        if (!bucket) {
          bucket = [];
          this.buckets.set(k, bucket);
        }
        bucket.push(item);
      }
    }
  }

  /** 查询点 (x, y) 半径 r 内的所有候选 item（已去重）。 */
  query(x: number, y: number, r: number, callback: (item: GridItem) => void): void {
    const c = this.cell;
    const stamp = ++this.stampCounter;
    const ix0 = Math.floor((x - r) / c);
    const iy0 = Math.floor((y - r) / c);
    const ix1 = Math.floor((x + r) / c);
    const iy1 = Math.floor((y + r) / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const bucket = this.buckets.get(this.key(ix, iy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (item.stamp === stamp) continue;
          item.stamp = stamp;
          callback(item);
        }
      }
    }
  }
}
