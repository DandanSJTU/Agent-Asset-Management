/**
 * MySkillsPage — 「我的技能」个人技能库。
 *
 * 与团队 SkillsPage 共享 SkillDetailPane / AssetListPanel / AssetSplitLayout /
 * ImportSkillDialog 等组件，但：
 *   - 不展示 team / fixed 双 tab、agent 下拉、可见性切换（个人库天然私密）
 *   - 列表走 personalListSkills（Panel 服务端注入 team_id='personal' +
 *     owner_agent_id=个人虚拟 agent，天然按用户隔离）
 *   - 导入仅开放「目录导入」（createSkill → /api/v1/personal-skills/create），
 *     不开放对话导入（extract 属团队提炼车道，个人库不暴露）
 *   - 详情面板写操作走 personalSkillApi（updateSkill / writeSkillFiles /
 *     removeSkillFiles / versions 均路由到 /api/v1/personal-skills）
 *
 * 数据模型见 MemoryCore skill-handlers.ts 头注释（team_id='personal' 保留值 +
 * agent_id='personal-<userId>' 虚拟 agent）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag } from 'tea-component';
import { DeleteIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { ResourcePage } from '@/pages/ResourcePage';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemId,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import SkillDetailPane from '@/pages/SkillsPage/components/SkillDetailPane';
import ImportSkillDialog from '@/pages/SkillsPage/components/ImportSkillDialog';
import ImportFromInsightDialog from './components/ImportFromInsightDialog';
import { useAuthStore } from '@/stores/auth';
import {
  personalListSkills,
  personalDeleteSkill,
  personalExportSkill,
  personalCreateSkill,
  personalSkillApi,
  type SkillSummary,
} from '@/lib/api/skill-api';
import '../SkillsPage/styles/skills-list.css';

export function MySkillsPage() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const myUserId = auth?.user_id ?? '';

  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showImportFromInsight, setShowImportFromInsight] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.skill_id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await personalListSkills({ pagination: { limit: 200, offset: 0 } });
      setSkills(res.items);
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(
    async (s: SkillSummary) => {
      const ok = await tea.confirm({
        message: t('skills.delete.confirm', { name: s.name }),
        description: t('skills.delete.confirm.desc'),
        okText: t('skills.delete.okText'),
        cancelText: t('skills.delete.cancelText'),
      });
      if (!ok) return;
      setDeleteLoading(true);
      try {
        await personalDeleteSkill(s.skill_id);
        tea.notify.success(t('skills.personal.notify.deleted', { name: s.name }));
        if (selectedSkillId === s.skill_id) setSelectedSkillId(null);
        void refresh();
      } catch (err) {
        tea.notify.error(err);
      } finally {
        setDeleteLoading(false);
      }
    },
    [selectedSkillId, refresh, t],
  );

  const handleExport = useCallback(async () => {
    if (!selectedSkillId) return;
    setExportLoading(true);
    try {
      const result = await personalExportSkill(selectedSkillId);
      const byteChars = atob(result.zip_base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNums[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (result.warnings.length > 0) {
        tea.notify.warning(t('skills.export.partial', { warnings: result.warnings.join('; ') }));
      }
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setExportLoading(false);
    }
  }, [selectedSkillId, t]);

  return (
    <ResourcePage>
      <div className="_memory-skills-body">
        <AssetPageHeader
          title={t('mySkills.title')}
          scope={null}
          subtitle={t('mySkills.subtitle', { count: skills.length })}
          actions={
            <>
              <Button
                onClick={handleExport}
                disabled={!selectedSkillId}
                tooltip={!selectedSkillId ? t('skills.export.tooltip.empty') : undefined}
                loading={exportLoading}
              >
                {t('skills.export')}
              </Button>
              <Button
                type="primary"
                onClick={() => setShowImport(true)}
                data-guide="import-skill"
              >
                {t('skills.import')}
              </Button>
              <Button onClick={() => setShowImportFromInsight(true)}>
                {t('mySkills.importFromInsight')}
              </Button>
            </>
          }
        />

        <AssetSplitLayout
          storageKey="mySkills:assetSplitWidth"
          sidebar={
            <AssetListPanel
              title={t('mySkills.title')}
              count={t('skills.count', { count: skills.length })}
              loading={loading}
              items={skills}
              selectedId={selectedSkillId}
              getItemId={(s) => s.skill_id}
              onSelect={(s) => setSelectedSkillId(s.skill_id)}
              emptyText={t('mySkills.empty')}
              renderItem={(s) => (
                <>
                  <AssetItemHeader>
                    {/* 个人库列表即数据面，version 真实可信，直接展示 */}
                    <Tag theme="primary" className="_memory-skill-item-version">
                      v{s.version}
                    </Tag>
                    <AssetItemName title={s.name}>{s.name}</AssetItemName>
                    <Button
                      type="text"
                      tooltip={t('skills.delete.own')}
                      className="_memory-skill-item-delete"
                      onClick={async (e: any) => {
                        e?.stopPropagation();
                        const ok = await tea.confirm({
                          message: t('skills.delete.confirm', { name: s.name }),
                          description: t('skills.delete.confirm.desc'),
                          okText: t('skills.delete.okText'),
                          cancelText: t('skills.delete.cancelText'),
                        });
                        if (ok) void handleDelete(s);
                      }}
                      disabled={deleteLoading}
                    >
                      <DeleteIcon size={14} />
                    </Button>
                  </AssetItemHeader>

                  <AssetItemId>{s.skill_id}</AssetItemId>

                  <AssetItemBadges>
                    <AssetItemTime>{new Date(s.updated_at_ms).toLocaleString()}</AssetItemTime>
                  </AssetItemBadges>
                </>
              )}
            />
          }
          detail={
            <SkillDetailPane
              skillName={selectedSkill?.name ?? null}
              skillId={selectedSkillId ?? undefined}
              teamId="personal"
              userId={myUserId}
              // 个人库即本人私有库，选中即有编辑权
              canEdit={!!selectedSkillId}
              onChanged={() => void refresh()}
              api={personalSkillApi}
            />
          }
        />

        {showImport && (
          <ImportSkillDialog
            target="team"
            teamId="personal"
            userId={myUserId}
            onClose={() => setShowImport(false)}
            onImported={() => {
              setShowImport(false);
              void refresh();
            }}
            api={{ createSkill: personalCreateSkill }}
            allowedModes={['directory']}
          />
        )}

        {showImportFromInsight && (
          <ImportFromInsightDialog
            userId={myUserId}
            onClose={() => setShowImportFromInsight(false)}
            onImported={() => {
              setShowImportFromInsight(false);
              void refresh();
            }}
          />
        )}
      </div>
    </ResourcePage>
  );
}
