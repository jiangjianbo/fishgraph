/**
 * demo 示例图构造（纯函数，无 DOM 依赖）。
 *
 * 与单元测试共享：tests/demo-scenes.test.ts 消费同一 GRAPHS 表做管线
 * 级校验（无重叠 / 确定性 / R6 零共线 / 走线不穿盒 / grid5x5 参数不
 * 变），保证「demo 里画的」与「测试里验的」是同一批图。
 */
import type { GraphSpec } from '../src/index.js';

/** 确定性随机（random 图固定 seed，布局逐位可复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + 0x6d2b79f5) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function treeGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [{ id: 'root', label: 'root' }];
  const edges: GraphSpec['edges'] = [];
  const level1: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = `b${i}`;
    nodes.push({ id, label: id });
    edges.push({ source: 'root', target: id });
    level1.push(id);
  }
  level1.forEach((p, pi) => {
    for (let j = 0; j < 4; j++) {
      const id = `l${pi}-${j}`;
      nodes.push({ id, label: id });
      edges.push({ source: p, target: `l${pi}-${j}` });
    }
  });
  return { nodes, edges };
}

export function gridGraph(): GraphSpec {
  const n = 5;
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      nodes.push({ id: `${x},${y}` });
      if (x + 1 < n) edges.push({ source: `${x},${y}`, target: `${x + 1},${y}` });
      if (y + 1 < n) edges.push({ source: `${x},${y}`, target: `${x},${y + 1}` });
    }
  }
  return { nodes, edges };
}

export function starGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [{ id: 'hub', label: 'hub' }];
  const edges: GraphSpec['edges'] = [];
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `s${i}`, label: `s${i}` });
    edges.push({ source: 'hub', target: `s${i}` });
  }
  return { nodes, edges };
}

/** 星形十字（1+4）：形状契约「十字」的管线级样例（hub 四正交向）。 */
export function starCrossGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [{ id: 'hub', label: 'hub' }];
  const edges: GraphSpec['edges'] = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `s${i}`, label: `s${i}` });
    edges.push({ source: 'hub', target: `s${i}` });
  }
  return { nodes, edges };
}

export function mixedGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  // 两个成群团块（K4 与 K3）+ 4 个离散点
  for (let i = 0; i < 4; i++) nodes.push({ id: `c1-${i}`, label: `c1-${i}` });
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      edges.push({ source: `c1-${i}`, target: `c1-${j}` });
  for (let i = 0; i < 3; i++) nodes.push({ id: `c2-${i}`, label: `c2-${i}` });
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      edges.push({ source: `c2-${i}`, target: `c2-${j}` });
  for (let i = 0; i < 4; i++) nodes.push({ id: `iso-${i}`, label: `iso-${i}` });
  return { nodes, edges };
}

/** 离散多点：8 个孤立节点（无边）——placeOrphan 紧凑落格的样例。 */
export function orphansGraph(): GraphSpec {
  const nodes: GraphSpec['nodes'] = [];
  for (let i = 0; i < 8; i++) nodes.push({ id: `o${i}`, label: `孤立${i}` });
  return { nodes, edges: [] };
}

export function randomGraph(): GraphSpec {
  const rnd = mulberry32(7);
  const n = 80;
  const nodes: GraphSpec['nodes'] = [];
  const edges: GraphSpec['edges'] = [];
  for (let i = 0; i < n; i++) nodes.push({ id: i, label: String(i) });
  const seen = new Set<string>();
  for (let k = 0; k < 120; k++) {
    const a = Math.floor(rnd() * n);
    const b = Math.floor(rnd() * n);
    if (a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: a, target: b });
  }
  return { nodes, edges };
}

export function shapesGraph(): GraphSpec {
  // 声明形状的尺寸参数（w/h/r）仅在未物化渲染与声明形状贴合下生效；
  // grid-undirected 布局尺寸由文字阶梯盒决定（maxLabelAspect 回绕），
  // kind 只决定物化轮廓画法（rect 圆角矩形 / circle·ellipse 内切椭圆）。
  return {
    nodes: [
      { id: 'req', shape: { kind: 'rect', w: 150, h: 46 }, label: '需求评审' },
      { id: 'dev', shape: { kind: 'rect', w: 150, h: 46 }, label: '开发实现' },
      { id: 'qa', shape: { kind: 'rect', w: 150, h: 46 }, label: '测试验收' },
      { id: 'ok', shape: { kind: 'circle', r: 26 }, label: '发布' },
      { id: 'gate', shape: { kind: 'ellipse', rx: 52, ry: 30 }, label: '质量门禁' },
      { id: 'fix', shape: { kind: 'rect', w: 120, h: 40 }, label: '回归修复' },
    ],
    edges: [
      { source: 'req', target: 'dev' },
      { source: 'dev', target: 'qa' },
      { source: 'qa', target: 'ok', label: '通过' },
      { source: 'qa', target: 'fix', label: '不通过' },
      { source: 'fix', target: 'dev' },
      { source: 'qa', target: 'gate' },
    ],
  };
}

export function flowGraph(): GraphSpec {
  // 有向流程图（direction=TB/LR 时展示层级布局）
  return {
    nodes: [
      { id: 'start', label: '开始' },
      { id: 'input', label: '读取输入' },
      { id: 'check', label: '校验' },
      { id: 'work', label: '处理' },
      { id: 'retry', label: '重试' },
      { id: 'done', label: '完成' },
    ],
    edges: [
      { source: 'start', target: 'input' },
      { source: 'input', target: 'check' },
      { source: 'check', target: 'work' },
      { source: 'work', target: 'done' },
      { source: 'check', target: 'retry', label: '失败' },
      { source: 'retry', target: 'work' },
    ],
  };
}

export function groupsGraph(): GraphSpec {
  return {
    nodes: [
      { id: 'in-a', label: 'in-a' },
      { id: 'in-b', label: 'in-b' },
      { id: 'in-c', label: 'in-c' },
      { id: 'chain-1', label: '链1' },
      { id: 'chain-2', label: '链2' },
      { id: 'chain-3', label: '链3' },
      { id: 'ext-1', label: '外部1' },
      { id: 'ext-2', label: '外部2' },
    ],
    edges: [
      { source: 'in-a', target: 'in-b' },
      { source: 'in-b', target: 'in-c' },
      { source: 'chain-1', target: 'chain-2' },
      { source: 'chain-2', target: 'chain-3' },
      { source: 'sub', target: 'ext-1' },
      { source: 'ext-2', target: 'sub' },
      { source: 'ext-1', target: 'in-b' },
    ],
    subgraphs: [
      { id: 'sub', shape: { kind: 'rect', w: 380, h: 280 }, label: '子图', members: ['in-a', 'in-b', 'in-c'] },
    ],
  };
}

export function mermaidSubgraphGraph(): GraphSpec {
  return {
    nodes: [
      { id: 'CORE', label: 'ui-core' },
      { id: 'EVENT', label: 'ui-event' },
      { id: 'I18N', label: 'ui-i18n' },
      { id: 'THEME', label: 'ui-theme' },
      { id: 'BASE', label: 'ui-button/ui-input/ui-dialog/ui-table/…' },
      { id: 'BUSINESS', label: 'ui-business-user/ui-business-data/ui-business-permission' },
      { id: 'PROJECT', label: 'ui-web-project/ui-android-project/ui-desktop-project' },
      { id: 'PNPM', label: 'pnpm workspace' },
      { id: 'REG', label: 'Private npm Registry/Verdaccio' },
      { id: 'WEB', label: 'Web Project' },
      { id: 'ANDROID', label: 'Android Project' },
      { id: 'OTHER', label: 'Other Projects' },
    ],
    edges: [
      { source: 'CORE', target: 'BASE' },
      { source: 'EVENT', target: 'BASE' },
      { source: 'I18N', target: 'BASE' },
      { source: 'THEME', target: 'BASE' },
      { source: 'BASE', target: 'BUSINESS' },
      { source: 'BUSINESS', target: 'PROJECT' },
      { source: 'PNPM', target: 'CORE', label: '管理' },
      { source: 'PNPM', target: 'BASE', label: '管理' },
      { source: 'PNPM', target: 'BUSINESS', label: '管理' },
      { source: 'PNPM', target: 'PROJECT', label: '管理' },
      { source: 'BASE', target: 'REG', label: 'publish' },
      { source: 'BUSINESS', target: 'REG', label: 'publish' },
      { source: 'REG', target: 'WEB' },
      { source: 'REG', target: 'ANDROID' },
      { source: 'REG', target: 'OTHER' },
    ],
    subgraphs: [
      {
        id: 'SOURCE',
        shape: { kind: 'rect', w: 1500, h: 950 },
        label: '源码层',
        members: ['CORE', 'EVENT', 'I18N', 'THEME', 'BASE', 'BUSINESS', 'PROJECT'],
      },
      { id: 'DEV', shape: { kind: 'rect', w: 340, h: 220 }, label: '开发协作层', members: ['PNPM'] },
      { id: 'REPO', shape: { kind: 'rect', w: 380, h: 240 }, label: '制品层', members: ['REG'] },
      {
        id: 'CONSUMER',
        shape: { kind: 'rect', w: 760, h: 460 },
        label: '消费层',
        members: ['WEB', 'ANDROID', 'OTHER'],
      },
    ],
  };
}

/** demo 下拉列表的示例图注册表（value 与 index.html option 一致）。 */
export const GRAPHS: Record<string, () => GraphSpec> = {
  tree: treeGraph,
  grid: gridGraph,
  star: starGraph,
  starCross: starCrossGraph,
  mixed: mixedGraph,
  orphans: orphansGraph,
  random: randomGraph,
  shapes: shapesGraph,
  flow: flowGraph,
  groups: groupsGraph,
  mermaidSub: mermaidSubgraphGraph,
};
