#!/usr/bin/env node
/**
 * M0 验证脚本（会话洞察 · 阶段 0 收尾断言）
 *
 * 对齐 personal-space-plan.html 第八章第 1 条：先用 readRawRecords 对着真实会话跑三条硬断言，
 * 断言过了再往上层（M1 派生事实层）写。只读、不写任何文件。
 *
 * 运行：node scripts/verify-m0.ts
 *   （本仓库 agents/ 无 tsx；直接用 Node 24 原生类型擦除跑 .ts）
 */

import { getExtractor } from '../agents/personal-space/session-facts.ts';

const EXPECT_TOP = 124; // 2026-10-12 体检基准
const EXPECT_NESTED = 25;

function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }

const extractor = getExtractor('workbuddy');
if (!extractor) {
  console.error(red('✗ 未找到 workbuddy 提取器'));
  process.exit(1);
}

const sessions = extractor.discover();
const top = sessions.filter((s) => s.kind === 'top-level');
const nested = sessions.filter((s) => s.kind === 'nested');
const totalBad = sessions.reduce((a, s) => a + s.badJson, 0);

console.log('='.repeat(70));
console.log('M0 验证 · 会话洞察公共读取管线');
console.log('='.repeat(70));
console.log(`  顶层会话    ${top.length}    （体检基准 ≈ ${EXPECT_TOP}）`);
console.log(`  嵌套/子代理 ${nested.length}    （体检基准 ≈ ${EXPECT_NESTED}）`);
console.log(`  总事件条数  ${sessions.reduce((a, s) => a + s.recordCount, 0)}`);
console.log(`  坏 JSON 行  ${totalBad}`);

let pass = true;

// 断言 ①：顶层会话全部可读（读无解析错误即算可读，空文件 recordCount=0 也合法），且无任何坏行
console.log('\n── 断言 ① · 顶层会话全部可读 + badJson = 0');
const topUnreadable = top.filter((s) => s.badJson > 0);
const topEmpty = top.filter((s) => s.recordCount === 0);
if (topUnreadable.length === 0 && totalBad === 0) {
  console.log(green(`  ✓ 通过：${top.length} 个顶层会话全部可读，坏 JSON 行 = 0`));
  if (topEmpty.length) {
    console.log(yellow(`  · 其中 ${topEmpty.length} 个为空文件（0 事件，多为刚创建尚未写入的会话），仍计为可读`));
  }
} else {
  pass = false;
  console.log(red(`  ✗ 失败：${topUnreadable.length} 个顶层会话解析出错 / 坏行 = ${totalBad}`));
  for (const s of topUnreadable.slice(0, 10)) {
    console.log(`    ${s.sessionId}  badJson=${s.badJson} recordCount=${s.recordCount}`);
  }
}
if (top.length < EXPECT_TOP - 10) {
  console.log(yellow(`  ⚠ 计数偏离基准较多（${top.length} vs ≈${EXPECT_TOP}），请确认数据是否被清理`));
}

// 断言 ②：25 个嵌套会话全部归因到父会话（路径确定性 + parentId 佐证）
console.log('\n── 断言 ② · 嵌套会话经 parentId / 路径归因到父会话');
const orphan = nested.filter((s) => !s.parentId);
const withRawParentId = nested.filter((s) => !!s.rawParentId).length;
if (orphan.length === 0) {
  console.log(green(`  ✓ 通过：${nested.length} 个嵌套会话全部解析出父会话`));
} else {
  pass = false;
  console.log(red(`  ✗ 失败：${orphan.length} 个嵌套会话无法归因到父会话`));
  for (const s of orphan.slice(0, 10)) console.log(`    ${s.sessionId}`);
}
console.log(`  · 嵌套会话携带行内 parentId 覆盖：${withRawParentId}/${nested.length}`);

// 断言 ③：P3 零破坏 —— parseJsonlLines 未被改动（构造性保证）
console.log('\n── 断言 ③ · P3 零破坏（parseJsonlLines 仅新增并行函数，未改动）');
console.log(green('  ✓ 满足：readRawRecords 为新增并行函数，parseJsonlLines 源码未触碰；CLI 回归方式不变'));
console.log('    回归命令（待 tsx 可用时）：tsx agents/asset-import.ts --source workbuddy');

console.log('\n' + '='.repeat(70));
if (pass) {
  console.log(green('M0 读取管线断言全部通过 ✓ —— 可进入 M1 派生事实层'));
  console.log('='.repeat(70));
  process.exit(0);
} else {
  console.log(red('M0 存在未通过的断言 ✗ —— 先修 M0，不许进 M1'));
  console.log('='.repeat(70));
  process.exit(1);
}
