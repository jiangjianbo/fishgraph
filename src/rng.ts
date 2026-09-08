/** 确定性随机工具：固定种子保证布局结果可复现。 */

/** mulberry32 —— 小而快的可播种 PRNG。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由节点对索引推导确定性的单位向量方向。
 * 当两个节点完全重合（距离为 0）时，力方向没有定义，
 * 用这个确定性的伪随机方向把节点推开，避免 NaN 和不可复现。
 */
export function jitterDirection(i: number, j: number): { x: number; y: number } {
  let h = (Math.imul(i + 1, 374761393) + Math.imul(j + 1, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  const angle = ((h >>> 0) / 4294967296) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
