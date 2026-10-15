/**
 * /api/v1/layered/* —— 分层提炼（Layered Refine）独立第二车道路由。
 *
 * 设计要点（对齐 layered-refine-tab-design.html，M2 闭环）：
 *   1. 本路由是「proxy 式转发层」：不含任何提炼业务逻辑，全部委托给
 *      agents/layered-refine/index.ts（动态 import，避开 tsc rootDir 静态依赖，
 *      与 personal-space 路由懒加载 facts.ts 同构）。
 *   2. MemoryCore / gateway / 现有两个 tab 零改动；本期产物落用户级目录
 *      ~/.workbuddy/user-...-personal/context-infra/（md + jsonl + axioms）。
 *   3. 长耗时任务（observer / reflector / axiom）走 module 级后台 job 注册表，
 *      前端 2s 轮询 /jobs?id= 拿进度（抄 synthesis.ts 模式）。
 *   4. 单机自用硬校验（与 personal-space 同）：多用户部署整 tab 禁用。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';

function isSingleUser(_deps: PanelDeps): boolean {
  return true;
}

// 懒加载分层提炼引擎（跨包动态 import，避开 tsc rootDir 静态依赖）
let _enginePromise: Promise<typeof import('../../../../../agents/layered-refine/index.ts')> | null = null;

async function getEngine() {
  if (!_enginePromise) {
    const here = path.dirname(fileURLToPath(import.meta.url)); // routes → http → panel → src → MemoryPanel → 仓库根
    const repoRoot = path.resolve(here, '../../../../../');
    const enginePath = path.join(repoRoot, 'agents/layered-refine/index.ts');
    _enginePromise = import(enginePath) as unknown as Promise<typeof import('../../../../../agents/layered-refine/index.ts')>;
  }
  return _enginePromise;
}

function singleUserGuard(c: { json: (o: unknown, status?: number) => unknown }, deps: PanelDeps): boolean {
  if (!isSingleUser(deps)) {
    c.json({ code: 403, message: 'SINGLE_USER_ONLY', data: null }, 403);
    return false;
  }
  return true;
}

export function registerLayeredRefineRoutes(api: Hono, deps: PanelDeps): void {
  const guard = (c: { json: (o: unknown, status?: number) => unknown }) => singleUserGuard(c, deps);

  // 状态（目录 / 计数 / 最后运行 / 配置）
  api.get('/layered/status', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const data = await eng.getStatus();
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // L1 观测列表（读 jsonl 影子副本）
  api.get('/layered/observations', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const since = String(c.req.query('since') ?? '');
      const level = String(c.req.query('level') ?? '');
      const q = String(c.req.query('q') ?? '');
      const data = eng.listObservations({
        ...(since ? { since } : {}),
        ...(level ? { level: level as never } : {}),
        ...(q ? { q } : {}),
      });
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 可选源会话列表（UI 勾选"跑哪几个对话"）
  api.get('/layered/sessions', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const limit = Number(c.req.query('limit') ?? 40);
      const data = eng.listSourceSessions(Number.isFinite(limit) ? limit : 40);
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 触发 L1 Observer（返回 jobId，前端轮询）
  // sessionIds 非空 = 只提炼显式勾选的会话（"选 3 个对话跑一遍"）；缺省走窗口自动选源。
  api.post('/layered/observer/run', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const body = (await c.req.json().catch(() => ({}))) as {
        windowDays?: number;
        maxSessions?: number;
        force?: boolean;
        sessionIds?: string[];
      };
      const ids = Array.isArray(body.sessionIds)
        ? body.sessionIds.map((s) => String(s)).filter((s) => s.length > 0)
        : [];
      const { jobId } = eng.runObserverJob({
        ...(typeof body.windowDays === 'number' ? { windowDays: body.windowDays } : {}),
        ...(typeof body.maxSessions === 'number' ? { maxSessions: body.maxSessions } : {}),
        ...(body.force ? { force: true } : {}),
        ...(ids.length ? { sessionIds: ids } : {}),
      });
      return c.json({ code: 0, message: 'OK', data: { jobId, pending: true } });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 清空本车道产物（清掉 offline 桩假数据后重跑；只清 context-infra，不碰 USER.md / MEMORY.md）
  api.post('/layered/reset', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
      if (!body.confirm) return c.json({ code: 400, message: 'confirm required', data: null }, 400);
      const data = eng.resetAll();
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 触发 L2 Reflector
  api.post('/layered/reflector/run', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const { jobId } = eng.runReflectorJob();
      return c.json({ code: 0, message: 'OK', data: { jobId, pending: true } });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // L1 观测「标晋升」：直接推入候选池
  api.post('/layered/observations/:id/promote', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const id = String(c.req.param('id') ?? '');
      const data = eng.promoteObservation(id);
      if (data === null) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // L2 候选列表
  api.get('/layered/candidates', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const data = eng.listCandidates();
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // L2 候选人审（promote / demote / drop）
  api.post('/layered/candidates/:id/decide', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const id = String(c.req.param('id') ?? '');
      const body = (await c.req.json().catch(() => ({}))) as {
        decision?: 'promote' | 'demote' | 'drop';
        target?: 'USER.md' | 'MEMORY.md' | 'axioms';
      };
      if (!body.decision) return c.json({ code: 400, message: 'decision required', data: null }, 400);
      const data = await eng.decideCandidate(id, body.decision, body.target);
      if (data === null) return c.json({ code: 404, message: 'NOT_FOUND', data: null }, 404);
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // L3 公理列表
  api.get('/layered/axioms', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const data = eng.listAxioms();
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 新建 / 蒸馏公理（手动）
  api.post('/layered/axioms', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const body = (await c.req.json().catch(() => ({}))) as { text?: string; sources?: string[] };
      if (!body.text) return c.json({ code: 400, message: 'text required', data: null }, 400);
      const data = await eng.createAxiom({ text: body.text, sources: body.sources });
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });

  // 运行日志 / 单任务进度（2s 轮询）
  api.get('/layered/jobs', async (c) => {
    if (!guard(c)) return;
    try {
      const eng = await getEngine();
      const id = String(c.req.query('id') ?? '');
      const data = id ? eng.getJobs(id) : eng.getJobs();
      return c.json({ code: 0, message: 'OK', data });
    } catch (e) {
      return c.json({ code: 500, message: String((e as Error)?.message ?? e), data: null }, 500);
    }
  });
}
