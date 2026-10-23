/**
 * MySkillsPage — 「我的技能」个人技能库。
 *
 * 与团队 SkillsPage 共享 SkillDetailPane / AssetListPanel / AssetSplitLayout /
 * ImportSkillDialog 等组件，但：
 *   - 不展示 team / fixed 双 tab、agent 下拉、可见性切换（个人库天然私密）
 *   - 列表走 personalListSkills（Panel 服务端注入 team_id='personal' +
 *     owner_agent_id=个人虚拟 agent，天然按用户隔离）
 *   - 导入开放两种方式（同一个「导入 Skill」弹窗内的两个 tab）：「目录导入」
 *     （createSkill → /api/v1/personal-skills/create）+「从对话洞察导入」
 *     （insight tab，内容体 InsightImportPanel，走 personal-skills/extract）。
 *     不开放团队的「对话导入（粘贴 JSON）」与「从我的技能导入」。
 *   - 详情面板写操作走 personalSkillApi（updateSkill / writeSkillFiles /
 *     removeSkillFiles / versions 均路由到 /api/v1/personal-skills）
 *
 * 数据模型见 MemoryCore skill-handlers.ts 头注释（team_id='personal' 保留值 +
 * agent_id='personal-<userId>' 虚拟 agent）。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Copy, SearchBox, Table, Tag, Text } from 'tea-component';
import type { TableAddon } from 'tea-component';
import { DeleteIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { ResourcePage } from '@/pages/ResourcePage';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import SkillDetailPane from '@/pages/SkillsPage/components/SkillDetailPane';
import ImportSkillDialog from '@/pages/SkillsPage/components/ImportSkillDialog';
import DeploySkillDialog from './components/DeploySkillDialog';
import { useAuthStore } from '@/stores/auth';
import { formatAssetTimeFull } from '@/utils/time';
import { StatCard, StatCardRow } from '@/components/StatCard';
import {
  personalListSkills,
  personalDeleteSkill,
  personalExportSkill,
  personalCreateSkill,
  personalSkillApi,
  type SkillSummary,
} from '@/lib/api/skill-api';
import '../SkillsPage/styles/skills-list.css';

/* ===== 「选中即展示」推挤式详情面板（设计稿 docs/my-skills-detail-motion-design.html v2）=====
 * 未选中：右栏 width:0 不占位，列表全宽；选中：右栏生长到面板宽度并推挤列表。
 * 动效与数据解耦：宽度过渡只动 transform 之外的 width，详情内容固定宽度不回流。
 * 断点三态：≥1180 推挤揭示（可拖宽）｜960–1180 覆盖抽屉+遮罩｜<960 全屏替换。 */
const PANEL_MIN = 360;
const PANEL_MAX = 720;
const PANEL_DEFAULT = 460;
const PANEL_STORAGE_KEY = 'mySkills:panelWidth';
/** 关闭动画期间详情保持挂载的时长（略大于 CSS 退场 240ms） */
const PANEL_CLOSE_MS = 300;

function clampPanelWidth(w: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
}

function readPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? clampPanelWidth(n) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

/* ===== 时间筛选档位（按「最近修改」过滤）=====
 * today/week 取本地自然日/自然周（周一起）零点；7d/30d 为滚动窗口。 */
type RangeKey = 'today' | 'week' | 'd7' | 'd30' | 'all';

function rangeStartMs(key: RangeKey, now = Date.now()): number | null {
  switch (key) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 回到本周一
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'd7':
      return now - 7 * 86400_000;
    case 'd30':
      return now - 30 * 86400_000;
    default:
      return null; // 全部
  }
}

export function MySkillsPage() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const myUserId = auth?.user_id ?? '';

  const [loading, setLoading] = useState(true);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  /* ===== 列表筛选：关键词搜索 + 最近修改时间档位 ===== */
  const [keyword, setKeyword] = useState('');
  const [timeRange, setTimeRange] = useState<RangeKey>('all');

  /* ===== 推挤式详情面板状态 ===== */
  const [panelOpen, setPanelOpen] = useState(false);
  // 关闭动画期间仍需挂载详情（条件渲染会立刻卸载 DOM、退场动画播不出来），
  // lastSkillId 在关闭后延迟清空；切换选中时直接跟随新值。
  const [lastSkillId, setLastSkillId] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState<number>(readPanelWidth);
  const [panelResizing, setPanelResizing] = useState(false);

  const panelSkill = useMemo(
    () => skills.find((s) => s.skill_id === lastSkillId) ?? null,
    [skills, lastSkillId],
  );

  const closePanel = useCallback(() => {
    setSelectedSkillId(null);
    setPanelOpen(false);
  }, []);

  // 选中即打开；lastSkillId 跟随最新选中（关闭动画期间保持旧值由下方 effect 处理）
  useEffect(() => {
    if (selectedSkillId) {
      setPanelOpen(true);
      setLastSkillId(selectedSkillId);
    }
  }, [selectedSkillId]);

  // 关闭动画结束后再卸载详情内容
  useEffect(() => {
    if (panelOpen || !lastSkillId) return;
    const timer = window.setTimeout(() => setLastSkillId(null), PANEL_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [panelOpen, lastSkillId]);

  // Esc 关闭（打开期间全局监听）
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, closePanel]);

  // 拖拽调宽（仅桌面 docked 态；以窗口右缘为基准）
  useEffect(() => {
    if (!panelResizing) return;
    const onMove = (e: MouseEvent) => {
      setPanelWidth(clampPanelWidth(window.innerWidth - e.clientX));
    };
    const onUp = () => setPanelResizing(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [panelResizing]);

  // 拖拽结束持久化面板宽度
  useEffect(() => {
    if (panelResizing) return;
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, String(panelWidth));
    } catch {
      /* localStorage 不可用时静默忽略，仅影响记忆能力 */
    }
  }, [panelResizing, panelWidth]);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.skill_id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  );

  /* ===== 过滤后的列表（关键词 + 时间档位）===== */
  const filteredSkills = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const startMs = rangeStartMs(timeRange);
    return skills.filter((s) => {
      if (startMs !== null && (s.updated_at_ms ?? 0) < startMs) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.skill_id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.storage_dir ?? '').toLowerCase().includes(q)
      );
    });
  }, [skills, keyword, timeRange]);

  const hasFilter = keyword.trim() !== '' || timeRange !== 'all';

  /* ===== 统计条（4 卡，纯前端聚合，零后端依赖）=====
   * 说明：后端 skills 表无 category 列、且 326 条技能名高度个性化（首段去重 269/326），
   * 「分类覆盖」无稳定语义，故改用更能反映库质量的指标：描述完整率 + 名称唯一率、
   * 活跃占比 + 多版本技能数。 */
  const stats = useMemo(() => {
    const total = skills.length;
    const now = Date.now();
    const d7 = now - 7 * 86400_000;
    const d30 = now - 30 * 86400_000;
    const new7 = skills.filter((s) => (s.updated_at_ms ?? 0) >= d7).length;
    const new30 = skills.filter((s) => (s.updated_at_ms ?? 0) >= d30).length;
    const withDesc = skills.filter((s) => (s.description ?? '').trim().length > 0).length;
    const descRate = total ? Math.round((withDesc / total) * 100) : 0;
    const uniqueNames = new Set(skills.map((s) => s.name)).size;
    const uniqueRate = total ? Math.round((uniqueNames / total) * 100) : 0;
    const active = skills.filter((s) => s.status === 'active').length;
    const activeRate = total ? Math.round((active / total) * 100) : 0;
    const multiVer = skills.filter((s) => s.version > 1).length;
    return { total, new7, new30, descRate, uniqueRate, activeRate, multiVer };
  }, [skills]);

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

  /* ===== 表格列（四字段 + 行级删除） ===== */
  const columns = useMemo(
    () => [
      {
        key: 'name',
        header: t('mySkills.col.name'),
        width: 240,
        render: (s: SkillSummary) => (
          <span className="_mysk-cell-name">
            <Tag theme="primary">v{s.version}</Tag>
            <span className="_mysk-cell-name-text" title={`${s.name}\n${s.skill_id}`}>
              {s.name}
            </span>
          </span>
        ),
      },
      {
        key: 'description',
        header: t('mySkills.col.description'),
        render: (s: SkillSummary) => (
          <Text overflow tooltip={s.description.trim() || t('skills.item.noDescription')}>
            {s.description.trim() || t('skills.item.noDescription')}
          </Text>
        ),
      },
      {
        key: 'updated_at_ms',
        header: t('mySkills.col.updatedAt'),
        width: 180,
        render: (s: SkillSummary) => (
          <span className="_mysk-cell-time" title={formatAssetTimeFull(s.updated_at_ms)}>
            {formatAssetTimeFull(s.updated_at_ms) || '—'}
          </span>
        ),
      },
      {
        key: 'storage_dir',
        header: t('mySkills.col.location'),
        width: 240,
        render: (s: SkillSummary) =>
          s.storage_dir ? (
            <span className="_mysk-cell-path" title={s.storage_dir}>
              <code>{s.storage_dir}</code>
              <Copy text={s.storage_dir} />
            </span>
          ) : (
            <Text theme="label">—</Text>
          ),
      },
      {
        key: 'actions',
        header: t('mySkills.col.actions'),
        width: 64,
        render: (s: SkillSummary) => (
          <Button
            type="text"
            tooltip={t('skills.delete.own')}
            className="_mysk-row-delete"
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
        ),
      },
    ],
    [t, handleDelete, deleteLoading],
  );

  /* 行点击 = 选中（唤起详情推挤面板）。tea Table 无 onRowClick，
     用 onInjectColumn 给每个 td 注入 onClick（事件冒泡到 tr 即行点击）。 */
  const rowClickAddon = useMemo<TableAddon>(
    () => ({
      onInjectColumn:
        (next) =>
        (record, rowKey, recordIndex, column, columnIndex) => {
          const res = next(record, rowKey, recordIndex, column, columnIndex);
          return {
            ...res,
            props: {
              ...res.props,
              onClick: () => setSelectedSkillId((record as SkillSummary).skill_id),
            },
          };
        },
    }),
    [],
  );

  /* 加载中 / 空数据提示（有筛选条件时空态文案区分开） */
  const tableTipAddon = useMemo(
    () =>
      Table.addons.autotip({
        isLoading: loading,
        emptyText: hasFilter ? t('mySkills.emptyFiltered') : t('mySkills.empty'),
      }),
    [loading, hasFilter, t],
  );

  return (
    <ResourcePage>
      <div className="_memory-skills-body">
        <AssetPageHeader
          title={t('mySkills.title')}
          scope={null}
          subtitle={t('mySkills.subtitle', { count: skills.length })}
          actions={
            <>
              {/* 一键部署：置于操作区首位（与其他入口并列的页面级动作），未选中 skill 时禁用 */}
              <Button
                type="primary"
                onClick={() => setShowDeploy(true)}
                disabled={!selectedSkillId}
                tooltip={!selectedSkillId ? t('mySkills.deploy.tooltip.empty') : undefined}
                data-guide="deploy-skill"
              >
                {t('mySkills.deploy')}
              </Button>
              <Button
                onClick={handleExport}
                disabled={!selectedSkillId}
                tooltip={!selectedSkillId ? t('skills.export.tooltip.empty') : undefined}
                loading={exportLoading}
              >
                {t('skills.export')}
              </Button>
              {/* 「导入 Skill」弹窗内含两个 tab：目录导入 / 从对话洞察导入
                  （后者原为页头独立按钮，2026-10-16 收敛进弹窗） */}
              <Button
                type="primary"
                onClick={() => setShowImport(true)}
                data-guide="import-skill"
              >
                {t('skills.import')}
              </Button>
            </>
          }
        />

        {/* 统计条：4 卡（纯前端聚合，零后端依赖）。紫=技能色系，与既有视觉一致。 */}
        <StatCardRow>
          <StatCard label="技能总数" value={stats.total} accent="#8b5cf6" />
          <StatCard
            label="近 7 天新增"
            value={stats.new7}
            sub={`近 30 天 ${stats.new30}`}
            accent="#8b5cf6"
          />
          <StatCard
            label="描述完整率"
            value={`${stats.descRate}%`}
            sub={`名称唯一率 ${stats.uniqueRate}%`}
            accent="#8b5cf6"
          />
          <StatCard
            label="活跃占比"
            value={`${stats.activeRate}%`}
            sub={`多版本技能 ${stats.multiVer}`}
            accent="#8b5cf6"
          />
        </StatCardRow>

        {/* 搜索行：全宽搜索框 + 最近修改时间档位筛选（今天/本周/7天/30天/全部） */}
        <div className="_mysk-toolbar">
          <SearchBox
            className="_mysk-search"
            value={keyword}
            onChange={(v) => setKeyword(v)}
            placeholder={t('mySkills.search.placeholder')}
          />
          <div className="_mysk-ranges" role="tablist" aria-label={t('mySkills.range.label')}>
            {(
              [
                ['today', 'mySkills.range.today'],
                ['week', 'mySkills.range.week'],
                ['d7', 'mySkills.range.d7'],
                ['d30', 'mySkills.range.d30'],
                ['all', 'mySkills.range.all'],
              ] as const
            ).map(([key, i18nKey]) => (
              <button
                key={key}
                type="button"
                className={`_mysk-range${timeRange === key ? ' is-active' : ''}`}
                aria-pressed={timeRange === key}
                onClick={() => setTimeRange(key)}
              >
                {t(i18nKey)}
              </button>
            ))}
          </div>
        </div>

        {/* 选中即展示：默认列表全宽，无右栏；点击行唤起详情面板。
            列表为表格形态（对齐「本地 Agent 技能」页），列为产品指定的四字段：
            技能名称 / 描述 / 最近修改 / 本地位置（+ 行级删除操作）。 */}
        <div className="_mysk-split">
          <section className="_mysk-list">
            <Card className="_mysk-table-card">
              <Card.Body>
                <Table<SkillSummary>
                  records={filteredSkills}
                  recordKey={(s) => s.skill_id}
                  columns={columns}
                  rowClassName={(s) => (s.skill_id === selectedSkillId ? '_mysk-row is-selected' : '_mysk-row')}
                  addons={[tableTipAddon, rowClickAddon]}
                />
              </Card.Body>
            </Card>
          </section>

          {/* 窄屏（<1180px）覆盖抽屉的遮罩；桌面 docked 态由 CSS 隐藏 */}
          {panelOpen && <div className="_mysk-mask" onClick={closePanel} />}

          <aside
            className={`_mysk-detail${panelOpen ? ' is-open' : ''}${panelResizing ? ' is-resizing' : ''}`}
            style={{ '--mysk-w': `${panelWidth}px` } as CSSProperties}
            aria-hidden={!panelOpen}
          >
            {/* 关闭动画期间保持挂载（lastSkillId 延迟清空），退场动画才播得出来 */}
            {panelSkill && (
              <div className="_mysk-detail-inner">
                <SkillDetailPane
                  key={panelSkill.skill_id}
                  skillName={panelSkill.name}
                  skillId={panelSkill.skill_id}
                  teamId="personal"
                  userId={myUserId}
                  // 个人库即本人私有库，选中即有编辑权
                  canEdit={!!panelSkill.skill_id}
                  onChanged={() => void refresh()}
                  onClose={closePanel}
                  api={personalSkillApi}
                />
              </div>
            )}
            {panelOpen && (
              <button
                type="button"
                className="_mysk-detail-resizer"
                aria-label={t('mySkills.panel.resizer')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPanelResizing(true);
                }}
              />
            )}
          </aside>
        </div>

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
            allowedModes={['local', 'directory', 'insight']}
          />
        )}

        {showDeploy && selectedSkill && (
          <DeploySkillDialog
            skillId={selectedSkill.skill_id}
            skillName={selectedSkill.name}
            onClose={() => setShowDeploy(false)}
            onDeployed={() => {
              setShowDeploy(false);
              void refresh();
            }}
          />
        )}
      </div>
    </ResourcePage>
  );
}
