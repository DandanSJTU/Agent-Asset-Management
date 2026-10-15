/**
 * scan-local-agent-skills.ts — 扫描本机所有 AI Agent 客户端的本地 skill 库。
 *
 * 来源映射与 `agents/asset-import.ts` 的 7 个 IDE 适配器保持一致（workbuddy / hermes /
 * claude-code / codebuddy / codex / openclaw / dsh）。每个 agent 的 skill 落盘目录由
 * 对应 adapter 的 `scanSkills()` 决定，这里复刻其 root 候选集（含常见 env 覆盖），
 * 但只做「只读扫描 + 解析」，不依赖 asset-import 那套大型 CLI 依赖。
 *
 * 输出给前端「我的技能 → 本地 Agent 技能」页展示，关键信息：
 *   - skill 名称（SKILL.md frontmatter `name`，缺失则回退目录名）
 *   - 使用的 agent（可能多个：如 ~/.agents/skills 下的 skill 同时被 codex / openclaw /
 *     claude-code / codebuddy 通过软链或 root 共享加载，故用 `agents: string[]`）
 *   - 最新修改时间（skill 目录下所有文件的最大 mtime）
 *   - 本地位置（以真实物理路径 realpath 为准，软链会解析到目标）
 *
 * 设计要点：
 *   - 跨 agent 按「物理真实路径」去重，避免同一份 skill 因软链/多个 root 而出现多行。
 *   - 软链会被解析（与 asset-import 用 statSync 跟链一致），但用 visited realpath 防止环。
 *   - 跳过 `.git` / `node_modules` / 以 `.` 开头的隐藏目录，避免进入巨型或循环目录。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** 单个扫描到的本地 skill（可能被多个 agent 共享）。 */
export interface LocalAgentSkill {
  /** frontmatter name，缺失时回退到目录名 */
  name: string;
  /** 共享该 skill 的 agent 列表（如 ['codex','openclaw','claude-code','codebuddy']），按 AGENTS 顺序 */
  agents: string[];
  /** frontmatter description（已去引号、截断） */
  description: string;
  /** frontmatter triggers 列表 */
  triggers: string[];
  /** skill 目录绝对路径（真实物理路径，软链已解析） */
  path: string;
  /** SKILL.md 绝对路径 */
  skillMdPath: string;
  /** 最新修改时间（毫秒，目录下所有文件最大 mtime） */
  updatedAtMs: number;
  /** 目录总大小（字节） */
  sizeBytes: number;
}

/** 单个 agent 下一个 skill root 的扫描概况。 */
export interface AgentSkillRoot {
  path: string;
  exists: boolean;
  /** 该 root 可达的 skill 物理目录数（跨 agent 共享的真实目录也可能被多个 root 命中） */
  count: number;
}

/** 每个 agent 的所有 root 分组。 */
export interface AgentSkillRootGroup {
  agent: string;
  roots: AgentSkillRoot[];
}

export interface LocalAgentSkillsResult {
  /** 扫描时刻（毫秒） */
  scannedAtMs: number;
  /** 各 agent 的 root 概况（用于展示「每个 agent 在哪些目录找到几个 skill」） */
  agents: AgentSkillRootGroup[];
  /** 去重后的全部 skill 列表（按真实路径去重，跨 agent 合并） */
  skills: LocalAgentSkill[];
  /** skills 总数（物理去重后的唯一 skill 数） */
  totalCount: number;
}

/** 与支持资产导入的 7 类 agent 客户端保持一致。 */
const AGENTS = [
  'workbuddy',
  'hermes',
  'claude-code',
  'codebuddy',
  'codex',
  'openclaw',
  'dsh',
] as const;

type AgentKind = (typeof AGENTS)[number];

function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=\/|$)/, homedir()));
}

function splitCsv(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 复刻 agents/asset-import.ts 各 adapter 的 skill root 候选集。
 * cwd 用于 `<cwd>/.agent/skills` 这类仓库级 root（面板进程通常 cwd=MemoryPanel，多半不存在，无妨）。
 */
function rootsForAgent(agent: AgentKind, home: string, cwd: string): string[] {
  switch (agent) {
    case 'workbuddy':
      return [
        join(home, '.workbuddy', 'skills'),
        join(cwd, '.workbuddy', 'skills'),
        join(cwd, 'workbuddy', 'skills'),
      ];
    case 'hermes': {
      const h = process.env.HERMES_HOME ? expandHome(process.env.HERMES_HOME) : join(home, '.hermes');
      const roots: string[] = [join(h, 'skills')];
      if (process.env.HERMES_BUNDLED_SKILLS) {
        roots.push(...splitCsv(process.env.HERMES_BUNDLED_SKILLS).map(expandHome));
      }
      if (process.env.HERMES_OPTIONAL_SKILLS) {
        roots.push(...splitCsv(process.env.HERMES_OPTIONAL_SKILLS).map(expandHome));
      }
      // 兼容 hermesAgentRepo()：env 未设时回退到 ~/.hermes/hermes-agent/{skills,optional-skills}
      const repo = join(h, 'hermes-agent');
      if (existsSync(repo)) {
        roots.push(join(repo, 'skills'), join(repo, 'optional-skills'));
      }
      return roots;
    }
    case 'claude-code':
      return [join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')];
    case 'codebuddy':
      return [join(home, '.codebuddy', 'skills'), join(cwd, '.codebuddy', 'skills')];
    case 'codex':
      return [
        join(home, '.agents', 'skills'),
        '/etc/codex/skills',
        join(cwd, '.agents', 'skills'),
      ];
    case 'openclaw': {
      const state = process.env.OPENCLAW_STATE_DIR
        ? expandHome(process.env.OPENCLAW_STATE_DIR)
        : join(home, '.openclaw');
      return [
        join(home, '.agents', 'skills'),
        join(state, 'npm-global', 'lib', 'node_modules', 'openclaw', 'skills'),
      ];
    }
    case 'dsh': {
      const dshHome = process.env.DSH_HOME ? expandHome(process.env.DSH_HOME) : join(home, '.dsh');
      const dshAgents = process.env.DSH_AGENTS_HOME
        ? expandHome(process.env.DSH_AGENTS_HOME)
        : join(home, '.agents');
      const roots: string[] = [
        join(cwd, '.dsh', 'skills'),
        join(cwd, '.agents', 'skills'),
        join(dshHome, 'skills'),
        join(dshAgents, 'skills'),
      ];
      if (process.env.DSH_CUSTOM_SKILL_DIRS) {
        roots.push(...splitCsv(process.env.DSH_CUSTOM_SKILL_DIRS).map(expandHome));
      }
      return roots;
    }
    default:
      return [];
  }
}

interface Frontmatter {
  name: string | null;
  description: string;
  triggers: string[];
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（仅支持简单标量 + 列表 + 块标量，覆盖本项目全部 skill）。
 * 不引入 yaml 依赖，避免重依赖；多行/复杂结构（锚点、嵌套 map）会退化为空。
 *
 * 支持的块标量：`description: >-` / `description: |-` 等（folded `>` 以空格连接、literal `|` 以换行连接）。
 */
function parseFrontmatter(content: string): Frontmatter {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const result: Frontmatter = { name: null, description: '', triggers: [] };
  if (!fm) return result;

  const lines = (fm[1] ?? '').split(/\r?\n/);
  // 当前处于块标量续行状态（folded `>` / literal `|`）
  let blockKey: 'description' | null = null;
  let blockFold: ' ' | '\n' = ' ';
  let blockLines: string[] = [];
  const flushBlock = (): void => {
    if (blockKey === 'description') result.description = blockLines.join(blockFold).trim();
    blockKey = null;
    blockLines = [];
  };

  let inTriggers = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const indent = line.length - line.trimStart().length;
    // 块标量续行：该行缩进（且非列表项）或空行 → 累积，不解析为 key
    if (blockKey !== null && (indent > 0 || line.trim() === '')) {
      if (line.trim() !== '') blockLines.push(line.trim());
      continue;
    }
    if (blockKey !== null) flushBlock();

    if (inTriggers) {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) {
        result.triggers.push(stripQuotes(m[1] ?? ''));
        continue;
      }
      inTriggers = false;
    }

    // 块标量开始：name/description 后跟 `>` 或 `|`（可能带 +/- 修饰）
    const blockMatch = line.match(/^(name|description)\s*:\s*([>|][+-]?)\s*$/);
    if (blockMatch) {
      blockKey = blockMatch[1] as 'description';
      blockFold = (blockMatch[2]?.[0] ?? '>') === '>' ? ' ' : '\n';
      blockLines = [];
      continue;
    }
    const nameMatch = line.match(/^name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      result.name = stripQuotes(nameMatch[1] ?? '') || null;
      continue;
    }
    const descMatch = line.match(/^description\s*:\s*(.+?)\s*$/);
    if (descMatch) {
      result.description = stripQuotes(descMatch[1] ?? '');
      continue;
    }
    if (/^triggers\s*:\s*$/.test(line)) {
      inTriggers = true;
      continue;
    }
  }
  if (blockKey !== null) flushBlock();
  return result;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '').trim();
}

/** 递归统计目录下所有文件的最大 mtime 与总字节数。 */
function statDir(dir: string): { mtimeMs: number; size: number } {
  let mtimeMs = 0;
  let size = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { mtimeMs, size };
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const sub = statDir(full);
      if (sub.mtimeMs > mtimeMs) mtimeMs = sub.mtimeMs;
      size += sub.size;
    } else if (st.isFile()) {
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
      size += st.size;
    }
  }
  return { mtimeMs, size };
}

function readIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 从一个 skill root 目录收集其下所有 skill 的物理真实路径集合。
 * 软链会被解析（与 asset-import 的 statSync 跟链一致），但以 realpath 去重防止环与重复 IO。
 * 跳过 `.git` / `node_modules` / 以 `.` 开头的隐藏目录。每个 SKILL.md 的父目录即一个 skill 目录。
 *
 * @returns 该 root 可达的 skill 物理目录真实路径集合（已去重）
 */
function collectRealpathsFromRoot(root: string): Set<string> {
  const found = new Set<string>();
  if (!existsSync(root)) return found;
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return found;
  }
  if (!rootStat.isDirectory()) return found;

  const walk = (dir: string, visited: Set<string>): void => {
    let rp: string;
    try {
      rp = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(rp)) return; // 防环（软链回指祖先）
    visited.add(rp);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = lstatSync(full); // 先 lstat 识别软链
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // 解析软链目标再决定是目录（递归）还是 SKILL.md 文件
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          continue;
        }
        let tst;
        try {
          tst = statSync(target);
        } catch {
          continue;
        }
        if (tst.isDirectory()) {
          walk(target, visited);
        } else if (tst.isFile() && entry === 'SKILL.md') {
          found.add(rp); // SKILL.md 位于软链目录本身
        }
        continue;
      }
      if (st.isDirectory()) {
        walk(full, visited);
      } else if (st.isFile() && entry === 'SKILL.md') {
        found.add(rp);
      }
    }
  };

  const visited = new Set<string>();
  walk(root, visited);
  return found;
}

/**
 * 扫描本机所有 agent 的本地 skill 库。
 * 跨 agent 按物理真实路径去重并聚合 `agents`；每个 agent 的每个 root 单独统计可达 skill 数。
 *
 * @param opts.cwd 用作 `<cwd>/.agent/skills` 这类仓库级 root 的基准（默认 process.cwd()）
 */
export function scanLocalAgentSkills(opts?: { cwd?: string }): LocalAgentSkillsResult {
  const home = homedir();
  const cwd = opts?.cwd?.trim() ? resolve(opts.cwd) : process.cwd();

  const agents: AgentSkillRootGroup[] = [];
  // 物理真实路径 → 聚合后的 skill（含 agents 集合）
  const byRealpath = new Map<string, LocalAgentSkill & { _agents: Set<string> }>();

  for (const agent of AGENTS) {
    const roots = rootsForAgent(agent, home, cwd);
    const rootGroups: AgentSkillRoot[] = [];
    for (const r of roots) {
      const exists = existsSync(r) && statSync(r).isDirectory();
      let count = 0;
      if (exists) {
        const realpaths = collectRealpathsFromRoot(r);
        for (const rp of realpaths) {
          count++;
          let entry = byRealpath.get(rp);
          if (!entry) {
            const skillMd = join(rp, 'SKILL.md');
            const text = readIfExists(skillMd);
            const fm = text != null ? parseFrontmatter(text) : { name: null, description: '', triggers: [] };
            const stats = statDir(rp);
            entry = {
              name: fm.name || basename(rp),
              agents: [],
              description: fm.description,
              triggers: fm.triggers,
              path: rp,
              skillMdPath: skillMd,
              updatedAtMs: stats.mtimeMs,
              sizeBytes: stats.size,
              _agents: new Set<string>(),
            };
            byRealpath.set(rp, entry);
          }
          entry._agents.add(agent);
        }
      }
      rootGroups.push({ path: r, exists, count });
    }
    agents.push({ agent, roots: rootGroups });
  }

  const skills: LocalAgentSkill[] = [];
  for (const entry of byRealpath.values()) {
    const agentsList = AGENTS.filter((a) => entry._agents.has(a));
    skills.push({
      name: entry.name,
      agents: agentsList,
      description: entry.description,
      triggers: entry.triggers,
      path: entry.path,
      skillMdPath: entry.skillMdPath,
      updatedAtMs: entry.updatedAtMs,
      sizeBytes: entry.sizeBytes,
    });
  }

  // 排序：先按首个 agent 在 AGENTS 中的顺序，再按名称，展示更稳定
  skills.sort((a, b) => {
    const ai = AGENTS.indexOf(a.agents[0] as AgentKind);
    const bi = AGENTS.indexOf(b.agents[0] as AgentKind);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });

  return {
    scannedAtMs: Date.now(),
    agents,
    skills,
    totalCount: skills.length,
  };
}
