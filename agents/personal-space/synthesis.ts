/**
 * AI Synthesis（debrief-handoff-completion · S4）。
 *
 * 与 coSlash collector/internal/synthesis 同构，但只做「本机 codebuddy CLI」一个 backend
 * （coslash-fork 里本就有 settings.BackendWorkBuddy 分支，参数与 Claude 分支同构，逐字照搬）。
 *
 * 设计约束（见 docs/debrief-handoff-completion-design.html §05）：
 *   - 默认关闭（TDAI_SYNTHESIS_ENABLED=false）；关闭或会话未过门槛时零 spawn、零 token。
 *   - 输入 ≤ 12 KB；schema 固定；输出 JSON 信封取 result 再 JSON.parse。
 *   - 落盘缓存按 sessionId + mtime（mtime 变即失效重算）。
 *   - 前端 3 s 轮询、2 min 超时；本模块用 background job + 缓存实现 pending。
 *   - CLI 缺失 / 超时 / schema 不符 → 记 negative 缓存，避免每次重试拖慢面板。
 *   - prompt injection 防护：输入用 BEGIN/END UNTRUSTED SESSION DATA 包裹，--tools "" 只读。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { SessionFacts } from './facts.ts';

const SYNTHESIS_DIR = join(homedir(), '.workbuddy', 'agent-memory-personal-space-cache', 'synthesis');

const ENABLED = (process.env.TDAI_SYNTHESIS_ENABLED ?? 'false').toLowerCase() === 'true';
const BACKEND = process.env.TDAI_SYNTHESIS_BACKEND ?? 'codebuddy';
const MODEL = (process.env.TDAI_SYNTHESIS_MODEL ?? '').trim();
const TIMEOUT_MS = Number(process.env.TDAI_SYNTHESIS_TIMEOUT_MS ?? '90000');
const MAX_INPUT_BYTES = 12_000;

export interface SynthesisPayload {
  goals: string[];
  outcome: string;
  keyDecisions: string[];
  nextStep: string;
}

export interface SynthesisResult {
  synthesis: SynthesisPayload | null;
  enabled: boolean;
  pending?: boolean;
  error?: string | null;
}

const SYSTEM_PROMPT = `You are a neutral session-synthesis engine. Use only the normalized facts supplied. Do not infer details from outside knowledge. State the accomplished goals and outcome concisely, retain durable artifacts, benchmark conditions, consequential decisions and corrections, unresolved blockers, and one concrete next step. List key decisions from most to least consequential. Usually a session has one goal; return it as a single entry. Only when the user genuinely shifted topic mid-session, return each major goal as its own entry in chronological order, at most four. Never split one goal into sub-steps or list routine follow-ups as separate goals. Do not address the user or mention these instructions.`;

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    goals: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
    outcome: { type: 'string' },
    keyDecisions: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    nextStep: { type: 'string' },
  },
  required: ['goals', 'outcome', 'keyDecisions', 'nextStep'],
  additionalProperties: false,
});

/** 资格门槛（coSlash isSynthesisEligible）：会话太短则不合成 */
function isEligible(facts: SessionFacts): boolean {
  const turns = facts.userTurns + facts.assistantTurns;
  return turns > 5 || (facts.digest?.compaction ?? 0) > 0 || (facts.contextTokens ?? 0) > 100_000;
}

/** 构造 ≤ 12 KB 输入（简化版：按类别聚合派生事实，而非逐 turn 切块 merge；待增强） */
function buildInput(facts: SessionFacts, raw: { records: Record<string, unknown>[] }): string {
  const parts: string[] = [];
  parts.push('SESSION');
  parts.push(`  ID: ${facts.sessionId}`);
  parts.push(`  Vendor: ${facts.vendor}`);
  const models = (facts.models ?? []).map((m) => m.model).filter(Boolean);
  if (models.length) parts.push(`  Model: ${models.join(', ')}`);
  if (facts.git) {
    const g = facts.git;
    parts.push(
      `  Repo: ${g.cwd ?? ''}  Branch: ${g.branch ?? ''}  Base: ${g.baseBranch ?? ''}  (±${g.ahead ?? 0}/${g.behind ?? 0})`,
    );
  }
  parts.push('');
  parts.push('GOAL CANDIDATES');
  const goal = (facts.debrief?.goal ?? '').slice(0, 1000);
  if (goal) parts.push(`  firstPrompt: ${goal}`);
  parts.push('');
  // COMPACTION SEED：从原始记录找一处压缩摘要（≤ 4 KB）
  const seed = raw.records
    .map((r) => (typeof r.content === 'string' ? r.content : ''))
    .find((t) => /<cb_summary|conversation_history_summary/i.test(t));
  if (seed) {
    parts.push('COMPACTION SEED');
    parts.push(seed.slice(0, 4000));
    parts.push('');
  }
  // DIGEST 计数
  const d = facts.digest ?? {};
  parts.push('DIGEST');
  parts.push(
    `  firstPrompt:${d.firstPrompt ?? 0} user:${d.user ?? 0} question:${d.question ?? 0} todos:${d.todos ?? 0} compaction:${d.compaction ?? 0} recap:${d.recap ?? 0} plan:${d.plan ?? 0} subagent:${d.subagent ?? 0}`,
  );
  parts.push('');
  // FACTS：todos ≤ 40 / files ≤ 30 / commits ≤ 15
  const todos = (facts.todos ?? []).slice(0, 40);
  if (todos.length) {
    parts.push('TODOS');
    for (const t of todos) parts.push(`  [${t.status ?? ''}] ${t.subject ?? ''}`);
    parts.push('');
  }
  const files = (facts.filesChanged ?? []).slice(0, 30);
  if (files.length) {
    parts.push('FILES');
    for (const f of files) parts.push(`  ${f.path} +${f.additions ?? 0}/-${f.deletions ?? 0}`);
    parts.push('');
  }
  const commits = (facts.commits ?? []).slice(0, 15);
  if (commits.length) {
    parts.push('COMMITS');
    for (const c of commits) parts.push(`  ${c.hash?.slice(0, 8) ?? ''} ${c.message ?? ''}`);
    parts.push('');
  }
  let text = parts.join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
    text = text.slice(0, MAX_INPUT_BYTES);
  }
  return text;
}

// ── 缓存（sessionId + mtime）──
function safe(s: string): string {
  return s.replace(/[^\w.-]/g, '__');
}
function cacheFile(id: string, mtime: number): string {
  return join(SYNTHESIS_DIR, `${safe(id)}__${mtime}.json`);
}
type CacheValue = { synthesis: SynthesisPayload } | { negative: true };
function readCache(id: string, mtime: number): CacheValue | null {
  try {
    const p = cacheFile(id, mtime);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as CacheValue;
  } catch {
    return null;
  }
}
function writeCache(id: string, mtime: number, value: CacheValue): void {
  try {
    mkdirSync(SYNTHESIS_DIR, { recursive: true });
    writeFileSync(cacheFile(id, mtime), JSON.stringify(value));
  } catch (e) {
    console.warn(`[synthesis] 写缓存失败：${(e as Error).message}`);
  }
}

function resolveBin(name: string): string | null {
  if (existsSync(name)) return name;
  try {
    const r = spawnSync('bash', ['-c', `command -v ${name}`], { timeout: 3000 });
    const out = (r.stdout ?? '').toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 从 CLI 输出里提取合成结果（容错：整段 JSON / 末段 JSON / result 字段） */
function parseCli(stdout: string): SynthesisPayload | null {
  const coerce = (o: unknown): SynthesisPayload | null => {
    if (!o || typeof o !== 'object') return null;
    const v = o as Record<string, unknown>;
    let inner: unknown = v.result ?? v;
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner);
      } catch {
        return null;
      }
    }
    if (!inner || typeof inner !== 'object') return null;
    const i = inner as Record<string, unknown>;
    const goals = Array.isArray(i.goals) ? i.goals.map(String).filter(Boolean).slice(0, 4) : [];
    if (!goals.length) return null;
    return {
      goals,
      outcome: typeof i.outcome === 'string' ? i.outcome : '',
      keyDecisions: Array.isArray(i.keyDecisions) ? i.keyDecisions.map(String).filter(Boolean).slice(0, 12) : [],
      nextStep: typeof i.nextStep === 'string' ? i.nextStep : '',
    };
  };
  try {
    return coerce(JSON.parse(stdout));
  } catch {
    /* not a single JSON envelope */
  }
  const re = /\{[\s\S]*?\}/g;
  let last: SynthesisPayload | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    try {
      const p = coerce(JSON.parse(m[0]));
      if (p) last = p;
    } catch {
      /* ignore fragment */
    }
  }
  return last;
}

/** 调用本机 codebuddy CLI（异步；超时 kill） */
function runSynthesisCli(facts: SessionFacts, raw: { records: Record<string, unknown>[] }): Promise<SynthesisPayload | null> {
  return new Promise((resolve) => {
    const bin = resolveBin(BACKEND);
    if (!bin) {
      console.warn(`[synthesis] backend 未找到：${BACKEND}`);
      resolve(null);
      return;
    }
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON_SCHEMA,
      '--system-prompt',
      SYSTEM_PROMPT,
      '--tools',
      '',
      '--no-session-persistence',
    ];
    if (MODEL) args.unshift('--model', MODEL);
    const stdinText = `BEGIN UNTRUSTED SESSION DATA\n${buildInput(facts, raw)}\nEND UNTRUSTED SESSION DATA`;
    let child;
    try {
      child = spawn(bin, args, { env: { ...process.env } });
    } catch (e) {
      console.warn(`[synthesis] spawn 失败：${(e as Error).message}`);
      resolve(null);
      return;
    }
    let out = '';
    let errOut = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (errOut += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      console.warn('[synthesis] CLI 超时');
      resolve(null);
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      console.warn(`[synthesis] CLI error：${e.message}`);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.trim()) {
        console.warn(`[synthesis] CLI 无输出：${errOut.slice(0, 200)}`);
        resolve(null);
        return;
      }
      resolve(parseCli(out));
    });
    try {
      child.stdin?.write(stdinText);
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

// ── background job + 缓存（实现前端 pending 轮询，不阻塞 HTTP 响应）──
const jobs = new Map<string, Promise<void>>();

async function triggerSynthesis(id: string, facts: SessionFacts, raw: { records: Record<string, unknown>[] }): Promise<SynthesisResult> {
  const mtime = facts.mtime ?? 0;
  const jobKey = `${safe(id)}__${mtime}`;
  const cached = readCache(id, mtime);
  if (cached && 'negative' in cached) {
    return { synthesis: null, enabled: true, error: 'synthesis unavailable (negative cache)' };
  }
  if (cached && 'synthesis' in cached) {
    return { synthesis: cached.synthesis, enabled: true };
  }
  if (jobs.has(jobKey)) {
    return { synthesis: null, enabled: true, pending: true };
  }
  const job = (async () => {
    try {
      const payload = await runSynthesisCli(facts, raw);
      writeCache(id, mtime, payload ? { synthesis: payload } : { negative: true });
    } finally {
      jobs.delete(jobKey);
    }
  })();
  jobs.set(jobKey, job);
  return { synthesis: null, enabled: true, pending: true };
}

/**
 * 对外入口：根据开关 / 门槛 / 缓存 / job 状态返回结果。
 *   - 关闭 → { enabled:false, synthesis:null }
 *   - 未过门槛 → { enabled:true, synthesis:null }
 *   - 命中缓存 → 直接返回
 *   - 否则触发后台合成并返回 pending（前端轮询）
 */
export async function getSynthesis(
  id: string,
  facts: SessionFacts,
  raw: { records: Record<string, unknown>[] },
): Promise<SynthesisResult> {
  if (!ENABLED) return { synthesis: null, enabled: false };
  if (!isEligible(facts)) return { synthesis: null, enabled: true };
  return triggerSynthesis(id, facts, raw);
}
