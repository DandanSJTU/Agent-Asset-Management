/**
 * InsightImportPanel — 「从对话洞察导入」面板（ImportSkillDialog 的 insight 模式内容体）。
 *
 * 历史上它是独立弹窗 ImportFromInsightDialog（挂「我的技能」页头按钮），
 * 2026-10-16 收敛为导入弹窗内的一个 tab，与「目录导入」并列：
 *   - 组件本身不再自带 Modal / Footer，只渲染内容体；提交由宿主
 *     ImportSkillDialog 的 Footer 主按钮通过 ref 的 submit() 触发，
 *     就绪态 / 提交态通过 onReadyChange / onSubmittingChange 回传宿主。
 *
 * 数据源：对话洞察（Session Insights）的会话列表（GET /api/v1/personal-space/sessions）
 * 与单会话真实消息（GET /api/v1/personal-space/records?id=）。用户选一个会话后，把后端
 * 已归一化的 messages 交给 skill 提炼管线（POST /api/v1/personal-skills/extract，
 * 身份由 Panel 服务端注入 team_id='personal' + agent_id='personal-<userId>'），由 LLM
 * 从对话中自动归纳出技能名 / 描述 / 内容并落个人命名空间。
 *
 * 与团队 SkillsPage「对话导入」的差异：来源从"粘贴 JSON"换成"从对话洞察选择会话"，
 * 且目标库是个人技能库（team_id='personal'），其余提炼链路完全复用。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Select } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import {
  fetchSessions,
  fetchSessionRecords,
  type SessionSummary,
  type SessionRecordMessage,
} from '@/lib/api/personal-space';
import { personalExtractSkills } from '@/lib/api/skill-api';
import '../styles/insight-import-panel.css';

const EXTRACT_SOFT_TIMEOUT_MS = 5000;

export type InsightImportPanelHandle = {
  /** 由宿主弹窗 Footer 的主按钮触发（仅在当前会话可提交时调用）。 */
  submit: () => void;
};

export type InsightImportPanelProps = {
  /** 当前用户 ID（仅用于展示/埋点，身份实际由后端注入） */
  userId: string;
  /** 提炼任务已受理：宿主据此关弹窗 + 刷新列表 */
  onImported: () => void;
  /** 是否已选中一个含消息的会话（驱动宿主 Footer 主按钮的 disabled） */
  onReadyChange?: (ready: boolean) => void;
  /** 提交中（驱动宿主 Footer 主按钮的 loading 与其它交互禁用） */
  onSubmittingChange?: (submitting: boolean) => void;
};

const InsightImportPanel = forwardRef<InsightImportPanelHandle, InsightImportPanelProps>(
  function InsightImportPanel(props, ref) {
    const { t } = useTranslation();
    const { onReadyChange, onSubmittingChange, onImported } = props;
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [loadingSessions, setLoadingSessions] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [selectedId, setSelectedId] = useState<string>('');
    const [records, setRecords] = useState<SessionRecordMessage[] | null>(null);
    const [loadingRecords, setLoadingRecords] = useState(false);
    const [recordsError, setRecordsError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      void (async () => {
        setLoadingSessions(true);
        setLoadError(null);
        try {
          const res = await fetchSessions();
          if (cancelled) return;
          // 仅展示有真实消息的会话（recordCount > 0）
          setSessions(res.sessions.filter((s) => s.recordCount > 0));
        } catch (err) {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled) setLoadingSessions(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    const selectedSession = useMemo(
      () => sessions.find((s) => s.sessionId === selectedId) ?? null,
      [sessions, selectedId],
    );

    const loadRecords = useCallback(async (id: string) => {
      setSelectedId(id);
      setRecords(null);
      setRecordsError(null);
      setResult(null);
      setError(null);
      if (!id) return;
      setLoadingRecords(true);
      try {
        const res = await fetchSessionRecords(id);
        setRecords(res.messages);
      } catch (err) {
        setRecordsError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingRecords(false);
      }
    }, []);

    const canSubmit = !!records && records.length > 0 && !submitting;

    // 就绪态 / 提交态回传宿主（两个布尔回调，避免宿主用对象字面量造成 effect 抖动）。
    useEffect(() => {
      onReadyChange?.(canSubmit);
    }, [canSubmit, onReadyChange]);

    useEffect(() => {
      onSubmittingChange?.(submitting);
    }, [submitting, onSubmittingChange]);

    const submit = useCallback(async (): Promise<void> => {
      if (!records || records.length === 0) {
        setError(t('importFromInsight.error.emptyMessages'));
        return;
      }
      setError(null);
      setResult(null);
      setSubmitting(true);
      const reason = `imported from session insight: ${selectedId}`;
      let softTimedOut = false;
      // 软超时兜底（5s）：archive 链路慢时后端可能超 Panel 硬超时，
      // 但任务其实已受理 —— 超时后直接展示"已受理"文案并静默吞掉后续错误。
      const extractPromise = personalExtractSkills({ messages: records, reason })
        .then((r) => ({ taskId: r.task_id }))
        .catch((e) => {
          if (softTimedOut) return null;
          throw e;
        });
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), EXTRACT_SOFT_TIMEOUT_MS),
      );
      try {
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === null) {
          softTimedOut = true;
          setResult(t('importFromInsight.result.accepted'));
        } else {
          setResult(t('importFromInsight.result', { taskId: raced.taskId }));
        }
        setTimeout(() => onImported(), 1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        tea.notify.error(msg);
      } finally {
        setSubmitting(false);
      }
    }, [records, selectedId, t, onImported]);

    useImperativeHandle(ref, () => ({ submit: () => void submit() }), [submit]);

    return (
      <>
        <Alert type="info">{t('importFromInsight.hint')}</Alert>

        {loadError && <Alert type="error">{t('importFromInsight.error.load', { msg: loadError })}</Alert>}

        <div className="_memory-ifid-section">
          <div className="_memory-ifid-label">{t('importFromInsight.selectSession')}</div>
          <Select
            size="full"
            searchable
            value={selectedId}
            onChange={(v: string) => void loadRecords(v)}
            placeholder={
              loadingSessions ? t('importFromInsight.loadingSessions') : t('importFromInsight.placeholder')
            }
            options={sessions.map((s) => ({
              value: s.sessionId,
              text: `${s.title || s.firstPrompt || s.sessionId} · ${s.recordCount} 条`,
            }))}
          />
          {!loadingSessions && sessions.length === 0 && !loadError && (
            <div className="_memory-ifid-hint">{t('importFromInsight.noSessions')}</div>
          )}
        </div>

        {loadingRecords && (
          <div className="_memory-ifid-hint">{t('importFromInsight.loadingRecords')}</div>
        )}
        {recordsError && <Alert type="error">{t('importFromInsight.error.load', { msg: recordsError })}</Alert>}

        {records && records.length > 0 && (
          <div className="_memory-ifid-preview-box">
            <div className="_memory-ifid-label">
              {t('importFromInsight.preview', { count: records.length })}
              {selectedSession?.title ? ` · ${selectedSession.title}` : ''}
            </div>
            <ul className="_memory-ifid-preview-list">
              {records.slice(0, 4).map((m, i) => (
                <li key={i}>
                  <span className={`_memory-ifid-role _memory-ifid-role-${m.role}`}>{m.role}</span>
                  <span className="_memory-ifid-preview-content">
                    {m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}
                  </span>
                </li>
              ))}
              {records.length > 4 && (
                <li className="_memory-ifid-preview-more">
                  {t('importFromInsight.previewMore', { count: records.length - 4 })}
                </li>
              )}
            </ul>
          </div>
        )}

        {error && <Alert type="error">{error}</Alert>}
        {result && (
          <Alert type="success">
            <span className="_memory-ifid-result-text">{result}</span>
          </Alert>
        )}
      </>
    );
  },
);

export default InsightImportPanel;
