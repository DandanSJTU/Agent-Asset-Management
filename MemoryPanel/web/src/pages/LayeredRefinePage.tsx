/**
 * LayeredRefinePage — 分层提炼 tab。
 *
 * 2026-10-15 收敛：原本「分层提炼」由 agents/layered-refine 自研引擎（codebuddy CLI +
 * 平文件 observations/candidates/axioms）驱动，与对话记忆的提炼是平行双实现。
 * 现统一复用对话记忆的提炼管线，详见 MyMemoryPage 顶部注释。
 *
 * 为避免重复 UI，本 tab 直接复用 MyMemoryPage（同一套对话记忆 L1/L2/L3 视图：
 * L1 观测 / L2 场景 / L3 画像 + 源会话选择器 + 最近运行）。后续若要在「分层提炼」
 * 与「我的记忆」两 tab 间区分视角，可在此组件内包裹差异化的筛选/默认 tab，
 * 底层数据层（personal-space 客户端 + 网关 personal 端点）无需改动。
 */
import { MyMemoryPage } from '@/pages/MyMemoryPage';

export function LayeredRefinePage() {
  return <MyMemoryPage />;
}
