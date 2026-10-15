/**
 * layered-refine API client — 分层提炼（独立第二车道）。
 *
 * 后端路由：MemoryPanel/src/panel/http/routes/layered-refine.ts
 * 统一信封：{ code, message, data }（与 personal-space 一致，复用 unwrapEnvelope）。
 */

import { request, unwrapEnvelope } from './base';
import type { MetaEnvelope } from './types';

const PREFIX = '/api/v1/layered';

export type TrafficLevel = 'high' | 'medium' | 'low';

export interface Observation {
  id: string;
  date: string;
  level: TrafficLevel;
  tag: string;
  text: string;
  firstSeen: string;
  lastSeen: string;
  supportCount: number;
  sources: string[];
  promoted: boolean;
}

export interface Candidate {
  id: string;
  text: string;
  level: TrafficLevel;
  tag: string;
  evidence: { supportCount: number; sessions: string[]; spanDays: number };
  suggestedTarget: 'USER.md' | 'MEMORY.md' | 'axioms';
  /** 稳定度：stable=支撑/跨会话/跨度三条全满足；emerging=跨度不足（如一次性导入） */
  maturity: 'stable' | 'emerging';
  status: 'pending' | 'promoted' | 'demoted' | 'dropped';
  createdAt: number;
  /** 聚合方式：llm=Reflector 语义合并 / rule=门槛回退 */
  mode: 'llm' | 'rule';
  /** 命中的观测 id（证据链） */
  sourceObsIds: string[];
}

export interface Axiom {
  id: string;
  title: string;
  tag: string;
  core: string;
  reasoning: string;
  application: string;
  sources: string[];
  createdAt: number;
  updatedAt: number;
}

export interface JobRecord {
  jobId: string;
  type: 'observer' | 'reflector' | 'axiom';
  startedAt: number;
  endedAt: number | null;
  status: 'pending' | 'running' | 'success' | 'failed';
  sessions?: number;
  observations?: number;
  noiseFiltered?: number;
  candidates?: number;
  axioms?: number;
  error?: string | null;
}

export interface LayeredConfig {
  rootDir: string;
  windowDays: number;
  maxSessionsPerRun: number;
  backend: string;
  excludeCompactionGte: number;
  promotion: { supportGte: number; sessionsGte: number; spanDaysGte: number };
}

export interface StatusResponse {
  rootDir: string;
  configured: boolean;
  counts: { sessions: number; observations: number; candidates: number; axioms: number; pendingCandidates: number };
  lastRuns: { observer: number | null; reflector: number | null; axiom: number | null };
  config: LayeredConfig;
}

export interface ObservationQuery {
  since?: string;
  level?: TrafficLevel;
  q?: string;
}

async function lrGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const env = await request<MetaEnvelope<T>>('GET', `${PREFIX}${path}`, undefined, undefined, signal);
  return unwrapEnvelope(env, 'empty layered-refine response');
}

export function fetchLayeredStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return lrGet<StatusResponse>('/status', signal);
}

export function fetchObservations(query: ObservationQuery = {}, signal?: AbortSignal): Promise<Observation[]> {
  const qs: string[] = [];
  if (query.since) qs.push(`since=${encodeURIComponent(query.since)}`);
  if (query.level) qs.push(`level=${encodeURIComponent(query.level)}`);
  if (query.q) qs.push(`q=${encodeURIComponent(query.q)}`);
  const suffix = qs.length ? `?${qs.join('&')}` : '';
  return lrGet<Observation[]>(`/observations${suffix}`, signal);
}

/** 可选源会话条目（UI 勾选「跑哪几个对话」）。 */
export interface SourceSessionItem {
  sessionId: string;
  vendor: string;
  mtime: number;
  kind: 'top-level' | 'nested';
  recordCount: number;
  userTurns: number;
  tokens: number;
  compaction: number;
  title: string;
  firstPrompt: string;
  msgTurns: number;
}

/** 拉取可选源会话列表。 */
export function fetchLayeredSessions(limit = 40, signal?: AbortSignal): Promise<SourceSessionItem[]> {
  const q = Number.isFinite(limit) ? limit : 40;
  return lrGet<SourceSessionItem[]>(`/sessions?limit=${q}`, signal);
}

/** 清空本车道产物（context-infra 下的观测 / 候选 / 公理 / 运行日志）。 */
export async function resetLayered(signal?: AbortSignal): Promise<{ cleared: string[] }> {
  const env = await request<MetaEnvelope<{ cleared: string[] }>>(
    'POST',
    `${PREFIX}/reset`,
    { confirm: true } as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'reset failed');
}

export async function runObserver(
  opts: { windowDays?: number; maxSessions?: number; force?: boolean; sessionIds?: string[] } = {},
  signal?: AbortSignal,
): Promise<{ jobId: string; pending: boolean }> {
  const env = await request<MetaEnvelope<{ jobId: string; pending: boolean }>>(
    'POST',
    `${PREFIX}/observer/run`,
    opts as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'observer run failed');
}

export async function runReflector(signal?: AbortSignal): Promise<{ jobId: string; pending: boolean }> {
  const env = await request<MetaEnvelope<{ jobId: string; pending: boolean }>>(
    'POST',
    `${PREFIX}/reflector/run`,
    {},
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'reflector run failed');
}

export function fetchCandidates(signal?: AbortSignal): Promise<Candidate[]> {
  return lrGet<Candidate[]>('/candidates', signal);
}

export async function promoteObservation(id: string, signal?: AbortSignal): Promise<unknown> {
  const env = await request<MetaEnvelope<unknown>>(
    'POST',
    `${PREFIX}/observations/${encodeURIComponent(id)}/promote`,
    {},
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'promote failed');
}

export async function decideCandidate(
  id: string,
  decision: 'promote' | 'demote' | 'drop',
  target?: 'USER.md' | 'MEMORY.md' | 'axioms',
  signal?: AbortSignal,
): Promise<unknown> {
  const env = await request<MetaEnvelope<unknown>>(
    'POST',
    `${PREFIX}/candidates/${encodeURIComponent(id)}/decide`,
    { decision, target } as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'decide failed');
}

export function fetchAxioms(signal?: AbortSignal): Promise<Axiom[]> {
  return lrGet<Axiom[]>('/axioms', signal);
}

export async function createAxiom(input: { text: string; sources?: string[] }, signal?: AbortSignal): Promise<Axiom> {
  const env = await request<MetaEnvelope<Axiom>>(
    'POST',
    `${PREFIX}/axioms`,
    input as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'create axiom failed');
}

export function fetchLayeredJobs(id?: string, signal?: AbortSignal): Promise<JobRecord[] | JobRecord | null> {
  const suffix = id ? `?id=${encodeURIComponent(id)}` : '';
  return lrGet<JobRecord[] | JobRecord | null>(`/jobs${suffix}`, signal);
}
