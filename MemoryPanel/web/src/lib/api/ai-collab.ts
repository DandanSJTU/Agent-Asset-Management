/**
 * ai-collab API client — 「AI 协作」记忆资产对比演示。
 *
 * 后端路由：MemoryPanel/src/panel/http/routes/ai-collab.ts
 * 统一信封：{ code, message, request_id, data }（复用 meta/envelope 体系）。
 *
 * demo 版：后端直接返回脚本化内容（基线 / 增强回答 + 记忆·Skill·Wiki 检索明细），
 * 不依赖实时大模型；前端按 useMemory / useSkill / useWiki 控制增强栏注入的资产类型。
 */
import { request, unwrapEnvelope } from './base';
import type { MetaEnvelope } from './types';

const PREFIX = '/api/v1/ai-collab';

export interface AiCollabAnswer {
  answer: string;
  ms: number;
  tokens: number;
}

export interface AiCollabMemoryItem {
  id: string;
  content: string;
  type: string;
}

export interface AiCollabSkillItem {
  name: string;
  description: string;
}

export interface AiCollabWikiItem {
  title: string;
  snippet: string;
  score: number;
}

export interface AiCollabRetrieval {
  memories: AiCollabMemoryItem[];
  skills: AiCollabSkillItem[];
  wiki: AiCollabWikiItem[];
}

export interface AiCollabResult {
  question: string;
  baseline: AiCollabAnswer;
  enhanced: AiCollabAnswer;
  retrieval: AiCollabRetrieval;
  /** demo=true 表示内容为脚本化示例，非实时大模型生成 */
  demo: boolean;
}

export interface AiCollabAskReq {
  question?: string;
  useMemory?: boolean;
  useSkill?: boolean;
  useWiki?: boolean;
}

export async function postAiCollabAsk(req: AiCollabAskReq = {}): Promise<AiCollabResult> {
  const envelope = await request<MetaEnvelope<AiCollabResult>>(
    'POST',
    `${PREFIX}/ask`,
    req
  );
  return unwrapEnvelope(envelope, 'empty ai-collab response');
}
