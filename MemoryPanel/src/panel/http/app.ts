import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import { apiCallTelemetryMiddleware } from './middleware/api-call-telemetry-middleware.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerSkillProxyRoutes } from './routes/skill/proxy.js';
import { registerPersonalSkillRoutes } from './routes/personal-skills.js';
import { registerLocalAgentSkillRoutes } from './routes/local-agent-skills.js';
import { registerAnalyticsProxyRoutes } from './routes/analytics/proxy.js';
import { registerChatMemoryRoutes } from './routes/chat-memory.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerTaskSourceRoutes } from './routes/task-source.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';
import { registerAuthRoutes, registerWoaIngressRoutes } from './routes/auth.js';
import { registerPersonalSpaceRoutes } from './routes/personal-space.js';
import { registerLayeredRefineRoutes } from './routes/layered-refine.js';
import { registerAiCollabRoutes } from './routes/ai-collab.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  // API 调用审计（可选 ClickHouse 上报，不配则 NoOp）
  // user_id 采集三级兜底: route.set('resolvedUserId') > userIdResolver cache > 空
  api.use('*', apiCallTelemetryMiddleware(deps.apiCallTelemetry, deps.userIdResolver));
  registerMetaInstanceRoutes(api, deps);
  registerAuthRoutes(api, deps);
  registerMetaProxyRoutes(api, deps);
  // Skill 数据面透明代理：/api/v1/skill/* → 内核 /v3/skill/*
  registerSkillProxyRoutes(api, deps);
  // 个人技能库代理：/api/v1/personal-skills/* → 内核 /v3/skill/*（服务端注入 personal scope 身份）
  registerPersonalSkillRoutes(api, deps);
  // 本地 Agent 技能浏览器：只读扫描本机各 agent 的 skill 目录（「我的技能 → 本地 Agent 技能」）
  registerLocalAgentSkillRoutes(api, deps);
  // Analytics 查询面透明代理：/api/v1/analytics/* → 内核 /v3/analytics/*
  registerAnalyticsProxyRoutes(api, deps);
  // Chat Memory 面板 3-tab 专属业务路由（12.3 决策例外，见 chat-memory.ts 顶注释）
  registerChatMemoryRoutes(api, deps);
  // Task 聚合路由：task/list + 批量 task-agent/list 一次返回
  registerTaskRoutes(api, deps);
  // Task 外部来源：/api/v1/task/source/* → 内核 /v3/task-source/*（令牌随请求体下发，不留存）
  registerTaskSourceRoutes(api, deps);
  registerAgentOverviewRoutes(api, deps);
  // Agent 生命周期业务路由：/agent/delete-cascade 在 control 层级联清 skill 再 archive
  registerAgentLifecycleRoutes(api, deps);
  registerKnowledgeRoutes(api, deps);
  // 会话洞察（Session Insights）观测面：复用 agents/personal-space 派生事实引擎
  registerPersonalSpaceRoutes(api, deps);
  // 分层提炼（Layered Refine）独立第二车道：复用 agents/layered-refine 引擎（MemoryCore 零改动）
  registerLayeredRefineRoutes(api, deps);
  // AI 协作：记忆资产对比演示（demo 版，脚本化内容；后续可接真实检索 + LLM）
  registerAiCollabRoutes(api, deps);
  app.route(API_PREFIX, api);
  // 仅当至少一个 header-injected Provider 已注册时才挂 ingress 中间件：
  // 该中间件会拦截"根路径 GET + 命中任一 Provider 的 ingressHeaderName"的请求
  // 自动完成 IdP 登录。未启用时不注册，上游网关转发来的带头请求会原样落到静态资源，
  // 避免"未开 IdP 却仍被 IdP 流程绑架"。
  // 双层 optional chaining：既有测试 fixture 只塞被测路由需要的字段，`deps.auth`
  // 与 `deps.config.auth` 常被整块省略；缺任何一层都视为未启用 IdP，与 v1 时代
  // `deps.config.auth?.woa?.enabled` 的兼容语义一致。
  if (deps.auth?.listHeaderInjectedProviders?.().length) {
    registerWoaIngressRoutes(app, deps);
  }

  app.onError((err, c) => {
    deps.logger.error('panel unhandled error', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      { code: 500, message: 'INTERNAL', request_id: c.get('reqId') ?? '', data: null },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  app.use('/*', serveStatic({ root: distDir }));
  app.get('*', (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p === '/health') return next();
    // index.html 不缓存：serveStatic 会新建 Response 覆盖 c.header()，故这里直接读文件返回。
    // 无协商头时浏览器启发式缓存会钉死旧 bundle（前端发版后用户看不到新版，2026-10-16 踩坑）；
    // 带 hash 的 assets 由 vite 文件名自然失效，仍走上面的长缓存静态服务。
    const html = readFileSync(path.join(distDir, 'index.html'), 'utf-8');
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}
