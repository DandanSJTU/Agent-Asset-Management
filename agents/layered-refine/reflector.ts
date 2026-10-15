/**
 * layered-refine · L2 Reflector 主流程（reflector.ts）。
 *
 * 职责：把 L1 观测池聚合为「可晋升候选」——找出跨场景、跨时间反复出现并保持一致的模式，
 * 而不是把每条观测原样搬上来。聚合分两条路径：
 *   1. LLM 语义聚合（主）：REFLECTOR_SYSTEM 做同义合并 + 落点建议 + 证据绑定；
 *   2. 规则门槛（回退）：LLM 不可用时按 support / sessions / span 量化筛选。
 *
 * 关键设计变更（2026-10-15）：
 *   - 原先 REFLECTOR_SYSTEM 写好了却没被任何代码调用，L2 实际是纯规则过滤，语义聚合缺失；
 *   - 跨度（spanDays）原先是一票否决，导致"一次性导入 3 个会话"场景下 L2 恒为空。
 *     现改为：跨度不足 → 仍进候选池，但标 maturity='emerging'，由人审决定是否采纳，
 *     把"稳定性判断"交回给人，而不是让机械门槛把第二层卡死。
 */

import { resolveConfig, loadObservations, appendCandidates, loadCandidates } from './store.ts';
import { REFLECTOR_SYSTEM, buildReflectorUserPrompt } from './prompts.ts';
import { runLayeredCli } from './llm-cli.ts';
import type { Candidate, Observation } from './types.ts';

const REFLECTOR_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          level: { type: 'string', enum: ['high', 'medium', 'low'] },
          tag: { type: 'string' },
          target: { type: 'string', enum: ['USER.md', 'MEMORY.md', 'axioms'] },
          /** 命中的观测 id —— 必须真实存在于输入，用于生成证据链 */
          sourceObsIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'level', 'tag', 'target', 'sourceObsIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.max(0, Math.round((db - da) / 86400000));
}

function pickTarget(level: string): Candidate['suggestedTarget'] {
  if (level === 'high') return 'USER.md';
  if (level === 'medium') return 'MEMORY.md';
  return 'axioms';
}

/** 由命中的观测集合计算证据（支撑次数 / 跨会话 / 时间跨度）。 */
function buildEvidence(hits: Observation[]) {
  const supportCount = hits.reduce((s, o) => s + o.supportCount, 0);
  const sessions = [...new Set(hits.flatMap((o) => o.sources))];
  const firstSeen = hits.map((o) => o.firstSeen).sort()[0] ?? '';
  const lastSeen = hits.map((o) => o.lastSeen).sort().pop() ?? '';
  const spanDays = daysBetween(firstSeen, lastSeen);
  return { supportCount, sessions, spanDays };
}

export interface ReflectorResult {
  candidates: number;
  /** 进入聚合池的观测数（未晋升） */
  eligible: number;
  /** 聚合方式：llm=语义聚合成功 / rule=回退门槛 */
  mode: 'llm' | 'rule';
  error?: string | null;
}

interface RawCandidate {
  text?: string;
  level?: string;
  tag?: string;
  target?: string;
  sourceObsIds?: string[];
}

export async function runReflector(): Promise<ReflectorResult> {
  const cfg = resolveConfig();
  const pool = loadObservations().filter((o) => !o.promoted);
  const existing = loadCandidates().filter((c) => c.status === 'pending');
  const existingText = new Set(existing.map((c) => c.text));
  const byId = new Map(pool.map((o) => [o.id, o]));
  const newOnes: Candidate[] = [];

  // ── 路径 1：LLM 语义聚合 ──
  //
  // 触发条件只看"池里至少有 2 条"，不再要求 support>=2 / 跨会话>=2。
  // 原因（首跑暴露的真问题）：三条会话对同一个概念会写出**措辞不同**的观测
  // （如"追问具体文件夹" vs "必须看真实 diff" vs "要求落到代码位置"），
  // 它们在 L1 层是三条 supportCount=1 的独立记录，规则门槛永远判不出"稳定"；
  // 而把它们判定为同一个模式，恰恰只有语义聚合能做到。用 support>=2 挡住 LLM，
  // 等于在最需要它的场景把它关掉——L2 恒为空。
  const hasSignal = pool.length >= 2;
  let parsed: { candidates?: RawCandidate[] } | null = null;
  if (hasSignal) {
    const prompt = buildReflectorUserPrompt(
      pool.map((o) => ({
        id: o.id,
        text: o.text,
        level: o.level,
        tag: o.tag,
        supportCount: o.supportCount,
        sources: o.sources,
        firstSeen: o.firstSeen,
        lastSeen: o.lastSeen,
      })),
    );
    parsed = (await runLayeredCli(REFLECTOR_SYSTEM, prompt, REFLECTOR_SCHEMA, cfg)) as
      | { candidates?: RawCandidate[] }
      | null;
  }

  if (parsed?.candidates?.length) {
    for (const c of parsed.candidates) {
      const text = (c.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 6 || existingText.has(text)) continue;
      // 证据校验：sourceObsIds 必须真实存在且去重后 ≥2 条——丢弃 LLM 编造的引用
      const ids = [...new Set((c.sourceObsIds ?? []).filter((id) => byId.has(String(id))))];
      if (ids.length < 2) continue;
      const hits = ids.map((id) => byId.get(id)!);
      const evidence = buildEvidence(hits);
      const level = (['high', 'medium', 'low'] as const).find((l) => l === c.level) ?? hits[0].level;
      const target = (['USER.md', 'MEMORY.md', 'axioms'] as const).find((t) => t === c.target) ?? pickTarget(level);
      newOnes.push({
        id: `cand_${hits[0].id}_${newOnes.length}`,
        text,
        level,
        tag: (c.tag || hits[0].tag || 'misc').toLowerCase().replace(/[^\w-]/g, '-').slice(0, 24),
        evidence,
        suggestedTarget: target,
        maturity: evidence.spanDays >= cfg.promotion.spanDaysGte ? 'stable' : 'emerging',
        status: 'pending',
        createdAt: Date.now(),
        mode: 'llm',
        sourceObsIds: ids,
      });
      existingText.add(text);
    }
    if (newOnes.length) appendCandidates(newOnes);
    return { candidates: newOnes.length, eligible: pool.length, mode: 'llm', error: null };
  }

  // ── 路径 2：规则门槛回退（LLM 不可用 / 未产出）──
  for (const o of pool) {
    const span = daysBetween(o.firstSeen, o.lastSeen);
    const hardOk =
      o.supportCount >= cfg.promotion.supportGte && o.sources.length >= cfg.promotion.sessionsGte;
    if (!hardOk) continue;
    if (existingText.has(o.text)) continue;
    newOnes.push({
      id: `cand_${o.id}`,
      text: o.text,
      level: o.level,
      tag: o.tag,
      evidence: { supportCount: o.supportCount, sessions: o.sources, spanDays: span },
      suggestedTarget: pickTarget(o.level),
      maturity: span >= cfg.promotion.spanDaysGte ? 'stable' : 'emerging',
      status: 'pending',
      createdAt: Date.now(),
      mode: 'rule',
      sourceObsIds: [o.id],
    });
    existingText.add(o.text);
  }
  if (newOnes.length) appendCandidates(newOnes);
  return {
    candidates: newOnes.length,
    eligible: pool.length,
    mode: 'rule',
    error: parsed === null && hasSignal ? 'LLM 不可用，已回退规则门槛' : null,
  };
}
