/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, Navigate, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { SessionInsightsPage } from '@/pages/SessionInsightsPage';
import { MyMemoryPage } from '@/pages/MyMemoryPage';
import { LayeredRefinePage } from '@/pages/LayeredRefinePage';
import { MySkillsPage } from '@/pages/MySkillsPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { GuidePage } from '@/pages/GuidePage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      // 「任务看板」已按需求隐藏（menu.tsx workbench_board.hidden）：'/' 不再渲染看板，
      // 统一落到「会话洞察」；WorkbenchPage 代码保留，恢复时改回 <WorkbenchPage /> 即可。
      { index: true, element: <Navigate to="/insights" replace /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'insights', element: <SessionInsightsPage /> },
      { path: 'my-memory', element: <MyMemoryPage /> },
      { path: 'layered-refine', element: <LayeredRefinePage /> },
      { path: 'personal/skills', element: <MySkillsPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'guide', element: <GuidePage /> },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);
