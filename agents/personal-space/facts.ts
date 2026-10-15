/**
 * 会话洞察 · 派生事实层（M1）
 *
 * 输入：discoverSessionMeta() stat-only 发现 + readOneSession() 按需单文件读
 *       （仅缓存未命中的会话才读盘；命中路径零读文件 —— M1 DoD② 索引化缓存）。
 * 产出：每个会话的六类派生事实（四态 / token 成本 / git / FileEdits / Digest / 缓存）。
 *
 * 性能约束（方案阶段 1 DoD）：冷启动全量 ≤ 30s；命中缓存二次 ≤ 1s；单会话成本误差 < 5%。
 * 成本定价：复用 LiteLLM 公开价目表 model_prices.json（MIT，已于本地落地）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverSessionMeta, readOneSession, type ExtractedSession } from './session-facts.ts';
import { stripHarnessWrappers } from '../../MemoryProxy/src/common/session-harness.ts';

// 引擎单一入口：scanOne 供面板 /personal-space/facts 时间线按需单文件读（M1 DoD②）
export { scanOne } from './session-facts.ts';

export type SessionState = 'active' | 'waiting' | 'idle' | 'inactive';

export interface ModelCost {
  model: string;
  input: number;
  output: number;
  costUsd: number;
  /** true=来自本地估算覆盖（混元内部别名不在公开价目表，金额为估算，仅供相对排名） */
  estimated?: boolean;
}

export interface SessionFacts {
  sessionId: string;
  kind: 'top-level' | 'nested';
  parentId?: string;
  vendor: string;
  state: SessionState;
  startedAt?: number;
  endedAt?: number;
  recordCount: number;
  badJson: number;
  size: number;
  mtime: number;
  userTurns: number;
  assistantTurns: number;
  firstPrompt: string;
  /** 会话标题（ai-title 事件），空则前端回退 firstPrompt */
  title: string;
  /** 嵌套会话：从父会话 Agent 调用 description 取的任务名（对齐 coslash subagents.go；B 方案）。空则无 */
  spawnTask: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number };
  costUsd: number;
  /** true=成本含估算模型价目（非官方口径，绝对金额仅供相对排名） */
  costEstimated?: boolean;
  models: ModelCost[];
  git?: { cwd: string; status?: GitStatus; branch?: string; ahead?: number; behind?: number };
  edits: { operations: number; addedLines: number; removedLines: number; files: string[] };
  digest: {
    firstPrompt: number;
    user: number;
    question: number;
    todos: number;
    compaction: number;
    recap: number;
    plan: number;
    subagent: number;
  };
  /** M-B：会话级结构化衍生（后端派生，前端 Inspector 六块消费） */
  debrief?: { goal: string; goalSource?: 'declared' | 'inferred' | 'floor'; outcome: string; keyDecisions: string[] };
  /** v7 · 续会话就绪度派生字段 */
  contextTokens?: number | null;
  contextWindow?: number | null;
  lastEditAt?: number | null;
  baseBranch?: string | null;
  filesChanged?: { path: string; additions: number; deletions: number; edits: number; isNew: boolean }[];
  commits?: { hash: string; message: string; ts: number }[];
  todos?: { subject: string; status: string; completed: boolean }[];
  commands?: { name: string; count: number }[];
  /**
   * S6 · TIMELINE digest 条目（对齐 coslash DigestEntry）：逐条分类 + 描述 + 答案 + turn + 时间。
   * 与 digest 计数对象并存：digest 计数用于顶部 tag，digestEntries 用于 TIMELINE 事件流渲染。
   */
  digestEntries?: DigestEntry[];
}

/** S6 · TIMELINE 条目分类（对齐 coslash 八类） */
export type DigestCategory =
  | 'first_prompt'
  | 'user'
  | 'question'
  | 'todos'
  | 'compaction'
  | 'recap'
  | 'plan'
  | 'subagent';

/** S6 · 单条 TIMELINE 事件（对齐 coslash DigestEntry） */
export interface DigestEntry {
  turn: number;
  category: DigestCategory;
  description: string;
  answer?: string;
  subagentId?: string;
  time?: number;
}

// ── 价目表（懒加载，本地落地）──
const PRICE_PATH = fileURLToPath(new URL('./model_prices.json', import.meta.url));
let PRICES: Record<string, Record<string, number>> | null = null;
function loadPrices(): Record<string, Record<string, number>> | null {
  if (PRICES) return PRICES;
  if (!existsSync(PRICE_PATH)) return null;
  try {
    PRICES = JSON.parse(readFileSync(PRICE_PATH, 'utf-8'));
  } catch {
    PRICES = null;
  }
  return PRICES;
}

function normModel(m: unknown): string | null {
  if (typeof m !== 'string' || !m.trim()) return null;
  let s = m.trim().toLowerCase();
  const i = s.indexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  return s || null;
}

/**
 * 本地价目覆盖（M1 · 成本估算）。
 *
 * 真实数据里 providerData 只带 {"agent":"cli"}，模型名是腾讯混元内部别名
 * （hy3 / hy3-x / hy4-preview），既不在公开 LiteLLM 价目表，也不携带单价。
 * 故这里以【公开混元定价区间】折算成 USD/token 作为近似估算，并在产出里打
 * `estimated` 标记——绝对金额非官方口径，仅供"哪个会话更烧 token / 成本更高"
 * 的相对排名参考。要拿到精确成本，替换本表或接入真实价目 API 即可。
 *
 * 参考（2025 公开口径，¥/M tokens）：hunyuan-TurboS 0.8/2、hunyuan-turbo 2.4/9.6、
 * hunyuan-standard 0.5~0.8/2。FX 取 7.1。
 */
const FX_CNY_USD = 1 / 7.1;
const MODEL_COST_OVERRIDES: Record<string, { input: number; output: number; cacheRead: number }> = {
  // 内部别名 → 近似公开混元中档（turboS 区间）
  hy3: { input: 0.8 * FX_CNY_USD / 1e6, output: 2.0 * FX_CNY_USD / 1e6, cacheRead: 0.08 * FX_CNY_USD / 1e6 },
  'hy3-x': { input: 0.8 * FX_CNY_USD / 1e6, output: 2.0 * FX_CNY_USD / 1e6, cacheRead: 0.08 * FX_CNY_USD / 1e6 },
  // 预览版（更大/更新）→ 取 turbo 区间
  'hy4-preview': { input: 2.4 * FX_CNY_USD / 1e6, output: 9.6 * FX_CNY_USD / 1e6, cacheRead: 0.24 * FX_CNY_USD / 1e6 },
};

/**
 * 上下文窗口本地表（v7 · 续会话就绪度 · 不猜分母）。
 *
 * 会话数据里没有任何窗口字段（全量扫 141 个会话，contextWindow / maxContext /
 * contextLength 等键命中数为 0），只能建本地表。表值以【实测下界】为准：
 *   实测 max(inputTokens) 取每个会话末次请求的最大值，是窗口下界而非窗口本身。
 *
 * 关键决策：只填有实测支撑的模型；其余模型一律返回 null（前端显示「窗口未知」，
 * 不显示百分比）。理由：假精确比「未知」更糟 —— 用户会据百分比判断「还能聊多久」。
 *
 * 标定依据（实测下界）：
 *   hy3 / hy3-x  168k 以内      → 262,144（与 coSlash 截图 24% of 262k 自洽）
 *   hy4-preview  203k（下界）    → 262,144（待校准：已接近边界，后续数据 >262k 需上调）
 *   step-5-preview 193k（下界）  → 262,144（异厂模型，仅近似，待校准）
 *   space-bunny / glm-5.3-flash / deepseek-v4-flash 等 → 不填（unknown）
 */
const MODEL_CONTEXT_OVERRIDES: Record<string, number> = {
  hy3: 262_144,
  'hy3-x': 262_144,
  'hy4-preview': 262_144,
  'step-5-preview': 262_144,
};

function resolveContextWindow(model: string | null): number | null {
  const n = normModel(model);
  if (!n) return null;
  return MODEL_CONTEXT_OVERRIDES[n] ?? null;
}

function resolvePrice(model: string | null): { price: Record<string, number>; estimated: boolean } | null {
  const n = normModel(model);
  if (!n) return null;
  const ov = MODEL_COST_OVERRIDES[n] ?? MODEL_COST_OVERRIDES[n.replace(/^.*\//, '')];
  if (ov) {
    return {
      price: {
        input_cost_per_token: ov.input,
        output_cost_per_token: ov.output,
        cache_read_input_token_cost: ov.cacheRead,
        cache_creation_input_token_cost: 0,
      },
      estimated: true,
    };
  }
  const p = loadPrices();
  if (!p) return null;
  const lit = p[n] ?? p[`openai/${n}`] ?? p[`anthropic/${n}`] ?? p[`google/${n}`];
  return lit ? { price: lit, estimated: false } : null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

function findUsage(rec: Record<string, unknown>): Record<string, unknown> | null {
  const cands = [
    rec.usage,
    rec.message && (rec.message as Record<string, unknown>).usage,
    rec.payload && (rec.payload as Record<string, unknown>).usage,
    rec.payload && (rec.payload as Record<string, unknown>).message && ((rec.payload as Record<string, unknown>).message as Record<string, unknown>).usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).response && ((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).response && ((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).body && (((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).body as Record<string, unknown>).usage,
  ];
  for (const c of cands) if (c && typeof c === 'object') return c as Record<string, unknown>;
  return null;
}

function findModel(rec: Record<string, unknown>): string | null {
  const pd = rec.providerData as Record<string, unknown> | undefined;
  const cands = [
    pd?.model,
    pd?.response?.model,
    rec.model,
    pd?.response?.body?.model,
  ];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

function extractTokens(u: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheCreate: number } {
  // 真实数据字段为驼峰（混元 providerData.usage）：inputTokens / outputTokens / totalTokens，
  // 缓存命中在 inputTokensDetails 数组 [{cached_tokens}] 里。同时兼容 OpenAI 蛇形命名兜底。
  const input = num(u.inputTokens) || num(u.input_tokens) || num(u.prompt_tokens) || num(u.input) || 0;
  const output = num(u.outputTokens) || num(u.output_tokens) || num(u.completion_tokens) || num(u.output) || 0;
  let cacheRead = num(u.cache_read_input_tokens);
  if (!cacheRead) {
    const det = u.inputTokensDetails ?? u.prompt_tokens_details ?? u.input_tokens_details;
    if (Array.isArray(det)) {
      for (const d of det) cacheRead += num((d as Record<string, unknown>)?.cached_tokens);
    } else if (det && typeof det === 'object') {
      const o = det as Record<string, unknown>;
      cacheRead += num(o.cached_tokens) || num(o.cache_read_input_tokens) || 0;
    }
  }
  const cacheCreate = num(u.cache_creation_input_tokens) || 0;
  return { input, output, cacheRead, cacheCreate };
}

function contentText(rec: Record<string, unknown>): string {
  const c = rec.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>).text ?? '') : '')).join(' ');
  return '';
}

function countLines(s: unknown): number {
  if (typeof s !== 'string' || !s) return 0;
  return s.split('\n').length;
}

function extractEdit(rec: Record<string, unknown>): { file: string | null; added: number; removed: number; isNew: boolean } | null {
  if (rec.type !== 'function_call') return null;
  const name = String(rec.name ?? '').toLowerCase();
  if (!/edit|write|replace|multiedit|update|create|notebook/i.test(name)) return null;
  let p = rec.parameters ?? rec.args ?? rec.input ?? rec.arguments;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return null; }
  }
  if (!p || typeof p !== 'object') return null;
  const pp = p as Record<string, unknown>;
  const file = (pp.file_path ?? pp.path ?? pp.filename ?? null) as string | null;
  const oldS = (pp.old_string ?? pp.oldString ?? '') as string;
  const newS = (pp.new_string ?? pp.newString ?? pp.content ?? '') as string;
  // 以 function_call 参数为准（方案：FileEdits 以解析参数为主、snapshot 为辅）
  // isNew：显式 create/new_file/notebook 事件；或 write/edit 且无 old_string（整文件新建/覆盖）
  const isNew =
    /(^|[^a-z])(create|new_file|notebook)([^a-z]|$)/i.test(name) ||
    (/(^|[^a-z])write([^a-z]|$)/i.test(name) && !oldS && !!newS);
  return { file: typeof file === 'string' ? file : null, added: countLines(newS), removed: countLines(oldS), isNew };
}

/**
 * v7 · OUTCOME 取「最后一条 recap」：不以工具调用收尾的终版文本回复。
 * 工具调用类中间态（stop=tool_use / 内容含 tool_use 块）不算；太短的包裹残留也不算。
 */
function assistantRecap(rec: Record<string, unknown>, raw: string, stripped: string): string | null {
  const msg = (rec.message ?? rec.payload ?? null) as Record<string, unknown> | null;
  const stop = String((msg?.stopReason ?? msg?.stop_reason ?? rec.stopReason ?? rec.stop_reason) ?? '').toLowerCase();
  if (/tool_use|tool_result|function_call/i.test(stop)) return null;
  const c = msg?.content ?? rec.content;
  if (Array.isArray(c)) {
    const hasTool = c.some(
      (b) => b && typeof b === 'object' && /tool_use|tool_result|function_call/i.test(String((b as Record<string, unknown>).type)),
    );
    if (hasTool) return null;
  }
  const t = stripped.trim();
  if (t.length < 30) return null;
  return t.slice(0, 2000);
}

function classifyDigest(rec: Record<string, unknown>): string | null {
  const type = String(rec.type ?? '');
  // 注意：parentId 是通用字段（~94% 记录都有），绝不能当作子代理标记，否则会严重虚高。
  // 子代理只认真实类型标记（数据中暂无 subagent_result 类型，故该分类在真实数据下为 0，符合预期）。
  if (/compaction|context_summary|auto_compact/i.test(type)) return 'compaction';
  // v7：真实压缩事件常写在 user 消息正文的 <cb_summary> / <conversation_history_summary> 包裹内，
  // 仅靠 type 正则会系统性漏计；此处补「正文包裹」并集（与 type 正则取并集去重）。
  const raw = contentText(rec);
  if (/<(?:cb_summary|conversation_history_summary|context_summary|auto_compact)[^>]*>/i.test(raw)) return 'compaction';
  if (/^recap$|summary|chat_summary/i.test(type)) return 'recap';
  if (type === 'subagent_result' || type === 'subagent') return 'subagent';
  const name = String(rec.name ?? '').toLowerCase();
  if (/todo/i.test(name)) return 'todos';
  if (/plan|exitplanmode/i.test(name)) return 'plan';
  if (rec.role === 'user') {
    const c = contentText(rec).trim();
    if (/\?$/.test(c) || /[？]|如何|怎么|为什么|是否|能否|什么|哪些/.test(c)) return 'question';
    return 'user';
  }
  return null;
}

// ── M-B：function_call 参数解析 + Task* 事件归并（todos 列表）──
function parseToolArgs(rec: Record<string, unknown>): Record<string, unknown> | null {
  let p = rec.parameters ?? rec.args ?? rec.input ?? rec.arguments;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}

/**
 * 把一次 TaskCreate/TaskUpdate/TodoWrite 事件归并进 todos 列表（last-write-wins）。
 * 归并键优先 subject（Create/Update 通常都带），其次 taskId（部分 Update 仅带 taskId）。
 * 注意：ToolCreate 的 taskId 由工具运行时分配、不在 params 里，故 Create→Update 靠 taskId
 * 跨事件关联在原始记录里往往不成立；此时 Update 若无 subject 无法定位 → 跳过（避免 untitled 噪声）。
 */
function applyTodo(
  args: Record<string, unknown>,
  name: string,
  map: Map<string, { subject: string; status: string; completed: boolean; taskId?: string }>,
  order: string[],
): void {
  if (Array.isArray(args.todos)) {
    for (const it of args.todos as Record<string, unknown>[]) {
      const subject = String(it.content ?? it.subject ?? '').trim();
      if (!subject) continue;
      const status = String(it.status ?? 'pending');
      const completed = status === 'completed' || !!it.completed;
      const key = `subj:${subject}`;
      map.set(key, { subject, status, completed });
      if (!order.includes(key)) order.push(key);
    }
    return;
  }
  const subject = String(args.subject ?? args.content ?? '').trim();
  const id = args.taskId ?? args.id;
  if (/update/i.test(name)) {
    // 先按 subject，再按 taskId 找已有条目
    let target = subject ? map.get(`subj:${subject}`) : undefined;
    if (!target && id) {
      for (const e of map.values()) if (e.taskId === id) { target = e; break; }
    }
    if (!target) return; // 无 subject/taskId 无法定位 → 跳过（避免 untitled 噪声）
    target.status = String(args.status ?? target.status);
    target.completed = args.completed != null ? !!args.completed : target.status === 'completed';
    if (subject) target.subject = subject;
    return;
  }
  // create / todo：归并键优先 subject，其次 taskId
  const key = subject ? `subj:${subject}` : id ? `id:${id}` : null;
  if (!key) return;
  const entry: { subject: string; status: string; completed: boolean; taskId?: string } = {
    subject: subject || 'untitled',
    status: String(args.status ?? 'pending'),
    completed: !!args.completed,
  };
  if (id) entry.taskId = id;
  map.set(key, entry);
  if (!order.includes(key)) order.push(key);
}

// ── 状态机（基于文件 mtime 的启发式；实时进程探测留待后续增强）──
function stateFromMtime(mtime: number): SessionState {
  const dt = Date.now() - mtime;
  if (dt < 5 * 60_000) return 'active';
  if (dt < 60 * 60_000) return 'waiting';
  if (dt < 24 * 60 * 60_000) return 'idle';
  return 'inactive';
}

// ── git ahead/behind（按 cwd 去重 + TTL 缓存）──
// git 结果按 cwd 缓存；TTL 内复用零 spawn，超时才重新探（M1 DoD②：warm 路径不再每次全量 spawn）。
// 旧实现每次调用都清空重算（12 个 cwd × 最多 3 次 spawnSync ≈ 200ms），是指标未过的第二因素。
/**
 * git 查询三态（R3 修复）：
 *  - ok           正常返回（含 branch/ahead/behind）
 *  - not-repo     合法非 git 仓库（git 明确返回 not a git repository，如普通项目目录）
 *  - unavailable  环境受限（git spawn 失败/超时/被拦截，如沙箱屏蔽 .git、容器未挂载、git 未安装）
 * unavailable 与 not-repo 必须区分：前者是环境问题（可能恢复），后者是稳定事实。
 */
export type GitStatus = 'ok' | 'not-repo' | 'unavailable';

export interface GitInfo {
  cwd: string;
  status: GitStatus;
  branch?: string;
  /** v7：与上游比较的基准分支（@{upstream} 名，无上游时回退到 branch 名） */
  baseBranch?: string;
  ahead?: number;
  behind?: number;
  /** M-B：最近若干条提交（git log -n 20），仅 status=ok 时有 */
  commits?: { hash: string; message: string; ts: number }[];
}
interface GitCacheEntry {
  ts: number;
  result: GitInfo | null;
}
const GIT_CACHE = new Map<string, GitCacheEntry | null>();
/** git 状态 TTL：会话文件写盘频繁，10 分钟足够新；超时才重新 spawn */
const GIT_TTL_MS = 10 * 60_000;
/** 本次 computeAllSessions 内实际发生的 git spawn 次数（用于判断是否需要持久化缓存） */
let _gitSpawnsThisRun = 0;

function gitState(cwd: string): GitInfo {
  const inside = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 3000 });
  // spawn 本身失败（git 不存在/被安全策略拦截/超时）→ 环境受限，与"不是仓库"严格区分
  if (inside.error || inside.signal) return { cwd, status: 'unavailable' };
  if (inside.status !== 0) {
    const err = (inside.stderr ?? '').toString();
    if (/not a git repository/i.test(err)) return { cwd, status: 'not-repo' };
    // 其他非零退出（权限/cannot change to/被拦截等）→ 环境受限
    return { cwd, status: 'unavailable' };
  }
  const br = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 });
  const branch = br.status === 0 ? br.stdout.toString().trim() : undefined;
  // v7：上游基准分支（用于就绪度 Branch 格「behind {base}」），无上游回退到 branch 名
  const up = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', '@{upstream}'], { timeout: 3000 });
  const baseBranch = up.status === 0 ? up.stdout.toString().trim() || branch : branch;
  let ahead: number | undefined;
  let behind: number | undefined;
  const lr = spawnSync('git', ['-C', cwd, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { timeout: 3000 });
  if (lr.status === 0) {
    const [a, b] = lr.stdout.toString().trim().split(/\s+/).map(Number);
    ahead = a;
    behind = b;
  } else {
    const st = spawnSync('git', ['-C', cwd, 'status', '-sb'], { timeout: 3000 });
    if (st.status === 0) {
      const m = st.stdout.toString().match(/ahead (\d+).*behind (\d+)/);
      if (m) { ahead = +m[1]; behind = +m[2]; }
    }
  }
  // M-B：git log 最近 20 条提交（status=ok 才探；失败/空仓/无 → commits 留空）
  let commits: { hash: string; message: string; ts: number }[] | undefined;
  const lg = spawnSync('git', ['-C', cwd, 'log', '-n', '20', '--format=%H%x1f%s%x1f%ct'], { timeout: 3000 });
  if (lg.status === 0) {
    commits = lg.stdout
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const p = line.split('\x1f');
        const ts = Number(p[2]) * 1000; // %ct 为秒 → 转 ms 与 timeline 一致
        return { hash: p[0] ?? '', message: p[1] ?? '', ts: Number.isFinite(ts) ? ts : 0 };
      });
  }
  return { cwd, status: 'ok', branch, baseBranch, ahead, behind, commits };
}

/** 解析 git 状态：命中 TTL 缓存零 spawn；未命中/过期才 spawn 并回写 GIT_CACHE */
function resolveGit(cwd: string): GitInfo | null {
  const hit = GIT_CACHE.get(cwd);
  if (hit && Date.now() - hit.ts < GIT_TTL_MS) return hit.result;
  const result = gitState(cwd);
  GIT_CACHE.set(cwd, { ts: Date.now(), result });
  _gitSpawnsThisRun++;
  return result;
}

const CWD_KEYS = new Set(['cwd', 'project', 'workingdir', 'workingdirectory', 'workspace', 'repo', 'projectpath']);
function extractCwd(rec: Record<string, unknown>): string | null {
  const walk = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (CWD_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) {
        // R3: no existsSync precondition - a historical cwd stays informative even if the
        // directory was deleted or is not mounted; the precondition only causes false
        // negatives under sandbox broker / containers / mount namespaces.
        // Accessibility is judged by gitState tri-state (ok/not-repo/unavailable).
        return v.trim();
      }
      if (typeof v === 'object' && v !== null) {
        const r = walk(v);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(rec);
}

/* ===================== v7 · 续会话就绪度（Resume or hand off） =====================
 * 阈值集中此处，前端只渲染颜色（设计文档 §3.2 / §3.4）。
 * 复刻 coSlash sessionReadiness 的判定链：compactions ≥ 2 / headroom < 2 → fresh；
 * headroom ≥ 5 → resume；否则 inspect；窗口未知 → inspect（不猜 headroom）。
 */
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

const TOKENS_PER_TURN = 18_400;
const USABLE_WINDOW = 0.85;
const FRESH_TURNS = 2;
const RESUME_TURNS = 5;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)} sec`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} hr`;
  const d = h / 24;
  return `${Math.round(d)} day${d >= 2 ? 's' : ''}`;
}

function fillTone(pct: number): ReadinessTone {
  if (pct >= 85) return 'danger';
  if (pct >= 65) return 'warn';
  return 'ok';
}
function driftTone(behind: number): ReadinessTone {
  if (behind > 15) return 'danger';
  if (behind > 5) return 'warn';
  return 'ok';
}
function staleTone(ageMs: number): ReadinessTone {
  if (ageMs > 72 * HOUR) return 'danger';
  if (ageMs > 3 * HOUR) return 'warn';
  return 'ok';
}

function computeVerdict(compactions: number, standingTurns: number | null): ReadinessVerdict {
  if (compactions >= 2) return 'fresh';
  if (standingTurns == null) return 'inspect';
  if (standingTurns < FRESH_TURNS) return 'fresh';
  if (standingTurns >= RESUME_TURNS) return 'resume';
  return 'inspect';
}

export function buildReadiness(
  facts: SessionFacts,
  now: number = Date.now(),
): { readiness: Readiness; verdict: ReadinessVerdict } {
  // Context used
  const used = facts.contextTokens ?? null;
  const window = facts.contextWindow ?? null;
  let context: ReadinessCell;
  let standingTurns: number | null = null;
  if (used == null) {
    context = { value: '—', tone: null };
  } else if (window == null) {
    // 优化点 1：窗口未知不显示百分比，只给绝对值
    context = { value: `${fmtTokens(used)} used · 窗口未知`, tone: null };
  } else {
    const pct = Math.round((used / window) * 100);
    context = { value: `${pct}% of ${fmtTokens(window)}`, tone: fillTone(pct) };
    const tokensPerTurn = Math.min(TOKENS_PER_TURN, (window * USABLE_WINDOW) / RESUME_TURNS);
    standingTurns = Math.max(0, Math.floor((window * USABLE_WINDOW - used) / tokensPerTurn));
  }

  // Compactions（不配色，只出数值）
  const compactions = facts.digest.compaction;

  // Branch
  const git = facts.git;
  let branch: ReadinessCell;
  if (!git || git.status === 'unavailable') {
    branch = { value: git?.status === 'unavailable' ? 'git 环境受限' : '—', tone: null };
  } else if (git.status === 'not-repo') {
    branch = { value: '非 git 仓库', tone: null };
  } else {
    const base = git.baseBranch ?? git.branch ?? '';
    const ahead = git.ahead ?? 0;
    const behind = git.behind ?? 0;
    branch = { value: `${ahead} ahead, ${behind} behind ${base}.`, tone: driftTone(behind) };
  }

  // Working tree（lastEditAt）
  const lastEditAt = facts.lastEditAt ?? null;
  let workspace: ReadinessCell;
  if (lastEditAt == null) {
    workspace = { value: '—', tone: null };
  } else {
    const age = now - lastEditAt;
    workspace = { value: `Last edit ${timeAgo(lastEditAt)}.`, tone: staleTone(age) };
  }

  // Prompt cache（纯由 mtime 推，双窗）
  const at = facts.mtime ?? null;
  let cache: CacheReadiness;
  if (at == null) {
    cache = { warm: false, within5m: false, within1h: false, at: null, tone: null };
  } else {
    const age = now - at;
    const within5m = age <= 5 * MIN;
    const within1h = age <= HOUR;
    cache = { warm: within1h, within5m, within1h, at, tone: within1h ? 'ok' : 'warn' };
  }

  const verdict = computeVerdict(compactions, standingTurns);
  return {
    readiness: {
      context,
      compactions: { value: String(compactions), tone: null },
      branch,
      workspace,
      cache,
    },
    verdict,
  };
}

export function buildFacts(session: ExtractedSession, raw: { records: Record<string, unknown>[] }): SessionFacts {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  const modelMap = new Map<string, ModelCost>();
  let userTurns = 0;
  let assistantTurns = 0;
  const edits = { operations: 0, addedLines: 0, removedLines: 0, files: [] as string[] };
  const digest = { firstPrompt: session.firstPrompt ? 1 : 0, user: 0, question: 0, todos: 0, compaction: 0, recap: 0, plan: 0, subagent: 0 };
  let cwd: string | null = null;
  let costEstimated = false;

  // M-B 累加器：逐文件变更 / todos / commands / debrief 首末文本
  const fileMap = new Map<string, { additions: number; deletions: number; edits: number; isNew: boolean }>();
  const todoMap = new Map<string, { subject: string; status: string; completed: boolean; taskId?: string }>();
  const todoOrder: string[] = [];
  const cmdMap = new Map<string, number>();
  let firstUserText = '';
  let lastAssistantText = '';
  // v7：续会话就绪度 / 简报派生累加器
  let lastInputTokens = 0; // 末次请求 inputTokens（上下文占用）
  let lastUsageModel: string | null = null; // 末次 usage 对应的模型（用于取窗口）
  let firstRealUserText = ''; // GOAL floor：跳过压缩摘要机器文本的首条真实用户提问
  let lastRecapText = ''; // OUTCOME：最后一条非工具调用的终版回复
  let lastEditTs: number | null = null; // lastEditAt 回退值：末条 Edit/Write 记录时间戳
  const editedFilePaths = new Set<string>(); // 用于 fs stat 取最大 mtime
  // S6 · TIMELINE digest 条目累加器
  let turnNo = 0; // 对话轮次：每条 user 消息 +1；其余事件沿用当前轮次
  const digestEntries: DigestEntry[] = [];
  let lastQuestionIdx: number | null = null; // 待回填 answer 的 question 条目下标
  // 按 ts 排序，保证 debrief（首/末）与 todos（last-write-wins）语义正确
  const tsOfRec = (r: Record<string, unknown>): number => {
    const v = (r.timestamp ?? r.ts) as unknown;
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const d = Date.parse(v);
      return Number.isNaN(d) ? 0 : d;
    }
    return 0;
  };
  const recs = (raw.records as Record<string, unknown>[]).slice().sort((a, b) => tsOfRec(a) - tsOfRec(b));

  for (const r of recs) {
    const rec = r as Record<string, unknown>;
    if (typeof rec.role === 'string') {
      if (rec.role === 'user') {
        userTurns++;
        turnNo++; // S6 · 每个 user 消息 = 一个对话轮次
        const raw = contentText(rec);
        const stripped = stripHarnessWrappers(raw);
        if (!firstUserText) firstUserText = stripped;
        // v7 · B1 修复兜底：GOAL floor 跳过被压缩摘要淹没的首条 user 记录
        const isSummary = /<(?:cb_summary|conversation_history_summary|context_summary|auto_compact)[^>]*>/i.test(raw);
        if (!firstRealUserText && stripped.trim().length > 5 && !isSummary) firstRealUserText = stripped.trim();
      } else if (rec.role === 'assistant') {
        assistantTurns++;
        const raw = contentText(rec);
        const stripped = stripHarnessWrappers(raw);
        lastAssistantText = stripped;
        const recap = assistantRecap(rec, raw, stripped);
        if (recap) lastRecapText = recap;
      }
    }
    if (!cwd) {
      const c = extractCwd(rec);
      if (c) cwd = c;
    }
    // 成本
    const usage = findUsage(rec);
    if (usage) {
      const t = extractTokens(usage);
      const model = findModel(rec);
      // v7 · 末次请求的上下文占用（覆盖写，recs 已按 ts 升序，最后一条 win）
      lastInputTokens = t.input;
      lastUsageModel = model;
      tokens.input += t.input;
      tokens.output += t.output;
      tokens.cacheRead += t.cacheRead;
      tokens.cacheCreate += t.cacheCreate;
      if (model) {
        const rp = resolvePrice(model);
        const price = rp?.price ?? null;
        const estimated = rp?.estimated ?? false;
        const cost =
          (t.input * (price?.input_cost_per_token ?? 0)) +
          (t.output * (price?.output_cost_per_token ?? 0)) +
          (t.cacheRead * (price?.cache_read_input_token_cost ?? 0)) +
          (t.cacheCreate * (price?.cache_creation_input_token_cost ?? 0));
        if (estimated) costEstimated = true;
        const mk = normModel(model) ?? model;
        const prev = modelMap.get(mk) ?? { model: mk, input: 0, output: 0, costUsd: 0, estimated };
        prev.input += t.input;
        prev.output += t.output;
        prev.costUsd += cost;
        if (estimated) prev.estimated = true;
        modelMap.set(mk, prev);
      }
    }
    // FileEdits（保留原 edits 汇总，并聚合到逐文件 filesChanged）
    const ed = extractEdit(rec);
    if (ed) {
      edits.operations++;
      edits.addedLines += ed.added;
      edits.removedLines += ed.removed;
      lastEditTs = tsOfRec(rec); // v7：lastEditAt 回退值 = 末条 Edit/Write 时间戳
      if (ed.file) {
        editedFilePaths.add(ed.file); // v7：用于 fs stat 取最大 mtime
        if (!edits.files.includes(ed.file)) edits.files.push(ed.file);
        const cur = fileMap.get(ed.file) ?? { additions: 0, deletions: 0, edits: 0, isNew: false };
        cur.additions += ed.added;
        cur.deletions += ed.removed;
        cur.edits += 1;
        if (ed.isNew) cur.isNew = true;
        fileMap.set(ed.file, cur);
      }
    }
    // M-B：function_call 名称聚合（commands）+ Task* 事件（todos）
    if (rec.type === 'function_call') {
      const cn = String(rec.name ?? '');
      if (cn) cmdMap.set(cn, (cmdMap.get(cn) ?? 0) + 1);
      if (/taskcreate|taskupdate|todo/i.test(cn)) {
        const a = parseToolArgs(rec);
        if (a) applyTodo(a, cn, todoMap, todoOrder);
      }
    }
    // Digest（计数 + S6 TIMELINE 条目）
    const rawText = contentText(rec);
    const strippedText = stripHarnessWrappers(rawText);
    const cat = classifyDigest(rec);
    if (cat) {
      if (cat === 'user') digest.user++;
      else if (cat === 'question') digest.question++;
      else if (cat === 'todos') digest.todos++;
      else if (cat === 'compaction') digest.compaction++;
      else if (cat === 'recap') digest.recap++;
      else if (cat === 'plan') digest.plan++;
      else if (cat === 'subagent') digest.subagent++;

      const ts = tsOfRec(rec) || null;
      let desc = '';
      if (cat === 'user' || cat === 'question' || cat === 'compaction') desc = strippedText;
      else if (cat === 'recap') desc = assistantRecap(rec, rawText, strippedText) ?? strippedText;
      else if (cat === 'plan') {
        const a = parseToolArgs(rec);
        desc = a?.plan ? String(a.plan) : rawText || 'Plan mode';
      } else if (cat === 'todos') desc = `Todos updated (${todoOrder.length} items)`;
      else if (cat === 'subagent') desc = String(rec.name ?? rec.id ?? 'Subagent');
      const entry: DigestEntry = {
        turn: turnNo,
        category: cat as DigestCategory,
        description: desc.replace(/\s+/g, ' ').trim().slice(0, 500),
      };
      if (ts) entry.time = ts;
      if (cat === 'subagent' && rec.id) entry.subagentId = String(rec.id);
      digestEntries.push(entry);
      if (cat === 'question') lastQuestionIdx = digestEntries.length - 1;
      // S6 · question→answer 回填：本条 recap 作为上一 question 的答案
      if (cat === 'recap' && lastQuestionIdx !== null) {
        const ans = assistantRecap(rec, rawText, strippedText);
        if (ans) {
          digestEntries[lastQuestionIdx].answer = ans.replace(/\s+/g, ' ').trim().slice(0, 1000);
          lastQuestionIdx = null;
        }
      }
    }
  }

  // S6 · 置顶 FIRST PROMPT 条目（turn 1），与计数对象的 firstPrompt 语义对齐
  const fpText = firstRealUserText || firstUserText || session.firstPrompt || '';
  if (fpText) {
    digestEntries.unshift({
      turn: 1,
      category: 'first_prompt',
      description: fpText.replace(/\s+/g, ' ').trim().slice(0, 500),
      time: session.startedAt ?? null,
    });
  }
  // S6 · 上限保护：超大会话截断到 600 条（保留首条在前），避免 payload 爆炸
  if (digestEntries.length > 600) digestEntries.length = 600;

  // M-B：派生 filesChanged / todos / commands / debrief
  const filesChanged = [...fileMap.entries()]
    .map(([path, v]) => ({ path, additions: v.additions, deletions: v.deletions, edits: v.edits, isNew: v.isNew }))
    .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
  const todos = todoOrder.map((k) => todoMap.get(k)!).filter((t) => t && t.subject.trim());
  const commands = [...cmdMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const debrief = {
    // v7 · B1 修复：GOAL 优先真实首问（跳过压缩摘要机器文本），源标记为 floor（合成未启用时）
    goal: (firstRealUserText || firstUserText || session.firstPrompt || '').slice(0, 2000),
    goalSource: 'floor' as const,
    // v7 · B2 修复：OUTCOME 优先「最后一条 recap」，否则末条助手文本
    outcome: (lastRecapText || lastAssistantText || '').slice(0, 2000),
    keyDecisions: [] as string[],
  };

  // v7 · 续会话就绪度派生
  const contextTokens = lastInputTokens || null;
  const contextWindow = resolveContextWindow(lastUsageModel);
  // lastEditAt：优先编辑文件 stat 最大 mtime；回退末条 Edit/Write 时间戳
  let lastEditAt: number | null = null;
  for (const p of editedFilePaths) {
    try {
      const mt = statSync(p).mtimeMs;
      if (lastEditAt == null || mt > lastEditAt) lastEditAt = mt;
    } catch {
      /* 文件已删除 / 不可访问：跳过 */
    }
  }
  if (lastEditAt == null && lastEditTs != null) lastEditAt = lastEditTs;

  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
  const costUsd = [...modelMap.values()].reduce((a, m) => a + m.costUsd, 0);

  // git：cwd 来自本会话记录；resolveGit 内部按 cwd TTL 缓存去重（跨进程重启保留，见 facts 缓存）
  const git = cwd ? (resolveGit(cwd) ?? undefined) : undefined;

  return {
    sessionId: session.sessionId,
    kind: session.kind,
    parentId: session.parentId,
    vendor: session.vendor,
    state: stateFromMtime(session.mtime),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    recordCount: session.recordCount,
    badJson: session.badJson,
    size: session.size,
    mtime: session.mtime,
    userTurns,
    assistantTurns,
    firstPrompt: session.firstPrompt,
    title: session.title,
    spawnTask: session.spawnTask ?? '',
    tokens,
    costUsd,
    costEstimated: costEstimated || undefined,
    models: [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    git: session.kind === 'top-level' ? git : undefined,
    edits,
    digest,
    debrief,
    contextTokens,
    contextWindow,
    lastEditAt,
    baseBranch: git?.baseBranch ?? null,
    filesChanged,
    commits: git?.commits,
    todos,
    commands,
    digestEntries,
  };
}

export interface ComputeResult {
  facts: SessionFacts[];
  cached: number;
  rebuilt: number;
  coldMs: number;
}

const CACHE_DIR = join(homedir(), '.workbuddy', 'agent-memory-personal-space-cache');
const CACHE_FILE = join(CACHE_DIR, 'facts-cache.json');

interface CacheEntry {
  mtime: number;
  size: number;
  facts: SessionFacts;
}

interface FactsCache {
  entries: Record<string, CacheEntry>;
  /** git 状态按 cwd 的 TTL 缓存（M1 DoD②：warm 路径零 spawn；缺省视为空） */
  gitByCwd?: Record<string, GitCacheEntry>;
}

/**
 * 派生事实 schema/算法版本。算法或字段变更时 +1，旧缓存自动失效全量重建。
 * v5 = git 三态（R3）：GitInfo.status = ok/not-repo/unavailable；
 *      extractCwd 去掉 existsSync 前置；gitByCwd 持久化排除 unavailable（环境临时状态不固化）。
 * v6 = M-B 后端扩展：SessionFacts 新增 debrief / filesChanged / commits / todos / commands
 *      （逐文件 diffstat、git log、Task* 事件、function_call 聚合）。
 * v7 = 续会话就绪度（debrief-handoff-completion）：SessionFacts 新增 contextTokens /
 *      contextWindow / lastEditAt / baseBranch / debrief.goalSource；compaction 口径三态并集；
 *      readiness 语义与阈值集中到 buildReadiness（引擎侧计算 tone，前端只渲染颜色）。
 * v8 (2026-10-14): 新增 S6 TIMELINE digest 条目（digestEntries: DigestEntry[]），schema 变更，升版本失效旧缓存。
 */
const FACTS_CACHE_VERSION = 8;

function loadCache(): FactsCache {
  try {
    if (!existsSync(CACHE_FILE)) return { entries: {} };
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as FactsCache & { version?: number };
    if (!parsed || parsed.version !== FACTS_CACHE_VERSION || typeof parsed.entries !== 'object') {
      return { entries: {} };
    }
    return { entries: parsed.entries, gitByCwd: parsed.gitByCwd };
  } catch {
    return { entries: {} };
  }
}

function saveCache(cache: FactsCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ version: FACTS_CACHE_VERSION, ...cache }));
  } catch (e) {
    console.warn(`[warn] 写入 facts 缓存失败：${(e as Error).message}`);
  }
}

/**
 * 全量计算派生事实（M1 DoD② 索引化路径）：
 *
 *   useCache=true  → discoverSessionMeta() stat-only 发现（~10ms，零读文件）；
 *                    逐会话比对 mtime+size，命中直接复用缓存 facts（零读盘），
 *                    未命中才 readOneSession() 单文件读 + buildFacts。
 *                    git 状态按 cwd TTL 缓存，warm 路径零 spawn。
 *   useCache=false → 同一发现逻辑，但强制全部重读重建（冷启动 / 算法变更后的全量刷新）。
 *
 * 缓存仅在确有变动（rebuilt>0 或 git 刷新）时写盘，纯命中零 IO。
 */
export function computeAllSessions(useCache = true): ComputeResult {
  const t0 = Date.now();
  _gitSpawnsThisRun = 0;

  // ① stat-only 发现：walk + stat，不读任何文件内容
  const metas = discoverSessionMeta('workbuddy');
  const topLevelKeys = new Set(metas.filter((m) => m.kind === 'top-level').map((m) => m.sessionId));

  // ② 装载缓存（facts 条目 + git TTL 缓存）；git TTL 缓存播种进 GIT_CACHE，
  //    过期条目由 resolveGit 按需重算，未过期则零 spawn
  const cache = useCache ? loadCache() : { entries: {} };
  GIT_CACHE.clear();
  for (const [cwd, e] of Object.entries(cache.gitByCwd ?? {})) GIT_CACHE.set(cwd, e);

  const cacheNext: Record<string, CacheEntry> = {};
  const facts: SessionFacts[] = [];
  let cached = 0;
  let rebuilt = 0;

  for (const m of metas) {
    const prev = cache.entries[m.sessionId];
    if (useCache && prev && prev.mtime === m.mtime && prev.size === m.size) {
      // 命中：facts 直接复用，零读盘。git 超 TTL 才刷新（仅顶层带 git 的会话）
      const f = prev.facts;
      const cwd = f.git?.cwd;
      if (cwd) {
        const e = GIT_CACHE.get(cwd);
        if (!e || Date.now() - e.ts >= GIT_TTL_MS) {
          const r = resolveGit(cwd);
          f.git = r ? { ...r, cwd } : undefined;
        }
      }
      facts.push(f);
      cacheNext[m.sessionId] = prev;
      cached++;
      continue;
    }
    // 未命中（新会话 / 文件变动 / 无缓存）：只读这一个文件
    const sc = readOneSession(m, topLevelKeys);
    const nf = buildFacts(sc.session, sc.raw);
    facts.push(nf);
    cacheNext[m.sessionId] = { mtime: m.mtime, size: m.size, facts: nf };
    rebuilt++;
  }

  // ③ 持久化：仅在确有变动时写盘（纯命中零 IO）；git TTL 缓存随 facts 一起落盘
  if (useCache && (rebuilt > 0 || _gitSpawnsThisRun > 0)) {
    const gitByCwdOut: Record<string, GitCacheEntry> = {};
    for (const [cwd, e] of GIT_CACHE) {
      if (!e) continue;
      // unavailable is a transient environment state (.git blocked / timeout / git missing), never persisted -
      // otherwise a recovered environment would still read the stale unavailable result after restart;
      // not-repo is a stable fact and persists normally.
      if (e.result?.status === 'unavailable') continue;
      gitByCwdOut[cwd] = e;
    }
    saveCache({ entries: cacheNext, gitByCwd: gitByCwdOut });
  }
  return { facts, cached, rebuilt, coldMs: Date.now() - t0 };
}
