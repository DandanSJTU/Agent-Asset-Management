#!/usr/bin/env node
import { scanSessions } from '../agents/personal-space/session-facts.ts';
import { buildFacts } from '../agents/personal-space/facts.ts';

const scanned = scanSessions('workbuddy');
let nanSessions = 0;
let maxRec = 0;
for (const s of scanned) {
  const facts = buildFacts(s.session, s.raw);
  if (Number.isNaN(facts.digest.recap)) {
    nanSessions++;
    if (nanSessions <= 2) {
      console.log(`\nNaN recap 会话: ${s.session.sessionId}`);
      console.log(`  digest: ${JSON.stringify(facts.digest)}`);
      // 找一条被 classify 成 recap 的记录
      let shown = 0;
      for (const r of s.raw.records) {
        const rec = r as Record<string, unknown>;
        const type = String(rec.type ?? '');
        if (/^recap$|summary|chat_summary/i.test(type) || (rec.parentId && false)) {
          if (shown < 3) { console.log(`   recap-like type=${type} parentId=${rec.parentId}`); shown++; }
        }
      }
    }
  }
  if (facts.digest.recap > maxRec) maxRec = facts.digest.recap;
}
console.log(`\nNaN recap 会话数: ${nanSessions}`);
console.log(`最大 recap 值: ${maxRec}`);
