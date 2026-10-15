/**
 * layered-refine · 引擎入口（index.ts，barrel）。
 *
 * 面板路由通过「运行时动态 import」只加载本文件一个入口，避免跨包静态依赖
 * （对齐 personal-space 路由的懒加载模式）。本模块持有 module 级 job 注册表，
 * 实现前端 pending 轮询（observer / reflector 长耗时，不阻塞 HTTP）。
 *
 * 关键边界：本车道只复用 agents/personal-space 的「会话读取 IO」，不 import MemoryCore /
 * gateway / 现有两个 tab 的任何提炼产物 —— 这是"独立第二车道"的实体保证。
 */

import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  saveConfig,
  queryObservations,
  loadObservations,
  loadCandidates,
  appendCandidates,
  updateCandidate,
  markPromoted,
  loadAxioms,
  appendJob,
  loadJobs,
  ensureDirs,
  resetAll as resetAllImpl,
} from './store.ts';
import { runObserver, listSourceSessions as listSourceSessionsImpl } from './observer.ts';
import { runReflector } from './reflector.ts';
import { distillAxiom } from './axiom.ts';
import type { Candidate, JobRecord, ObservationQuery, StatusResponse } from './types.ts';

// ── 后台 job 注册表 ──
const jobs = new Map<string, Promise<void>>();
const jobStatus = new Map<string, JobRecord>();

function newJobId(type: JobRecord['type']): string {
  return `${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function startJob(type: JobRecord['type']): { jobId: string; rec: JobRecord } {
  const jobId = newJobId(type);
  const rec: JobRecord = {
    jobId,
    type,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
  };
  jobStatus.set(jobId, rec);
  appendJob(rec);
  return { jobId, rec };
}

function finishJob(jobId: string, patch: Partial<JobRecord>): void {
  const rec = jobStatus.get(jobId);
  if (!rec) return;
  const next = { ...rec, ...patch, endedAt: Date.now() };
  jobStatus.set(jobId, next);
  appendJob(next);
}

// ── 接口 ──
export async function getStatus(): Promise<StatusResponse> {
  const cfg = resolveConfig();
  const obs = queryObservations();
  const cands = loadCandidates();
  const axs = loadAxioms();
  const jobsAll = loadJobs();
  const lastOf = (t: JobRecord['type']) => {
    const f = jobsAll.find((j) => j.type === t && j.status === 'success');
    return f ? f.endedAt : null;
  };
  const sessionSet = new Set<string>();
  for (const o of obs) for (const s of o.sources ?? []) sessionSet.add(s);
  return {
    rootDir: cfg.rootDir,
    configured: existsSync(join(cfg.rootDir, 'config.json')),
    counts: {
      sessions: sessionSet.size,
      observations: obs.length,
      candidates: cands.length,
      axioms: axs.length,
      pendingCandidates: cands.filter((c) => c.status === 'pending').length,
    },
    lastRuns: {
      observer: lastOf('observer'),
      reflector: lastOf('reflector'),
      axiom: lastOf('axiom'),
    },
    config: cfg,
  };
}

export function listObservations(query: ObservationQuery = {}) {
  return queryObservations(query);
}

export function runObserverJob(opts: {
  windowDays?: number;
  maxSessions?: number;
  force?: boolean;
  sessionIds?: string[];
} = {}): { jobId: string } {
  const { jobId, rec } = startJob('observer');
  const job = (async () => {
    try {
      const r = await runObserver(opts);
      finishJob(jobId, {
        status: 'success',
        sessions: r.sessions,
        observations: r.observations.length,
        noiseFiltered: r.noiseFiltered,
        llmMissed: r.llmMissed,
        pickedSessionIds: r.pickedSessionIds,
        error: r.error ?? null,
      });
    } catch (e) {
      finishJob(jobId, { status: 'failed', error: (e as Error).message });
    }
  })();
  jobs.set(jobId, job);
  job.finally(() => jobs.delete(jobId));
  void rec;
  return { jobId };
}

/** 列出可选源会话（UI 勾选"跑哪几个对话"）。 */
export function listSourceSessions(limit = 40) {
  return listSourceSessionsImpl(limit);
}

export function runReflectorJob(): { jobId: string } {
  const { jobId, rec } = startJob('reflector');
  const job = (async () => {
    try {
      const r = await runReflector();
      finishJob(jobId, {
        status: 'success',
        candidates: r.candidates,
        mode: r.mode,
        error: r.error ?? null,
      });
    } catch (e) {
      finishJob(jobId, { status: 'failed', error: (e as Error).message });
    }
  })();
  jobs.set(jobId, job);
  job.finally(() => jobs.delete(jobId));
  void rec;
  return { jobId };
}

export function listCandidates() {
  return loadCandidates();
}

/** L1 人工「标晋升」：把一条观测直接推入候选池（人审前不写目标文件）。 */
export function promoteObservation(obsId: string): unknown {
  const o = loadObservations().find((x) => x.id === obsId);
  if (!o) return null;
  const existing = loadCandidates().find((c) => c.id === `cand_${o.id}`);
  if (existing) return existing;
  const cand = {
    id: `cand_${o.id}`,
    text: o.text,
    level: o.level,
    tag: o.tag,
    evidence: { supportCount: o.supportCount, sessions: o.sources, spanDays: 0 },
    suggestedTarget: (o.level === 'high' ? 'USER.md' : o.level === 'medium' ? 'MEMORY.md' : 'axioms') as Candidate['suggestedTarget'],
    maturity: 'emerging' as const,
    status: 'pending' as const,
    createdAt: Date.now(),
    mode: 'rule' as const,
    sourceObsIds: [o.id],
  };
  appendCandidates([cand]);
  return cand;
}

const PERSONAL_DIR = join(homedir(), 'user-f65c0bcb-048a-453e-9a1c-a67f7d64691d-personal');

/** 人审晋升：把候选写进目标文件（USER.md / MEMORY.md / axioms），并软删除对应观测。 */
export async function decideCandidate(
  id: string,
  decision: 'promote' | 'demote' | 'drop',
  targetOverride?: 'USER.md' | 'MEMORY.md' | 'axioms',
): Promise<unknown> {
  const cand = loadCandidates().find((c) => c.id === id);
  if (!cand) return null;

  if (decision === 'promote') {
    const target = targetOverride ?? cand.suggestedTarget;
    if (target === 'axioms') {
      const obsId = cand.id.startsWith('cand_') ? cand.id.slice(5) : cand.id;
      const axJob = startJob('axiom');
      await distillAxiom(cand.text, [obsId, ...cand.evidence.sessions]);
      finishJob(axJob.jobId, { status: 'success', axioms: 1 });
    } else {
      const file = join(PERSONAL_DIR, target);
      const line = `- ${cand.text}${cand.tag ? `  (#${cand.tag})` : ''}\n`;
      appendFileSync(file, line, 'utf8');
    }
    updateCandidate(id, { status: 'promoted' });
    const obsId = cand.id.startsWith('cand_') ? cand.id.slice(5) : cand.id;
    markPromoted([obsId]);
    return { ok: true, target };
  }
  if (decision === 'demote') updateCandidate(id, { status: 'demoted' });
  if (decision === 'drop') updateCandidate(id, { status: 'dropped' });
  return { ok: true, status: decision };
}

export function listAxioms() {
  return loadAxioms();
}

export async function createAxiom(input: { text: string; sources?: string[] }): Promise<unknown> {
  const start = startJob('axiom');
  try {
    const ax = await distillAxiom(input.text, input.sources ?? []);
    finishJob(start.jobId, { status: 'success', axioms: 1 });
    return ax;
  } catch (e) {
    finishJob(start.jobId, { status: 'failed', error: (e as Error).message });
    throw e;
  }
}

export function getJobs(id?: string) {
  if (id) return jobStatus.get(id) ?? loadJobs().find((j) => j.jobId === id) ?? null;
  return loadJobs();
}

export function updateConfig(patch: Record<string, unknown>): StatusResponse['config'] {
  return saveConfig(patch as never);
}

/** 清空本车道全部产物（清掉 offline 桩假数据后重跑用）。 */
export function resetAll(): { cleared: string[] } {
  return resetAllImpl();
}

// 进程退出前确保目录存在（路由首次调用时也兜底）
ensureDirs();
