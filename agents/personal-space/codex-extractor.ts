/**
 * ChatGPT Work / Codex 会话抽取器（会话洞察 · vendor=codex）
 *
 * 与 coslash collector/internal/vendors/codex 同构：Codex 把本地会话落盘在
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 * 归档在 ~/.codex/archived_sessions，每行是一个信封：
 *   { "timestamp":"ISO","ordinal":n,"type":<...,"payload":{...} }
 * type ∈ session_meta | turn_context | event_msg | response_item | compacted | world_state
 *
 * 用户 / 助手对话轮次统一从 response_item.payload 取（payload.type==="message"，
 * payload.role ∈ {user,assistant}，content 为 [{type:"input_text"|"output_text",text}]）。
 * 这一点与 asset-import.ts 的 parseJsonlLines 对 codex 的处理完全一致（已在工作的
 * codex 导入适配器验证），故归一逻辑对齐它，避免重复踩坑。
 *
 * session_meta 提供 session_id（稳定会话 ID）/ parentThreadID（跨文件父子线程）/ cwd。
 *
 * 除对话正文外，本文件还把「派生事实所需的经济/元信息」归一成 facts.ts 认识的形态
 * （否则成本 / token / 上下文占用 / 工作目录全为空——这些字段在 codex 里与正文不同层）：
 *   - session_meta / turn_context → `{type:'codex_meta', cwd, model}`：cwd 供 extractCwd 命中，
 *     model 供 findModel 命中（turn_context.model，如 deepseek-v4-pro）；
 *   - token_usage_record          → `{type:'codex_usage', usage, model}`：逐轮 usage，供成本累加；
 *   - event_msg/token_count       → `{type:'codex_context', contextTokens, contextWindow}`：
 *     last_token_usage.input_tokens 是「上下文占用」，info.model_context_window 是「分母」——
 *     codex 自带窗口值，不必走 facts.ts 的本地窗口表；
 *   - response_item/function_call（仅文件改写类）→ `{type:'function_call', name, arguments}`：
 *     让 extractEdit 复用统一口径统计「编辑操作」。
 *
 * 设计约束（对齐 session-facts.ts）：
 *   - 单一 IO 入口仍是 readRawRecords（来自 asset-import），本文件不新增扫盘通路；
 *   - discover() 直接产出完整 ExtractedSession（首问 / 时间范围 / 父子已算好），
 *     因为 scanSessions 对 non-workbuddy vendor 直接采用 discover() 结果、不再 buildSession；
 *   - normalizeCodexRecords 把原始 envelope 归一成 {role,content,timestamp} 形态，
 *     供 readSessionMessages（我的记忆提炼）消费，与 workbuddy 形态同构。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { readRawRecords, expandContent, type RawRecordFile } from '../asset-import.ts';
// 类型仅做类型注解，运行时无依赖（避免与 session-facts 形成循环引用）。
import type { ExtractedSession, SessionExtractor, SessionKind } from './session-facts.ts';
// 复用会话洞察侧已验证的 harness 包裹剥离（<environment_context> 等注入内容）。
import { stripHarnessWrappers, sanitizeFirstPromptForDisplay } from '../../MemoryProxy/src/common/session-harness.ts';

/** 首问字符上限（与 session-facts.FIRST_PROMPT_MAX 一致）。 */
const FIRST_PROMPT_MAX = 80;
/** Codex rollout 文件名特征。 */
const ROLLOUT_RE = /rollout-.*\.jsonl$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 把 codex content（string / block 数组）提取为纯文本，工具片段（tool_use/function_call）不进对话流。 */
function codexContentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  // expandContent: 文本片段返回 {content}，工具片段返回 {role:'tool_call'|'tool_result',...}
  return expandContent(content)
    .filter((f) => f.role === undefined)
    .map((f) => f.content)
    .join('\n')
    .trim();
}

function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const d = Date.parse(v);
    return Number.isNaN(d) ? undefined : d;
  }
  return undefined;
}

const numOr = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** 文件改写类工具名（只有这些 function_call 才进 facts 的「编辑操作」统计）。 */
const EDIT_TOOL_RE = /patch|write|edit|replace|delete_file|create_file/i;

/**
 * 把 codex 的逐轮 usage 归一成 facts.ts `extractTokens` 认识的蛇形字段。
 *
 * 关键语义：OpenAI/Codex 的 `input_tokens` **已包含** `cached_input_tokens`。
 * facts.ts 的成本公式是 `input×单价 + cacheRead×缓存单价`，若原样透传会把命中缓存的
 * 部分按「未命中」价重复计费。故拆成 `input_tokens = 总量 − 缓存命中`，
 * 命中部分单列 `cache_read_input_tokens`——这样总计与成本都自洽。
 */
function codexUsageRecord(
  u: Record<string, unknown>,
  model: string | null,
  timestamp: unknown,
): Record<string, unknown> {
  const inputTotal = numOr(u.input_tokens);
  const cached = numOr(u.cached_input_tokens);
  const usage: Record<string, unknown> = {
    input_tokens: Math.max(0, inputTotal - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: numOr(u.cache_write_input_tokens),
    output_tokens: numOr(u.output_tokens),
    reasoning_output_tokens: numOr(u.reasoning_output_tokens),
    prompt_tokens_total: inputTotal,
  };
  const out: Record<string, unknown> = { type: 'codex_usage', timestamp, usage };
  if (model) out.model = model;
  return out;
}

/**
 * 把 codex 原始 envelope 记录归一成 workbuddy 形态（与 workbuddy 同构）。
 *
 * 产出四类记录：
 *   1. `{role, content, timestamp}` —— 对话轮次（仅 user / assistant；developer 注入丢弃）；
 *   2. `{type:'codex_meta', cwd, model}` —— 工作目录 / 模型（供 extractCwd / findModel）；
 *   3. `{type:'codex_usage', usage, model}` —— 逐轮 token 用量（供成本 / cache 统计）；
 *   4. `{type:'codex_context', contextTokens, contextWindow}` —— 上下文占用与窗口；
 * 另加文件改写类 function_call（供「编辑操作」统计）。
 * 无 role 的记录不会污染对话轮次 / 记忆提炼（下游按 role 过滤）。
 */
export function normalizeCodexRecords(raw: RawRecordFile): RawRecordFile {
  const out: Record<string, unknown>[] = [];
  let model: string | null = null;
  const pushMeta = (rec: Record<string, unknown>, cwd: unknown): void => {
    const o: Record<string, unknown> = { type: 'codex_meta', timestamp: rec.timestamp };
    if (typeof cwd === 'string' && cwd.trim()) o.cwd = cwd.trim();
    if (model) o.model = model;
    if (o.cwd || o.model) out.push(o);
  };

  for (const r of raw.records) {
    const rec = r as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : '';
    const pl = (
      rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : {}
    ) as Record<string, unknown>;

    // ① 会话元信息：稳定 cwd（首条即会话工作目录）
    if (type === 'session_meta') {
      pushMeta(rec, pl.cwd);
      continue;
    }
    // ② 每轮上下文：cwd + 真实模型（codex 的模型名只在这里，不在 usage 里）
    if (type === 'turn_context') {
      if (typeof pl.model === 'string' && pl.model.trim()) model = pl.model.trim();
      pushMeta(rec, pl.cwd);
      continue;
    }
    // ③ 逐轮 token 用量（成本主来源）
    if (type === 'token_usage_record') {
      const u = pl.usage;
      if (u && typeof u === 'object') out.push(codexUsageRecord(u as Record<string, unknown>, model, rec.timestamp));
      continue;
    }
    // ④ event_msg：只取 token_count（上下文占用 + 窗口）；其余（task_* / item_completed）无正文
    if (type === 'event_msg') {
      if (pl.type === 'token_count') {
        const info = (pl.info ?? {}) as Record<string, unknown>;
        const last = (info.last_token_usage ?? {}) as Record<string, unknown>;
        const ctxTokens = numOr(last.input_tokens) || numOr(last.total_tokens);
        const ctxWindow = numOr(info.model_context_window);
        if (ctxTokens || ctxWindow) {
          const o: Record<string, unknown> = { type: 'codex_context', timestamp: rec.timestamp };
          if (ctxTokens) o.contextTokens = ctxTokens;
          if (ctxWindow) o.contextWindow = ctxWindow;
          if (model) o.model = model;
          out.push(o);
        }
      }
      continue;
    }
    // ⑤ 对话正文 / 文件改写工具调用
    if (type === 'response_item') {
      const pt = typeof pl.type === 'string' ? pl.type : '';
      if (pt === 'function_call') {
        const name = typeof pl.name === 'string' ? pl.name : '';
        if (EDIT_TOOL_RE.test(name)) {
          out.push({
            type: 'function_call',
            timestamp: rec.timestamp,
            name,
            arguments: pl.arguments ?? pl.input,
          });
        }
        continue;
      }
      if (pt && pt !== 'message') continue;
      const nested =
        pl.message && typeof pl.message === 'object' ? (pl.message as Record<string, unknown>) : undefined;
      const role =
        typeof pl.role === 'string' ? pl.role : typeof nested?.role === 'string' ? nested!.role : pt === 'user' || pt === 'assistant' ? pt : '';
      if (role !== 'user' && role !== 'assistant') continue;
      const content = codexContentToText(pl.content ?? nested?.content);
      if (!content) continue;
      const recOut: Record<string, unknown> = { role, content, timestamp: rec.timestamp };
      if (typeof pl.id === 'string') recOut.id = pl.id;
      out.push(recOut);
      continue;
    }
    // ⑥ world_state：仅当 turn_context 缺失时兜底取模型名（payload 很大，绝不整块透传）
    if (type === 'world_state' && !model) {
      const st = (pl.state ?? {}) as Record<string, unknown>;
      const cm = (st.collaboration_mode ?? {}) as Record<string, unknown>;
      const m = typeof st.model === 'string' ? st.model : typeof cm.model === 'string' ? cm.model : '';
      if (m.trim()) pushMeta(rec, pl.cwd);
    }
  }
  return { records: out, badJson: raw.badJson, mtime: raw.mtime, size: raw.size };
}

/** 从 readRawRecords 结果里读 session_id（稳定 ID），回退到文件名里的 uuid。 */
function codexSessionId(raw: RawRecordFile, full: string): string {
  for (const r of raw.records) {
    const rec = r as Record<string, unknown>;
    if (rec.type === 'session_meta') {
      const pl = (rec.payload as Record<string, unknown> | undefined) ?? {};
      const sid = pl.session_id ?? pl.id;
      if (typeof sid === 'string' && sid.trim()) return sid.trim();
    }
  }
  const base = basename(full, '.jsonl');
  const m = base.match(UUID_RE);
  return m ? m[0] : base;
}

/** 从 session_meta 读父线程 ID（跨文件父子 lineage），无则 undefined。 */
function codexParentThreadId(raw: RawRecordFile): string | undefined {
  for (const r of raw.records) {
    const rec = r as Record<string, unknown>;
    if (rec.type === 'session_meta') {
      const pl = (rec.payload as Record<string, unknown> | undefined) ?? {};
      const pid = pl.parentThreadID ?? pl.parent_thread_id;
      if (typeof pid === 'string' && pid.trim()) return pid.trim();
    }
  }
  return undefined;
}

/** 递归查找 codex 会话根下的所有 rollout-*.jsonl（含 archived_sessions）。 */
function findRollouts(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(full);
      } catch {
        /* 权限/竞态：跳过 */
      }
    }
  }
  return out;
}

function codexSessionsRoot(): string | undefined {
  const root = join(homedir(), '.codex', 'sessions');
  return existsSync(root) ? root : undefined;
}

/** 从归一后的 records 派生首问 / 时间范围。 */
function summarizeFromNormalized(norm: RawRecordFile): {
  firstPrompt: string;
  startedAt?: number;
  endedAt?: number;
  messageCount: number;
} {
  let firstPrompt = '';
  const ts: number[] = [];
  let messageCount = 0;
  for (const r of norm.records) {
    const rec = r as Record<string, unknown>;
    const role = rec.role;
    if (role !== 'user' && role !== 'assistant') continue;
    messageCount++;
    const t = parseTs(rec.timestamp);
    if (t !== undefined) ts.push(t);
    if (!firstPrompt && role === 'user') {
      const stripped = stripHarnessWrappers(typeof rec.content === 'string' ? rec.content : String(rec.content ?? ''));
      const clean = stripped.trim();
      if (clean) firstPrompt = sanitizeFirstPromptForDisplay(clean, FIRST_PROMPT_MAX);
    }
  }
  ts.sort((a, b) => a - b);
  return {
    firstPrompt,
    startedAt: ts.length ? ts[0] : undefined,
    endedAt: ts.length ? ts[ts.length - 1] : undefined,
    messageCount,
  };
}

/**
 * 构造 ChatGPT Work / Codex 的会话抽取器。
 * discover() 直接产出完整 ExtractedSession：先逐文件读 + 归一 + 摘要，
 * 再做第二遍把 parentThreadID 解析成已发现会话的 sessionId（跨文件父子）。
 */
export function makeCodexExtractor(): SessionExtractor {
  return {
    vendor: 'codex',
    discover(): ExtractedSession[] {
      const root = codexSessionsRoot();
      if (!root) return [];
      const files = findRollouts(root);
      if (!files.length) return [];

      interface Parsed {
        full: string;
        sessionId: string;
        parentThreadId?: string;
        firstPrompt: string;
        kind: SessionKind;
        size: number;
        mtime: number;
        recordCount: number;
        badJson: number;
        startedAt?: number;
        endedAt?: number;
      }

      const parsed: Parsed[] = files.map((full) => {
        const raw0 = readRawRecords(full);
        const norm = normalizeCodexRecords(raw0);
        const summary = summarizeFromNormalized(norm);
        let st: { size: number; mtimeMs: number };
        try {
          const s = statSync(full);
          st = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          st = { size: raw0.size, mtimeMs: raw0.mtime };
        }
        return {
          full,
          sessionId: codexSessionId(raw0, full),
          parentThreadId: codexParentThreadId(raw0),
          firstPrompt: summary.firstPrompt,
          kind: 'top-level' as SessionKind,
          size: st.size,
          mtime: st.mtimeMs,
          recordCount: raw0.records.length,
          badJson: raw0.badJson,
          startedAt: summary.startedAt,
          endedAt: summary.endedAt,
        };
      });

      // 第二遍：把 parentThreadID 解析成已发现会话的 sessionId（跨文件父子 lineage）。
      const idSet = new Set(parsed.map((p) => p.sessionId));
      for (const p of parsed) {
        if (p.parentThreadId && idSet.has(p.parentThreadId)) p.kind = 'nested';
      }

      return parsed.map((p) => ({
        sessionId: p.sessionId,
        vendor: 'codex',
        kind: p.kind,
        path: p.full,
        parentId: p.parentThreadId && idSet.has(p.parentThreadId) ? p.parentThreadId : undefined,
        rawParentId: p.parentThreadId,
        size: p.size,
        mtime: p.mtime,
        recordCount: p.recordCount,
        badJson: p.badJson,
        firstPrompt: p.firstPrompt,
        // codex 不生成 ai-title，标题留空；列表以首问展示。
        title: '',
        spawnTask: '',
        startedAt: p.startedAt,
        endedAt: p.endedAt,
      }));
    },
  };
}
