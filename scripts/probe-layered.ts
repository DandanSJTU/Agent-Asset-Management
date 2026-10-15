/**
 * probe-layered — 分层提炼引擎状态体检（不经 HTTP，直接 import 引擎）。
 *
 * 用途：沙箱内 curl localhost 被拦时，用本脚本确认 /api/v1/layered/status 的真实形态。
 *
 * 用法：cd <repo> && MemoryPanel/node_modules/.bin/tsx scripts/probe-layered.ts
 */

import { getStatus, listObservations, listCandidates, listAxioms, getJobs } from '../agents/layered-refine/index.ts';

getStatus().then((s) => {
  console.log('=== status ===');
  console.log(JSON.stringify(s, null, 2));
  console.log('\n=== observations ===');
  console.log(JSON.stringify(listObservations().slice(0, 5), null, 2));
  console.log('\n=== candidates ===');
  console.log(JSON.stringify(listCandidates().slice(0, 5), null, 2));
  console.log('\n=== axioms ===');
  console.log(JSON.stringify(listAxioms().slice(0, 5), null, 2));
  console.log('\n=== jobs (最新 5) ===');
  console.log(JSON.stringify(getJobs().slice(0, 5), null, 2));
});
