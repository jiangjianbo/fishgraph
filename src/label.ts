/**
 * 边文字的包围盒估算与回绕。
 *
 * 规则：文字条越宽越高都消耗能量，布局趋向"占用面积最小"。
 * 枚举行数 k，把文字按词边界贪婪折成 k 行，
 * 包围盒面积 A(k) = (最宽行宽 + 2·pad) × (k·lineH + 2·pad)，取最小者。
 * 短文字自然为单行；长文字自动折行接近方形，避免一条超长横条。
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
 */
export function estimateLabelBox(text: string, fontSize: number, padding: number): LabelBox {
  const chars = Math.max(text.length, 1);
  const charW = fontSize * CHAR_WIDTH_RATIO;
  const lineH = fontSize;
  const words = splitWords(text);

  let bestArea = Infinity;
  let bestRows: string[] = wrapWords(words, chars);
  // 枚举行数上限（贪婪折行可能折不出目标行数，实际行数 ≤ k）；
  // 面积取最小，同面积偏好少回绕（k 从小到大、strict less 保证偏好前行数少者）。
  for (let k = 1; k <= chars; k++) {
    const rows = wrapWords(words, Math.ceil(chars / k));
    if (rows.length > k) continue;
    let maxLen = 1;
    for (const r of rows) maxLen = Math.max(maxLen, r.length);
    const area = (maxLen * charW + 2 * padding) * (rows.length * lineH + 2 * padding);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      bestRows = rows;
    }
  }
  let maxLen = 1;
  for (const r of bestRows) maxLen = Math.max(maxLen, r.length);
  return {
    hw: (maxLen * charW) / 2 + padding,
    hh: (bestRows.length * lineH) / 2 + padding,
    lines: bestRows.length,
    rows: bestRows,
  };
}
