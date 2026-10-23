/**
 * /api/v1/personal-space/* —— 会话洞察（Session Insights）观测面路由。
 *
 * 设计要点（对齐 personal-space-plan.html M2 / P1）：
 *   1. 复用 agents/personal-space 已验证的派生事实引擎（computeAllSessions / scanOne），
 *      服务端不重复实现扫描与指标逻辑，保证单一事实来源。其中 computeAllSessions 为索引化
 *      路径（M1 DoD②）：stat-only 发现 + 命中零读盘；单会话时间线经 scanOne 按需单文件读，
 *      不再随全量扫描返回 records。
 *   2. 用【运行时解析路径 + 动态 import】加载引擎：本 server tree 的 tsconfig rootDir=src，
 *      静态跨包 import 会触发 TS6059；动态 import 用变量路径则 tsc 不做静态解析，构建零破坏。
 *      运行时由 tsx（本地 start-local.sh）或 `node --import tsx`（Docker 生产镜像）加载 .ts 引擎，
 *      与 agents/ 下 verify 脚本同一运行方式。
 *   3. 单机自用硬校验（P1）：多人部署（>1 活跃 user）下整 tab 禁用，返回 403 SINGLE_USER_ONLY。
 *      本地单机自用部署（本仓库默认形态）视为 single。真实多用户判定应接入 deps 的 user 表计数，
 *      此处留出 isSingleUser() 单一开关，避免误杀本机环境。
 *   4. 观测面全部 GET，返回面板统一 envelope { code, message, data }；唯一写入口是
 *      POST /personal-space/resume（M-D 终端拉起，纯本地动作、不经 gateway）。
 *
 * 部署配套（已在 Dockerfile / start-combined.sh 落实）：
 *   - 本地：start-local.sh 以 `tsx src/index.ts` 跑源码，agents/ 在仓库根，引擎 .ts 由 tsx 加载。
 *   - 生产镜像：Dockerfile 将仓库根 agents/ COPY 到 /app/agents，start-combined.sh 以
 *     `node --import tsx/esm dist/index.js` 启动，动态 import 的 .ts 由 tsx loader 转译。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';

/** P1 运行时硬校验：本地单机自用 = true；真实多用户部署应接入 deps 的 user 表计数后改为按需判定。 */
function isSingleUser(_deps: PanelDeps): boolean {
  return true;
}

// 懒加载引擎（跨包动态 import，避开 tsc rootDir 静态依赖）
let _enginePromise: Promise<{
  computeAllSessions: (useCache?: boolean) => {
    facts: Record<string, unknown>[];
    cached: number;
    rebuilt: number;
    coldMs: number;
  };
  scanOne: (vendor: string, sessionId: string) => {
    session: Record<string, unknown>;
    raw: { records: Record<string, unknown>[] };
  } | null;
  buildReadiness: (facts: Record<string, unknown>, now?: number) => {
    readiness: Record<string, unknown>;
    verdict: string;
  };
}> | null = null;

async function getEngine() {
  if (!_enginePromise) {
    const here = path.dirname(fileURLToPath(import.meta.url)); // 目录：.../MemoryPanel/src/panel/http/routes (tsx) | .../dist/panel/http/routes (node dist)
    // 仓库根：从本文件所在【目录】向上 5 级（routes → http → panel → src → MemoryPanel → 仓库根）。
    // 注意 import.meta.url 是文件路径，必须用 path.dirname 取目录再向上，否则第一个 .. 只剥文件名、
    // 会少算一级，本地落到 MemoryPanel/、Docker 落到 /app/panel，引擎加载不到。
    // 本地(tsx)与 Docker(/app/panel/dist/...)两种布局均解析到 agents/ 所在的根目录。
    const repoRoot = path.resolve(here, '../../../../../');
    const enginePath = path.join(repoRoot, 'agents/personal-space/facts.ts');
    _enginePromise = import(enginePath) as unknown as Promise<typeof _enginePromise extends Promise<infer T> ? T : never>;
  }
  return _enginePromise;
}

// 懒加载 AI Synthesis 模块（默认关闭；启用时才 spawn 本机 codebuddy CLI）
let _synthPromise: Promise<{
  getSynthesis: (
    id: string,
    facts: Record<string, unknown>,
    raw: { records: Record<string, unknown>[] },
  ) => Promise<{
    synthesis: { goals: string[]; outcome: string; keyDecisions: string[]; nextStep: string } | null;
    enabled: boolean;
    pending?: boolean;
    error?: string | null;
  }>;
}> | null = null;

async function getSynthesisModule() {
  if (!_synthPromise) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../../../../../');
    const synthPath = path.join(repoRoot, 'agents/personal-space/synthesis.ts');
    _synthPromise = import(synthPath) as unknown as Promise<typeof _synthPromise extends Promise<infer T> ? T : never>;
  }
  return _synthPromise;
}

function singleUserGuard(c: { json: (o: unknown, status?: number) => unknown }, deps: PanelDeps): boolean {
  if (!isSingleUser(deps)) {
    c.json({ code: 403, message: 'SINGLE_USER_ONLY', data: { singleUser: false } }, 403);
    return false;
  }
  return true;
}

// ── M-D · Resume：拉起终端新会话（Start fresh with handoff / Start fresh）──
// 语义：在原会话的 git.cwd 打开一个新 Terminal 窗口并启动 agent CLI。
//   - mode=handoff：前端已用 buildHandoff 生成八段式交接文本，后端落盘到
//     ~/.workbuddy/agent-memory-handoffs/<sessionId>-<ts>.md，经 stdin 管道注入 CLI
//     （cat <file> | <cli>，交互模式首条提示），不作为命令行参数（避免 ARG_MAX / 转义问题）。
//   - mode=fresh：只 cd 到原工作目录启动 CLI，不携带历史上下文。
// CLI 可用 TDAI_RESUME_BACKEND 覆盖，缺省沿用 AI Synthesis 的 TDAI_SYNTHESIS_BACKEND，再缺省 codebuddy。

/** 交接文本落盘目录（复用 facts 缓存的 ~/.workbuddy 命名空间） */
const HANDOFF_DIR = path.join(homedir(), '.workbuddy', 'agent-memory-handoffs');
/** 交接文本上限（前端 buildHandoff 自身截断到 64 KiB，这里留一倍余量防滥用） */
const HANDOFF_MAX_BYTES = 128 * 1024;

/** 同 synthesis.ts 的 resolveBin：PATH 探测，找不到返回 null */
function resolveCliBin(name: string): string | null {
  if (/[/\\]/.test(name)) return name; // 显式路径直接信任
  try {
    const r = spawnSync('bash', ['-c', `command -v ${JSON.stringify(name)}`], { timeout: 3000 });
    const out = (r.stdout ?? '').toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** POSIX 单引号安全包装 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * macOS 拉起终端：把 shell 命令写成 .command 启动脚本，`open -a Terminal` 执行。
 * 不走 osascript/Apple Events（依赖「自动化」授权，headless/远程场景易 -10004），
 * LaunchServices 打开 .command 无需额外权限，Terminal 会新开窗口执行。
 */
async function launchMacTerminal(shellCmd: string): Promise<{ ok: boolean; stderr?: string }> {
  const scriptFile = path.join(HANDOFF_DIR, `resume-${Date.now()}.command`);
  try {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    writeFileSync(scriptFile, `#!/bin/bash\n${shellCmd}\n`, { mode: 0o755 });
    chmodSync(scriptFile, 0o755);
  } catch (e) {
    return { ok: false, stderr: String((e as Error)?.message ?? e) };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('open', ['-a', 'Terminal', scriptFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, stderr: String((e as Error)?.message ?? e) });
      return;
    }
    let errOut = '';
    child.stderr?.on('data', (d: Buffer) => (errOut += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ ok: false, stderr: 'open 超时（5s）' });
    }, 5000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr: errOut.trim() || `open exit ${code}` });
    });
  });
}

export function registerPersonalSpaceRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/personal-space/mode', (c) => {
    return c.json({
      code: 0,
      message: 'OK',
      data: { singleUser: isSingleUser(deps) },
    });
  });

  // 列表（只返摘要；P4 增量缓存已在引擎内部按 mtime+size 复用）
  api.get('/personal-space/sessions', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const eng = await getEngine();
      const { facts, cached, rebuilt, coldMs } = eng.computeAllSessions(true);
      const list = facts.map((f: Record<string, unknown>) => ({
        sessionId: f.sessionId,
        kind: f.kind,
        parentId: f.parentId ?? null,
        vendor: f.vendor,
        state: f.state,
        startedAt: f.startedAt ?? null,
        endedAt: f.endedAt ?? null,
        recordCount: f.recordCount,
        size: f.size,
        mtime: f.mtime,
        firstPrompt: f.firstPrompt,
        title: f.title ?? '',
        spawnTask: f.spawnTask ?? '',
        userTurns: f.userTurns,
        assistantTurns: f.assistantTurns,
        tokens: f.tokens,
        costUsd: f.costUsd,
        costEstimated: !!f.costEstimated,
        models: (Array.isArray(f.models) ? f.models : []).map((m: Record<string, unknown>) => ({
          model: m.model,
          costUsd: m.costUsd,
          estimated: !!m.estimated,
        })),
        git: f.git ?? null,
        edits: f.edits,
        digest: f.digest,
      }));
      return c.json({
        code: 0,
        message: 'OK',
        data: {
          sessions: list,
          stats: { total: list.length, cached, rebuilt, coldMs },
        },
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 单会话派生事实 + 时间线（供 Inspector）
  api.get('/personal-space/facts', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const id = String(c.req.query('id') ?? '');
      const vendorQ = String(c.req.query('vendor') ?? '');
      const eng = await getEngine();
      const { facts } = eng.computeAllSessions(true);
      const f = facts.find(
        (x: Record<string, unknown>) =>
          x.sessionId === id && (!vendorQ || String(x.vendor ?? '') === vendorQ),
      );
      if (!f) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      // 时间线按需单文件读（M1 DoD② 索引化：computeAllSessions 不再随全量扫描返回 records）
      // vendor 取自该 facts 条目本身（多 vendor：workbuddy / codex…），不能写死 workbuddy。
      const sc = eng.scanOne(String(f.vendor ?? 'workbuddy'), id);
      const records = (sc?.raw?.records ?? []) as Record<string, unknown>[];
      const timeline = records
        .map((r) => ({
          type: r.type,
          role: r.role,
          ts: (r.timestamp ?? r.ts) || null,
          name: r.name ?? null,
          len: typeof r.content === 'string' ? r.content.length : 0,
        }))
        .filter((x) => x.ts)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      // M-B：把引擎新派生字段从 facts 对象提到响应级兄弟字段（设计契约：fresh/debrief/filesChanged/commits/todos/commands 与 facts 平级）
      const fAny = f as Record<string, unknown>;
      const gitAny = (fAny.git ?? null) as Record<string, unknown> | null;
      return c.json({
        code: 0,
        message: 'OK',
        data: {
          facts: f,
          timeline,
          recordCount: records.length,
          // S6 · TIMELINE 条目流（facts 引擎已派生 digestEntries）
          digest: (fAny.digestEntries as
            | { turn: number; category: string; description: string; answer?: string; subagentId?: string; time?: number }[]
            | undefined) ?? null,
          debrief:
            (fAny.debrief as
              | { goal: string; goalSource?: 'declared' | 'inferred' | 'floor'; outcome: string; keyDecisions: string[] }
              | undefined) ?? null,
          filesChanged: (fAny.filesChanged as { path: string; additions: number; deletions: number; edits: number; isNew: boolean }[] | undefined) ?? null,
          commits: (gitAny?.commits as { hash: string; message: string; ts: number }[] | undefined) ?? null,
          todos: (fAny.todos as { subject: string; status: string; completed: boolean }[] | undefined) ?? null,
          commands: (fAny.commands as { name: string; count: number }[] | undefined) ?? null,
          // fresh：当前 facts 始终基于 mtime+size 缓存即时重算（命中即准确），故恒为 true；
          // 预留给未来"仅摘要/陈旧快照"场景（届时 fresh=false 触发 M-A 的陈旧 banner）。
          fresh: true,
        },
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // ── M4b · 取会话真实消息（供「我的技能」从对话洞察导入对话）──
  // 复用 scanOne 读单会话 records，归一化为 skill/extract 可直接消费的 messages：
  //   role 映射到 {user,assistant,system,tool_call,tool_result}，跳过非对话 role
  //   （compaction/summary/ai-title/event/thinking 等）；content 为 array 时拼接 text 块。
  // 上限 500 条（与 extract request 上限一致），超出取尾部最近 500 条。
  api.get('/personal-space/records', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const id = String(c.req.query('id') ?? '').trim();
      if (!id) return c.json({ code: 400, message: 'MISSING_SESSION_ID', data: null }, 400);
      const vendorQ = String(c.req.query('vendor') ?? '');
      const eng = await getEngine();
      const { facts } = eng.computeAllSessions(true);
      const f = facts.find(
        (x: Record<string, unknown>) =>
          x.sessionId === id && (!vendorQ || String(x.vendor ?? '') === vendorQ),
      );
      if (!f) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      const sc = eng.scanOne(String(f.vendor ?? 'workbuddy'), id);
      const raw = (sc?.raw?.records ?? []) as Record<string, unknown>[];

      const ROLE_MAP: Record<string, string> = {
        user: 'user',
        assistant: 'assistant',
        system: 'system',
        tool: 'tool_result',
        tool_result: 'tool_result',
        function_result: 'tool_result',
        tool_call: 'tool_call',
        tool_use: 'tool_call',
        function_call: 'tool_call',
      };
      const textOf = (c: unknown): string => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          return c
            .map((b: unknown) => {
              if (typeof b === 'string') return b;
              if (b && typeof b === 'object') {
                const o = b as Record<string, unknown>;
                return typeof o.text === 'string' ? o.text : typeof o.content === 'string' ? o.content : '';
              }
              return '';
            })
            .join(' ')
            .trim();
        }
        if (c && typeof c === 'object') return JSON.stringify(c);
        return String(c ?? '');
      };

      const capped = raw.slice(-500);
      const messages = capped
        .map((r) => {
          const role = typeof r.role === 'string' ? ROLE_MAP[r.role] : undefined;
          if (!role) return null;
          const content = textOf(r.content).trim();
          if (!content) return null;
          const msg: Record<string, unknown> = { role, content };
          const toolName =
            (typeof r.tool_name === 'string' && r.tool_name) ||
            (typeof r.toolName === 'string' && r.toolName) ||
            undefined;
          const toolCallId =
            (typeof r.tool_call_id === 'string' && r.tool_call_id) ||
            (typeof r.toolCallId === 'string' && r.toolCallId) ||
            undefined;
          if (toolName) msg.tool_name = toolName;
          if (toolCallId) msg.tool_call_id = toolCallId;
          return msg;
        })
        .filter((m): m is Record<string, unknown> => m !== null);

      return c.json({
        code: 0,
        message: 'OK',
        data: {
          sessionId: id,
          title: (f.title as string) ?? '',
          messageCount: messages.length,
          messages,
        },
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // Resume Readiness 五格（上下文 / 压缩 / 分支 / 工作区 / 缓存）—— v7 语义重写
  api.get('/personal-space/handoff', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const id = String(c.req.query('id') ?? '');
      const eng = await getEngine();
      const { facts } = eng.computeAllSessions(true);
      const f = facts.find((x: Record<string, unknown>) => x.sessionId === id);
      if (!f) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      // 阈值与配色集中引擎侧（buildReadiness），前端只渲染颜色
      const { readiness, verdict } = eng.buildReadiness(f, Date.now());
      return c.json({
        code: 0,
        message: 'OK',
        data: {
          sessionId: id,
          verdict,
          contextTokens: (f.contextTokens as number) ?? null,
          contextWindow: (f.contextWindow as number) ?? null,
          lastEditAt: (f.lastEditAt as number) ?? null,
          baseBranch: (f.baseBranch as string) ?? null,
          readiness,
        },
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // AI Synthesis（默认关闭；启用后按 coSlash schema 合成 Debrief，落盘缓存 + pending 轮询）
  api.get('/personal-space/synthesis', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const id = String(c.req.query('id') ?? '');
      const eng = await getEngine();
      const { facts } = eng.computeAllSessions(true);
      const f = facts.find((x: Record<string, unknown>) => x.sessionId === id);
      if (!f) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      const sc = eng.scanOne('workbuddy', id);
      const raw = (sc?.raw?.records ?? []) as Record<string, unknown>[];
      const synth = await getSynthesisModule();
      const result = await synth.getSynthesis(id, f, { records: raw });
      return c.json({
        code: 0,
        message: 'OK',
        data: result,
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // ── M-D · Resume：拉起终端新会话（POST；.command + `open -a Terminal`，纯本地动作）──
  api.post('/personal-space/resume', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        sessionId?: unknown;
        mode?: unknown;
        handoffText?: unknown;
      };
      const id = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!id) return c.json({ code: 400, message: 'MISSING_SESSION_ID', data: null }, 400);
      const mode = body.mode === 'fresh' ? 'fresh' : 'handoff';
      const handoffText = typeof body.handoffText === 'string' ? body.handoffText : '';
      if (mode === 'handoff' && !handoffText.trim()) {
        return c.json({ code: 400, message: 'MISSING_HANDOFF_TEXT', data: null }, 400);
      }
      if (Buffer.byteLength(handoffText, 'utf8') > HANDOFF_MAX_BYTES) {
        return c.json({ code: 413, message: 'HANDOFF_TOO_LARGE', data: null }, 413);
      }

      // 会话必须解析得出工作目录，否则终端无从 cd
      const eng = await getEngine();
      const { facts } = eng.computeAllSessions(true);
      const f = facts.find((x: Record<string, unknown>) => x.sessionId === id);
      if (!f) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      const git = f.git as { cwd?: string } | null | undefined;
      const cwd = git?.cwd;
      if (!cwd) {
        return c.json({ code: 400, message: 'NO_CWD', data: null }, 400);
      }

      // CLI 解析（与 AI Synthesis 同源：TDAI_RESUME_BACKEND > TDAI_SYNTHESIS_BACKEND > codebuddy）
      const backend =
        process.env.TDAI_RESUME_BACKEND ?? process.env.TDAI_SYNTHESIS_BACKEND ?? 'codebuddy';
      const bin = resolveCliBin(backend);
      if (!bin) {
        return c.json({ code: 400, message: `BACKEND_NOT_FOUND:${backend}`, data: null }, 400);
      }

      // handoff 模式：交接文本落盘，经 stdin 管道注入交互式 CLI
      let handoffFile: string | null = null;
      if (mode === 'handoff') {
        mkdirSync(HANDOFF_DIR, { recursive: true });
        // sessionId 形如 "Users-xxx/<uuid>"，含路径分隔符，必须 flatten 成安全文件名
        const safeId = id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
        handoffFile = path.join(HANDOFF_DIR, `${safeId}-${Date.now()}.md`);
        writeFileSync(handoffFile, handoffText);
      }

      const inner =
        mode === 'handoff'
          ? `cd ${shq(cwd)} && cat ${shq(handoffFile!)} | ${shq(bin)}`
          : `cd ${shq(cwd)} && ${shq(bin)}`;

      if (process.platform !== 'darwin') {
        return c.json({ code: 501, message: 'TERMINAL_LAUNCH_UNSUPPORTED', data: null }, 501);
      }
      const launched = await launchMacTerminal(inner);
      if (!launched.ok) {
        return c.json(
          { code: 500, message: `TERMINAL_LAUNCH_FAILED:${launched.stderr ?? ''}`, data: null },
          500,
        );
      }
      return c.json({
        code: 0,
        message: 'OK',
        data: { ok: true, mode, cwd, backend, handoffFile },
      });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // ── M4b · 个人记忆写入 / 状态 / 浏览（proxy 到 gateway；gateway 拥有 store + LLM）──
  // 本地单机自用：panel 不直连 SQLite（避免跨进程锁竞争），统一由 gateway 落库后回读状态。
  const resolveGateway = (): { endpoint: string; apiKey: string } => {
    let entry;
    try {
      entry = deps.instanceRegistry.resolve('default');
    } catch {
      entry = deps.instanceRegistry.listAll()[0];
    }
    const e = entry ?? ({ gateway_endpoint: 'http://127.0.0.1:8420', api_key: 'local' } as {
      gateway_endpoint: string;
      api_key: string;
    });
    return { endpoint: e.gateway_endpoint, apiKey: e.api_key };
  };

  const proxyToGateway = async (
    c: { json: (o: unknown, status?: number) => unknown },
    subPath: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Response | void> => {
    if (!singleUserGuard(c as never, deps)) return;
    try {
      const { endpoint, apiKey } = resolveGateway();
      const r = await fetch(`${endpoint}${subPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({ code: r.status, message: r.statusText, data: null }));
      return c.json(data, r.status) as Response;
    } catch (e) {
      return c.json({ code: 502, message: String((e as Error)?.message ?? e), data: null }, 502) as Response;
    }
  };

  api.post('/personal-space/extract', async (c) => {
    if (!singleUserGuard(c, deps)) return;
    const body = await c.req.json().catch(() => ({}));
    return proxyToGateway(c, '/api/v1/personal/extract', 'POST', body);
  });
  api.get('/personal-space/source-sessions', (c) => proxyToGateway(c, '/api/v1/personal/source-sessions', 'GET'));
  api.get('/personal-space/pending', (c) => {
    const vendor = String(c.req.query('vendor') ?? 'workbuddy');
    const sessionId = String(c.req.query('sessionId') ?? '');
    return proxyToGateway(c, `/api/v1/personal/pending?vendor=${encodeURIComponent(vendor)}&sessionId=${encodeURIComponent(sessionId)}`, 'GET');
  });
  api.get('/personal-space/memories', (c) => proxyToGateway(c, '/api/v1/personal/memories', 'GET'));
  // ── M4b · 个人记忆 L2/L3 产物浏览（proxy 到 gateway；复用对话记忆的 scene/persona 落盘）──
  api.get('/personal-space/scenes', (c) => {
    const vendor = String(c.req.query('vendor') ?? '');
    const sub = vendor ? `/api/v1/personal/scenes?vendor=${encodeURIComponent(vendor)}` : '/api/v1/personal/scenes';
    return proxyToGateway(c, sub, 'GET');
  });
  api.get('/personal-space/persona', (c) => {
    const vendor = String(c.req.query('vendor') ?? '');
    const sub = vendor ? `/api/v1/personal/persona?vendor=${encodeURIComponent(vendor)}` : '/api/v1/personal/persona';
    return proxyToGateway(c, sub, 'GET');
  });
}
