/**
 * layered-refine · L1 Observer 主流程（observer.ts）。
 *
 * 职责：扫最近有活动的会话 → 剥离 harness 注入 → 构造"相邻对"输入 → 逐会话调 LLM
 * 提炼认知原则 → 落盘（md append-only + jsonl 影子副本合并）。
 *
 * 数据源：复用 agents/personal-space 的 computeAllSessions（发现）+ readSessionMessages
 * （只读 IO 适配器，已剥离 harness）。这是"独立第二车道"：只复用 IO，不耦合提炼产物。
 *
 * 关键防护（设计文档 P0）：readSessionMessages 内部走 stripHarnessWrappers，已在
 * MemoryProxy/src/common/session-harness.ts 补了 previous_assistant_message / task-notification
 * 漏剥——否则会把 AI 自己写的压缩摘要当成"用户的表达"去提炼，产出 consensus 复制品。
 */

import { computeAllSessions } from '../personal-space/facts.ts';
import { readSessionMessages } from '../personal-space/session-messages.ts';
import { resolveConfig, appendObservationMd, mergeObservations, ensureDirs } from './store.ts';
import { OBSERVER_SYSTEM, buildObserverUserPrompt } from './prompts.ts';
import { runLayeredCli } from './llm-cli.ts';
import type { Observation, TrafficLevel } from './types.ts';

const OBSERVER_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['high', 'medium', 'low'] },
          tag: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['level', 'tag', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['observations'],
  additionalProperties: false,
};

interface SourcePick {
  sessionId: string;
  vendor: string;
  mtime: number;
  tokens: number;
  compaction: number;
  commands: { name: string; count: number }[];
  filesChanged: number;
}

/**
 * 把 computeAllSessions 的 facts 行规整为选源结构。
 * computeAllSessions 返回类型在跨包动态 import 下退化为 unknown，这里做防御式取值。
 */
function toPicks(facts: unknown): SourcePick[] {
  const rows = Array.isArray(facts) ? (facts as Array<Record<string, unknown>>) : [];
  const picks: SourcePick[] = [];
  for (const f of rows) {
    const mtime = Number(f.mtime ?? 0);
    const compaction = Number((f.digest as Record<string, unknown> | undefined)?.compaction ?? 0);
    picks.push({
      sessionId: String(f.sessionId ?? ''),
      vendor: String(f.vendor ?? 'workbuddy'),
      mtime,
      tokens: Number((f.tokens as Record<string, unknown> | undefined)?.total ?? f.tokens ?? 0),
      compaction,
      commands: Array.isArray(f.commands) ? (f.commands as { name: string; count: number }[]) : [],
      filesChanged: Array.isArray(f.filesChanged) ? (f.filesChanged as unknown[]).length : 0,
    });
  }
  return picks;
}

/**
 * 选源：窗口内 + 按 token 降序取前 N + 污染过滤（compaction）。
 *
 * 显式指定 sessionIds 时（UI 勾选 / 脚本指定）：跳过窗口与 token 排序，
 * 严格按传入顺序取，保证"我选的这 3 个对话"就是实际被提炼的 3 个。
 */
function pickSessions(opts: {
  windowDays?: number;
  maxSessions?: number;
  force?: boolean;
  sessionIds?: string[];
}): SourcePick[] {
  const cfg = resolveConfig();
  const all = toPicks(computeAllSessions(true).facts);

  if (opts.sessionIds?.length) {
    const wanted = new Set(opts.sessionIds);
    const byId = new Map(all.map((p) => [p.sessionId, p]));
    const out: SourcePick[] = [];
    for (const id of opts.sessionIds) {
      const hit = byId.get(id);
      // 指定 but 事实层没扫到（非 workbuddy vendor / 已删除）：退化成最小结构，仍尝试读消息
      out.push(hit ?? { sessionId: id, vendor: 'workbuddy', mtime: 0, tokens: 0, compaction: 0, commands: [], filesChanged: 0 });
    }
    void wanted;
    return out;
  }

  const windowDays = opts.windowDays ?? cfg.windowDays;
  const maxN = opts.maxSessions ?? cfg.maxSessionsPerRun;
  const cutoff = Date.now() - windowDays * 86400000;
  let within = all.filter((p) => p.mtime >= cutoff && p.sessionId);
  if (!opts.force) {
    // 污染过滤：compaction 越高，AI 摘要顶替原始表达越多
    within = within.filter((p) => p.compaction < cfg.excludeCompactionGte);
  }
  within.sort((a, b) => b.tokens - a.tokens);
  return within.slice(0, maxN);
}

/** 选源候选（供 UI 勾选）：近期会话 + 可读对话轮次 + 首问预览。 */
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
  /** 提炼输入的实际对话轮次（user + assistant），0 = 无可用内容 */
  msgTurns: number;
}

/**
 * 列出可作为「分层提炼」源会话的候选（默认最近 40 个顶层会话）。
 * 只读：不写 store、不调 LLM。
 */
export function listSourceSessions(limit = 40): SourceSessionItem[] {
  const { facts } = computeAllSessions(true);
  const rows = toPicks(facts);
  const idx = new Map(rows.map((r) => [r.sessionId, r]));
  const raw = Array.isArray(facts) ? (facts as Array<Record<string, unknown>>) : [];
  const out: SourceSessionItem[] = [];
  for (const f of raw) {
    const sid = String(f.sessionId ?? '');
    if (!sid) continue;
    const pick = idx.get(sid);
    const fp = String(f.firstPrompt ?? '');
    out.push({
      sessionId: sid,
      vendor: String(f.vendor ?? 'workbuddy'),
      mtime: Number(f.mtime ?? 0),
      kind: (f.kind === 'nested' ? 'nested' : 'top-level') as 'top-level' | 'nested',
      recordCount: Number(f.recordCount ?? 0),
      userTurns: Number(f.userTurns ?? 0),
      tokens: pick?.tokens ?? 0,
      compaction: pick?.compaction ?? 0,
      title: String(f.title ?? ''),
      firstPrompt: fp.replace(/\s+/g, ' ').trim().slice(0, 80),
      msgTurns: 0,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const cut = out.slice(0, Math.max(1, limit));
  // msgTurns 只在最终候选上算（读盘较重），避免对上百个会话全量解析
  for (const it of cut) {
    try {
      it.msgTurns = readSessionMessages(it.vendor, it.sessionId).length;
    } catch {
      it.msgTurns = 0;
    }
  }
  return cut;
}

/**
 * 注入噪声识别：转录里有一批 role=user 的消息**不是用户的表达**，若拿去提炼，
 * 会把"系统提示词"当成"用户的认知原则"，产出彻头彻尾的假记忆。实测三类：
 *   1. 工具提醒 / 任务完成通知（"Use the TaskOutput tool with task_id=…"）；
 *   2. <task-notification> / <system-reminder> 之类的 harness 包裹残留；
 *   3. 压缩摘要（compaction recap）：把历史对话编号拼接后伪装成一条 user 消息。
 * 这与 harness 剥离是两件事——剥离只去掉包裹标签，这里进一步识别"整条都不是人话"。
 */
const INJECTED_PATTERNS: RegExp[] = [
  /Use the TaskOutput tool with task_id=/i,
  /<task-notification/i,
  /<system-reminder/i,
  /This session is being continued/i,
  /<conversation_history_summary>/i,
  /As you answer the user's questions/i,
];

function isInjectedUserTurn(content: string): boolean {
  return INJECTED_PATTERNS.some((re) => re.test(content));
}

/**
 * 压缩摘要识别：若一条 user 消息**包含了此前某轮用户消息的原文**，它就是 compaction
 * 把历史拼接出来的，不是人说的。
 *
 * 为什么不用"长文本 + 编号列表"这类启发式：实测误杀——用户粘贴的文章摘录里含
 * "1. 它是什么"就被判成摘要丢掉了。包含关系是确定性判据，误杀率远低于形态猜测。
 */
function isRecap(text: string, earlier: string[]): boolean {
  for (const e of earlier) {
    if (text.includes(e)) return true;
  }
  return false;
}

/**
 * 构造相邻对：当前 user 消息 + 前一条 assistant 首句（≤200 字符）作语境。
 * @returns { pairs, skipped } skipped = 被判为注入噪声而丢弃的 user 轮次
 */
function buildAdjacentPairs(messages: { role: string; content: string }[]): {
  pairs: string;
  skipped: number;
} {
  const lines: string[] = [];
  let skipped = 0;
  /** 已确认是真人表达的 user 消息指纹（取前 120 字符，用于识别摘要拼接） */
  const earlier: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i];
    if (cur.role !== 'user') continue;
    const text = cur.content.replace(/\s+/g, ' ').trim();
    if (!text || isInjectedUserTurn(text) || isRecap(text, earlier)) {
      skipped++;
      continue;
    }
    if (text.length >= 20) earlier.push(text.slice(0, 120));
    const prev = messages[i - 1];
    const ctx = prev && prev.role === 'assistant' ? prev.content.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    lines.push(`[上一轮助手] ${ctx}\n[用户] ${text}`);
  }
  return { pairs: lines.join('\n\n'), skipped };
}

function behaviorFingerprint(p: SourcePick): string {
  const top = p.commands
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((c) => `${c.name}×${c.count}`)
    .join(', ');
  return `行为指纹：改动文件 ${p.filesChanged} 个；高频命令 [${top}]`;
}

export interface ObserverResult {
  sessions: number;
  observations: Observation[];
  noiseFiltered: number;
  /** LLM 未返回结果（CLI 不可用 / 超时 / 载体未命中）的会话数——用于 UI 明确告警，而非静默空跑 */
  llmMissed: number;
  /** 本次实际被提炼的会话 id（UI 回填"跑了哪几个"） */
  pickedSessionIds: string[];
  error?: string | null;
}

export async function runObserver(opts: {
  windowDays?: number;
  maxSessions?: number;
  force?: boolean;
  sessionIds?: string[];
} = {}): Promise<ObserverResult> {
  ensureDirs();
  const cfg = resolveConfig();
  const picks = pickSessions(opts);
  const collected: { level: TrafficLevel; tag: string; text: string; sessionId: string }[] = [];
  let noiseFiltered = 0;
  let llmMissed = 0;
  let totalBytes = 0;

  for (const p of picks) {
    const msgs = readSessionMessages(p.vendor, p.sessionId);
    const { pairs, skipped } = buildAdjacentPairs(msgs);
    if (!pairs.trim()) {
      noiseFiltered++;
      continue;
    }
    if (skipped > 0) {
      console.log(`[layered-refine] ${p.sessionId} 丢弃注入噪声 ${skipped} 条`);
    }
    let block = `SESSION ${p.sessionId}\n${behaviorFingerprint(p)}\n\n${pairs}`;
    // 单会话截断
    const maxBytes = cfg.maxInputBytesPerSession;
    if (Buffer.byteLength(block, 'utf8') > maxBytes) block = block.slice(0, maxBytes);
    // 总输入封顶
    if (totalBytes + Buffer.byteLength(block, 'utf8') > cfg.maxTotalInputBytes) break;
    totalBytes += Buffer.byteLength(block, 'utf8');

    const userPrompt = buildObserverUserPrompt([block]);
    const parsed = (await runLayeredCli(OBSERVER_SYSTEM, userPrompt, OBSERVER_SCHEMA, cfg)) as
      | { observations?: { level: TrafficLevel; tag: string; text: string }[] }
      | null;
    if (!parsed) {
      // 关键：LLM 拿不到结果时绝不能静默跳过——否则 UI 显示"跑了 3 个会话、产出 0 条"，
      // 用户无法区分"真的没有稳定信号"和"LLM 通道挂了"。
      llmMissed++;
      continue;
    }
    const obs = parsed?.observations ?? [];
    for (const o of obs) {
      const level = (o.level === 'high' || o.level === 'medium' || o.level === 'low' ? o.level : 'low') as TrafficLevel;
      const tag = (o.tag || 'misc').toLowerCase().replace(/[^\w-]/g, '-').slice(0, 24);
      const text = (o.text || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6) continue;
      collected.push({ level, tag, text, sessionId: p.sessionId });
      appendObservationMd(level, tag, text, `${p.sessionId}:${tag}:${text.slice(0, 16)}`);
    }
  }

  const merged = collected.length ? mergeObservations(collected) : [];
  return {
    sessions: picks.length,
    observations: merged,
    noiseFiltered,
    llmMissed,
    pickedSessionIds: picks.map((p) => p.sessionId),
    error: null,
  };
}
