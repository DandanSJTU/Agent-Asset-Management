import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../../kernel/types.js';

/**
 * /api/v1/personal-skills/* —— 个人技能库数据面代理。
 *
 * 与 `/api/v1/skill/*` 透明代理的关键区别：**服务端注入身份**，不信任前端 body：
 *   - user_id  = panelMeta.userId（IdP 会话）；user_key 认证时现场调 auth/verify 解析
 *   - team_id  = 'personal'（保留值，个人技能库，见 MemoryCore skill-handlers.ts 头注释）
 *   - agent_id = `personal-<user_id>`（每用户虚拟 agent，保证唯一索引按用户隔离）
 *   - list     强制 filters.owner_agent_id = 本人虚拟 agent（防止查到他人个人技能）
 *
 * 管控面约定：个人技能不进 meta_assets（内核 handleCreate / skillAssetHooks 对
 * personal team 跳过 ensureSkillAsset），因此这里不暴露 visibility/ACL 相关动作，
 * 也不暴露 conversation-add（团队增量提炼车道）。
 *
 * `extract` 例外开放：「我的技能」支持「从对话洞察导入对话」——把对话洞察模块的
 * 会话消息交给 skill 提炼管线生成个人技能。extract 走与团队同一套归档→worker→
 * SkillCore.create 链路，但服务端注入 team_id='personal' + agent_id='personal-<userId>'，
 * 生成的技能落个人命名空间、自动进入「我的技能」列表（与个人库 list 的
 * owner_agent_id 过滤一致）。extract 本身不需要 LLM 之外的额外授权，故放开。
 *
 * 白名单与内核 `/v3/skill/{action}` 对齐的子集；新增 action 需同步检查内核
 * schema 是否接受注入后的三元组。
 */

/** 与 MemoryCore skill-handlers.ts 的 PERSONAL_SKILL_TEAM_ID 保持一致。 */
const PERSONAL_SKILL_TEAM_ID = 'personal';

/** 与 MemoryCore skill-handlers.ts 的 personalSkillAgentId() 保持一致。 */
function personalSkillAgentId(userId: string): string {
  return `personal-${userId}`;
}

const ALLOWED_ACTIONS = new Set([
  'list',
  'get',
  'create',
  'update',
  'patch',
  'delete',
  'versions',
  'files/read',
  'files/write',
  'files/remove',
  'export',
  // 「我的技能」从对话洞察导入对话：把会话消息交给 skill 提炼管线。
  'extract',
]);

function readAction(path: string): string {
  const marker = '/personal-skills/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * 身份解析：优先 IdP 会话回填的 panelMeta.userId；
 * user_key 认证（面板前端默认路径）现场调内核 auth/verify 解析并回填 resolver 缓存。
 */
async function resolveUserId(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userKey: string,
  idpUserId: string | undefined,
  reqId?: string,
): Promise<string | null> {
  if (idpUserId) return idpUserId;
  if (!userKey) return null;
  try {
    const env = await deps.metaKernel.invoke('auth/verify', { user_key: userKey }, ctx);
    if (env.code !== 0) return null;
    const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
    const uid = data?.valid ? data.user?.user_id : undefined;
    if (typeof uid === 'string' && uid.length > 0) {
      // 顺手预热 user_key → user_id 缓存（telemetry 埋点受益）
      deps.userIdResolver.warm(userKey, uid, ctx.instanceId);
      return uid;
    }
  } catch {
    return null;
  }
  return null;
}

export function registerPersonalSkillRoutes(api: Hono, deps: PanelDeps): void {
  api.post(
    '/personal-skills/*',
    validatePanelMetaHeaders(deps),
    async (c) => {
      const action = readAction(c.req.path);
      if (!action || !ALLOWED_ACTIONS.has(action)) {
        return respondControlError(c, 404, 'UNKNOWN_PERSONAL_SKILL_ACTION');
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const panelMeta = c.get('panelMeta');
      const ctx: MetaCallContext = {
        instanceId: panelMeta.instanceId,
        gatewayEndpoint: panelMeta.gatewayEndpoint,
        gatewayApiKey: panelMeta.gatewayApiKey,
        userKey: panelMeta.userKey,
        reqId: c.get('reqId'),
      };

      const userId = await resolveUserId(
        deps,
        ctx,
        panelMeta.userKey ?? '',
        panelMeta.userId,
        c.get('reqId'),
      );
      if (!userId) {
        return respondControlError(c, 403, 'PERSONAL_SCOPE_IDENTITY_REQUIRED');
      }

      const agentId = personalSkillAgentId(userId);
      // 服务端权威注入：覆盖（而非合并）三元组，前端传什么都不生效。
      const patched: Record<string, unknown> = {
        ...body,
        user_id: userId,
        team_id: PERSONAL_SKILL_TEAM_ID,
        agent_id: agentId,
      };
      if (action === 'list') {
        const filters = (body.filters as Record<string, unknown> | undefined) ?? {};
        patched.filters = { ...filters, owner_agent_id: agentId };
      }

      const envelope = await deps.skillKernel.invoke(action, patched, ctx);
      return respondEnvelope(c, envelope);
    },
  );
}
