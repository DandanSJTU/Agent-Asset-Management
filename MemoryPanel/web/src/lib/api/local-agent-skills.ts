/**
 * local-agent-skills.ts — 前端访问「本地 Agent 技能」扫描接口。
 *
 * 后端只读扫描本机各 AI Agent 客户端（workbuddy / hermes / claude-code / codebuddy /
 * codex / openclaw / dsh）的本地 skill 目录，解析 SKILL.md frontmatter，返回
 * 技能名 / 使用的 agent（可能多个，按真实物理路径去重后聚合）/ 描述 / 触发词 /
 * 最新修改时间 / 本地路径。
 *
 * 与 panelSession 一致：注入 X-Tdai-Service-Id + X-Tdai-User-Key；解包统一信封
 * （code !== 0 抛 ApiError），复用 base.ts 的 request / unwrapEnvelope。
 */
import { request, unwrapEnvelope, type ApiError } from './base';
import type { MetaEnvelope } from './types';
import { getPanelSession } from '../panelSession';

export interface LocalAgentSkill {
  name: string;
  /** 使用的 agent 列表（workbuddy / hermes / claude-code / codebuddy / codex / openclaw / dsh），
   *  同一份物理 skill 被多个 agent 共享时（如软链）会列出多个，按 AGENTS 顺序排序 */
  agents: string[];
  description: string;
  triggers: string[];
  /** skill 目录绝对路径 */
  path: string;
  /** SKILL.md 绝对路径 */
  skillMdPath: string;
  /** 最新修改时间（毫秒） */
  updatedAtMs: number;
  /** 目录总大小（字节） */
  sizeBytes: number;
}

export interface AgentSkillRoot {
  path: string;
  exists: boolean;
  count: number;
}

export interface AgentSkillRootGroup {
  agent: string;
  roots: AgentSkillRoot[];
}

export interface LocalAgentSkillsResult {
  scannedAtMs: number;
  agents: AgentSkillRootGroup[];
  skills: LocalAgentSkill[];
  totalCount: number;
}

/** 拉取本机所有 agent 的本地 skill 清单。 */
export async function listLocalAgentSkills(signal?: AbortSignal): Promise<LocalAgentSkillsResult> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  }
  const envelope = await request<MetaEnvelope<LocalAgentSkillsResult>>(
    'GET',
    '/api/v1/local-agent-skills',
    undefined,
    headers,
    signal,
  );
  return unwrapEnvelope(envelope, 'empty local-agent-skills response');
}

export type { ApiError };

// ========================= 读取单个本地 skill 内容（「从本地导入」落库用） =========================

export interface LocalAgentSkillResource {
  /** 相对 skill 目录的资源路径（如 scripts/run.sh、references/x.md） */
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type: string;
  is_executable: boolean;
}

export interface LocalAgentSkillContent {
  /** SKILL.md 全文 */
  content: string;
  resources: LocalAgentSkillResource[];
}

/** 读取本机某个本地 skill 物理目录的完整内容（SKILL.md + 资源文件），用于「从本地导入」落库。 */
export async function getLocalAgentSkillContent(
  path: string,
  signal?: AbortSignal,
): Promise<LocalAgentSkillContent> {
  const session = getPanelSession();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) {
    headers['X-Tdai-Service-Id'] = session.instanceId;
    if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  }
  const qs = '?path=' + encodeURIComponent(path);
  const envelope = await request<MetaEnvelope<LocalAgentSkillContent>>(
    'GET',
    `/api/v1/local-agent-skills/content${qs}`,
    undefined,
    headers,
    signal,
  );
  return unwrapEnvelope(envelope, 'empty local-agent-skills content');
}
