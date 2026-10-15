/**
 * skill-api.ts — Skill 数据面 API 客户端。
 *
 * 对接文档：见团队内部知识库 Skill API 章节
 * 14 个 POST 接口，前端走 Panel 后端代理 `/api/v1/skill/`，由 Panel 再转发到记忆 Gateway `/v3/skill/`。
 * 鉴权 Header：`X-Tdai-Service-Id` + `X-Tdai-User-Key`（与 meta API 一致）。
 *
 * 统一信封 `{ code, message, request_id, data }`，code === 0 为成功。
 */

import { getPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import i18n from '@/i18n';

// ========================= Envelope =========================

export interface SkillEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export class SkillApiError extends Error {
  code: number;
  requestId: string;
  rawMessage: string;

  constructor(code: number, message: string, requestId: string) {
    super(formatApiErrorMessage({ code, message, requestId }));
    this.name = 'SkillApiError';
    this.code = code;
    this.requestId = requestId;
    this.rawMessage = message;
  }
}

// ========================= Types =========================

/** 列表/搜索结果的基础形态 */
export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

/** get 接口返回，包含完整内容 */
export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

/** 资源文件入参 */
export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

/** 搜索命中结果 */
export interface SkillSearchHit extends SkillSummary {
  score: number;
  snippet: string;
}

// ========================= Base Request =========================

const SKILL_PREFIX = '/api/v1/skill';

/** 去除 body 中值为空字符串或 undefined 的字段（v3 校验要求字符串字段要么不传，要么非空） */
function stripEmpty(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === '' || v === undefined) continue;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function skillCall<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${SKILL_PREFIX}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripEmpty(body)),
    signal,
  });
  if (res.status === 401) {
    throw new SkillApiError(401, i18n.t('skillApi.error.unauthorized'), '');
  }
  const text = await res.text();
  let envelope: SkillEnvelope<T>;
  try {
    envelope = JSON.parse(text) as SkillEnvelope<T>;
  } catch {
    throw new SkillApiError(res.status || 500, text || res.statusText || 'Skill request failed', '');
  }
  if (!res.ok || envelope.code !== 0) {
    throw new SkillApiError(envelope.code ?? res.status, envelope.message || res.statusText, envelope.request_id);
  }
  return envelope.data;
}

// ========================= API Functions =========================

// ---- 3.1 create ----

export function createSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  name: string;
  content: string;
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}): Promise<SkillSummary> {
  return skillCall('create', params as unknown as Record<string, unknown>);
}

// ---- 3.2 update ----

export function updateSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  content: string;
}): Promise<SkillSummary> {
  return skillCall('update', params as unknown as Record<string, unknown>);
}

// ---- 3.3 patch ----

export function patchSkill(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}): Promise<SkillSummary> {
  return skillCall('patch', params as unknown as Record<string, unknown>);
}

// ---- 3.4 delete ----

export function deleteSkillV3(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
}): Promise<{ skill_id: string; archived: boolean }> {
  return skillCall('delete', params as unknown as Record<string, unknown>);
}

// ---- 3.5 get ----

export interface GetSkillParams {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  include_content?: boolean;
  include_manifest?: boolean;
}

export function getSkill(params: GetSkillParams): Promise<SkillDetail> {
  return skillCall('get', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    include_content: params.include_content ?? true,
    include_manifest: params.include_manifest ?? true,
  });
}

// ---- 3.6 list ----

export interface ListSkillFilters {
  owner_agent_id?: string;
  name_prefix?: string;
  status?: string[];
}

export interface ListSkillParams {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  filters?: ListSkillFilters;
  pagination?: { limit?: number; offset?: number };
}

export interface ListSkillResult {
  items: SkillSummary[];
  total: number;
}

export function listSkills(params: ListSkillParams): Promise<ListSkillResult> {
  return skillCall('list', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    agent_id: params.agent_id ?? '',
    filters: params.filters ?? {},
    pagination: params.pagination ?? { limit: 100, offset: 0 },
  });
}

// ---- 3.7 search ----

export interface SearchSkillParams {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  query: string;
  top_k?: number;
  mode?: 'bm25' | 'embedding' | 'hybrid';
  scope?: 'team';
}

export interface SearchSkillResult {
  items: SkillSearchHit[];
}

export function searchSkills(params: SearchSkillParams): Promise<SearchSkillResult> {
  return skillCall('search', params as unknown as Record<string, unknown>);
}

// ---- 3.8 versions ----

export interface VersionsResult {
  items: SkillSummary[];
  total: number;
}

export function listSkillVersions(params: {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  pagination?: { limit?: number; offset?: number };
}): Promise<VersionsResult> {
  return skillCall('versions', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    pagination: params.pagination ?? { limit: 100, offset: 0 },
  });
}

// ---- 3.9 files/write ----

export function writeSkillFiles(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  files: SkillResourcePayload[];
}): Promise<SkillSummary> {
  return skillCall('files/write', params as unknown as Record<string, unknown>);
}

// ---- 3.10 files/remove ----

export function removeSkillFiles(params: {
  user_id: string;
  team_id: string;
  agent_id: string;
  skill_id: string;
  expected_version: number;
  paths: string[];
}): Promise<SkillSummary> {
  return skillCall('files/remove', params as unknown as Record<string, unknown>);
}

// ---- 3.11 files/read ----

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

export function readSkillFile(params: {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  path: string;
  encoding?: 'utf-8' | 'base64';
}): Promise<ReadFileResult> {
  return skillCall('files/read', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    path: params.path,
    encoding: params.encoding,
  });
}

// ---- 3.12 listing ----

export interface ListingResult {
  mode: 'full' | 'search';
  listing: string;
  hits: Array<{ skill_id: string; version: number; name: string }>;
}

export function getSkillListing(params: {
  user_id?: string;
  team_id?: string;
  agent_id: string;
  query?: string;
  char_budget?: number;
}): Promise<ListingResult> {
  return skillCall('listing', params as unknown as Record<string, unknown>);
}

// ---- 3.13 extract ----

/**
 * `/v3/skill/extract` 入参（space_id 已转 optional）：
 *   - user_id / team_id / agent_id：必填
 *   - space_id：**前端不传**。跟其他 12 个 skill 接口一致, 从 `X-Tdai-Service-Id`
 *     header (= panelSession.instanceId) 走; 后端 handler 用 `auth.serviceId` 兜底。
 *   - session_id：可选，缺省时后端生成 `sx-<8hex>`
 *   - task_id：可选，透传为 SkillTaskEntry.task_ref_id（业务 ref，与归档 task_id 不同）
 *   - reason / options.max_iterations：透传给主 agent extractor prompt
 *   - role 新增 `system`（对齐 conversation/add 的 5 种 role）
 */
export interface ExtractParams {
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
  session_id?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
    content: string;
    tool_name?: string;
    tool_call_id?: string;
  }>;
  reason?: string;
  options?: { max_iterations?: number };
}

/**
 * `/v3/skill/extract` 返回体：
 *   - 后端恒走 archive → agent 队列 → worker 异步链路，永远返回 task_id；
 *     老版本的 `{mode:'sync', candidates}` 已被移除。
 *   - task_id 是**归档 task_id**（`task-<uuid8>`），跟入参 task_id (业务 task_ref_id) 是两个字段。
 *   - archive_key 是 COS 归档路径（含 `/skill_buffer/{user}/{team}/{agent}/{session}/`）。
 */
export interface ExtractResult {
  ok: true;
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
}

export function extractSkills(params: ExtractParams): Promise<ExtractResult> {
  return skillCall('extract', params as unknown as Record<string, unknown>);
}

// ---- 3.14 export ----

export interface ExportSkillParams {
  user_id?: string;
  team_id?: string;
  skill_id: string;
  version?: number;
  format?: 'zip';
}

export interface ExportSkillResult {
  zip_base64: string;
  filename: string;
  name: string;
  version: number;
  file_count: number;
  total_bytes: number;
  warnings: string[];
}

const EXPORT_TIMEOUT_MS = 30_000;

export function exportSkill(params: ExportSkillParams, signal?: AbortSignal): Promise<ExportSkillResult> {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(EXPORT_TIMEOUT_MS) : undefined;
  // 合并外部 signal 与内部超时
  const effectiveSignal = signal && timeout
    ? AbortSignal.any?.([signal, timeout]) ?? timeout
    : (signal ?? timeout);

  return skillCall('export', {
    user_id: params.user_id ?? '',
    team_id: params.team_id ?? '',
    skill_id: params.skill_id,
    version: params.version,
    format: params.format,
  }, effectiveSignal);
}

// ========================= Personal Skill Library API =========================
//
// 「我的技能」独立个人技能库：数据面在 MemoryCore 走 `team_id='personal'` +
// `agent_id='personal-<userId>'` 保留命名空间（见 MemoryCore skill-handlers.ts）。
// 前端经 Panel 后端代理 `/api/v1/personal-skills/*`，**身份由 Panel 服务端权威注入**
// （user_id / team_id / agent_id），前端只需传业务参数，不传身份三元组。
//
// 与团队 skill API 的差异：
//   - prefix 不同（/api/v1/personal-skills vs /api/v1/skill）
//   - 不暴露 extract / conversation-add（个人库复用团队提炼车道无意义）
//   - 列表由 Panel 强制 filters.owner_agent_id = 本人虚拟 agent（天然隔离）

const PERSONAL_SKILL_PREFIX = '/api/v1/personal-skills';

async function personalSkillCall<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const session = getPanelSession();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    headers['X-Tdai-User-Key'] = session.userKey;
  }
  const res = await fetch(`${PERSONAL_SKILL_PREFIX}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(stripEmpty(body)),
    signal,
  });
  if (res.status === 401) {
    throw new SkillApiError(401, i18n.t('skillApi.error.unauthorized'), '');
  }
  const text = await res.text();
  let envelope: SkillEnvelope<T>;
  try {
    envelope = JSON.parse(text) as SkillEnvelope<T>;
  } catch {
    throw new SkillApiError(res.status || 500, text || res.statusText || 'Personal skill request failed', '');
  }
  if (!res.ok || envelope.code !== 0) {
    throw new SkillApiError(envelope.code ?? res.status, envelope.message || res.statusText, envelope.request_id);
  }
  return envelope.data;
}

/**
 * SkillDetailPane 使用的 6 个数据面函数集合。
 * 团队页用 `teamSkillApi`，个人页用 `personalSkillApi`（路由到 /api/v1/personal-skills）。
 * 通过把这套 API 抽成可注入对象，SkillDetailPane 的 UI 逻辑（编辑/文件/版本）一套复用。
 */
export interface SkillDetailApi {
  getSkill: typeof getSkill;
  readSkillFile: typeof readSkillFile;
  updateSkill: typeof updateSkill;
  writeSkillFiles: typeof writeSkillFiles;
  removeSkillFiles: typeof removeSkillFiles;
  listSkillVersions: typeof listSkillVersions;
}

export const teamSkillApi: SkillDetailApi = {
  getSkill,
  readSkillFile,
  updateSkill,
  writeSkillFiles,
  removeSkillFiles,
  listSkillVersions,
};

export const personalSkillApi: SkillDetailApi = {
  getSkill: (params): Promise<SkillDetail> =>
    personalSkillCall<SkillDetail>('get', {
      skill_id: params.skill_id,
      version: params.version,
      include_content: params.include_content ?? true,
      include_manifest: params.include_manifest ?? true,
    }),
  readSkillFile: (params): Promise<ReadFileResult> =>
    personalSkillCall<ReadFileResult>('files/read', {
      skill_id: params.skill_id,
      version: params.version,
      path: params.path,
      encoding: params.encoding,
    }),
  updateSkill: (params): Promise<SkillSummary> =>
    personalSkillCall<SkillSummary>('update', {
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      content: params.content,
    }),
  writeSkillFiles: (params): Promise<SkillSummary> =>
    personalSkillCall<SkillSummary>('files/write', {
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      files: params.files,
    }),
  removeSkillFiles: (params): Promise<SkillSummary> =>
    personalSkillCall<SkillSummary>('files/remove', {
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      paths: params.paths,
    }),
  listSkillVersions: (params): Promise<VersionsResult> =>
    personalSkillCall<VersionsResult>('versions', {
      skill_id: params.skill_id,
    }),
};

// ---- 个人库：list ----
export interface PersonalListSkillParams {
  filters?: ListSkillFilters;
  pagination?: { limit?: number; offset?: number };
}

export function personalListSkills(params: PersonalListSkillParams = {}): Promise<ListSkillResult> {
  return personalSkillCall<ListSkillResult>('list', {
    filters: params.filters ?? {},
    pagination: params.pagination ?? { limit: 100, offset: 0 },
  });
}

// ---- 个人库：create（目录导入落库）----
export function personalCreateSkill(params: {
  name: string;
  content: string;
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}): Promise<SkillSummary> {
  return personalSkillCall<SkillSummary>('create', {
    name: params.name,
    content: params.content,
    resources: params.resources,
    metadata: params.metadata,
  });
}

// ---- 个人库：delete ----
export function personalDeleteSkill(skill_id: string): Promise<{ skill_id: string; archived: boolean }> {
  return personalSkillCall('delete', { skill_id });
}

// ---- 个人库：export ----
export function personalExportSkill(skill_id: string, signal?: AbortSignal): Promise<ExportSkillResult> {
  return personalSkillCall<ExportSkillResult>('export', { skill_id, format: 'zip' }, signal);
}

// ---- 个人库：extract（「我的技能」从对话洞察导入对话）----
/**
 * 个人技能库「从对话洞察导入对话」：POST /api/v1/personal-skills/extract。
 *
 * 与团队 `extractSkills` 同构，但**身份由 Panel 服务端权威注入**
 * （user_id / team_id='personal' / agent_id='personal-<userId>'），前端只传业务参数
 * （messages + 可选 reason/options）。后端 `extract` 走与团队同一套归档→worker→
 * SkillCore.create 链路，生成的技能落个人命名空间、自动进入「我的技能」列表。
 *
 * 依赖 skill 提炼管线已就绪（resolveConversationAdd + LLM）。未就绪时网关返回
 * 50301 'skill extract not wired'，前端按普通错误展示。
 */
export function personalExtractSkills(params: {
  messages: ExtractParams['messages'];
  reason?: string;
  options?: { max_iterations?: number };
}): Promise<ExtractResult> {
  return personalSkillCall<ExtractResult>('extract', {
    messages: params.messages as unknown as Record<string, unknown>[],
    reason: params.reason,
    options: params.options,
  });
}

// ---- 3.15 extract/result (deprecated) ----
//
// `/v3/skill/extract/result` 已下线。SkillCoreSink 会在 worker
// drain 后直接把 skill 写入表，提取结果通过 `/v3/skill/list` 拿到（不再有独立
// 的 result 查询接口）。前端拿到 extract 的 task_id 即视为"任务已受理"。
