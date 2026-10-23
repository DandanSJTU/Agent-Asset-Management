import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { scanLocalAgentSkills, readLocalAgentSkillContent } from '../../lib/scan-local-agent-skills.js';

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

  /**
   * GET /api/v1/local-agent-skills/content?path=<skill-dir> —— 读取单个本地 skill 的完整内容。
   *
   * 供「从本地导入」落库：后端按 path 读取 SKILL.md（content）+ 其余资源文件
   * （resources，utf-8/base64 自动判定），返回给前端后直接交给 personal-skills/create。
   * path 必须是已知 agent root 子目录，否则返回 PATH_NOT_ALLOWED（防目录遍历）。
   */
  api.get(
    '/local-agent-skills/content',
    validatePanelMetaHeaders(deps),
    async (c) => {
      const path = c.req.query('path');
      if (!path || typeof path !== 'string') {
        return c.json(
          { code: 400, message: 'MISSING_PATH', request_id: c.get('reqId') ?? '', data: null },
          400,
        );
      }
      try {
        const data = readLocalAgentSkillContent(path, process.cwd());
        return c.json({ code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg === 'PATH_NOT_ALLOWED' ? 400 : 500;
        const message = msg === 'PATH_NOT_ALLOWED' ? 'PATH_NOT_ALLOWED' : 'READ_LOCAL_SKILL_FAILED';
        return c.json({ code, message, request_id: c.get('reqId') ?? '', data: null }, code);
      }
    },
  );
}
