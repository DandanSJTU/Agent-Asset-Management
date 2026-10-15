/**
 * session-search.ts — 会话洞察（Session Insights）搜索引擎。
 *
 * 基线对齐 coslash 的会话搜索（frontend/src/pages/coslash/lib/session-library.ts:57-116
 * + CoslashLayout.tsx:285 matchesSearch），并针对本项目数据模型做字段映射与召回优化：
 *
 *   coslash 原实现
 *     · 查询串按空格拆词，AND 语义（任一词不命中即淘汰）
 *     · 每个词取「命中字段的最高权重」累加（best-of，不是多字段累加）
 *     · repo:/group:/machine:/agent:/status: 五种结构化前缀，命中 +15 且只过滤不计文本
 *     · 相关度降序压过用户自选排序键；叙事字段仅本地会话可见（隐私门禁）
 *
 *   本实现的差异（有意为之，见文件内注释）
 *     ① 召回层：coslash 是每次击键全量 includes 扫描（其报告的「优化点 1」）。
 *        这里改为 bigram 倒排索引求候选集，评分只对候选集做，语义与全量扫描等价
 *        （倒排只可能多召回，最终由 matchesSearch 精确校验）。
 *     ② 中文：coslash 依赖空格分词，中文无空格会退化成「整串子串」。
 *        这里对连续 chunk 取 2-gram，中文/英文/混排统一处理，保持「子串」语义。
 *     ③ 前缀：coslash 的 group:/machine: 本项目无对应维度，替换为 branch:/kind:/model:。
 *     ④ 隐私：沿用 coslash 口径，git.cwd 与 edits.files 私有路径一律不建索引。
 *
 * 纯函数模块（零运行时依赖），可独立单测。
 */

import type { SessionSummary } from '@/lib/api/personal-space';

/* ============================================================
 * 1. 权重表
 * ============================================================ */

/**
 * 字段权重（对齐 coslash 的 5 档梯度：用户为什么开会话 > 会话里发生了什么）。
 * 数值即「该字段命中一次的贡献分」，取命中字段的最高值（best-of）。
 */
export const FIELD_WEIGHT = {
  /** 会话标题（ai-title） */
  title: 100,
  /** 仓库 / 目录（由 sessionId 派生） */
  repo: 40,
  /** 首条 prompt */
  firstPrompt: 30,
  /** git 分支 */
  branch: 20,
  /** Agent / vendor */
  vendor: 20,
  /** 模型名 */
  model: 15,
  /** sessionId 全串（含 repo 路径 + 会话 slug） */
  sessionId: 12,
} as const;

/** 结构化前缀命中固定加分（coslash QUALIFIER_WEIGHT） */
export const QUALIFIER_WEIGHT = 15;

/** 空查询的中性分（coslash 返回 1，表示「匹配一切」） */
export const EMPTY_QUERY_SCORE = 1;

/** 支持的结构化前缀（coslash 为 repo/group/machine/agent/status） */
export const QUALIFIER_KEYS = ['repo', 'agent', 'status', 'branch', 'kind', 'model'] as const;
export type QualifierKey = (typeof QUALIFIER_KEYS)[number];

const QUALIFIER_RE = new RegExp(`^(${QUALIFIER_KEYS.join('|')}):(.+)$`);

export interface Qualifier {
  key: QualifierKey;
  value: string;
}

export interface ParsedQuery {
  /** 自由文本词（已小写、已剔除结构化前缀） */
  terms: string[];
  qualifiers: Qualifier[];
}

export interface SearchField {
  text: string;
  weight: number;
}

/* ============================================================
 * 2. 索引构建（字段表 + bigram 倒排）
 * ============================================================ */

/** 会话所属仓库 / 目录：sessionId 最后一个 '/' 之前的部分 */
export function repoOf(sessionId: string): string {
  const k = sessionId.lastIndexOf('/');
  return k > 0 ? sessionId.slice(0, k) : sessionId || '—';
}

const fieldCache = new WeakMap<SessionSummary, SearchField[]>();

/**
 * 拆出可搜索的加权字段。文本在建索引时一次性 lowercase。
 * 结果缓存进 WeakMap，重复评分不重复归一化。
 *
 * 隐私口径（对齐 coslash）：git.cwd、edits.files 私有路径不建索引。
 */
export function sessionSearchFields(s: SessionSummary): SearchField[] {
  const cached = fieldCache.get(s);
  if (cached) return cached;
  const fields: SearchField[] = [
    { text: (s.title || '').toLowerCase(), weight: FIELD_WEIGHT.title },
    { text: repoOf(s.sessionId).toLowerCase(), weight: FIELD_WEIGHT.repo },
    { text: (s.firstPrompt || '').toLowerCase(), weight: FIELD_WEIGHT.firstPrompt },
    { text: (s.vendor || '').toLowerCase(), weight: FIELD_WEIGHT.vendor },
    { text: (s.git?.branch || '').toLowerCase(), weight: FIELD_WEIGHT.branch },
    {
      text: (s.models || []).map((m) => m.model || '').join(' ').toLowerCase(),
      weight: FIELD_WEIGHT.model,
    },
    { text: (s.sessionId || '').toLowerCase(), weight: FIELD_WEIGHT.sessionId },
  ].filter((f) => f.text.length > 0);
  fieldCache.set(s, fields);
  return fields;
}

/** 结构化前缀的取值（已小写） */
function qualifierText(s: SessionSummary, repo: string, key: QualifierKey): string {
  switch (key) {
    case 'repo':
      return repo.toLowerCase();
    case 'agent':
      return (s.vendor || '').toLowerCase();
    case 'status':
      return (s.state || '').toLowerCase();
    case 'branch':
      return (s.git?.branch || '').toLowerCase();
    case 'kind':
      return (s.kind || '').toLowerCase();
    case 'model':
      return (s.models || []).map((m) => m.model || '').join(' ').toLowerCase();
    default:
      return '';
  }
}

/**
 * bigram 切分：按空白切 chunk，chunk 长度 1 直接作为 gram，否则取所有相邻 2-gram。
 * 统一处理中英文混排，且保持「子串」语义（"auth" 能召回 "authentication"）。
 */
export function gramsOf(text: string): Set<string> {
  const out = new Set<string>();
  const lower = (text || '').toLowerCase();
  for (const chunk of lower.split(/\s+/)) {
    if (!chunk) continue;
    if (chunk.length === 1) {
      out.add(chunk);
      continue;
    }
    for (let i = 0; i + 1 < chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

export interface SessionSearchIndex {
  sessions: SessionSummary[];
  /** gram -> 命中的会话下标集合 */
  postings: Map<string, Set<number>>;
}

/** 建倒排索引。字段拼接用空格分隔，跨字段只会多生成 gram（多召回），不会漏召回。 */
export function buildSearchIndex(sessions: SessionSummary[]): SessionSearchIndex {
  const postings = new Map<string, Set<number>>();
  for (let i = 0; i < sessions.length; i += 1) {
    const blob = sessionSearchFields(sessions[i])
      .map((f) => f.text)
      .join(' ');
    for (const g of gramsOf(blob)) {
      let set = postings.get(g);
      if (!set) {
        set = new Set<number>();
        postings.set(g, set);
      }
      set.add(i);
    }
  }
  return { sessions, postings };
}

/* ============================================================
 * 3. 查询解析
 * ============================================================ */

/** 拆词：空格分词 + 结构化前缀抽取（前缀只过滤、不参与文本匹配与高亮） */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const qualifiers: Qualifier[] = [];
  for (const word of (query || '').trim().toLowerCase().split(/\s+/)) {
    if (!word) continue;
    const m = word.match(QUALIFIER_RE);
    if (m && m[2]) {
      qualifiers.push({ key: m[1] as QualifierKey, value: m[2] });
      continue;
    }
    terms.push(word);
  }
  return { terms, qualifiers };
}

export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return parsed.terms.length === 0 && parsed.qualifiers.length === 0;
}

/* ============================================================
 * 4. 评分（coslash matchesSearch 等价语义）
 * ============================================================ */

/** 单词得分：命中的最高权重字段（best-of，不是多字段累加） */
export function scoreWordInFields(fields: SearchField[], word: string): number {
  let best = 0;
  for (const f of fields) {
    if (f.text.includes(word) && f.weight > best) best = f.weight;
  }
  return best;
}

/**
 * 判定 + 计分：0 表示不匹配。
 * · 结构化前缀：不命中直接淘汰，命中 +15
 * · 文本词：AND 语义，任一词不命中即淘汰，命中累加其 best-of 权重
 */
export function matchesSearch(s: SessionSummary, parsed: ParsedQuery): number {
  if (isEmptyQuery(parsed)) return EMPTY_QUERY_SCORE;
  const repo = repoOf(s.sessionId);
  let score = 0;
  for (const q of parsed.qualifiers) {
    if (!qualifierText(s, repo, q.key).includes(q.value)) return 0;
    score += QUALIFIER_WEIGHT;
  }
  if (parsed.terms.length) {
    const fields = sessionSearchFields(s);
    for (const term of parsed.terms) {
      const w = scoreWordInFields(fields, term);
      if (w === 0) return 0;
      score += w;
    }
  }
  return score;
}

/* ============================================================
 * 5. 召回（倒排候选集）
 * ============================================================ */

/**
 * 召回候选下标。返回 null 表示「无法走索引，退化为全量扫描」
 * （无文本词 / 词无 gram 可切）。返回空数组表示确定无命中。
 */
export function recallCandidates(index: SessionSearchIndex, terms: string[]): number[] | null {
  if (terms.length === 0) return null;
  const lists: Set<number>[] = [];
  for (const term of terms) {
    const grams = gramsOf(term);
    if (grams.size === 0) return null;
    for (const g of grams) {
      const post = index.postings.get(g);
      // 该 gram 全库不存在 → 必然无命中
      if (!post) return [];
      lists.push(post);
    }
  }
  if (lists.length === 0) return null;
  lists.sort((a, b) => a.size - b.size);
  const out: number[] = [];
  const base = lists[0];
  outer: for (const idx of base) {
    for (let i = 1; i < lists.length; i += 1) {
      if (!lists[i].has(idx)) continue outer;
    }
    out.push(idx);
  }
  return out;
}

/* ============================================================
 * 6. 主入口
 * ============================================================ */

export interface SessionSearchResult {
  /** 命中的会话，已按相关度降序（稳定排序，同分保持原序） */
  matched: SessionSummary[];
  /** sessionId -> 相关度分数（供排序做第一关键字） */
  scores: Map<string, number>;
  /** 高亮用词（已剔除结构化前缀） */
  terms: string[];
  qualifiers: Qualifier[];
  /** 实际参与评分的会话数（观测召回率用） */
  scanned: number;
  /** true 表示本次退化为全量扫描 */
  degraded: boolean;
}

export function runSessionSearch(index: SessionSearchIndex, query: string): SessionSearchResult {
  const parsed = parseQuery(query);
  const candidates = recallCandidates(index, parsed.terms);
  const degraded = candidates === null;
  let pool: SessionSummary[];
  if (degraded) {
    pool = index.sessions;
  } else {
    pool = [];
    for (const i of candidates as number[]) pool.push(index.sessions[i]);
  }

  const matched: SessionSummary[] = [];
  const scores = new Map<string, number>();
  for (const s of pool) {
    const sc = matchesSearch(s, parsed);
    if (sc <= 0) continue;
    matched.push(s);
    scores.set(s.sessionId, sc);
  }
  matched.sort((a, b) => (scores.get(b.sessionId) ?? 0) - (scores.get(a.sessionId) ?? 0));

  return {
    matched,
    scores,
    terms: parsed.terms,
    qualifiers: parsed.qualifiers,
    scanned: pool.length,
    degraded,
  };
}

/* ============================================================
 * 7. 高亮（coslash Highlight.tsx 等价：全部匹配区间 + 合并重叠）
 * ============================================================ */

export type Range = [number, number];

/** 找出 text 中所有命中区间（非仅第一个），按起点排序并合并重叠 */
export function highlightRanges(text: string, terms: string[]): Range[] {
  if (!text || !terms.length) return [];
  const lower = text.toLowerCase();
  const raw: Range[] = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      raw.push([at, at + term.length]);
      from = at + Math.max(1, term.length);
    }
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Range[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/* ============================================================
 * 8. 搜索历史（coslash 只持久化最后一次查询，这里升级为最近 N 条）
 * ============================================================ */

const HISTORY_KEY = 'agent-memory.session-insights.search.v1';
const HISTORY_MAX = 8;

export function loadSearchHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

export function pushSearchHistory(query: string): string[] {
  const q = (query || '').trim();
  if (typeof window === 'undefined' || !q) return loadSearchHistory();
  const next = [q, ...loadSearchHistory().filter((x) => x !== q)].slice(0, HISTORY_MAX);
  try {
    window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用时静默降级 */
  }
  return next;
}

export function clearSearchHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    window.sessionStorage.removeItem(HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
  return [];
}

/**
 * 视作「仍在运行」的 state —— coslash 用 `status != null` 表达同一件事
 * （其 sessionShareEligibility：`if (session.status != null) return 'running'`）。
 * 本项目 state 无 null，故用白名单：inactive = 已结束，其余（active / waiting / idle）都还活着。
 */
export const LIVE_STATES = new Set(['active', 'waiting', 'idle']);

/**
 * 时间窗过滤，带活跃豁免。
 *
 * coslash 原式：`sessions.filter(s => start == null || s.status != null || s.mtime >= start)`。
 * 语义：时间窗只约束「已结束」的会话；仍在运行的会话即便 mtime 停在几天前也保留 ——
 * 一个跑了三天的长会话，切到「今天」不该凭空消失。
 *
 * 注意这决定了搜索的召回池：搜索发生在时间窗之后，窗外的历史会话搜不到（与 coslash 同款天花板）。
 */
export function filterByRange(sessions: SessionSummary[], start: number | null): SessionSummary[] {
  if (start == null) return sessions;
  return sessions.filter((s) => LIVE_STATES.has((s.state || '').toLowerCase()) || s.mtime >= start);
}
