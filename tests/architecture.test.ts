/**
 * 架构自检：src/ 只含通用概念，不含任何图实例数据。
 * （"概念 vs 数据"边界 —— 实例内容只允许出现在 tests/ 与 demo/ 中）
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('架构边界：src/ 不含图实例数据', () => {
  it('源码中不出现任何测试/示例图的实例标识符', () => {
    const files = collectSources('src');
    expect(files.length).toBeGreaterThan(10);
    // 实例标识符：mermaid 架构图与分组示例的专属字符串
    const forbidden = [
      'SOURCE', 'CONSUMER', 'Verdaccio', 'PNPM', 'pnpm workspace',
      'ui-core', 'ui-event', 'ui-business', 'Web Project',
      '源码层', '开发协作层', '制品层', '消费层',
      'in-a', 'chain-1',
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        expect(content.includes(token), `${file} 含实例标识符 "${token}"`).toBe(false);
      }
    }
  });
});
