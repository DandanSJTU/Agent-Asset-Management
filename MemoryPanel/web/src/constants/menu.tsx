/**
 * 菜单元数据 — 从 App.tsx 抽出
 *
 * 包含页面 ID 类型、页面元信息、分组排序、分组图标。
 * Sidebar / TabBar / 路由等模块共用。
 */
import { useTranslation } from 'react-i18next';
import {
  DashboardIcon,
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';

export type PageId =
  | 'workbench_board'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'team_members'
  | 'team_agents'
  | 'api_keys'
  | 'analytics'
  | 'personal_insights'
  | 'personal_memory'
  | 'layered_refine'
  | 'personal_skills'
  | 'ai_collab';

/** 页面元数据 */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** 所属分组，用于侧边栏菜单分组标题 */
  group: string;
  /** 分组内排序，越小越靠前 */
  order: number;
  /** 固定标签页不可关闭（工作台看板） */
  affix?: boolean;
  /**
   * 不在侧边栏菜单中展示（路由仍保留可达）。
   * 用于「功能已合并进别的 tab，但先不删旧页面」的过渡期。
   */
  hidden?: boolean;
}

// 使用 useTranslation 的 hook 版本
export function usePageMeta(): Record<PageId, PageMeta> {
  const { t } = useTranslation();
  return {
    // 2026-10-15 按需求隐藏「任务看板」：侧边栏+标签栏均不展示；'/' index 路由已改跳 /insights，
    // WorkbenchPage 暂不在路由表渲染（页面代码保留，后续需要时加一行路由即可恢复）。
    workbench_board: { id: 'workbench_board', label: t('menu.workbench_board'), desc: t('menu.desc.workbench_board'), group: t('menu.group.workbench'), order: 0, affix: true, hidden: true },
    analytics:      { id: 'analytics',      label: t('menu.analytics'), desc: t('menu.desc.analytics'), group: t('menu.group.observability'), order: 0 },
    team_agents:     { id: 'team_agents',     label: t('menu.team_agents'), desc: t('menu.desc.team_agents'), group: t('menu.group.assets'), order: 0 },
    wiki:            { id: 'wiki',            label: t('menu.wiki'), desc: t('menu.desc.wiki'), group: t('menu.group.assets'), order: 1 },
    // Code_Graph：按需求隐藏前端入口（侧边栏与标签栏均不展示，路由仍可达以保留过渡能力）。
    code:            { id: 'code',            label: t('menu.code'), desc: t('menu.desc.code'), group: t('menu.group.assets'), order: 2, hidden: true },
    skills:          { id: 'skills',          label: t('menu.skills'), desc: t('menu.desc.skills'), group: t('menu.group.assets'), order: 3 },
    chat_memory:     { id: 'chat_memory',     label: t('menu.chat_memory'), desc: t('menu.desc.chat_memory'), group: t('menu.group.assets'), order: 4 },
    team_members:    { id: 'team_members',    label: t('menu.team_members'), desc: t('menu.desc.team_members'), group: t('menu.group.organization'), order: 0 },
    api_keys:        { id: 'api_keys',        label: t('menu.api_keys'), desc: t('menu.desc.api_keys'), group: t('menu.group.organization'), order: 1 },
    personal_insights: { id: 'personal_insights', label: t('menu.personal_insights'), desc: t('menu.desc.personal_insights'), group: t('menu.group.personal'), order: 0 },
    personal_memory:   { id: 'personal_memory',   label: t('menu.personal_memory'),   desc: t('menu.desc.personal_memory'),   group: t('menu.group.personal'), order: 1 },
    // 2026-10-15 收敛后与「我的记忆」渲染同一组件（LayeredRefinePage 即 MyMemoryPage），
    // 菜单隐藏避免重复入口；路由 /layered-refine 仍保留可达（过渡期，同 Code_Graph 处理）。
    layered_refine:    { id: 'layered_refine',    label: t('menu.layered_refine'),    desc: t('menu.desc.layered_refine'),    group: t('menu.group.personal'), order: 2, hidden: true },
    // 「我的技能」：个人私有技能库（team_id='personal' + 虚拟 agent），与团队 Skills 页平行但彼此隔离。
    personal_skills:   { id: 'personal_skills',   label: t('menu.personal_skills'),   desc: t('menu.desc.personal_skills'),   group: t('menu.group.personal'), order: 3 },
    // 「AI 协作」（ai_collab）：按需求移除前端入口——侧边栏与标签栏均不展示（hidden: true），
    // 路由 /ai-collab 与页面代码保留可达，需要恢复时删掉 hidden 即可（与 workbench_board / code 同款处理）。
    ai_collab:         { id: 'ai_collab',         label: t('menu.ai_collab'),         desc: t('menu.desc.ai_collab'),         group: t('menu.group.assets'), order: 5, hidden: true },
  };
}

/** 分组排序顺序：工作台 → 个人空间 → Agent记忆 → 组织与权限（数据分析默认隐藏，置于末尾） */
export const GROUP_ORDER_KEYS = ['workbench', 'personal', 'assets', 'organization', 'observability'] as const;

/** 每个页面在侧边栏菜单中的图标（Tea 官方图标，size 16） */
export const ITEM_ICON: Record<PageId, JSX.Element> = {
  workbench_board: <DashboardIcon size={16} />,
  analytics: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="10" width="3" height="6" rx="0.8" />
      <rect x="10.5" y="6" width="3" height="10" rx="0.8" />
      <rect x="15" y="13" width="3" height="3" rx="0.8" />
    </svg>
  ),
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  personal_skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
  ai_collab: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 3.4L17 8l-3.4 1.6L12 13l-1.6-3.4L7 8l3.4-1.6L12 3z" />
      <path d="M5 14l.9 1.9L8 17l-2.1 1.1L5 20l-.9-1.9L2 17l2.1-1.1L5 14z" />
      <path d="M18 14l.9 1.9L21 17l-2.1 1.1L18 20l-.9-1.9L15 17l2.1-1.1L18 14z" />
    </svg>
  ),
  personal_insights: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  personal_memory: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-9-9" />
      <path d="M21 3v6h-6" />
    </svg>
  ),
  layered_refine: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="5" rx="1.2" />
      <rect x="3" y="10" width="18" height="5" rx="1.2" />
      <rect x="3" y="16" width="18" height="4" rx="1.2" />
    </svg>
  ),
};

/** 分组图标（工作台 / 可观测 / 组织与权限 / 资产管理） */
export const GROUP_ICON: Record<string, JSX.Element> = {
  workbench: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  observability: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  organization: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  assets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
  personal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 16 0v1" />
    </svg>
  ),
};
