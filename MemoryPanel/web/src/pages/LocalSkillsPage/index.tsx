/**
 * LocalSkillsPage — 「我的技能 → 本地 Agent 技能」。
 *
 * 只读浏览器：后端 GET /api/v1/local-agent-skills 扫描本机各 AI Agent 客户端
 * （workbuddy / hermes / claude-code / codebuddy / codex / openclaw / dsh）的本地
 * skill 目录，解析 SKILL.md frontmatter，返回：
 *   技能名 / 使用的 agent（可能多个）/ 描述 / 最新修改时间 / 本地路径。
 *
 * 与「我的技能」个人库（落 MemoryCore、DB 托管）互补：本页只是磁盘浏览，不落库。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Copy,
  Justify,
  SearchBox,
  Select,
  StatusTip,
  Table,
  Tag,
  Text,
} from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { ResourcePage } from '@/pages/ResourcePage';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import {
  listLocalAgentSkills,
  type LocalAgentSkill,
} from '@/lib/api/local-agent-skills';
import './local-skills.css';

/** 用于在 agent 筛选下拉里展示的 7 类 agent（与后端 AGENTS 保持一致）。 */
const AGENT_ORDER = [
  'workbuddy',
  'hermes',
  'claude-code',
  'codebuddy',
  'codex',
  'openclaw',
  'dsh',
];

function formatTime(ms: number): string {
  if (!ms || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export function LocalSkillsPage() {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<LocalAgentSkill[]>([]);
  const [scannedAt, setScannedAt] = useState<number | null>(null);

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [keyword, setKeyword] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listLocalAgentSkills();
      setSkills(res.skills);
      setScannedAt(res.scannedAtMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      tea.notify.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const presentAgents = useMemo(() => {
    const set = new Set<string>();
    skills.forEach((s) => s.agents.forEach((a) => set.add(a)));
    return AGENT_ORDER.filter((a) => set.has(a));
  }, [skills]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return skills.filter((s) => {
      if (agentFilter !== 'all' && !s.agents.includes(agentFilter)) return false;
      if (!kw) return true;
      return (
        s.name.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw) ||
        s.path.toLowerCase().includes(kw) ||
        s.triggers.some((tr) => tr.toLowerCase().includes(kw))
      );
    });
  }, [skills, agentFilter, keyword]);

  const columns = [
    {
      key: 'name',
      header: t('localSkills.col.name'),
      width: 200,
      render: (s: LocalAgentSkill) => <span className="_local-skill-name">{s.name}</span>,
    },
    {
      key: 'agents',
      header: t('localSkills.col.agent'),
      width: 200,
      render: (s: LocalAgentSkill) => (
        <span className="_local-skill-agents">
          {s.agents.map((a) => (
            <Tag key={a} theme="primary">
              {a}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      key: 'description',
      header: t('localSkills.col.description'),
      render: (s: LocalAgentSkill) => (
        <Text overflow tooltip={s.description}>
          {s.description || '—'}
        </Text>
      ),
    },
    {
      key: 'updatedAtMs',
      header: t('localSkills.col.updatedAt'),
      width: 180,
      render: (s: LocalAgentSkill) => <span className="_local-skill-mtime">{formatTime(s.updatedAtMs)}</span>,
    },
    {
      key: 'path',
      header: t('localSkills.col.path'),
      render: (s: LocalAgentSkill) => (
        <span className="_local-skill-path" title={s.path}>
          <code>{s.path}</code>
          <Copy text={s.path} />
          <Text theme="label" className="_local-skill-size">
            {formatSize(s.sizeBytes)}
          </Text>
        </span>
      ),
    },
  ];

  return (
    <ResourcePage>
      <div className="_local-skills-body">
        <AssetPageHeader
          title={t('localSkills.title')}
          scope={null}
          subtitle={
            <span>
              {t('localSkills.subtitle', { count: filtered.length, total: skills.length })}
              {scannedAt ? ` · ${t('localSkills.scannedAt')} ${formatTime(scannedAt)}` : ''}
            </span>
          }
          actions={
            <Button onClick={() => void refresh()} loading={loading}>
              {t('localSkills.refresh')}
            </Button>
          }
        />

        <Card className="_local-skills-toolbar">
          <Card.Body>
            <Justify
              left={
                <Select
                  value={agentFilter}
                  onChange={(v) => setAgentFilter(v as string)}
                  style={{ width: 200 }}
                  appearance="button"
                >
                  <Select.Option value="all">{t('localSkills.filter.allAgents')}</Select.Option>
                  {presentAgents.map((a) => (
                    <Select.Option key={a} value={a}>
                      {a}
                    </Select.Option>
                  ))}
                </Select>
              }
              right={
                <SearchBox
                  value={keyword}
                  onChange={(v) => setKeyword(v)}
                  placeholder={t('localSkills.searchPlaceholder')}
                  style={{ width: 320 }}
                />
              }
            />
          </Card.Body>
        </Card>

        {error ? (
          <StatusTip status="error" errorText={error} onRetry={() => void refresh()} />
        ) : (
          <Card className="_local-skills-table">
            <Card.Body>
              <Table
                records={filtered}
                recordKey="path"
                columns={columns}
                loading={loading}
                emptyText={t('localSkills.empty')}
              />
            </Card.Body>
          </Card>
        )}

      </div>
    </ResourcePage>
  );
}
