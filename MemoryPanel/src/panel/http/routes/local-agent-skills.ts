import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { scanLocalAgentSkills } from '../../lib/scan-local-agent-skills.js';

/**
 * GET /api/v1/local-agent-skills —— 扫描本机所有 Agent 客户端的本地 skill 库。
 *
 * 只读、本地文件系统扫描（不落库、不调内核）。与 `/api/v1/personal-skills/*` 互补：
 * 后者是「我的技能」个人库（落 MemoryCore，DB 托管），本接口是「本地 Agent 技能」
 * 浏览器（直接读磁盘上各 agent 的 skill 目录）。
 *
 * 复用 validatePanelMetaHeaders：要求 X-Tdai-Service-Id + X-Tdai-User-Key，与面板
 * 其它业务接口一致；扫描结果仅含当前登录用户本机的 skill 目录，无越权风险。
 */
export function registerLocalAgentSkillRoutes(api: Hono, deps: PanelDeps): void {
  api.get(
    '/local-agent-skills',
    validatePanelMetaHeaders(deps),
    async (c) => {
      try {
        const result = scanLocalAgentSkills({ cwd: process.cwd() });
        return c.json({
          code: 0,
          message: 'ok',
          request_id: c.get('reqId') ?? '',
          data: result,
        });
      } catch (err) {
        deps.logger.error('scan local agent skills failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        return c.json(
          {
            code: 500,
            message: 'SCAN_LOCAL_AGENT_SKILLS_FAILED',
            request_id: c.get('reqId') ?? '',
            data: null,
          },
          500,
        );
      }
    },
  );
}
