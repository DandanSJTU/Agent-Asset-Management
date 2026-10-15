import { useAuthStore } from '@/stores/auth';
import { useCurrentRole } from '@/services/useCurrentRole';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';

export function AgentsPage() {
  const { auth } = useAuthStore();
  const role = useCurrentRole();
  if (!auth) return null;

  return (
    <TeamManagementPanel
      currentUser={auth.user_id}
      instanceId={auth.instance_id}
      isAdmin={role === 'admin'}
      section="agents"
      // Agent 模块（默认 Agent 模板 + Agents 卡片网格）暂隐藏，
      // 后续将在本页增加其他资产管理模块；恢复显示删掉这行即可。
      showAgentModules={false}
    />
  );
}
