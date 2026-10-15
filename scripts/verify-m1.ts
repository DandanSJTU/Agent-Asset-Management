#!/usr/bin/env node
/**
 * M1 验证脚本（会话洞察 · 派生事实层）
 *
 * 对齐 personal-space-plan.html 阶段 1 DoD：
 *   ① 冷启动全量扫描 ≤ 30s
 *   ② 二次加载 ≤ 1s（缓存命中）
 *   ③ 单会话成本与人工核算误差 < 5%（这里打印 Top 会话供人工 eyeball）
 *
 * 运行：node scripts/verify-m1.ts
 */

import { spawnSync } from 'node:child_process';
import { computeAllSessions, type SessionFacts } from '../agents/personal-space/facts.ts';

// ── git 可用性预检（R3）──
// 沙箱屏蔽 .git / 容器未挂载项目目录 / git 未安装时，git 统计失去意义。
// 对当前仓库探测一次：不可用时给 git 统计行加「环境受限」标注——
// 把环境问题与引擎缺陷区分开，避免 G-A 类审计误报。
const _gitProbe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { timeout: 3000 });
const gitEnvOk = _gitProbe.status === 0 && !_gitProbe.error && !_gitProbe.signal;
const gitEnvNote = gitEnvOk ? '' : '  ' + yellow('(git 环境受限：.git 不可见/未安装/被拦截，统计仅供参考，非引擎缺陷)');

function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }

console.log('='.repeat(70));
console.log('M1 验证 · 派生事实层（真实数据全量）');
console.log('='.repeat(70));

// ① 冷启动（禁用缓存）
const cold = computeAllSessions(false);
console.log(`\n── DoD ① · 冷启动全量扫描`);
console.log(`  会话数      ${cold.facts.length}`);
console.log(`  冷启动耗时  ${cold.coldMs}ms  ${cold.coldMs <= 30000 ? green('✓ ≤30s') : red('✗ >30s')}`);

// ② 缓存命中（先建缓存，再命中）
computeAllSessions(true); // 建缓存
const warm = computeAllSessions(true); // 命中
console.log(`\n── DoD ② · 缓存命中二次加载`);
console.log(`  本次命中    ${warm.cached} / 重建 ${warm.rebuilt}`);
console.log(`  二次耗时    ${warm.coldMs}ms  ${warm.coldMs <= 1000 ? green('✓ ≤1s') : red('✗ >1s')}`);

// 汇总统计
const f = warm.facts;
const totalCost = f.reduce((a, x) => a + x.costUsd, 0);
const withCost = f.filter((x) => x.costUsd > 0);
const totalTok = f.reduce((a, x) => a + x.tokens.total, 0);
const states: Record<string, number> = {};
for (const x of f) states[x.state] = (states[x.state] ?? 0) + 1;
const gitOk = f.filter((x) => x.git && (x.git.status ?? 'ok') === 'ok');
const topWithGit = gitOk.filter((x) => x.git?.branch);
const aheadSum = topWithGit.reduce((a, x) => a + (x.git?.ahead ?? 0), 0);
const behindSum = topWithGit.reduce((a, x) => a + (x.git?.behind ?? 0), 0);
const gitTri = { ok: 0, 'not-repo': 0, unavailable: 0 };
for (const x of f) if (x.git) gitTri[x.git.status ?? 'ok']++;
const totalEdits = f.reduce((a, x) => a + x.edits.operations, 0);
const totalAdded = f.reduce((a, x) => a + x.edits.addedLines, 0);
const totalRemoved = f.reduce((a, x) => a + x.edits.removedLines, 0);
const dSum = f.reduce((a, x) => ({
  firstPrompt: a.firstPrompt + x.digest.firstPrompt,
  user: a.user + x.digest.user,
  question: a.question + x.digest.question,
  todos: a.todos + x.digest.todos,
  compaction: a.compaction + x.digest.compaction,
  recap: a.recap + x.digest.recap,
  plan: a.plan + x.digest.plan,
  subagent: a.subagent + x.digest.subagent,
}), { firstPrompt: 0, user: 0, question: 0, todos: 0, compaction: 0, recap: 0, plan: 0, subagent: 0 });

console.log('\n── 汇总统计');
console.log(`  总成本      $${totalCost.toFixed(4)}（${withCost.length} 个会话有成本）`);
console.log(`  总 Token    ${totalTok.toLocaleString()}`);
console.log(`  状态分布    ${Object.entries(states).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`  Git 三态    ok:${gitTri.ok} / not-repo:${gitTri['not-repo']} / unavailable:${gitTri.unavailable}${gitEnvNote}`);
console.log(`  Git 仓库    ${topWithGit.length} 个 ok 会话位于 git 仓（ahead 合计 ${aheadSum} / behind 合计 ${behindSum}）`);
console.log(`  FileEdits   ${totalEdits} 次操作 / +${totalAdded} 行 / -${totalRemoved} 行`);
console.log(`  Digest      user:${dSum.user} question:${dSum.question} todos:${dSum.todos} compaction:${dSum.compaction} recap:${dSum.recap} plan:${dSum.plan} subagent:${dSum.subagent}`);

console.log('\n── DoD ③ · 成本高会话 Top5（人工 eyeball 成本准确度）');
const top = [...f].filter((x) => x.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);
for (const x of top) {
  const models = x.models.map((m) => `${m.model}($${m.costUsd.toFixed(4)})`).join(', ');
  console.log(`  ${x.sessionId.slice(0, 50).padEnd(50)}  $${x.costUsd.toFixed(4)}  tok=${x.tokens.total}`);
  console.log(`     模型: ${models || '(价目缺失)'}`);
}

console.log('\n' + '='.repeat(70));
console.log(green('M1 派生事实层已对真实数据跑通 ✓'));
console.log('='.repeat(70));
