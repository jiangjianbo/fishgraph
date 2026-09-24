/**
 * 尺寸分级（格单位架构 · 初始化阶段）—— px 盒 → 整数格占用的唯一换算。
 *
 * 设计口径（2026-09-23 定稿）：
 *  - px 只是中间量：盒宽/盒高**各自独立**做容差聚类分级，最小级的上界
 *    即基准格宽/格高（宽高基准可以不同 → 矩形格）；
 *  - 分级只负责定基准格：占用格数 = 盒尺寸 ÷ 基准格（向上取整，≥1），
 *    保证任何盒都放得进 gw×gh 个整格（级数≠格数，200px 的盒在 20px
 *    格里占 10 格，而不是"第 2 级就占 2 格"）；
 *  - 宽高比本身定不出格数（2:1 可以是 2×1 也可以是 4×2），必须靠绝对
 *    分级：同级 = 锚定聚类（对簇内最小成员的比值 ≤ 容差）；
 *  - 纯函数模块：输入 px 盒，输出格数与基准，与布局无关，属于初始化
 *    的一部分（GraphStore.refreshGrades 统一调用）。
 */

/** 分级容差：同簇成员对簇锚点（簇内最小值）的比值上界。 */
export const GRADE_TOLERANCE = 1.25;

/** 退化阈值：小于该值的盒尺寸不参与基准聚类（0 盒不把格拉爆）。 */
const DEGENERATE_EPS = 1e-9;

/** 单轴分级结果：基准格尺寸 + 各元素的级数（簇序号）。 */
export interface AxisGrades {
  /** 基准格尺寸（px，内存中间量）= 最小级的上界；全退化时回退 1。 */
  cell: number;
  /** 各元素级数（与输入同序，≥1 整数；仅表达分了几档，格数另算）。 */
  grades: number[];
}

/**
 * 单轴锚定聚类分级：升序扫描，成员对当前簇锚点（簇最小成员）的比值
 * ≤ tolerance 则入簇，否则另起新簇（锚点更新为新簇最小成员）。
 * 刻意不与上一元素链式比较 —— 防止 1.0→1.2→1.44→… 连锁滚雪球把
 * 本应同级的尺寸翻倍。平局按输入下标稳定排序，结果确定。
 * 格 = 最小级（第一簇）的上界；退化值（< DEGENERATE_EPS）不参与聚类，
 * 一律记最低级，避免 0 盒把基准格拉成无穷小。
 */
export function gradeAxis(values: readonly number[], tolerance: number = GRADE_TOLERANCE): AxisGrades {
  const n = values.length;
  if (n === 0) return { cell: 1, grades: [] };
  const order = values
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v >= DEGENERATE_EPS)
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const grades = new Array<number>(n).fill(1);
  if (order.length === 0) return { cell: 1, grades };
  let anchor = order[0]!.v;
  let cell = order[0]!.v;
  let grade = 1;
  for (const { v, i } of order) {
    if (v > anchor * tolerance + 1e-9) {
      grade += 1;
      anchor = v;
    } else if (grade === 1 && v > cell) {
      cell = v; // 最小级上界即格
    }
    grades[i] = grade;
  }
  return { cell, grades };
}

/** 输入盒（px，含边距与文字物化 —— 由调用方保证口径一致）。 */
export interface BoxSize {
  w: number;
  h: number;
}

/** 分级总结果：矩形格基准 + 各元素占用格数（宽×高，均 ≥1）。 */
export interface GradeBasis {
  /** 基准格宽（px，内存中间量）= 宽度最小级上界。 */
  cellW: number;
  /** 基准格高（px，内存中间量）= 高度最小级上界。 */
  cellH: number;
  /** 各元素占用格宽（与输入同序，≥1 整数）= ceil(w / cellW)。 */
  gw: number[];
  /** 各元素占用格高（与输入同序，≥1 整数）= ceil(h / cellH)。 */
  gh: number[];
}

/**
 * 宽高独立分级：宽度序列与高度序列各自 gradeAxis 定出矩形格基准
 * （cellW/cellH 可不同），再按基准除法（向上取整）得到各元素占用格数。
 * 最小级恰好 1×1；宽高比信息由矩形格形状承载，格数由绝对尺寸决定。
 */
export function gradeBoxes(boxes: readonly BoxSize[], tolerance: number = GRADE_TOLERANCE): GradeBasis {
  const width = gradeAxis(boxes.map((b) => b.w), tolerance);
  const height = gradeAxis(boxes.map((b) => b.h), tolerance);
  // -1e-9 抵消浮点噪声：恰好整除（如 cell 自身）不得因误差多出一格。
  return {
    cellW: width.cell,
    cellH: height.cell,
    gw: boxes.map((b) => Math.max(1, Math.ceil(b.w / width.cell - 1e-9))),
    gh: boxes.map((b) => Math.max(1, Math.ceil(b.h / height.cell - 1e-9))),
  };
}
