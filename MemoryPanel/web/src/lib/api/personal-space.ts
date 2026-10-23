/**
 * personal-space API client — 会话洞察（Session Insights）观测面。
 *
 * 后端路由：MemoryPanel/src/panel/http/routes/personal-space.ts
 * 统一信封：{ code, message, data }（与 meta/analytics 透明代理一致，可复用 unwrapEnvelope）。
 *
 * 注意：本 client 以「只读观测」接口为主；唯一写入口是 resumeSession（M-D 终端拉起，
 * 纯本地动作）。记忆写入面（M4b）走 gateway proxy，亦在此定义。
 */
import { request, unwrapEnvelope } from './base';
import type { MetaEnvelope } from './types';

const PREFIX = '/api/v1/personal-space';

export interface ModelCostItem {
  model: string;
  costUsd: number;
  estimated: boolean;
}

export interface GitInfo {
  cwd: string;
  /** R3 tri-state: ok=queried / not-repo=legitimately not a git repo / unavailable=environment-limited (git blocked, not installed, timeout) */
  status?: 'ok' | 'not-repo' | 'unavailable';
  branch?: string;
  ahead?: number;
  behind?: number;
}

export interface SessionDigest {
  firstPrompt: number;
  user: number;
  question: number;
  todos: number;
  compaction: number;
  recap: number;
  plan: number;
  subagent: number;
}

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
}

export interface SessionSummary {
  sessionId: string;
  kind: 'top-level' | 'nested';
  parentId: string | null;
  vendor: string;
  state: string;
  startedAt: number | null;
  endedAt: number | null;
  recordCount: number;
  size: number;
  mtime: number;
  firstPrompt: string;
  /** 会话标题（ai-title），空则展示回退 firstPrompt */
  title: string;
  /** 嵌套会话：父会话 Agent 调用任务名（B 方案，对齐 coslash spawn.Task），空则回退 firstPrompt */
  spawnTask: string;
  userTurns: number;
  assistantTurns: number;
  tokens: SessionTokens;
  costUsd: number;
  costEstimated: boolean;
  models: ModelCostItem[];
  git: GitInfo | null;
  edits: { operations: number; addedLines: number; removedLines: number; files: string[] };
  digest: SessionDigest;
}

export interface SessionListStats {
  total: number;
  cached: number;
  rebuilt: number;
  coldMs: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  stats: SessionListStats;
}

export interface TimelineItem {
  type: string;
  role: string | null;
  ts: number;
  name: string | null;
  len: number;
}

/** S6 · TIMELINE 条目分类（对齐 coslash 八类，英文短标签不进 i18n） */
export type DigestCategory =
  | 'first_prompt'
  | 'user'
  | 'question'
  | 'todos'
  | 'compaction'
  | 'recap'
  | 'plan'
  | 'subagent';

/** S6 · TIMELINE 单条事件（对齐 coslash DigestEntry） */
export interface DigestEntry {
  turn: number;
  category: DigestCategory;
  description: string;
  answer?: string;
  subagentId?: string;
  time?: number;
}

/** M-B：会话级结构化衍生（后端 facts 引擎派生，Inspector 六块消费） */
export interface Debrief {
  goal: string;
  /** 目标来源：declared=会话内显式声明 / inferred=AI 合成推断 / floor=首问兜底 */
  goalSource?: 'declared' | 'inferred' | 'floor';
  outcome: string;
  keyDecisions: string[];
}
export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  edits: number;
  isNew: boolean;
}
export interface CommitInfo {
  hash: string;
  message: string;
  ts: number;
}
export interface TodoItem {
  subject: string;
  status: string;
  completed: boolean;
}
export interface CommandUse {
  name: string;
  count: number;
}

export interface SessionFactsResponse {
  facts: SessionSummary;
  timeline: TimelineItem[];
  recordCount: number;
  /** S6 · TIMELINE 事件流（对齐 coslash DigestEntry）：逐条分类 + 描述 + 答案 + turn + 时间 */
  digest?: DigestEntry[] | null;
  /** M-B：会话级衍生字段（响应级兄弟字段，与 facts 平级） */
  debrief?: Debrief | null;
  filesChanged?: FileChange[] | null;
  commits?: CommitInfo[] | null;
  todos?: TodoItem[] | null;
  commands?: CommandUse[] | null;
  /** 陈旧信号：当前恒为 true（facts 随 mtime+size 缓存即时重算）；fresh=false 触发陈旧 banner */
  fresh?: boolean;
}

/** v7 · 续会话就绪度（debrief-handoff-completion） */
export type ReadinessTone = 'ok' | 'warn' | 'danger' | null;
export interface ReadinessCell {
  value: string;
  tone: ReadinessTone;
}
export interface CacheReadiness {
  warm: boolean;
  within5m: boolean;
  within1h: boolean;
  at: number | null;
  tone: ReadinessTone;
}
export interface Readiness {
  context: ReadinessCell;
  compactions: ReadinessCell;
  branch: ReadinessCell;
  workspace: ReadinessCell;
  cache: CacheReadiness;
}
export type ReadinessVerdict = 'resume' | 'inspect' | 'fresh';

export interface HandoffResponse {
  sessionId: string;
  verdict: ReadinessVerdict;
  contextTokens: number | null;
  contextWindow: number | null;
  lastEditAt: number | null;
  baseBranch: string | null;
  readiness: Readiness;
}

export interface SynthesisPayload {
  goals: string[];
  outcome: string;
  keyDecisions: string[];
  nextStep: string;
}
export interface SynthesisResponse {
  synthesis: SynthesisPayload | null;
  enabled: boolean;
  pending?: boolean;
  error?: string | null;
}

async function psGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const env = await request<MetaEnvelope<T>>('GET', `${PREFIX}${path}`, undefined, undefined, signal);
  return unwrapEnvelope(env, 'empty personal-space response');
}

export function fetchSessions(signal?: AbortSignal): Promise<SessionListResponse> {
  return psGet<SessionListResponse>('/sessions', signal);
}

/** vendor 可选：多 vendor（workbuddy / codex…）下 sessionId 可能重名，带上可精确命中。 */
export function fetchSessionFacts(id: string, signal?: AbortSignal, vendor?: string): Promise<SessionFactsResponse> {
  const q = `/facts?id=${encodeURIComponent(id)}${vendor ? `&vendor=${encodeURIComponent(vendor)}` : ''}`;
  return psGet<SessionFactsResponse>(q, signal);
}

/** M4b · 取会话真实消息（「从对话洞察导入对话」源数据）
 * 后端已归一化为 skill/extract 可直接消费的 messages（role + content + 可选 tool_*）。 */
export interface SessionRecordMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: string;
  tool_name?: string;
  tool_call_id?: string;
}

export interface SessionRecordsResponse {
  sessionId: string;
  title: string;
  messageCount: number;
  messages: SessionRecordMessage[];
}

export function fetchSessionRecords(id: string, signal?: AbortSignal, vendor?: string): Promise<SessionRecordsResponse> {
  const q = `/records?id=${encodeURIComponent(id)}${vendor ? `&vendor=${encodeURIComponent(vendor)}` : ''}`;
  return psGet<SessionRecordsResponse>(q, signal);
}

export function fetchHandoff(id: string, signal?: AbortSignal): Promise<HandoffResponse> {
  return psGet<HandoffResponse>(`/handoff?id=${encodeURIComponent(id)}`, signal);
}

export function fetchSynthesis(id: string, signal?: AbortSignal): Promise<SynthesisResponse> {
  return psGet<SynthesisResponse>(`/synthesis?id=${encodeURIComponent(id)}`, signal);
}

// ============================
// M-D · Resume：拉起终端新会话（Start fresh with handoff / Start fresh）
// ============================

export type ResumeMode = 'handoff' | 'fresh';

export interface ResumeResponse {
  ok: boolean;
  mode: ResumeMode;
  /** 终端将 cd 到的工作目录（原会话 git.cwd） */
  cwd: string;
  /** 实际启动的 CLI 名（TDAI_RESUME_BACKEND > TDAI_SYNTHESIS_BACKEND > codebuddy） */
  backend: string;
  /** handoff 模式下交接文本的落盘路径（经 stdin 注入 CLI） */
  handoffFile: string | null;
}

/**
 * 在原会话工作目录拉起新终端会话。
 * - mode='handoff'：handoffText（前端 buildHandoff 产物）落盘后经 stdin 注入 CLI 首条提示；
 * - mode='fresh'：不携带任何上下文。
 */
export async function resumeSession(
  sessionId: string,
  mode: ResumeMode,
  handoffText?: string,
  signal?: AbortSignal,
): Promise<ResumeResponse> {
  const env = await request<MetaEnvelope<ResumeResponse>>(
    'POST',
    `${PREFIX}/resume`,
    { sessionId, mode, handoffText } as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'empty resume response');
}

// ============================
// M4b · 个人记忆（"我的记忆"）写入 / 状态 / 浏览
// ============================

export type SourceSessionStatus = 'never' | 'running' | 'done' | 'failed' | 'partial';

export interface SourceSessionRecord {
  source_key: string;
  vendor: string;
  session_id: string;
  file_path?: string;
  file_mtime?: number;
  file_size?: number;
  status: SourceSessionStatus;
  /** 已沉淀（已摄入）的源消息条数 —— 增量游标 */
  cursor_record_index: number;
  cursor_ts?: number;
  l0_count: number;
  l1_count: number;
  l2_count: number;
  l3_count: number;
  last_job_id?: string;
  last_error?: string;
  last_cost_usd?: number;
  last_duration_ms?: number;
  /** 源文件已删除 —— 记忆保留，血缘置灰 */
  source_missing?: boolean;
}

export interface SourceSessionListResponse {
  sessions: SourceSessionRecord[];
}

export interface ExtractRequest {
  vendor?: string;
  sessionId: string;
  /** 提炼层级；默认 ['L0','L1']。L2/L3 本期未接入管线，仅占位。 */
  layers?: string[];
  promptMode?: string;
  includeChildren?: boolean;
  /** 全量重炼：忽略增量游标，从头再提炼（将废弃旧产物）。 */
  forceFull?: boolean;
}

export interface ExtractResponse {
  sourceKey: string;
  vendor: string;
  sessionId: string;
  messageCount: number;
  startIndex: number;
  ingestedCount: number;
  l0Count: number;
  l1Count: number;
  l1Rounds: number;
  /** 对话记忆完整分层提炼：L2 场景块 / L3 画像计数（仅 layers 含 L2/L3 时 > 0）。 */
  l2Count?: number;
  l3Count?: number;
  durationMs: number;
  skipped?: boolean;
}

/**
 * 个人记忆（L1）一条 —— 线格式为 **camelCase `MemoryRecord`**。
 *
 * 注意：gateway `handlePersonalMemories` 走的是 `queryMemoryRecords()`
 * （`l1-reader.ts`），它会把 SQLite 的 `L1RecordRow`（snake_case）经
 * `rowToMemoryRecord()` 映射成 `MemoryRecord`（camelCase）再返回。
 * 因此这里必须用 camelCase 字段名（`id`/`sessionId`/`createdAt`），
 * 否则前端会全部读到 `undefined`（分组退化成一个 'unknown' 组）。
 */
export interface PersonalMemory {
  id: string;
  content: string;
  type: string;
  priority?: number;
  scene_name?: string;
  source_message_ids?: string[];
  metadata?: Record<string, unknown>;
  timestamps?: string[];
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  sessionKey?: string;
  sessionId?: string;
  taskId?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
}

export interface PersonalMemoryResponse {
  memories: PersonalMemory[];
}

/** M4b · 增量探测：距上次提炼还差多少条「新消息」（精确「可增量 M 条」来源，不依赖 LLM）。 */
export interface PersonalPendingResponse {
  sourceKey: string;
  vendor: string;
  sessionId: string;
  messageCount: number;
  startIndex: number;
  pending: number;
  status: SourceSessionStatus;
}

export function fetchPersonalSourceSessions(signal?: AbortSignal): Promise<SourceSessionListResponse> {
  return psGet<SourceSessionListResponse>('/source-sessions', signal);
}

export function fetchPersonalMemories(signal?: AbortSignal): Promise<PersonalMemoryResponse> {
  return psGet<PersonalMemoryResponse>('/memories', signal);
}

/** L2 场景块（对话记忆 SceneExtractor 产物，dataDir/profiles/<scope>/scene_blocks/*.md）。 */
export interface PersonalScene {
  id: string;
  filename: string;
  content: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PersonalSceneResponse {
  scenes: PersonalScene[];
}

/** L3 长期画像（对话记忆 PersonaGenerator 产物，dataDir/profiles/<scope>/persona.md）。 */
export interface PersonalPersonaResponse {
  persona: string | null;
  filename: string | null;
  updatedAtMs: number;
}

export function fetchPersonalScenes(vendor?: string, signal?: AbortSignal): Promise<PersonalSceneResponse> {
  const q = vendor ? `?vendor=${encodeURIComponent(vendor)}` : '';
  return psGet<PersonalSceneResponse>(`/scenes${q}`, signal);
}

export function fetchPersonalPersona(vendor?: string, signal?: AbortSignal): Promise<PersonalPersonaResponse> {
  const q = vendor ? `?vendor=${encodeURIComponent(vendor)}` : '';
  return psGet<PersonalPersonaResponse>(`/persona${q}`, signal);
}

export function fetchPersonalPending(vendor: string, sessionId: string, signal?: AbortSignal): Promise<PersonalPendingResponse> {
  return psGet<PersonalPendingResponse>(
    `/pending?vendor=${encodeURIComponent(vendor)}&sessionId=${encodeURIComponent(sessionId)}`,
    signal,
  );
}

export async function triggerPersonalExtract(req: ExtractRequest, signal?: AbortSignal): Promise<ExtractResponse> {
  const env = await request<MetaEnvelope<ExtractResponse>>(
    'POST',
    `${PREFIX}/extract`,
    req as unknown as Record<string, unknown>,
    undefined,
    signal,
  );
  return unwrapEnvelope(env, 'extract failed');
}
