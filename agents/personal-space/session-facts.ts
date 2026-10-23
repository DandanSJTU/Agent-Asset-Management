/**
 * 会话洞察 · 派生事实层入口（M0）
 *
 * 设计要点（对齐 personal-space-plan.html 阶段 0）：
 *   - readRawRecords 已并入 agents/asset-import.ts，这里直接复用，不重复扫盘。
 *   - 注册表当前含 workbuddy（本机占 98.7% 数据量）与 codex（ChatGPT Work / Codex
 *     本地 rollout，~/.codex/sessions）。其余 vendor 样本不足时按同样的体检流程接入即可，
 *     扩展位保留（见方案 P2 / P9）。
 *   - 子代理归因：优先用行内 parentId（覆盖率极高），并辅以「路径即父子」的确定性兜底，
 *     不学 coslash 让 ParentIDFromPath 恒返回 "" 把嵌套会话渲染成孤儿。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { readRawRecords, type RawRecordFile } from '../asset-import.ts';
// 会话层「注入内容剥离」共用工具（coslash 优化点②落地）：五家 vendor 的首问 /
// 用户输入 harness 包裹剥离统一走这里，新增 harness 标签只改该文件一处。
import {
  stripHarnessWrappers,
  sanitizeFirstPromptForDisplay,
} from '../../MemoryProxy/src/common/session-harness.ts';
// 非 workbuddy vendor 的会话抽取器（ChatGPT Work / Codex 等）。
import { makeCodexExtractor, normalizeCodexRecords } from './codex-extractor.ts';

export type SessionKind = 'top-level' | 'nested';

export interface ExtractedSession {
  /** 稳定会话 ID：顶层 = `<slug>/<uuid>`，嵌套 = 相对 projects 的路径（去扩展名） */
  sessionId: string;
  vendor: string;
  kind: SessionKind;
  path: string;
  /** 嵌套会话：经 parentId / 路径解析出的父会话 sessionId */
  parentId?: string;
  /** 嵌套会话：记录中实际读到的 parentId 字段值（用于佐证归因可行） */
  rawParentId?: string;
  size: number;
  mtime: number;
  /** 原始事件条数（不含坏行） */
  recordCount: number;
  badJson: number;
  firstPrompt: string;
  /** 会话标题：转录中 type:"ai-title" 事件的 aiTitle 字段（客户端生成，后写覆盖先写）；无则空串 */
  title: string;
  /** 嵌套会话：从父会话 Agent 调用的 description 取的任务名（对齐 coslash subagents.go；B 方案）。无则空串 */
  spawnTask: string;
  startedAt?: number;
  endedAt?: number;
}

export interface SessionExtractor {
  vendor: string;
  /** 发现并提取本机该 vendor 的全部会话（只读，不写任何 store） */
  discover(): ExtractedSession[];
}

const TS_KEYS = new Set(['ts', 'timestamp', 'time', 'created_at', 'createdAt', 'datetime', 'date', 'sentat']);

function extractTimestamps(rec: Record<string, unknown>): number[] {
  const out: number[] = [];
  const scan = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (TS_KEYS.has(key)) {
        let d = NaN;
        if (typeof v === 'string') d = Date.parse(v);
        else if (typeof v === 'number') d = v < 1e12 ? v * 1000 : v;
        if (!Number.isNaN(d)) out.push(d);
      }
      if (typeof v === 'object' && v !== null) scan(v);
    }
  };
  scan(rec);
  return out;
}

/**
 * 首问字符上限（与历史 firstPrompt 上限一致）。超过即截断，配合
 * sanitizeFirstPromptForDisplay 的首行 + 内网路径/ token 抹除，防无 ai-title 时
 * 列表露出内网路径 / 长日志（coslash 优化点④）。
 */
const FIRST_PROMPT_MAX = 80;

/**
 * 从父会话原始记录里取「派生出本嵌套会话」的 Agent 调用任务名（B 方案，对齐 coslash subagents.go 的
 * cmp.Or(spawn.Task, …, firstPrompt)）。
 *
 * 关联键（已用真实转录验证）：父会话的 Agent / Task 工具调用（type ∈ {function_call, tool_use}，
 * arguments 为 JSON 字符串）其 arguments.prompt 等于子会话的首条 user 消息文本——WorkBuddy 把 parent
 * 的 prompt 直接作为子代理首轮输入。因此用 childFirstUser（已去 harness 包裹、trim）与父 prompt 做
 * 精确 / 前缀匹配，命中即返回 arguments.description（即给人看的任务名，如「探索存储层检索实现」）。
 *
 * 返回空串表示未关联到（父会话无 Agent 调用 / 关联失败），调用方回退到 firstPrompt。
 */
export function extractParentSpawnTask(childFirstUser: string, parentRaw?: RawRecordFile): string {
  const child = childFirstUser.trim();
  if (!child || !parentRaw) return '';
  let bestDesc = '';
  let bestScore = 0;
  for (const r of parentRaw.records) {
    const rec = r as Record<string, unknown>;
    const t = rec.type;
    if (t !== 'function_call' && t !== 'tool_use') continue;
    const name = rec.name;
    if (name !== 'Agent' && name !== 'Task') continue;
    const argStr =
      typeof rec.arguments === 'string'
        ? rec.arguments
        : typeof (rec as Record<string, unknown>).input === 'string'
          ? ((rec as Record<string, unknown>).input as string)
          : '';
    if (!argStr) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argStr) as Record<string, unknown>;
    } catch {
      continue;
    }
    const prompt = typeof args.prompt === 'string' ? (args.prompt as string).trim() : '';
    const desc = typeof args.description === 'string' ? (args.description as string).trim() : '';
    if (!desc || !prompt) continue;
    // 精确匹配优先；退化：父子 prompt 互为前缀（容差截断 / harness 包裹差异）取最长公共前缀者
    let score = 0;
    if (prompt === child) {
      score = child.length;
    } else if (prompt.startsWith(child) || child.startsWith(prompt)) {
      let k = 0;
      const n = Math.min(prompt.length, child.length);
      while (k < n && prompt[k] === child[k]) k++;
      score = k;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDesc = desc;
    }
  }
  // 要求公共前缀足够长，避免偶然前缀（如都只是 "探索 /Users/..." 短串）误关联
  return bestScore >= 30 ? bestDesc : '';
}

/** 递归收集 jsonl，按相对 projects 的深度区分顶层 / 嵌套 */
function walk(root: string): { full: string; rel: string; depth: number }[] {
  const out: { full: string; rel: string; depth: number }[] = [];
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
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name.endsWith('.jsonl')) {
        const rel = full.slice(root.length + 1);
        const depth = rel.split('/').length - 1;
        out.push({ full, rel, depth });
      }
    }
  }
  return out;
}

/**
 * 嵌套会话路径兜底归因：`<slug>/<uuid>/subagents/<x>.jsonl` → 父 = `<slug>/<uuid>`。
 * 返回父会话 sessionId（顶层 / 无父则空）。B 方案与 discover/scanSessions 共用，避免重复解析。
 */
function computeParentId(
  f: { rel: string; depth: number },
  topLevelKeys: Set<string>,
): string | undefined {
  if (f.depth === 1) return undefined;
  const segs = f.rel.split('/');
  if (segs.length >= 2) {
    const candidate = `${segs[0]}/${segs[1]}`;
    if (topLevelKeys.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 顶层会话 raw 记录索引：sessionId(`<slug>/<uuid>`) → RawRecordFile。
 * 供 B 方案父 spawn 关联回溯父会话 Agent 调用（discover / scanSessions 共用，只读一次盘）。
 */
function buildTopLevelRawMap(
  scanned: ReturnType<typeof scanWorkbuddyRaw>,
): Map<string, RawRecordFile> {
  const m = new Map<string, RawRecordFile>();
  for (const s of scanned) {
    if (s.f.depth === 1) m.set(s.f.rel.replace(/\.jsonl$/, ''), s.raw);
  }
  return m;
}

/** 从一次 readRawRecords 的结果构造 ExtractedSession（摘要层，不含派生事实） */
function buildSession(
  f: { full: string; rel: string; depth: number },
  raw: RawRecordFile,
  topLevelKeys: Set<string>,
  parentRaw?: RawRecordFile,
  meta?: { vendor?: string; kind?: SessionKind; sessionId?: string; parentId?: string },
): ExtractedSession {
  // 非 workbuddy vendor：kind / sessionId / vendor 由 SessionMeta 给定（其 sessionId 不含
  // `<slug>/<uuid>` 目录层级，depth 推导会误判为 nested），workbuddy 沿用原有路径推导。
  const vendor = meta?.vendor ?? 'workbuddy';
  const kind: SessionKind = meta?.kind ?? (f.depth === 1 ? 'top-level' : 'nested');
  let firstPrompt = '';
  let rawFirstUser = '';
  let title = '';
  let rawParentId: string | undefined;
  const ts: number[] = [];
  for (const r of raw.records) {
    const rec = r as Record<string, unknown>;
    const pid = rec.parentId;
    if (typeof pid === 'string' && pid && !rawParentId) rawParentId = pid;
    if (!firstPrompt && rec.role === 'user') {
      // 同时保留「去包裹 + 首行截断」后的展示串，与「未清洗原始首问」——后者用于 B 方案的父 spawn 关联
      const c = Array.isArray(rec.content)
        ? rec.content.map((x: Record<string, unknown>) => x?.text ?? '').join(' ')
        : String(rec.content ?? '');
      rawFirstUser = c;
      firstPrompt = sanitizeFirstPromptForDisplay(stripHarnessWrappers(c), FIRST_PROMPT_MAX);
    }
    // 对齐 coslash workbuddy/parse.go:161：ai-title 事件按顺序读取，后写覆盖先写（重命名取最新）
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) {
      title = rec.aiTitle.trim();
    }
    ts.push(...extractTimestamps(rec));
  }
  ts.sort((a, b) => a - b);
  const sessionId = meta?.sessionId ?? f.rel.replace(/\.jsonl$/, '');
  const parentId = meta ? meta.parentId : computeParentId(f, topLevelKeys);
  // B 方案：嵌套会话优先用父会话 Agent 调用 description 作为标题（对齐 coslash subagents.go）
  let spawnTask = '';
  if (kind === 'nested' && parentId && parentRaw) {
    spawnTask = extractParentSpawnTask(stripHarnessWrappers(rawFirstUser), parentRaw);
  }
  return {
    sessionId,
    vendor,
    kind,
    path: f.full,
    parentId,
    rawParentId: kind === 'nested' ? rawParentId : undefined,
    size: raw.size,
    mtime: raw.mtime,
    recordCount: raw.records.length,
    badJson: raw.badJson,
    firstPrompt,
    title,
    spawnTask,
    startedAt: ts.length ? ts[0] : undefined,
    endedAt: ts.length ? ts[ts.length - 1] : undefined,
  };
}

/** 单次 walk + 读盘：返回 {file, raw} 列表（只读一次） */
function scanWorkbuddyRaw(): { f: { full: string; rel: string; depth: number }; raw: RawRecordFile }[] {
  const root = join(homedir(), '.workbuddy', 'projects');
  if (!existsSync(root)) return [];
  const files = walk(root);
  return files.map((f) => ({ f, raw: readRawRecords(f.full) }));
}

export function makeWorkbuddyExtractor(): SessionExtractor {
  return {
    vendor: 'workbuddy',
    discover(): ExtractedSession[] {
      const scanned = scanWorkbuddyRaw();
      const topLevelKeys = new Set(
        scanned.filter((s) => s.f.depth === 1).map((s) => s.f.rel.replace(/\.jsonl$/, '')),
      );
      const topLevelRaw = buildTopLevelRawMap(scanned);
      return scanned.map((s) => {
        const pid = computeParentId(s.f, topLevelKeys);
        const parentRaw = pid ? topLevelRaw.get(pid) : undefined;
        return buildSession(s.f, s.raw, topLevelKeys, parentRaw);
      });
    },
  };
}

/** vendor 注册表：workbuddy（本机主数据源）+ codex（ChatGPT Work / Codex 本地 rollout），保留多 vendor 扩展位（见方案 P2 / P9） */
export const EXTRACTOR_REGISTRY: Record<string, () => SessionExtractor> = {
  workbuddy: makeWorkbuddyExtractor,
  codex: makeCodexExtractor,
};

/**
 * 会话洞察「全量集合」默认扫描的 vendor 列表（面板列表 / Agent facet 的数据面）。
 * 只有本机真实存在数据源的 vendor 才列入，避免下拉出现永远 0 条的选项。
 * 新增 vendor：在此追加 + EXTRACTOR_REGISTRY 注册 + normalizeVendorRecords 归一。
 */
export const ENABLED_VENDORS: string[] = ['workbuddy', 'codex'];

export function getExtractor(vendor: string): SessionExtractor | undefined {
  const factory = EXTRACTOR_REGISTRY[vendor];
  return factory ? factory() : undefined;
}

/** 按 vendor 路由原始记录归一：codex 需把 envelope 归一成 workbuddy 形态；其余 vendor 原样返回。 */
function normalizeVendorRecords(vendor: string, raw: RawRecordFile): RawRecordFile {
  if (vendor === 'codex') return normalizeCodexRecords(raw);
  return raw;
}

/**
 * 单次扫描：发现会话并同时返回原始记录（只读一次盘）。
 * 满足方案「readRawRecords 是两条管线唯一公共 IO 入口、禁止各扫一遍」的原则——
 * 会话摘要（ExtractedSession）与后续派生事实（M1）都从这一次 readRawRecords 结果派生，
 * 不重复扫盘。
 */
export interface ScannedSession {
  session: ExtractedSession;
  raw: RawRecordFile;
}

export function scanSessions(vendor = 'workbuddy'): ScannedSession[] {
  if (vendor !== 'workbuddy') {
    const extractor = getExtractor(vendor);
    if (!extractor) return [];
    // 非 workbuddy vendor：先 discover 摘要，再补读原始记录并按 vendor 归一（该 vendor 样本极少，性能可忽略）。
    // codex 的 envelope 需归一成 {role,content,timestamp} 形态才能被「我的记忆」提炼消费。
    return extractor.discover().map((session) => ({
      session,
      raw: normalizeVendorRecords(vendor, readRawRecords(session.path)),
    }));
  }
  const scanned = scanWorkbuddyRaw();
  const topLevelKeys = new Set(
    scanned.filter((s) => s.f.depth === 1).map((s) => s.f.rel.replace(/\.jsonl$/, '')),
  );
  const topLevelRaw = buildTopLevelRawMap(scanned);
  return scanned.map((s) => {
    const pid = computeParentId(s.f, topLevelKeys);
    const parentRaw = pid ? topLevelRaw.get(pid) : undefined;
    return { session: buildSession(s.f, s.raw, topLevelKeys, parentRaw), raw: s.raw };
  });
}

// ── M1 DoD② · stat-only 发现 + 单文件按需读（索引化缓存的地基）──
//
// 背景：computeAllSessions 旧实现每次调用都全量 read+parse 全部会话文件（~110MB / 2.1 万条），
// facts 缓存只挡住聚合层（buildFacts）、挡不住读盘，二次加载 ~1.05s 压线超 DoD②（≤1s）。
// 现在把「发现」与「读取」解耦：
//   discoverSessionMeta = walk + stat（~10ms，零读文件）
//   readOneSession      = 按需读单个文件（未命中缓存 / 时间线接口才触发）
// 读盘仍是唯一公共入口 readRawRecords，不新增第二条 IO 通路。

/** 轻量会话元信息：只含 stat 可得字段，不含任何文件内容 */
export interface SessionMeta {
  sessionId: string;
  vendor: string;
  kind: SessionKind;
  path: string;
  /** 嵌套会话：路径兜底归因的父会话 sessionId（行内 parentId 需读文件，见 readOneSession） */
  parentId?: string;
  size: number;
  mtime: number;
}

/** stat-only 发现：walk + statSync，绝不读文件内容 */
export function discoverSessionMeta(vendor = 'workbuddy'): SessionMeta[] {
  if (vendor !== 'workbuddy') {
    // 其他 vendor 无本机样本：退回全量 discover()（样本极少，性能可忽略，语义不变）
    return (getExtractor(vendor)?.discover() ?? []).map((s) => ({
      sessionId: s.sessionId,
      vendor: s.vendor,
      kind: s.kind,
      path: s.path,
      parentId: s.parentId,
      size: s.size,
      mtime: s.mtime,
    }));
  }
  const root = join(homedir(), '.workbuddy', 'projects');
  if (!existsSync(root)) return [];
  const files = walk(root);
  const topLevelKeys = new Set(
    files.filter((f) => f.depth === 1).map((f) => f.rel.replace(/\.jsonl$/, '')),
  );
  const out: SessionMeta[] = [];
  for (const f of files) {
    const sessionId = f.rel.replace(/\.jsonl$/, '');
    const parentId = computeParentId(f, topLevelKeys);
    let st;
    try {
      st = statSync(f.full);
    } catch {
      continue; // walk 与 stat 之间文件被删 / 无权限：跳过该文件
    }
    out.push({
      sessionId,
      vendor: 'workbuddy',
      kind: f.depth === 1 ? 'top-level' : 'nested',
      path: f.full,
      parentId,
      size: st.size,
      mtime: st.mtimeMs,
    });
  }
  return out;
}

/** 按需读取单个会话（单文件 readRawRecords + 摘要构造）；供索引化缓存未命中路径与时间线接口使用 */
export function readOneSession(meta: SessionMeta, topLevelKeys: Set<string>): ScannedSession {
  const rel = `${meta.sessionId}.jsonl`;
  const depth = meta.sessionId.split('/').length - 1;
  const raw = normalizeVendorRecords(meta.vendor, readRawRecords(meta.path));
  // B 方案：单会话读取也回溯父会话 raw，保证嵌套会话 spawnTask 命中（时间线 / Inspector 路径）。
  // 父会话回溯仅 workbuddy 适用（其父会话是同根下另一条转录）；codex 的父子由 session_meta 跨文件给出。
  let parentRaw: RawRecordFile | undefined;
  if (meta.parentId && meta.vendor === 'workbuddy') {
    const parentPath = join(homedir(), '.workbuddy', 'projects', `${meta.parentId}.jsonl`);
    if (existsSync(parentPath)) parentRaw = readRawRecords(parentPath);
  }
  const session = buildSession({ full: meta.path, rel, depth }, raw, topLevelKeys, parentRaw, {
    vendor: meta.vendor,
    kind: meta.kind,
    sessionId: meta.sessionId,
    parentId: meta.parentId,
  });
  return { session, raw };
}

/** 单会话扫描（发现 + 读取）；时间线 / Inspector 按 id 取原始记录时使用，避免全量读盘 */
export function scanOne(vendor: string, sessionId: string): ScannedSession | null {
  if (vendor !== 'workbuddy') {
    const all = scanSessions(vendor);
    return all.find((s) => s.session.sessionId === sessionId) ?? null;
  }
  const metas = discoverSessionMeta('workbuddy');
  const topLevelKeys = new Set(metas.filter((m) => m.kind === 'top-level').map((m) => m.sessionId));
  const m = metas.find((x) => x.sessionId === sessionId);
  return m ? readOneSession(m, topLevelKeys) : null;
}
