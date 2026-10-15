/**
 * probe-sessions — 本地会话素材体检（分层提炼「选源」辅助脚本）。
 *
 * 用途：列出 ~/.workbuddy/projects 下最近有活动的会话，统计可读出的
 * 对话轮次（user / assistant），并用 texts24 Law 口径估算 compact 污染程度，
 * 帮人挑出「表达密度高、未被 AI 摘要顶替」的 3 个演示样本。
 *
 * 只读脚本：不写任何 store、不调 LLM。
 *
 * 用法：
 *   cd <repo> && MemoryPanel/node_modules/.bin/tsx scripts/probe-sessions.ts [limit]
 */

import { discoverSessionMeta } from '../agents/personal-space/session-facts.ts';
import { readSessionMessages } from '../agents/personal-space/session-messages.ts';

const limit = Number(process.argv[2] ?? 25);

const metas = discoverSessionMeta('workbuddy')
  .filter((m) => m.kind === 'top-level')
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, limit);

const now = Date.now();
const rows: Array<Record<string, string | number>> = [];

for (const m of metas) {
  const msgs = readSessionMessages('workbuddy', m.sessionId);
  const userTurns = msgs.filter((x) => x.role === 'user');
  const assistantTurns = msgs.filter((x) => x.role === 'assistant');
  const userChars = userTurns.reduce((s, x) => s + x.content.length, 0);
  const allChars = msgs.reduce((s, x) => s + x.content.length, 0);
  // 压缩摘要比例：assistant 内容里包含 "This session is being continued" 等续接标记的条数
  const compactionHits = assistantTurns.filter((x) =>
    /This session is being continued| conversation summary|summary of the conversation/i.test(x.content),
  ).length;
  // 用户表达密度：user 字符 / 总字符。越低 = assistant 独白越多，提炼价值越低
  const density = allChars > 0 ? Math.round((userChars / allChars) * 100) : 0;
  const ageDays = Math.round((now - m.mtime) / 86400000);

  rows.push({
    ageDays,
    turns: msgs.length,
    user: userTurns.length,
    userChars,
    density,
    compaction: compactionHits,
    sizeKB: Math.round(m.size / 1024),
    sessionId: m.sessionId,
    preview: (userTurns[0]?.content ?? '').replace(/\s+/g, ' ').slice(0, 46),
  });
}

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
console.log(
  [pad('age(d)', 7), pad('turns', 6), pad('user', 5), pad('uChars', 7), pad('dens%', 6), pad('comp', 5), pad('sizeKB', 7), 'sessionId / 首问预览'].join(' '),
);
console.log('-'.repeat(140));
for (const r of rows) {
  console.log(
    [
      pad(r.ageDays, 7),
      pad(r.turns, 6),
      pad(r.user, 5),
      pad(r.userChars, 7),
      pad(r.density, 6),
      pad(r.compaction, 5),
      pad(r.sizeKB, 7),
      `${r.sessionId}`,
    ].join(' '),
  );
  console.log(`    ↳ ${r.preview}`);
}

// 推荐：用户在 ≥3 轮、用户表达 ≥600 字、无压缩续接、7 天内
const good = rows.filter(
  (r) => Number(r.user) >= 3 && Number(r.userChars) >= 600 && Number(r.compaction) === 0,
);
console.log('\n=== 推荐样本（user≥3 轮 / userChars≥600 / compaction=0）===');
for (const r of good) console.log(`  ${r.sessionId}  (turns=${r.turns}, user=${r.user}, uChars=${r.userChars}, ${r.ageDays}d)`);
console.log(`\n共 ${rows.length} 个近期会话，其中 ${good.length} 个满足推荐条件。`);
