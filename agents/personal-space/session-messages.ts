/**
 * 消息源适配器（M4b · 洞察侧入口）
 *
 * 把「会话洞察」侧的源会话原始记录转换为「我的记忆」提炼管线的输入
 * —— `ConversationMessage[]`（结构对齐 MemoryCore/src/core/conversation/l0-recorder.ts）。
 *
 * 设计要点（对齐 personal-memory-impl-plan.html / my-memory-tab-design.html）：
 *   1. 单一 IO 入口仍是 readRawRecords（经 session-facts.scanOne），不新增扫盘通路；
 *      复用 agents/personal-space 已验证的会话发现/读取引擎，保证事实单一来源。
 *   2. 只抽取 user / assistant 的「对话轮次」（role），与 l0-recorder 捕获口径一致；
 *      工具调用 / ai-title / system 等事件不进入记忆提炼输入，避免噪声污染个人画像。
 *   3. 兼容 content 为 string 或 [{type,text}] 多模态片段，并过滤无文本片段；
 *      时间戳兼容 epoch ms 与 epoch s（<1e12 视为秒）。
 *   4. 纯函数、零副作用：给定 (vendor, sessionId) 确定性返回，便于 UI 估算可提炼消息数。
 */

import { scanOne } from './session-facts.ts';
// 复用会话洞察侧已验证的 harness 包裹剥离（<system-reminder> / <user_info> 等注入内容），
// 与 session-facts.ts 同一条路径，确保"我的记忆"提炼输入不被 harness 噪声污染。
import { stripHarnessWrappers } from '../../MemoryProxy/src/common/session-harness.ts';

/** 提炼管线输入：结构对齐 ConversationMessage（id/role/content/timestamp）。 */
export interface SourceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** epoch ms */
  timestamp: number;
}

/** 把多形态 content 规整为纯文本（多模态片段仅取 text）。 */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .filter((s) => s.trim().length > 0)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

/** 规整时间戳：数字 <1e12 视为秒 → ms；字符串走 Date.parse；缺省回退当前时间。 */
function normalizeTimestamp(...candidates: unknown[]): number {
  for (const v of candidates) {
    if (v == null) continue;
    if (typeof v === 'number') {
      if (v > 0 && v < 1e12) return Math.round(v * 1000);
      if (v >= 1e12) return Math.round(v);
    }
    if (typeof v === 'string') {
      const d = Date.parse(v);
      if (!Number.isNaN(d)) return d;
    }
  }
  return Date.now();
}

/**
 * 读取一个源会话、转换为提炼输入消息（按时间升序）。
 *
 * @param vendor  会话 vendor（本期仅 'workbuddy' 有样本）
 * @param sessionId  源会话稳定 ID（即 agents/personal-space 的 sessionId，路径去扩展名）
 * @returns 空数组表示会话不存在或无有效对话轮次（调用方据此判断"无新增"）
 */
export function readSessionMessages(vendor: string, sessionId: string): SourceMessage[] {
  const sc = scanOne(vendor, sessionId);
  if (!sc) return [];
  const records = (sc.raw?.records ?? []) as Record<string, unknown>[];
  const out: SourceMessage[] = [];
  let idx = 0;
  for (const rec of records) {
    const role = rec.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = stripHarnessWrappers(normalizeContent(rec.content));
    if (!content.trim()) continue;
    const ts = normalizeTimestamp(rec.timestamp, rec.ts);
    out.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : `${sessionId}:${idx}`,
      role,
      content,
      timestamp: ts,
    });
    idx++;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 仅估算可提炼消息数（不构造完整对象），供 UI 在触发前展示"可增量 M 条"。
 */
export function countSessionMessages(vendor: string, sessionId: string): number {
  return readSessionMessages(vendor, sessionId).length;
}
