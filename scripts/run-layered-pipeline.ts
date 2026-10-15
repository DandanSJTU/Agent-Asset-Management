/**
 * run-layered-pipeline — 分层提炼 L1→L2→L3 全链路编排脚本。
 *
 * 分两阶段（解决受限环境里 CLI 挂死、但又必须用真 LLM 的矛盾）：
 *   phase=dump  跑一次 observer，把真实发出的 prompt 全部落盘（只落盘、不产出）；
 *               由外部真 LLM（WorkBuddy agent）读 prompt 产出结果，按 key 写入
 *               LAYERED_REFINE_LLM_FILE（结果载体）。
 *   phase=run   清空旧产物 → observer（从载体取真结果）→ reflector → 打印每层输出。
 *
 * 用法：
 *   LAYERED_REFINE_BACKEND=file MemoryPanel/node_modules/.bin/tsx scripts/run-layered-pipeline.ts dump
 *   LAYERED_REFINE_BACKEND=file LAYERED_REFINE_LLM_FILE=... tsx scripts/run-layered-pipeline.ts run
 */

const PHASE = String(process.argv[2] ?? 'dump');

/** 本次演示选定的 3 个本地会话（跨 3 个不同主题，便于验证"跨场景"是否成立）。 */
const SESSION_IDS = [
  'Users-dandan-Projects-TencentDB-Agent-Memory/a03c6367-8c13-41ba-b17f-6ba149308c8e', // 分层提炼 tab 建设
  'Users-dandan-Projects-coslash-fork/7bd36fcf-ad2d-47bd-9080-2a7b4762605d', // coslash 登录 / resume 排障
  'Users-dandan-Projects-TencentDB-Agent-Memory/601224cb-8516-46ca-a6f3-83ab5e9630b2', // 三篇文章：知识消费断层
];

const DUMP_FILE = 'local-deploy/data/layered/prompts.jsonl';
const CARRIER = process.env.LAYERED_REFINE_LLM_FILE || 'local-deploy/data/layered/llm-results.jsonl';

async function main() {
  const eng = await import('../agents/layered-refine/index.ts');
  const { runObserver } = await import('../agents/layered-refine/observer.ts');
  const { runReflector } = await import('../agents/layered-refine/reflector.ts');
  const { loadObservations, loadCandidates, loadAxioms, resolveConfig } = await import(
    '../agents/layered-refine/store.ts'
  );

  const cfg = resolveConfig();
  console.log(`phase=${PHASE} backend=${cfg.backend} carrier=${CARRIER}`);
  console.log(`sessions=${SESSION_IDS.length}`);

  // 两阶段都落盘 prompt：dump 只落 observer；run 阶段会把 reflector / axiom 的 prompt 也补上
  process.env.LAYERED_REFINE_DUMP_PROMPTS = DUMP_FILE;

  if (PHASE === 'dump') {
    const r = await runObserver({ sessionIds: SESSION_IDS });
    console.log(`\n[dump] prompts -> ${DUMP_FILE}`);
    console.log(`[dump] sessions=${r.sessions} llmMissed=${r.llmMissed} observations=${r.observations.length}`);
    return;
  }

  // ── run ──
  // ① 清空旧产物（历史 offline 桩的假观测必须清掉，否则与真观测混在一起）
  const cleared = eng.resetAll();
  console.log(`\n[run] 已清空 ${cleared.cleared.length} 个产物文件`);

  // ② L1 Observer
  const obsRes = await runObserver({ sessionIds: SESSION_IDS });
  console.log(`\n========== L1 观测（Observer 产出）==========`);
  console.log(`会话数=${obsRes.sessions} 新增/合并后观测=${obsRes.observations.length} 噪声过滤=${obsRes.noiseFiltered} LLM未命中=${obsRes.llmMissed}`);
  for (const o of obsRes.observations) {
    console.log(`  [${o.level}] (${o.tag}) x${o.supportCount} 跨${o.sources.length}会话 :: ${o.text}`);
  }

  // ③ L2 Reflector
  const refRes = await runReflector();
  const cands = loadCandidates();
  console.log(`\n========== L2 候选（Reflector 产出）==========`);
  console.log(`入池观测=${refRes.eligible} 新候选=${refRes.candidates} 聚合方式=${refRes.mode} ${refRes.error ? '⚠ ' + refRes.error : ''}`);
  for (const c of cands) {
    console.log(`  [${c.level}/${c.maturity}] → ${c.suggestedTarget} :: ${c.text}`);
    console.log(`      证据: 支撑${c.evidence.supportCount}次 · 跨${c.evidence.sessions.length}会话 · 跨度${c.evidence.spanDays}天 · 来源观测${c.sourceObsIds.length}条`);
  }

  // ④ L3 Axiom：把第一条候选晋升为公理
  // 注意：这里显式指定 target='axioms'，是为了让演示走通"候选 → 公理蒸馏"这一段。
  // 真实使用时应尊重候选自带的 suggestedTarget（USER.md / MEMORY.md 直接追加一行）。
  const pending = cands.find((c) => c.status === 'pending');
  if (pending) {
    const ax = await eng.decideCandidate(pending.id, 'promote', 'axioms');
    console.log(`\n========== L3 公理（Axiom 蒸馏）==========`);
    console.log(`决策: ${JSON.stringify(ax)}`);
    for (const a of loadAxioms()) {
      console.log(`  ${a.id} — ${a.title} (${a.tag})`);
      console.log(`     核心含义: ${a.core}`);
      console.log(`     深度推演: ${a.reasoning}`);
      console.log(`     应用判定: ${a.application}`);
      console.log(`     来源: ${a.sources.join(' · ')}`);
    }
  } else {
    console.log(`\n[L3] 无待审候选，跳过公理蒸馏`);
  }

  console.log(`\n观测总数=${loadObservations().length} 候选总数=${loadCandidates().length} 公理总数=${loadAxioms().length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
