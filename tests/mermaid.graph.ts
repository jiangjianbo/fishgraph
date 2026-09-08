/**
 * 用户提供的 mermaid flowchart（TD）—— 作为真实业务图的压力/目视样本。
 *
 * 拓扑（与 mermaid 完全一致）：
 *   A 输入变更 → B 建立 Change Set → C 读取 Trace Graph → D 计算 Impact Set
 *   → E Tailoring → F 生成 Execution Plan → G 装载 Stage Contract
 *   → H 装载最小充分上下文 → I 执行 Stage → J 产生 Artifact → K 自动验证
 *   → L{Quality Gate}
 *   L --PASS--> M 更新 Baseline/State
 *   L --PASS_WITH_OPEN_ISSUES--> N 登记 Issue → M
 *   L --FAIL--> O 生成修正任务 → G
 *   L --BLOCKED--> P Decision/补充输入 → G
 *   M → Q 更新 Trace Graph → R{是否存在后续 Impact}
 *   R --是--> G    R --否--> S 阶段执行完成
 */

import type { GraphSpec } from '../src/index.js';

/** 粗略文字宽度：CJK 一字一字号，拉丁字符 0.6 字号（渲染与形状宽度共用）。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.6;
  }
  return w;
}

export const MERMAID_GRAPH: GraphSpec = (() => {
  const N = (id: string, label: string, diamond = false) => ({
    id,
    label,
    shape: diamond
      ? ({
          kind: 'rect' as const,
          // 单行文字水平居中在菱形中排（最宽处），对角线宽 = 形状宽
          w: Math.max(110, estimateTextWidth(label, 12) + 36),
          h: 72,
        })
      : ({ kind: 'rect' as const, w: Math.max(64, label.length * 13 + 20), h: 44 }),
  });
  return {
    nodes: [
      N('A', '输入变更'),
      N('B', '建立 Change Set'),
      N('C', '读取 Trace Graph'),
      N('D', '计算 Impact Set'),
      N('E', 'Tailoring'),
      N('F', '生成 Execution Plan'),
      N('G', '装载 Stage Contract'),
      N('H', '装载最小充分上下文'),
      N('I', '执行 Stage'),
      N('J', '产生 Artifact'),
      N('K', '自动验证'),
      N('L', 'Quality Gate', true),
      N('M', '更新 Baseline/State'),
      N('N', '登记 Issue'),
      N('O', '生成修正任务'),
      N('P', 'Decision/补充输入'),
      N('Q', '更新 Trace Graph'),
      N('R', '是否存在后续 Impact', true),
      N('S', '阶段执行完成'),
    ],
    edges: [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'D' },
      { source: 'D', target: 'E' },
      { source: 'E', target: 'F' },
      { source: 'F', target: 'G' },
      { source: 'G', target: 'H' },
      { source: 'H', target: 'I' },
      { source: 'I', target: 'J' },
      { source: 'J', target: 'K' },
      { source: 'K', target: 'L' },
      { source: 'L', target: 'M', label: 'PASS' },
      { source: 'L', target: 'N', label: 'PASS_WITH_OPEN_ISSUES' },
      { source: 'N', target: 'M' },
      { source: 'L', target: 'O', label: 'FAIL' },
      { source: 'L', target: 'P', label: 'BLOCKED' },
      { source: 'O', target: 'G' },
      { source: 'P', target: 'G' },
      { source: 'M', target: 'Q' },
      { source: 'Q', target: 'R' },
      { source: 'R', target: 'G', label: '是' },
      { source: 'R', target: 'S', label: '否' },
    ],
  };
})();
