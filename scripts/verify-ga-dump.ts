#!/usr/bin/env node
/**
 * G-A 硬门禁 · 数据侧导出脚本（会话洞察 P0 真数据复核）
 *
 * 对齐 personal-space-plan.html 路线图 G-A：用真实会话全量验证
 * 跑通率 / 耗时 / 成本准确度（数据侧部分）/ 脏数据（数据侧部分）。
 * 成本复算与脏数据扫描由独立 Python 脚本完成（见 /tmp/ga-check.py），
 * 本脚本只负责把引擎产出 + stat 元信息落盘，保证「单一事实来源」不被复制。
 *
 * 运行：node scripts/verify-ga-dump.ts
 */

import { writeFileSync } from 'node:fs';
import { computeAllSessions } from '../agents/personal-space/facts.ts';
import { discoverSessionMeta } from '../agents/personal-space/session-facts.ts';

function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }

console.log('='.repeat(70));
console.log('G-A 数据侧 · 引擎全量导出（真实数据）');
console.log('='.repeat(70));

// ① 冷启动（禁用缓存）——对应 G-A「耗时」与 DoD①
const cold = computeAllSessions(false);
console.log(`\n── 冷启动（无缓存）`);
console.log(`  会话数      ${cold.facts.length}`);
console.log(`  耗时        ${cold.coldMs}ms  ${cold.coldMs <= 30000 ? green('✓ ≤30s') : red('✗ >30s')}`);

// ② 建缓存 + 命中——对应 DoD②
computeAllSessions(true);
const warm = computeAllSessions(true);
console.log(`\n── 二次加载（缓存命中）`);
console.log(`  命中 ${warm.cached} / 重建 ${warm.rebuilt}`);
console.log(`  耗时        ${warm.coldMs}ms  ${warm.coldMs <= 1000 ? green('✓ ≤1s') : red('✗ >1s')}`);

// stat-only 元信息（供独立复算脚本定位原始文件，零读文件内容）
const meta = discoverSessionMeta('workbuddy');

const payload = {
  generatedAt: new Date().toISOString(),
  timings: {
    coldMs: cold.coldMs,
    warmMs: warm.coldMs,
    cached: warm.cached,
    rebuilt: warm.rebuilt,
  },
  facts: cold.facts,
  meta,
};
writeFileSync('/tmp/ga-facts.json', JSON.stringify(payload));
console.log(`\n已导出 /tmp/ga-facts.json（facts ${cold.facts.length} 条 / meta ${meta.length} 条）`);
console.log('='.repeat(70));
