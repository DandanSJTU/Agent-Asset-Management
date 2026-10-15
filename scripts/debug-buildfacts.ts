#!/usr/bin/env node
import { scanSessions } from '../agents/personal-space/session-facts.ts';
import { buildFacts } from '../agents/personal-space/facts.ts';

const scanned = scanSessions('workbuddy');
console.log(`扫描会话: ${scanned.length}`);

// 找一个 recordCount 大且有 providerData.usage 的会话
function findUsageLocal(rec: Record<string, unknown>): Record<string, unknown> | null {
  const pd = rec.providerData as Record<string, unknown> | undefined;
  if (pd && pd.usage && typeof pd.usage === 'object') return pd.usage as Record<string, unknown>;
  return null;
}

let sampled = 0;
for (const s of scanned) {
  let usageCount = 0;
  let modelCount = 0;
  for (const r of s.raw.records) {
    const rec = r as Record<string, unknown>;
    if (findUsageLocal(rec)) usageCount++;
    const pd = rec.providerData as Record<string, unknown> | undefined;
    if (pd?.model) modelCount++;
  }
  if (usageCount > 0 && sampled < 3) {
    sampled++;
    console.log(`\n=== 会话 ${s.session.sessionId} records=${s.raw.records.length} usageRecs=${usageCount} modelRecs=${modelCount}`);
    const facts = buildFacts(s.session, s.raw);
    console.log(`  buildFacts tokens: ${JSON.stringify(facts.tokens)}`);
    console.log(`  buildFacts costUsd: ${facts.costUsd}`);
    console.log(`  buildFacts models: ${JSON.stringify(facts.models).slice(0, 200)}`);
    // 抽样一条有 usage 的记录的 providerData
    for (const r of s.raw.records) {
      const rec = r as Record<string, unknown>;
      const u = findUsageLocal(rec);
      if (u) {
        console.log(`  样例 usage: ${JSON.stringify(u)}`);
        console.log(`  样例 providerData: ${JSON.stringify(rec.providerData).slice(0, 200)}`);
        break;
      }
    }
  }
}
if (sampled === 0) console.log('没有找到含 usage 的会话！');
