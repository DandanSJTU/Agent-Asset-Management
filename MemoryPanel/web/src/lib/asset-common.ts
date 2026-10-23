/**
 * asset-common —— 资产（Wiki / Code / Skill / Memory）页共享的类型与纯工具函数。
 *
 * 此前这些类型与工具函数在 wiki-constants.ts / code-constants.ts /
 * memory types.ts 中各自重复定义，这里统一收口，页面文件通过 re-export 保持
 * 原有 import 路径不变。
 */

/** 列表视图切换：卡片 / 表格 */
export type ViewMode = 'card' | 'list';

/** 列表状态筛选 */
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

/** 资产页子视图：列表 / 详情 */
export type SubView = 'list' | 'detail';

/**
 * 资产作用域：
 *   - team  团队池（visibility=team，全团队可见）
 *   - mine  我的（团队空间内 visibility=private 且 owner=我的资产）
 *   - fixed 固定资产（单个 agent 名下绑定；入口已隐藏，保留为死分支）
 *
 * 注意 mine ≠ 侧边栏「个人空间」：后者是 team_id='personal' 的独立命名空间，
 * 与团队空间内的 private 资产不是同一份数据。
 */
export type ScopeTab = 'team' | 'mine' | 'fixed';

/**
 * ISO 时间字符串 → 面板展示格式（本地时区，'MM/DD HH:MM'）。
 * 输入为空或非法 → 返回 '—'。
 * 此前在 wiki-constants.ts 与 code-constants.ts 中实现完全相同，收敛到此。
 */
export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
