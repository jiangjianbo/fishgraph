/**
 * 网格 A* 贴边代价契约（grid-route.ts 引擎级）。
 *
 * 偶数格尺寸盒中心吸附中心格格心（半格相位），物理边界落在行进侧相邻
 * 格的格心线上 —— 沿该格心线的走线在物理上正好贴着盒边（连线成为节点
 * 轮廓切线的根因）。回归固化三条规则：
 *   1. 等价路径存在时贴边代价使走线离开相切格线（通道走中间优先）；
 *   2. 紧通道无等价替代时照常贴边（软代价不影响可行性，最低限度兜底）；
 *   3. hugCost = 0 关闭贴边代价，恢复纯长度 + 拐点口径。
 *
 * 场景取自 demo tree 21 图左半区真实格几何（b3→l3-* 车道贴叶列盒边的
 * 回归缩影）：叶列盒（偶数格宽 2×1）在列 0–1、行 2/6/8，同宽盒在
 * 列 4–5、行 2/8 挡住沿行逃逸的替代路，1×1 源盒在 (9,4)。A* 返回压缩
 * 拐点序列（共线格合并）。
 */
import { describe, expect, it } from 'vitest';
import { gridRouteAStar } from '../src/index.js';
import type { Box } from '../src/index.js';

const TREE_SLICE: Box[] = [
  { x: 0, y: 2, width: 2, height: 1 }, // l3-1（目标盒：右物理边界 = 第 2 列格心线）
  { x: 4, y: 2, width: 2, height: 1 }, // l1-2（挡住沿行 2 的逃逸路）
  { x: 0, y: 6, width: 2, height: 1 }, // l3-0（回归：垂直车道曾被贴边擦过）
  { x: 0, y: 8, width: 2, height: 1 }, // l3-2（目标盒）
  { x: 4, y: 8, width: 2, height: 1 }, // l0-1（挡住沿行 8 的逃逸路）
  { x: 9, y: 4, width: 1, height: 1 }, // b3（源盒，奇数格宽无物理越界）
];

describe('A* 贴边代价（偶数格盒物理越界感知）', () => {
  it('等价路径存在时避开相切格线，走通道中央列', () => {
    // startOut (8,4) → goalOut (2,2)：贴第 2 列（目标盒右越界边）8 步
    // 1 拐 + 1 次贴边；沿行逃逸被 (4,2) 盒挡住；第 3 列（2 格通道中央）
    // 8 步 2 拐 0 贴边 —— 默认贴边代价 2 > 一次转弯，通道中央列胜出。
    const path = gridRouteAStar({ x: 8, y: 4 }, { x: 2, y: 2 }, TREE_SLICE);
    expect(path).toEqual([
      { x: 8, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
    ]);
  });

  it('贴边路径是 hugCost=0 下的最短路径（对照：关闭代价即贴边）', () => {
    const path = gridRouteAStar({ x: 8, y: 4 }, { x: 2, y: 2 }, TREE_SLICE, { hugCost: 0 });
    expect(path).toEqual([
      { x: 8, y: 4 },
      { x: 2, y: 4 },
      { x: 2, y: 2 },
    ]);
  });

  it('垂直车道擦过同列障碍盒的长直路同样避让（回归：l3-0/l3-2 被贴边擦过）', () => {
    // startOut (8,4) → goalOut (2,8)：贴第 2 列的直路在行 6 擦到障碍盒、
    // 行 8 擦到目标盒；沿行 8 逃逸被 (4,8) 盒挡住；第 3 列 0 贴边胜出。
    const path = gridRouteAStar({ x: 8, y: 4 }, { x: 2, y: 8 }, TREE_SLICE);
    expect(path).toEqual([
      { x: 8, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 8 },
      { x: 2, y: 8 },
    ]);
  });

  it('紧通道无等价替代时照常贴边（软代价不破坏可行性）', () => {
    // 目标盒紧贴源盒正下方：第 2 列是唯一短通道，贴边代价改变不了最优解。
    const tight: Box[] = [
      { x: 0, y: 0, width: 2, height: 1 },
      { x: 0, y: 2, width: 2, height: 1 },
    ];
    const path = gridRouteAStar({ x: 2, y: 0 }, { x: 2, y: 2 }, tight);
    expect(path).toEqual([
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ]);
  });

  it('sibling 车道折扣：代价相当的路径向共用干线倾斜（共线越长越好）', () => {
    // startOut (8,4) → goalOut (2,6)（b3→l3-0 缩影）：无折扣时贴源列早拐
    // 胜出（8 步 1 拐 = 9，随干线多 1 拐 = 10）；注入同向 sibling 的干线
    // 行 4 + 车道列 3 作折扣线后，随干线到列 3 再分岔胜出（10 − 7×0.25
    // = 8.25 < 9）。纯绕远（折扣 < 步长）永远无法胜出。
    const plain = gridRouteAStar({ x: 8, y: 4 }, { x: 2, y: 6 }, TREE_SLICE);
    expect(plain).toEqual([
      { x: 8, y: 4 },
      { x: 8, y: 6 },
      { x: 2, y: 6 },
    ]);
    const aligned = gridRouteAStar({ x: 8, y: 4 }, { x: 2, y: 6 }, TREE_SLICE, {
      laneBonus: { cols: new Set([3]), rows: new Set([4]), rate: 0.25 },
    });
    expect(aligned).toEqual([
      { x: 8, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 6 },
      { x: 2, y: 6 },
    ]);
  });
});
