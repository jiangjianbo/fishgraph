/**
 * 尺寸分级（格单位架构 · 初始化）单测。
 *
 * 分级是 px 盒 → 整数格占用的唯一换算：宽/高独立容差聚类，格 = 最小级
 * 上界。重点守护：
 *  - 宽高比定不出格数（2:1 可为 2×1 也可为 4×2），绝对尺寸才能定；
 *  - 宽高基准独立（矩形格，cellW ≠ cellH）；
 *  - 锚定聚类不链式滚雪球；
 *  - GraphStore 集成：盒含文字物化，applyNodeLabelSizes 后自动刷新。
 */
import { describe, expect, it } from 'vitest';
import { GRADE_TOLERANCE, gradeAxis, gradeBoxes } from '../src/layout/grade.js';
import { GraphStore } from '../src/graph/store.js';

describe('gradeAxis 单轴锚定聚类', () => {
  it('容差内同级：1.2× 不翻倍，格 = 最小级上界', () => {
    const r = gradeAxis([100, 120]);
    expect(r.cell).toBe(120);
    expect(r.grades).toEqual([1, 1]);
  });

  it('超容差翻级：1.3× 分两级，格 = 较小值', () => {
    const r = gradeAxis([100, 130]);
    expect(r.cell).toBe(100);
    expect(r.grades).toEqual([1, 2]);
  });

  it('锚定不链式：124 入簇后 130 仍相对锚点 100 判级（链式比较会误判同级）', () => {
    // 链式（与上一元素比）：130/124 ≈ 1.048 ≤ 1.25 → 三者同级（错误）；
    // 锚定（与簇最小 100 比）：130/100 = 1.3 > 1.25 → 另起新簇。
    const r = gradeAxis([100, 124, 130]);
    expect(r.cell).toBe(124);
    expect(r.grades).toEqual([1, 1, 2]);
  });

  it('离群小节点：格拉小，其余按绝对比例定级', () => {
    const r = gradeAxis([10, 100, 120]);
    expect(r.cell).toBe(10);
    expect(r.grades).toEqual([1, 2, 2]);
  });

  it('空输入与乱序输入', () => {
    expect(gradeAxis([])).toEqual({ cell: 1, grades: [] });
    expect(gradeAxis([300, 100, 200])).toEqual({ cell: 100, grades: [3, 1, 2] });
  });
});

describe('gradeBoxes 宽高独立分级（矩形格）', () => {
  it('同宽高比不同绝对尺寸可区分：100×50 与 200×100 → 1×1 与 2×2', () => {
    const r = gradeBoxes([{ w: 100, h: 50 }, { w: 200, h: 100 }]);
    expect(r.cellW).toBe(100);
    expect(r.cellH).toBe(50);
    expect(r.gw).toEqual([1, 2]);
    expect(r.gh).toEqual([1, 2]);
  });

  it('用户记法示例：同为 2:1，400×200 与 200×100 互为两级（2×2 与 1×1）', () => {
    // 宽高比同为 2:1，靠绝对分级消除 4:2 vs 2:1 的歧义：基准取最小级
    // （200×100），大者占 2×2 格 —— 格是矩形，宽高比由格形状承载。
    const r = gradeBoxes([{ w: 400, h: 200 }, { w: 200, h: 100 }]);
    expect(r.cellW).toBe(200);
    expect(r.cellH).toBe(100);
    expect(r.gw).toEqual([2, 1]);
    expect(r.gh).toEqual([2, 1]);
  });

  it('矩形格：200×50 相对基准 100×50 占 2×1（宽基准 ≠ 高基准的对照）', () => {
    const r = gradeBoxes([{ w: 100, h: 50 }, { w: 200, h: 50 }]);
    expect(r.cellW).toBe(100);
    expect(r.cellH).toBe(50);
    expect(r.gw).toEqual([1, 2]);
    expect(r.gh).toEqual([1, 1]);
  });

  it('宽高基准独立：100×50 与 100×100 → cellW=100 ≠ cellH=50，高占两级', () => {
    const r = gradeBoxes([{ w: 100, h: 50 }, { w: 100, h: 100 }]);
    expect(r.cellW).toBe(100);
    expect(r.cellH).toBe(50);
    expect(r.gw).toEqual([1, 1]);
    expect(r.gh).toEqual([1, 2]);
  });

  it('退化盒钳为 1 格，且不把基准格拉爆（0 盒不参与定基准）', () => {
    const r = gradeBoxes([{ w: 0, h: 0 }, { w: 100, h: 100 }]);
    expect(r.cellW).toBe(100);
    expect(r.cellH).toBe(100);
    expect(r.gw).toEqual([1, 1]);
    expect(r.gh).toEqual([1, 1]);
  });

  it('占用格数 = 盒尺寸 ÷ 基准格向上取整（级数≠格数）', () => {
    // 20 与 200 只分两级，但 200 在 20 的格子里物理占用 10 格。
    const r = gradeBoxes([{ w: 20, h: 20 }, { w: 200, h: 100 }]);
    expect(r.cellW).toBe(20);
    expect(r.cellH).toBe(20);
    expect(r.gw).toEqual([1, 10]);
    expect(r.gh).toEqual([1, 5]);
  });

  it('空图与单节点', () => {
    expect(gradeBoxes([])).toEqual({ cellW: 1, cellH: 1, gw: [], gh: [] });
    expect(gradeBoxes([{ w: 80, h: 40 }])).toEqual({ cellW: 80, cellH: 40, gw: [1], gh: [1] });
  });
});

describe('GraphStore 集成：refreshGrades 挂在 applyNodeLabelSizes 统一入口', () => {
  it('构造后盒分级写入 gw/gh 与基准格；默认容差常量导出一致', () => {
    const store = new GraphStore({
      nodes: [
        { id: 'small' }, // 默认圆 r=10 → 盒 20×20
        { id: 'wide', shape: { kind: 'rect', w: 200, h: 100 } },
      ],
      edges: [],
    });
    store.applyNodeLabelSizes(true);
    expect(GRADE_TOLERANCE).toBe(1.25);
    expect(store.gradeCellW).toBe(20);
    expect(store.gradeCellH).toBe(20);
    const small = store.elementById('small');
    const wide = store.elementById('wide');
    expect(small.gw).toBe(1);
    expect(small.gh).toBe(1);
    expect(wide.gw).toBe(10);
    expect(wide.gh).toBe(5);
  });

  it('长标签撑大文字盒：分级随之刷新（行为与 nodeBoxSize 口径一致）', () => {
    const store = new GraphStore({
      nodes: [
        { id: 'a', label: 'x' },
        { id: 'b', label: '这是一段比较长的中文标签文字用于撑大文字盒' },
      ],
      edges: [],
    });
    store.applyNodeLabelSizes(true);
    const a = store.elementById('a');
    const b = store.elementById('b');
    // 分级输入 == nodeBoxSize：a 是最小级（1×1），b 更大。
    expect(a.gw).toBe(1);
    expect(a.gh).toBe(1);
    expect(b.gw).toBeGreaterThan(1);
    expect(b.gh).toBeGreaterThan(1);
    expect(store.gradeCellW).toBeCloseTo(store.nodeBoxSize(a).w, 9);
    expect(store.gradeCellH).toBeCloseTo(store.nodeBoxSize(a).h, 9);
  });
});
