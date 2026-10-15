/**
 * verify-layered-api — 校验分层提炼引擎各层接口契约（不依赖 HTTP，沙箱内可直接跑）。
 */
import { getStatus, listObservations, listCandidates, listAxioms, listSourceSessions, getJobs } from '../agents/layered-refine/index.ts';

async function main() {
  const s = await getStatus();
  console.log('[status] configured=%s backend=%s', s.configured, s.config.backend);
  console.log('[status] counts=%s', JSON.stringify(s.counts));

  const src = listSourceSessions(3);
  console.log('[sources] n=%d', src.length);
  for (const x of src) {
    console.log('   - %s | turns=%d | compaction=%s', (x.title || x.firstPrompt || '').slice(0, 48), x.msgTurns, x.compaction);
  }

  const o = listObservations();
  console.log('[L1 observations] n=%d', o.length);
  const c = listCandidates();
  console.log('[L2 candidates] n=%d', c.length);
  for (const it of c) {
    console.log('   - [%s/%s] %s', it.level, it.maturity, it.text.slice(0, 46));
    console.log('       evidence: support=%d sessions=%d span=%d obsIds=%d', it.evidence.supportCount, it.evidence.sessions.length, it.evidence.spanDays, it.sourceObsIds.length);
  }
  const a = listAxioms();
  console.log('[L3 axioms] n=%d', a.length);
  for (const it of a) {
    console.log('   - %s %s (%s)', it.id, it.title, it.tag);
  }
  const j = getJobs();
  console.log('[jobs] n=%d', Array.isArray(j) ? j.length : 0);
  console.log('\nOK');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
