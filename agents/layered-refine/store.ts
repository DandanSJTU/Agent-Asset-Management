/**
 * layered-refine · 文件存储层（store.ts）。
 *
 * 全部落盘到用户级目录（与 USER.md / MEMORY.md 同级），不进仓库、不进 SQLite。
 * 本期 MemoryCore 零改动 —— 这是"独立第二车道"的实体边界。
 *
 * 落盘产物：
 *   config.json         配置（数据源范围 / 窗口 / 门槛 / LLM backend）
 *   OBSERVATIONS.md     L1 观测流水（append-only，格式 100% 对齐 context-infra）
 *   observations.jsonl  L1 结构化影子副本（UI 检索 + 证据链，唯一本地扩展）
 *   candidates.json     L2 晋升候选（等人审）
 *   axioms/INDEX.md     公理索引
 *   axioms/A0N_xxx.md   单条公理四段结构
 *   jobs/runs.jsonl     每次运行 walkthrough
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Axiom,
  Candidate,
  JobRecord,
  LayeredConfig,
  Observation,
  ObservationQuery,
  TrafficLevel,
} from './types.ts';

const DEFAULT_ROOT = join(
  homedir(),
  'user-f65c0bcb-048a-453e-9a1c-a67f7d64691d-personal',
  'context-infra',
);

/**
 * 数据根目录可被环境变量 LAYERED_REFINE_ROOT 覆盖（用于测试 / 隔离 / 自定义数据盘）。
 * 不设置时回退到用户级默认目录。该变量同时决定 config.json 的读取位置，
 * 因此设置后整套落盘（md / jsonl / candidates / axioms / jobs）都会重定向到该目录。
 */
const ROOT = process.env.LAYERED_REFINE_ROOT || DEFAULT_ROOT;

const DEFAULT_CONFIG: LayeredConfig = {
  rootDir: DEFAULT_ROOT,
  windowDays: 1,
  maxSessionsPerRun: 8,
  maxInputBytesPerSession: 8000,
  maxTotalInputBytes: 60000,
  backend: 'codebuddy',
  model: '',
  timeoutMs: 120000,
  excludeVerdictFresh: true,
  excludeCompactionGte: 3,
  promotion: {
    supportGte: 2,
    sessionsGte: 2,
    spanDaysGte: 3,
  },
};

// ── 目录与路径 ──
export function rootDir(): string {
  return resolveConfig().rootDir;
}
function p(name: string): string {
  return join(rootDir(), name);
}

export function ensureDirs(): void {
  const r = rootDir();
  for (const sub of ['', 'axioms', 'jobs']) {
    mkdirSync(join(r, sub), { recursive: true });
  }
}

// ── 配置 ──
function applyEnvOverride(cfg: LayeredConfig): LayeredConfig {
  const be = process.env.LAYERED_REFINE_BACKEND;
  if (be && be.length > 0) return { ...cfg, backend: be };
  return cfg;
}

export function resolveConfig(): LayeredConfig {
  const cfgPath = join(ROOT, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<LayeredConfig>;
      return applyEnvOverride({ ...DEFAULT_CONFIG, ...raw, promotion: { ...DEFAULT_CONFIG.promotion, ...(raw.promotion ?? {}) }, rootDir: ROOT });
    } catch {
      /* 损坏则回退默认 */
    }
  }
  return applyEnvOverride({ ...DEFAULT_CONFIG, rootDir: ROOT });
}

export function saveConfig(cfg: Partial<LayeredConfig>): LayeredConfig {
  const merged = { ...resolveConfig(), ...cfg, promotion: { ...resolveConfig().promotion, ...(cfg.promotion ?? {}) } };
  ensureDirs();
  writeFileSync(p('config.json'), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ── 工具 ──
function todayStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 稳定键：tag + 归一化 text（去空白、小写） */
export function obsKey(tag: string, text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const base = `${tag}::${norm}`;
  // 轻量 hash（FNV-1a），避免依赖 crypto
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'obs_' + (h >>> 0).toString(36);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const txt = readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  const out: T[] = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

function writeJsonl<T>(file: string, rows: T[]): void {
  ensureDirs();
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

// ── OBSERVATIONS.md（append-only）──
export function appendObservationMd(level: TrafficLevel, tag: string, text: string, key: string): void {
  const file = p('OBSERVATIONS.md');
  const date = todayStr();
  const dot = level === 'high' ? '🔴' : level === 'medium' ? '🟡' : '🟢';
  const line = `${dot} ${level[0].toUpperCase()}: [${tag}] ${text} — source: ${key}`;
  let content = existsSync(file) ? readFileSync(file, 'utf8') : `# Observations\n\n`;
  const dateHeader = `## Date: ${date}`;
  if (!content.includes(dateHeader)) {
    content += `\n${dateHeader}\n\n`;
  }
  // 同一天同 key 不重复追加（幂等，避免重复跑 observer 产生重复行）
  const dupRe = new RegExp(`source: ${escapeRe(key)}(\\s|$)`);
  if (dupRe.test(content)) return;
  content += `${line}\n`;
  writeFileSync(file, content, 'utf8');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── observations.jsonl（结构化影子副本，跨 run 合并）──
export function loadObservations(): Observation[] {
  return readJsonl<Observation>(p('observations.jsonl'));
}

export function mergeObservations(items: { level: TrafficLevel; tag: string; text: string; sessionId: string }[]): Observation[] {
  const all = loadObservations();
  const map = new Map(all.map((o) => [o.id, o]));
  const date = todayStr();
  for (const it of items) {
    const id = obsKey(it.tag, it.text);
    const ex = map.get(id);
    if (ex) {
      ex.lastSeen = date;
      ex.supportCount += 1;
      if (!ex.sources.includes(it.sessionId)) ex.sources.push(it.sessionId);
    } else {
      map.set(id, {
        id,
        date,
        level: it.level,
        tag: it.tag,
        text: it.text,
        firstSeen: date,
        lastSeen: date,
        supportCount: 1,
        sources: [it.sessionId],
        promoted: false,
      });
    }
  }
  const merged = [...map.values()];
  writeJsonl(p('observations.jsonl'), merged);
  return merged;
}

export function queryObservations(q: ObservationQuery = {}): Observation[] {
  let list = loadObservations();
  if (q.since) list = list.filter((o) => o.lastSeen >= q.since!);
  if (q.level) list = list.filter((o) => o.level === q.level);
  if (q.q) {
    const kw = q.q.toLowerCase();
    list = list.filter((o) => o.text.toLowerCase().includes(kw) || o.tag.toLowerCase().includes(kw));
  }
  return list.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}

export function markPromoted(ids: string[]): void {
  const all = loadObservations();
  let changed = false;
  for (const o of all) {
    if (ids.includes(o.id) && !o.promoted) {
      o.promoted = true;
      changed = true;
    }
  }
  if (changed) writeJsonl(p('observations.jsonl'), all);
}

// ── candidates.json ──
export function loadCandidates(): Candidate[] {
  return readJsonl<Candidate>(p('candidates.json'));
}

export function saveCandidates(list: Candidate[]): void {
  writeJsonl(p('candidates.json'), list);
}

export function appendCandidates(items: Candidate[]): Candidate[] {
  const all = loadCandidates();
  all.push(...items);
  saveCandidates(all);
  return all;
}

export function updateCandidate(id: string, patch: Partial<Candidate>): Candidate | null {
  const all = loadCandidates();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch };
  saveCandidates(all);
  return all[idx];
}

// ── axioms/ ──
export function loadAxioms(): Axiom[] {
  return readJsonl<Axiom>(join(rootDir(), 'axioms', 'axioms.jsonl'));
}

export function nextAxiomId(): string {
  const all = loadAxioms();
  let max = 0;
  for (const a of all) {
    const m = /^A(\d+)/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `A${String(max + 1).padStart(2, '0')}`;
}

export function saveAxiom(ax: Axiom): void {
  const all = loadAxioms();
  const idx = all.findIndex((a) => a.id === ax.id);
  if (idx >= 0) all[idx] = ax;
  else all.push(ax);
  writeJsonl(join(rootDir(), 'axioms', 'axioms.jsonl'), all);
  writeAxiomMd(ax);
  writeAxiomIndex();
}

export function writeAxiomMd(ax: Axiom): void {
  const md = `# ${ax.id} — ${ax.title}

## 核心含义
${ax.core}

## 深度推演
${ax.reasoning}

## 应用判定
${ax.application}

## 来源
${ax.sources.map((s) => `- ${s}`).join('\n') || '- （无）'}
`;
  writeFileSync(join(rootDir(), 'axioms', `${ax.id}_${slug(ax.title)}.md`), md, 'utf8');
}

export function writeAxiomIndex(): void {
  const all = loadAxioms().sort((a, b) => a.id.localeCompare(b.id));
  const lines = ['# Axiom Index', ''];
  for (const a of all) {
    lines.push(`- [${a.id} — ${a.title}](./${a.id}_${slug(a.title)}.md) · ${a.tag}`);
  }
  lines.push('');
  writeFileSync(join(rootDir(), 'axioms', 'INDEX.md'), lines.join('\n'), 'utf8');
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 清空全部提炼产物（观测 / 候选 / 公理 / 运行日志）。
 *
 * 存在理由：早期联调用了 backend=offline 的确定性桩，会在池里留下 100+ 条
 * tag=offline-preview 的**假观测**。它们与真观测同表、会被 Reflector 一起聚合，
 * 必须能一次性清干净再重跑，否则用户看到的是"164 条观测"的假繁荣。
 * 仅清空本车道目录，不碰 USER.md / MEMORY.md。
 */
export function resetAll(): { cleared: string[] } {
  const files = [
    p('observations.jsonl'),
    p('candidates.json'),
    p('OBSERVATIONS.md'),
    p('jobs/runs.jsonl'),
    join(rootDir(), 'axioms', 'axioms.jsonl'),
    join(rootDir(), 'axioms', 'INDEX.md'),
  ];
  const cleared: string[] = [];
  for (const f of files) {
    if (existsSync(f)) {
      writeFileSync(f, '', 'utf8');
      cleared.push(f);
    }
  }
  // 一并删掉单条公理 md（文件名含 slug，无法穷举，按目录扫）
  const axDir = join(rootDir(), 'axioms');
  if (existsSync(axDir)) {
    for (const name of readdirSync(axDir)) {
      if (name.endsWith('.md') && name !== 'INDEX.md') {
        unlinkSync(join(axDir, name));
        cleared.push(join(axDir, name));
      }
    }
  }
  return { cleared };
}

// ── jobs/runs.jsonl ──
export function appendJob(rec: JobRecord): void {
  ensureDirs();
  appendFileSync(p('jobs/runs.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

export function loadJobs(): JobRecord[] {
  return readJsonl<JobRecord>(p('jobs/runs.jsonl')).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
