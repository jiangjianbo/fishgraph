/**
 * 边文字的包围盒估算与回绕。
 *
 * 规则（2026-09-29 定稿）：节点尺寸按文字阶梯（行数 × 每行最大字符数）
 * 估算，系统参数约束**最大宽高比**（默认 4:1）—— 行数从少到多扫描，
 * 取第一个「盒宽 ≤ 盒高 × maxAspect」的行数（即满足约束的最少行数；
 * 扫描顺序本身保证少行数优先）；全部行数都超比（超长无断点词）时取
 * 宽高比最小的行数兜底。盒宽 = 每行最大字符数 × 字宽 + 2·pad，盒高 =
 * 行数 × 行高 + 2·pad，比例按含留白的最终盒判定。短文字自然单行，
 * 长文字回绕到比例上限内，节点整体偏扁（最扁 maxAspect:1）。
 *
 * 词边界：空格、下划线、斜杠之后允许断行
 * （PASS_WITH_OPEN_ISSUES → PASS_WITH / OPEN_ISSUES），
 * 单词内部绝不折断（PASS 永远是一整块，不会拆成 PA/SS）。
 */

export interface LabelBox {
  /** 包围盒半宽。 */
  hw: number;
  /** 包围盒半高。 */
  hh: number;
  /** 回绕后的行数。 */
  lines: number;
  /** 回绕后的各行文本（分隔符归属上一行行尾）。 */
  rows: string[];
}

/** 中英混排的保守字宽比例。 */
export const CHAR_WIDTH_RATIO = 0.75;

/** 最大宽高比缺省值（文字盒宽/高上限，超限回绕）。 */
export const DEFAULT_MAX_LABEL_ASPECT = 4;

/** 把文字切成断行单元：
 *  - CJK 字符逐字可断（中日韩文字没有词间空格）；
 *  - 拉丁词以分隔符（空格/下划线/斜杠）结尾为一个单元，单词内部不可断。 */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = '';
      }
      words.push(ch);
      continue;
    }
    cur += ch;
    if (ch === ' ' || ch === '_' || ch === '/' || ch === '\\') {
      words.push(cur);
      cur = '';
    }
  }
  if (cur) words.push(cur);
  return words.length > 0 ? words : [text];
}

/** 按词边界贪婪折行：每行尽量接近 target 字符，单词内部不折断。 */
function wrapWords(words: string[], target: number): string[] {
  const rows: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length > 0 && line.length + w.length > target) {
      rows.push(line);
      line = w;
    } else {
      line += w;
    }
  }
  if (line) rows.push(line);
  return rows;
}

/**
 * 估算标签包围盒（含回绕后的行文本，渲染方可直接用 rows）。
 * @param text      文字内容
 * @param fontSize  字号（px）
 * @param padding   文字与包围盒边缘的留白（px）
 * @param maxAspect 最大宽高比（盒宽/盒高，含留白；缺省 4 = 4:1），
 *                  超限回绕增加行数，取满足约束的最少行数
 */
export function estimateLabelBox(
  text: string,
  fontSize: number,
  padding: number,
  maxAspect: number = DEFAULT_MAX_LABEL_ASPECT,
): LabelBox {
  const chars = Math.max(text.length, 1);
  const charW = fontSize * CHAR_WIDTH_RATIO;
  const lineH = fontSize;
  const words = splitWords(text);

  interface Candidate {
    rows: string[];
    maxLen: number;
    ratio: number;
  }
  let satisfied: Candidate | null = null;
  let flattest: Candidate | null = null;
  // 枚举行数上限（贪婪折行可能折不出目标行数，实际行数 ≤ k）；
  // 行数升序扫描：首个满足宽高比者即最少行数，扫描可提前结束。
  for (let k = 1; k <= chars; k++) {
    const rows = wrapWords(words, Math.ceil(chars / k));
    if (rows.length > k) continue;
    let maxLen = 1;
    for (const r of rows) maxLen = Math.max(maxLen, r.length);
    const w = maxLen * charW + 2 * padding;
    const h = rows.length * lineH + 2 * padding;
    const cand: Candidate = { rows, maxLen, ratio: w / h };
    if (flattest === null || cand.ratio < flattest.ratio) flattest = cand;
    if (w <= h * maxAspect + 1e-9) {
      satisfied = cand;
      break;
    }
  }
  const chosen = satisfied ?? flattest!;
  return {
    hw: (chosen.maxLen * charW) / 2 + padding,
    hh: (chosen.rows.length * lineH) / 2 + padding,
    lines: chosen.rows.length,
    rows: chosen.rows,
  };
}
