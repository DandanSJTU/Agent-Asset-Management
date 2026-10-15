/**
 * SessionInsightsPage — 会话洞察（P0 观测面，三视图统一控制条）。
 *
 * 对标 coslash 三视图重构方案（docs/coslash-ui-views-redesign.html）：
 *   共享控制条（三视图 100% 一致）：
 *     筛选行（Status / Agent / Repo 三个 facet 触发器 + ViewSwitch）
 *     → 搜索行（facet chips + SearchBox）
 *     → scope 行（Rollup 统计 + 右簇视图专属控件 + range）。
 *   视图专属控件（内嵌 scope 行右簇，随视图动态显隐）：
 *     Table    → 密度切换（紧凑↔舒适）+ 可排序表头（Session/Updated/≈Cost）。
 *     Board    → Columns ▾ / Rows ▾ 分组维度（默认 Status / None）。
 *     Insights → Month 月份切换器（‹ ›），range 隐藏（月份即时间口径）。
 *   关键修复：Insights 不再拿原始 sessions，三视图共享同一份
 *     filtered（range + 搜索 + facets 贯通），筛选切视图不丢失。
 *
 * 数据全部来自 /api/v1/personal-space/*（只读观测）。
 *
 * 搜索（R-SEARCH）：不再使用「整串 includes」的关键词匹配，改走
 *   lib/session-search.ts 的两阶段引擎 —— bigram 倒排索引召回 + 加权字段评分排序，
 *   基线对齐 coslash（拆词 AND + 字段权重 best-of + 结构化前缀 + 相关度优先）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Dropdown,
  LoadingTip,
  Modal,
  SearchBox,
  Segment,
  StatusTip,
  Tag,
  Text,
} from 'tea-component';
import {
  fetchHandoff,
  fetchPersonalPending,
  fetchPersonalSourceSessions,
  fetchSessionFacts,
  fetchSessions,
  fetchSynthesis,
  resumeSession,
  triggerPersonalExtract,
  type CacheReadiness,
  type Debrief,
  type DigestCategory,
  type DigestEntry,
  type ExtractResponse,
  type GitInfo,
  type HandoffResponse,
  type PersonalPendingResponse,
  type ReadinessCell,
  type ReadinessTone,
  type ReadinessVerdict,
  type ResumeMode,
  type SessionFactsResponse,
  type SessionSummary,
  type SourceSessionRecord,
  type SynthesisResponse,
} from '@/lib/api/personal-space';
import { ApiError } from '@/lib/api/base';
import {
  blocksFromTexts,
  collapseDebriefBlocks,
  parseDebriefText,
  type DebriefBlock,
} from '@/lib/debrief-text';
import {
  buildSearchIndex,
  clearSearchHistory,
  filterByRange,
  loadSearchHistory,
  pushSearchHistory,
  repoOf,
  runSessionSearch,
  type Qualifier,
} from '@/lib/session-search';
import { Highlight } from '@/components/Highlight';
import './session-insights.css';
import { useResizable } from '@/lib/useResizable';

// ============================ M4b · 个人记忆「沉淀」状态机 / 可提炼性 ============================

/** 源会话提炼状态（徽标用）。 */
export type PrecipKind = 'never' | 'running' | 'done' | 'incremental' | 'failed';

export interface PrecipInfo {
  kind: PrecipKind;
  /** 已沉淀的 L1 条数。 */
  l1Count: number;
  /** 精确的「可增量」条数（pending 接口已知时）；否则为 0。 */
  pending: number;
  /** 是否有新内容（精确或启发式）。 */
  hasNew: boolean;
}

/** 由源会话记录 + 当前会话指纹 + 精确 pending 推导沉淀状态。 */
export function precipOf(
  s: SessionSummary,
  rec: SourceSessionRecord | undefined,
  pending: number | null,
): PrecipInfo {
  if (!rec) return { kind: 'never', l1Count: 0, pending: 0, hasNew: false };
  if (rec.status === 'running') return { kind: 'running', l1Count: 0, pending: 0, hasNew: false };
  if (rec.status === 'failed') return { kind: 'failed', l1Count: 0, pending: 0, hasNew: false };
  const l1 = rec.l1_count || 0;
  const known = pending ?? null;
  // 启发式（无精确 pending 时）：文件指纹变化 且 原始记录数超过游标 → 疑似有新内容。
  const hasNew =
    known != null
      ? known > 0
      : (s.mtime > (rec.cursor_ts ?? 0) || s.size !== (rec.file_size ?? -1)) &&
        s.recordCount > rec.cursor_record_index;
  return { kind: hasNew ? 'incremental' : 'done', l1Count: l1, pending: known ?? 0, hasNew };
}

export interface Extractability {
  extractable: boolean;
  stars: 0 | 1 | 2 | 3;
  reason?: string;
}

/** 可提炼性评分（设计 §8）：质量门 userTurns≥2 且 recordCount≥6 且 size≥2KB；否则 0 星禁用。 */
export function extractabilityOf(
  s: SessionSummary,
  t: (k: string, o?: Record<string, unknown>) => string,
): Extractability {
  if (s.userTurns < 2 || s.recordCount < 6 || s.size < 2048) {
    return { extractable: false, stars: 0, reason: t('insights.precip.notExtractable') };
  }
  const d = s.digest;
  const rich = (d?.question || 0) + (d?.plan || 0) + (d?.subagent || 0) + (d?.todos || 0);
  const stars: 0 | 1 | 2 | 3 = rich >= 4 ? 3 : rich >= 2 ? 2 : 1;
  return { extractable: true, stars };
}

export interface ExtractButtonCfg {
  disabled: boolean;
  labelKey: string;
  labelParams?: Record<string, unknown>;
  tooltipKey?: string;
}

/** 生成按钮的禁用态 / 文案（设计 §5.1 动态文案 + §8 可提炼性门）。 */
export function extractButtonOf(
  precip: PrecipInfo,
  ext: Extractability,
): ExtractButtonCfg {
  if (!ext.extractable) {
    return { disabled: true, labelKey: 'insights.precip.genButton', tooltipKey: undefined, labelParams: undefined };
  }
  if (precip.kind === 'running') {
    return { disabled: true, labelKey: 'insights.precip.genButton', tooltipKey: 'insights.precip.running' };
  }
  if (precip.kind === 'failed') {
    return { disabled: false, labelKey: 'insights.precip.retryButton' };
  }
  if (precip.kind === 'never') {
    return { disabled: false, labelKey: 'insights.precip.genButton' };
  }
  if (precip.kind === 'incremental') {
    if (precip.pending > 0) {
      return {
        disabled: false,
        labelKey: 'insights.precip.incrementalButton',
        labelParams: { n: precip.pending },
        tooltipKey: undefined,
      };
    }
    return {
      disabled: true,
      labelKey: 'insights.precip.incrementalButtonShort',
      tooltipKey: 'insights.precip.noNew',
    };
  }
  // done 且无新增
  return {
    disabled: true,
    labelKey: 'insights.precip.done',
    labelParams: { n: precip.l1Count },
    tooltipKey: 'insights.precip.noNew',
  };
}

/** 源会话记录 map 的键：vendor||session_id（设计 §4.1 的 source_key 命名空间）。 */
export function sourceMapKey(vendor: string, sessionId: string): string {
  return `${vendor}||${sessionId}`;
}

// ============================ M4b · 沉淀徽标 / 生成对话框 ============================

function PrecipBadge({
  precip,
  t,
}: {
  precip: PrecipInfo;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const map: Record<PrecipKind, { cls: string; text: string }> = {
    never: { cls: 'pc-never', text: t('insights.precip.never') },
    running: { cls: 'pc-running', text: t('insights.precip.running') },
    done: { cls: 'pc-done', text: t('insights.precip.done', { n: precip.l1Count }) },
    incremental: { cls: 'pc-inc', text: t('insights.precip.incremental') },
    failed: { cls: 'pc-failed', text: t('insights.precip.failed') },
  };
  const b = map[precip.kind];
  return (
    <span className={`pc-badge ${b.cls}`}>
      {b.text}
      {precip.kind === 'incremental' && precip.pending > 0 ? ` ${precip.pending} 条` : ''}
      {precip.kind === 'done' && precip.hasNew ? (
        <span className="pc-inc-dot" title={t('insights.precip.incremental')}>
          ·
        </span>
      ) : null}
    </span>
  );
}

/**
 * 「生成个人记忆」对话框（M4b · 共享 ExtractDialog）。
 * 选项：层级（L0+L1 / +L2 / +L3）、模式（chat/code）、范围（含子会话）、全量重炼。
 * 成本护栏：参考价 > ¥0.5 时需二次确认。本地未配置 LLM 时优雅提示 LLM_UNAVAILABLE。
 */
function PrecipControl({
  session,
  record,
  pending,
  onExtract,
  onView,
  t,
}: {
  session: SessionSummary;
  record: SourceSessionRecord | undefined;
  pending: number | null;
  onExtract: () => void;
  onView: () => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const precip = precipOf(session, record, pending);
  const ext = extractabilityOf(session, t);
  const btn = extractButtonOf(precip, ext);
  return (
    <div className="pc-insp">
      <div className="pc-insp-row">
        <PrecipBadge precip={precip} t={t} />
        {ext.stars > 0 && (
          <span className="pc-stars" title={t('insights.precip.notExtractable')}>
            {'★'.repeat(ext.stars)}
            {'☆'.repeat(3 - ext.stars)}
          </span>
        )}
      </div>
      <div className="pc-actions">
        <Button
          type="primary"
          disabled={btn.disabled}
          title={btn.tooltipKey ? t(btn.tooltipKey) : undefined}
          onClick={onExtract}
        >
          {t(btn.labelKey, btn.labelParams)}
        </Button>
        <Button onClick={onView}>{t('insights.precip.viewButton')}</Button>
      </div>
      {btn.tooltipKey && btn.disabled && <div className="pc-hint">{t(btn.tooltipKey)}</div>}
      {record?.source_missing && <div className="pc-hint">{t('insights.precip.sourceMissing')}</div>}
    </div>
  );
}

function ExtractDialog({
  open,
  session,
  onClose,
  onDone,
}: {
  open: boolean;
  session: SessionSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [layers, setLayers] = useState<string[]>(['L0', 'L1']);
  const [promptMode, setPromptMode] = useState<'chat' | 'code'>('chat');
  const [includeChildren, setIncludeChildren] = useState(false);
  const [forceFull, setForceFull] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [costAck, setCostAck] = useState(false);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !session) return;
    setResult(null);
    setError(null);
    setCostAck(false);
    setLayers(['L0', 'L1']);
    setPromptMode('chat');
    setIncludeChildren(false);
    setForceFull(false);
    const ac = new AbortController();
    fetchPersonalPending(session.vendor, session.sessionId, ac.signal)
      .then((p) => setPending(p.pending))
      .catch(() => setPending(null));
    return () => ac.abort();
  }, [open, session]);

  if (!session) return null;

  // 参考价（量级提示，非真实计费）：mini 档 ≈ ¥0.0006 / 1K tokens，单条消息约 800 tokens。
  // 本地未配置计费模型时实际成本为 0；此处仅作成本护栏的触发依据。
  const estCostCny = Math.max(0, (pending ?? 0) * 800) * 0.0006;
  const overBudget = estCostCny > 0.5;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await triggerPersonalExtract({
        sessionId: session.sessionId,
        vendor: session.vendor,
        layers,
        promptMode,
        includeChildren,
        forceFull,
      });
      setResult(res);
      onDone();
    } catch (e) {
      const ae = e as ApiError;
      if (ae?.rawMessage === 'LLM_UNAVAILABLE') {
        setError(t('insights.precip.llmUnavailable'));
      } else {
        setError(t('insights.precip.error', { reason: ae?.message || String(e) }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={open} caption={t('insights.precip.extractDialogTitle')} onClose={onClose} size="m">
      <Modal.Body>
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <b>{sessionTitle(session, undefined)}</b>
          <div style={{ color: 'var(--tea-color-text-secondary, #888)', marginTop: 4 }}>{session.sessionId}</div>
        </div>

        <div className="pc-field">
          <label>{t('insights.precip.layers')}</label>
          <Segment
            value={layers.includes('L3') ? '+L3' : layers.includes('L2') ? '+L2' : 'L0L1'}
            onChange={(v) => {
              if (v === 'L0L1') setLayers(['L0', 'L1']);
              else if (v === '+L2') setLayers(['L0', 'L1', 'L2']);
              else setLayers(['L0', 'L1', 'L2', 'L3']);
            }}
            options={[
              { value: 'L0L1', text: t('insights.precip.layerL0L1') },
              { value: '+L2', text: t('insights.precip.layerL2') },
              { value: '+L3', text: t('insights.precip.layerL3') },
            ]}
          />
        </div>

        <div className="pc-field">
          <label>{t('insights.precip.mode')}</label>
          <Segment
            value={promptMode}
            onChange={(v) => setPromptMode(v as 'chat' | 'code')}
            options={[
              { value: 'chat', text: t('insights.precip.modeChat') },
              { value: 'code', text: t('insights.precip.modeCode') },
            ]}
          />
        </div>

        <div className="pc-field pc-check">
          <label className="pc-check-row">
            <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} />
            {t('insights.precip.includeChildren')}
          </label>
          <label className="pc-check-row">
            <input type="checkbox" checked={forceFull} onChange={(e) => setForceFull(e.target.checked)} />
            忽略增量，全量重炼（将废弃旧产物）
          </label>
        </div>

        <div className="pc-cost">
          {t('insights.precip.estCost')}：≈ ¥{estCostCny.toFixed(4)}
        </div>
        {overBudget && (
          <label className="pc-check-row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={costAck} onChange={(e) => setCostAck(e.target.checked)} />
            {t('insights.precip.costAck', { n: estCostCny.toFixed(2) })}
          </label>
        )}

        {result && (
          <div className="pc-success">
            ✓ {t('insights.precip.success', { l0: result.l0Count, l1: result.l1Count, ms: result.durationMs })}
          </div>
        )}
        {error && <div className="pc-error">{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose}>{t('insights.precip.cancel')}</Button>
        <Button type="primary" loading={submitting} disabled={overBudget && !costAck} onClick={submit}>
          {submitting ? t('insights.precip.submitting') : t('insights.precip.submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

type ViewKey = 'table' | 'board' | 'insights';
type RangeKey = 'today' | 'week' | '7d' | '30d' | 'all';
type DimKey = 'state' | 'repo' | 'agent' | 'none';
type SortKey = 'title' | 'mtime' | 'cost' | 'tokens';
type Density = 'comfortable' | 'compact';

function fmtInt(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}

/**
 * R3: git tri-state rendering. ok -> branch (+-ahead/behind); not-repo/unavailable get
 * distinct copy so an environment-limited state is never misread as "not a repo" / "0".
 */
function gitLabel(g: GitInfo, t: (k: string) => string): string {
  if (g.status === 'unavailable') return t('insights.kv.gitUnavailable');
  if (g.status === 'not-repo') return t('insights.kv.gitNotRepo');
  return `${g.branch ?? '—'} (±${g.ahead ?? 0}/${g.behind ?? 0})`;
}

function fmtCost(usd: number, estimated?: boolean): string {
  const v = (usd ?? 0).toFixed(estimated ? 4 : 2);
  return `$${v}`;
}

function fmtCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function fmtRel(ts: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('insights.rel.now');
  if (diff < 3_600_000) return t('insights.rel.min', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('insights.rel.hour', { n: Math.floor(diff / 3_600_000) });
  return t('insights.rel.day', { n: Math.floor(diff / 86_400_000) });
}

/** S6 · TIMELINE 时钟（对齐 coslash formatDigestTime）：本地时:分 */
function fmtClock(ts: number | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** S6 · Prompt cache 相对时间（对齐 coslash formatTimeAgo，英文短标签不进 i18n） */
function fmtAgo(ms: number | undefined | null): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** S6 · 按天分组键（对齐 coslash digestDateKey） */
function digestDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** coslash 同款时间口径：today/week 取本地零点（周一起算），7d/30d 滚动窗口，all 不过滤 */
function rangeStart(range: RangeKey): number | null {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === 'today') return d.getTime();
  if (range === 'week') {
    const w = new Date();
    w.setHours(0, 0, 0, 0);
    w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
    return w.getTime();
  }
  if (range === '7d') return Date.now() - 7 * 86_400_000;
  if (range === '30d') return Date.now() - 30 * 86_400_000;
  return null;
}

/**
 * 输入防抖：coslash 是每次击键同步重算（其报告「优化点 1」指出上千会话时主线程压力）。
 * 这里对查询串做 150ms 防抖，输入框本身仍受控（打字不卡）。
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** 最近搜索下拉：复用 FacetMenu 的 Dropdown 语言，点击回填查询串 */
function RecentSearchMenu({
  label,
  items,
  onPick,
  onClear,
  clearLabel,
  emptyLabel,
}: {
  label: string;
  items: string[];
  onPick: (q: string) => void;
  onClear: () => void;
  clearLabel: string;
  emptyLabel: string;
}) {
  return (
    <Dropdown
      trigger="click"
      placement="bottom-end"
      appearance="pure"
      button={
        <span className={`sim-trig${items.length ? ' on' : ''}`}>
          {label}
          <i className="sim-caret">▾</i>
          {items.length > 0 && <span className="sim-badge">{items.length}</span>}
        </span>
      }
    >
      {(close) => (
        <div className="sim-fmenu sim-hist">
          {items.length === 0 && <div className="sim-fempty">{emptyLabel}</div>}
          {items.map((q) => (
            <button
              type="button"
              className="sim-hist-item"
              key={q}
              title={q}
              onClick={() => {
                onPick(q);
                close();
              }}
            >
              <span>{q}</span>
            </button>
          ))}
          {items.length > 0 && (
            <button
              type="button"
              className="sim-hist-clear"
              onClick={() => {
                onClear();
                close();
              }}
            >
              {clearLabel}
            </button>
          )}
        </div>
      )}
    </Dropdown>
  );
}

function monthKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 响应式断点查询（docked/modal 双态用） */
function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatch(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return match;
}

/**
 * 内容滚动区几何：取 `.tea-layout__content-body`（全局唯一滚动容器）的位置与高度，
 * 作为 fixed 滑出面板（docked 模式）的定位基准，避免覆盖全局 Header / Sider。
 */
function useContentRect(active: boolean): { top: number; height: number } | null {
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector('._memory-content-body');
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, height: r.height });
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active]);
  return rect;
}

const PALETTE = ['#00a870', '#3d93ff', '#e6b450', '#9c6dd1', '#ff7d9c', '#00b8d9', '#ff9c40', '#98a7b8'];

const STATE_COLORS: Record<string, string> = {
  active: '#2f9e63',
  waiting: '#e6a23c',
  idle: '#3d93ff',
  inactive: '#98a7b8',
};

function stateColor(state: string): string {
  return STATE_COLORS[(state || '').toLowerCase()] ?? '#98a7b8';
}

/**
 * 会话标题解析（C 方案防御 + B 方案优先）：
 *   1) ai-title（title）最优先；
 *   2) 嵌套会话无 ai-title 时，优先用父会话 Agent 任务名（spawnTask，对齐 coslash spawn.Task）；
 *   3) 否则回退 firstPrompt（经 A 方案清洗，已不再是 "探索 …"）；
 *   4) 最后回退 sessionId。
 * 超短护栏：若以上解析出的「可读字符」（去除 …/空白占位）≤2 个——典型是旧数据残留的
 *   "探索 …" 或纯路径被清洗成的 "…"——嵌套会话降级为 "父标题 · 子会话"（需传入 parentTitle），
 *   其余降级为 "未命名会话"，避免列表露出无意义串。
 */
function sessionTitle(
  s: Pick<SessionSummary, 'title' | 'spawnTask' | 'firstPrompt' | 'sessionId' | 'kind' | 'parentId'>,
  parentTitle?: string,
): string {
  const cand = (s.title || s.spawnTask || s.firstPrompt || s.sessionId || '').trim();
  const readable = cand.replace(/[….\s]/g, '').length;
  if (readable <= 2) {
    if (s.kind === 'nested' || s.parentId) {
      return parentTitle ? `${parentTitle} · 子会话` : '未命名子会话';
    }
    return '未命名会话';
  }
  return cand;
}

const PAGE_SIZE = 50;

export function SessionInsightsPage() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewKey>('table');
  const [keyword, setKeyword] = useState('');
  // 防抖后的查询串：搜索/召回/排序一律用它，输入框本身仍用 keyword（打字不卡）
  const debouncedKeyword = useDebouncedValue(keyword, 150);
  const [recent, setRecent] = useState<string[]>([]);
  const [range, setRange] = useState<RangeKey>('all');

  // facets：三视图共享（coslash matchesFacets 等价物）
  const [selStates, setSelStates] = useState<string[]>([]);
  const [selAgents, setSelAgents] = useState<string[]>([]);
  const [selRepos, setSelRepos] = useState<string[]>([]);

  // Table 专属：排序表头 + 密度切换
  const [sortKey, setSortKey] = useState<SortKey>('mtime');
  const [sortDesc, setSortDesc] = useState(true);
  const [density, setDensity] = useState<Density>('comfortable');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Board 专属：分组维度（默认 Status / None，对齐设计稿 D3）
  const [colDim, setColDim] = useState<DimKey>('state');
  const [rowDim, setRowDim] = useState<DimKey>('none');

  // Insights 专属：月份切换器
  const [month, setMonth] = useState<string | null>(null);

  // Inspector（Table 视图右侧详情，功能全保留）
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionFactsResponse | null>(null);
  const [handoff, setHandoff] = useState<HandoffResponse | null>(null);
  const [synthesis, setSynthesis] = useState<SynthesisResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // ===== M4b · 个人记忆（「我的记忆」）状态联合 =====
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sourceMap, setSourceMap] = useState<Map<string, SourceSessionRecord>>(new Map());
  const [pendingBySession, setPendingBySession] = useState<Record<string, number>>({});
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractTarget, setExtractTarget] = useState<SessionSummary | null>(null);

  const reloadSourceSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchPersonalSourceSessions(signal);
      const m = new Map<string, SourceSessionRecord>();
      for (const r of res.sessions) m.set(sourceMapKey(r.vendor, r.session_id), r);
      setSourceMap(m);
    } catch {
      // 非致命：状态列暂时全为「未提炼」（gateway 未启动 / 网络错误时）
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void reloadSourceSessions(ac.signal);
    return () => ac.abort();
  }, [reloadSourceSessions]);

  const openExtract = useCallback((s: SessionSummary) => {
    setExtractTarget(s);
    setExtractOpen(true);
  }, []);

  const goToMyMemory = useCallback(
    (sessionId: string) => {
      navigate(`/my-memory?session=${encodeURIComponent(sessionId)}`);
    },
    [navigate],
  );

  /** 选中 Inspector 时按需拉取精确「可增量」条数，并缓存到 pendingBySession。 */
  const fetchPendingFor = useCallback(async (s: SessionSummary): Promise<number | null> => {
    try {
      const p: PersonalPendingResponse = await fetchPersonalPending(s.vendor, s.sessionId);
      setPendingBySession((prev) => ({ ...prev, [s.sessionId]: p.pending }));
      return p.pending;
    } catch {
      return null;
    }
  }, []);

  const handleExtractDone = useCallback(() => {
    void reloadSourceSessions();
    setPendingBySession((prev) => {
      if (!extractTarget) return prev;
      const nxt = { ...prev };
      delete nxt[extractTarget.sessionId];
      return nxt;
    });
  }, [reloadSourceSessions, extractTarget]);

  // ===== M-C 二级 diff 面板选中：{ path, sessionId }；会话切换 / 快照刷新自动关闭（防看错版本） =====
  const [selectedDiff, setSelectedDiff] = useState<{ path: string; sessionId: string } | null>(null);

  // ===== M-A 滑出面板：宽度拖拽持久化 + 双态 + 定位基准 + a11y 引用 =====
  const { width: inspectorWidth, onMouseDown: onResizeMouseDown, reset: resetInspectorWidth } = useResizable(
    460, 360, 800, 'right', 'coslash.inspector-width.v1',
  );
  const docked = useMediaQuery('(min-width: 1180px)');
  const contentRect = useContentRect(!!selectedId);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSessions();
      setSessions(res.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // M4b · 从「我的记忆」血缘回跳（?session=<id>）：会话加载后自动选中并打开 Inspector
  const autoSelected = useRef(false);
  useEffect(() => {
    if (autoSelected.current) return;
    const want = searchParams.get('session');
    if (!want) return;
    if (sessions.length === 0) return;
    if (!sessions.some((s) => s.sessionId === want)) return;
    autoSelected.current = true;
    setSelectedId(want);
    // 选中后清掉 query，避免刷新重复触发
    const nxt = new URLSearchParams(searchParams.toString());
    nxt.delete('session');
    navigate({ search: nxt.toString() }, { replace: true });
  }, [sessions, searchParams, navigate]);

  // 搜索历史：挂载时读回（sessionStorage，仅当前标签页）
  useEffect(() => {
    setRecent(loadSearchHistory());
  }, []);

  // 查询串稳定 800ms 后入历史（Enter 亦会立即入，pushSearchHistory 内部去重）
  useEffect(() => {
    const q = debouncedKeyword.trim();
    if (q.length < 2) return;
    const id = window.setTimeout(() => setRecent(pushSearchHistory(q)), 800);
    return () => window.clearTimeout(id);
  }, [debouncedKeyword]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setHandoff(null);
      setDetailError(null);
      return;
    }
    // AbortController 守卫：切换会话时取消旧请求并阻止其乱序写入（竞态取消）
    const ac = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([fetchSessionFacts(selectedId, ac.signal), fetchHandoff(selectedId, ac.signal)])
      .then(([f, h]) => {
        if (ac.signal.aborted) return;
        setDetail(f);
        setHandoff(h);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setDetailLoading(false);
      });
    return () => {
      ac.abort();
    };
  }, [selectedId, retryToken]);

  // ===== AI Synthesis：拉取 + pending 轮询（3s，≤2min）=====
  // 默认关闭时后端立即返回 enabled:false，不轮询、不烧 token；仅 pending 态才轮询。
  useEffect(() => {
    if (!selectedId) {
      setSynthesis(null);
      return;
    }
    const ac = new AbortController();
    let timer: number | undefined;
    let polls = 0;
    const MAX_POLLS = 40; // 40 × 3s ≈ 120s
    const tick = () => {
      fetchSynthesis(selectedId, ac.signal)
        .then((r) => {
          if (ac.signal.aborted) return;
          setSynthesis(r);
          if (r.pending && polls++ < MAX_POLLS) {
            timer = window.setTimeout(tick, 3000);
          }
        })
        .catch((e) => {
          if (!ac.signal.aborted) {
            setSynthesis({ synthesis: null, enabled: false, error: e instanceof Error ? e.message : String(e) });
          }
        });
    };
    tick();
    return () => {
      ac.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedId, retryToken]);

  // ===== 筛选流水线：range → 搜索（召回+评分） → facets，三视图共享 =====
  const inRange = useMemo(() => filterByRange(sessions, rangeStart(range)), [sessions, range]);

  const facetOptions = useMemo(() => {
    const count = (get: (s: SessionSummary) => string) => {
      const m = new Map<string, number>();
      for (const s of inRange) m.set(get(s), (m.get(get(s)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      states: count((s) => s.state || '—'),
      agents: count((s) => s.vendor || '—'),
      repos: count((s) => repoOf(s.sessionId)).slice(0, 12),
    };
  }, [inRange]);

  // 倒排索引：随数据 / 时间范围重建；字段归一化有 WeakMap 缓存，重复建索引不重复归一化
  const searchIndex = useMemo(() => buildSearchIndex(inRange), [inRange]);

  // 召回 + 评分（0 分即淘汰）；查询串为空时 matched 恒等于 inRange
  const search = useMemo(() => runSessionSearch(searchIndex, debouncedKeyword), [searchIndex, debouncedKeyword]);
  const hasQuery = debouncedKeyword.trim().length > 0;
  const highlightTerms = search.terms;

  // 会话索引 + 父标题查询：供 sessionTitle 护栏把超短嵌套标题降级为 "父标题 · 子会话"
  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const parentTitleOf = useCallback(
    (s: SessionSummary): string | undefined => {
      if (!s.parentId) return undefined;
      const p = byId.get(s.parentId);
      return p ? p.title || p.spawnTask || undefined : undefined;
    },
    [byId],
  );

  const filtered = useMemo(() => {
    let list = search.matched;
    if (selStates.length) list = list.filter((s) => selStates.includes(s.state || '—'));
    if (selAgents.length) list = list.filter((s) => selAgents.includes(s.vendor || '—'));
    if (selRepos.length) list = list.filter((s) => selRepos.includes(repoOf(s.sessionId)));
    const sorted = [...list];
    const cmp: Record<SortKey, (a: SessionSummary, b: SessionSummary) => number> = {
      title: (a, b) =>
        sessionTitle(a).localeCompare(sessionTitle(b)),
      mtime: (a, b) => a.mtime - b.mtime,
      cost: (a, b) => a.costUsd - b.costUsd,
      tokens: (a, b) => a.tokens.total - b.tokens.total,
    };
    sorted.sort((a, b) => {
      // coslash sortSessions：有查询时相关度降序压过用户自选排序键
      if (hasQuery) {
        const d = (search.scores.get(b.sessionId) ?? 0) - (search.scores.get(a.sessionId) ?? 0);
        if (d !== 0) return d;
      }
      return sortDesc ? cmp[sortKey](b, a) : cmp[sortKey](a, b);
    });
    return sorted;
  }, [search, hasQuery, selStates, selAgents, selRepos, sortKey, sortDesc]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [debouncedKeyword, range, selStates, selAgents, selRepos]);

  // 跨时间窗探测：搜索的召回池被 range 锁在 inRange 内（coslash 亦如此），
  // 时间窗外的命中会被静默吞掉。仅当窗内确实零命中时才回退到全量探测一次，
  // 把「搜不到」从死路变成可发现、可一键修复。索引按 sessions 引用缓存，不会每次输入重建。
  const needRangeProbe = hasQuery && range !== 'all' && search.matched.length === 0;
  const fullIndex = useMemo(
    () => (needRangeProbe ? buildSearchIndex(sessions) : null),
    [needRangeProbe, sessions],
  );
  const outOfRangeHits = useMemo(
    () => (fullIndex ? runSessionSearch(fullIndex, debouncedKeyword).matched.length : 0),
    [fullIndex, debouncedKeyword],
  );

  // Insights 月份：来自 filtered（筛选贯通），月份切换器在 scope 行
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const s of filtered) set.add(monthKeyOf(s.mtime));
    return [...set].sort().reverse();
  }, [filtered]);
  const curMonth = month && months.includes(month) ? month : months[0] ?? null;
  const mi = curMonth ? months.indexOf(curMonth) : -1;

  // Insights 视图里「月份即时间口径」（range 被隐藏）→ scope 行的 Rollup 也随月份收敛，
  // 与视图内 KPI / 图表同源，避免顶部摘要与卡片数字口径打架；
  // 其余视图未启用月份选择器，rollup 仍为筛选后全量 matched 口径。
  const rollupSource = useMemo(
    () => (view === 'insights' && curMonth ? filtered.filter((s) => monthKeyOf(s.mtime) === curMonth) : filtered),
    [view, filtered, curMonth],
  );

  // Rollup（scope 行左侧）
  const rollup = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let estimated = 0;
    let unpriced = 0;
    for (const s of rollupSource) {
      tokens += s.tokens.total;
      cost += s.costUsd;
      if (s.costEstimated) estimated += 1;
      if (s.costUsd === 0) unpriced += 1;
    }
    return { tokens, cost, estimated, unpriced };
  }, [rollupSource]);

  const selected = sessions.find((s) => s.sessionId === selectedId) ?? null;

  // 三视图统一入口：仅驱动唯一选中键，不再强制切回 Table（docked 下可边看列表边看详情）
  const handleSelect = (id: string) => {
    lastFocusedRef.current = (document.activeElement as HTMLElement) ?? null;
    setSelectedId(id);
  };

  const closeInspector = () => {
    lastFocusedRef.current?.focus?.();
    setSelectedId(null);
  };

  // 打开面板时把焦点移入关闭按钮（a11y）；关闭时焦点归还触发元素
  useEffect(() => {
    if (selectedId && closeBtnRef.current) {
      closeBtnRef.current.focus();
    }
  }, [selectedId]);

  // 切换会话 / 刷新快照时关闭二级 diff（防看错版本）
  useEffect(() => {
    setSelectedDiff(null);
  }, [selectedId, retryToken]);

  // Esc 关闭：优先关二级 diff，否则关主面板（docked / modal 通用）
  useEffect(() => {
    if (!selectedId && !selectedDiff) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (selectedDiff) {
          setSelectedDiff(null);
          return;
        }
        closeInspector();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, selectedDiff]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };

  /** 一键清空：查询串 + facets + 时间范围（coslash 空状态里的 Clear everything） */
  const clearEverything = () => {
    setKeyword('');
    setSelStates([]);
    setSelAgents([]);
    setSelRepos([]);
    setRange('all');
  };

  const rangeLabel: Record<RangeKey, string> = {
    today: t('insights.range.today'),
    week: t('insights.range.week'),
    '7d': t('insights.range.7d'),
    '30d': t('insights.range.30d'),
    all: t('insights.range.all'),
  };

  // 查询串里的结构化前缀也以 chip 呈现（coslash：激活的过滤条件以 chip 形式逐个可移除）
  const dropQualifier = (q: Qualifier) => {
    const token = `${q.key}:${q.value}`;
    setKeyword((cur) =>
      cur
        .split(/\s+/)
        .filter((w) => w && w.toLowerCase() !== token)
        .join(' '),
    );
  };

  const activeChips: { key: string; label: string; clear: () => void }[] = [
    ...search.qualifiers.map((q) => ({
      key: `q-${q.key}-${q.value}`,
      label: `${q.key}: ${q.value}`,
      clear: () => dropQualifier(q),
    })),
    ...selStates.map((v) => ({
      key: `st-${v}`,
      label: `${t('insights.facet.status')}: ${v}`,
      clear: () => setSelStates((x) => x.filter((y) => y !== v)),
    })),
    ...selAgents.map((v) => ({
      key: `ag-${v}`,
      label: `${t('insights.facet.agent')}: ${v}`,
      clear: () => setSelAgents((x) => x.filter((y) => y !== v)),
    })),
    ...selRepos.map((v) => ({
      key: `rp-${v}`,
      label: `${t('insights.facet.repo')}: ${v}`,
      clear: () => setSelRepos((x) => x.filter((y) => y !== v)),
    })),
  ];

  const isInspectorOpen = !!selectedId;
  // docked 模式下视图区右侧给滑出面板让位（控制条保持全宽）；modal 下不挤压（被遮罩覆盖）
  const viewsPaddingRight = docked && isInspectorOpen ? inspectorWidth : 0;

  return (
    <div style={{ padding: 16 }}>
      {loading ? (
        <div style={{ marginTop: 24 }}>
          <LoadingTip />
        </div>
      ) : error && !selectedId ? (
        <div style={{ marginTop: 24 }}>
          <StatusTip status="error" errorText={error} onRetry={() => void load()} />
        </div>
      ) : (
        <>
          {/* ===== 共享控制条 · 筛选行：facet 触发器 + ViewSwitch ===== */}
          <div className="sim-frow">
            <FacetMenu
              label={t('insights.facet.status')}
              options={facetOptions.states}
              selected={selStates}
              onChange={setSelStates}
            />
            <FacetMenu
              label={t('insights.facet.agent')}
              options={facetOptions.agents}
              selected={selAgents}
              onChange={setSelAgents}
            />
            <FacetMenu
              label={t('insights.facet.repo')}
              options={facetOptions.repos}
              selected={selRepos}
              onChange={setSelRepos}
            />
            <Segment
              className="sim-viewsw"
              value={view}
              onChange={(v) => setView(v as ViewKey)}
              options={[
                { value: 'table', text: t('insights.view.table') },
                { value: 'board', text: t('insights.view.board') },
                { value: 'insights', text: t('insights.view.insights') },
              ]}
            />
          </div>

          {/* ===== 共享控制条 · 搜索行：chips + SearchBox ===== */}
          <div className="sim-searchrow">
            {activeChips.map((c) => (
              <span className="sim-chip" key={c.key}>
                {c.label}
                <span className="sim-chip-x" onClick={c.clear}>×</span>
              </span>
            ))}
            <SearchBox
              value={keyword}
              onChange={(v) => setKeyword(v)}
              onSearch={(v) => {
                const q = (v ?? keyword).trim();
                if (q) setRecent(pushSearchHistory(q));
              }}
              placeholder={t('insights.search')}
              style={{ flex: 1, minWidth: 200 }}
            />
            {hasQuery && (
              <span className="sim-matches" title={t('insights.search.matchesHint')}>
                <b>{fmtInt(filtered.length)}</b> {t('insights.search.matches')}
              </span>
            )}
            <RecentSearchMenu
              label={t('insights.search.recent')}
              items={recent}
              onPick={(q) => setKeyword(q)}
              onClear={() => setRecent(clearSearchHistory())}
              clearLabel={t('insights.search.recentClear')}
              emptyLabel={t('insights.search.recentEmpty')}
            />
          </div>

          {/* ===== 共享控制条 · scope 行：Rollup + 视图专属右簇 + range ===== */}
          <div className="sim-scoperow">
            <div className="sim-rollup">
              <b>{fmtInt(rollupSource.length)}</b> {t('insights.kpi.sessions')} · {fmtCompact(rollup.tokens)} tokens ·{' '}
              {fmtCost(rollup.cost, rollup.estimated > 0)}
              {rollup.unpriced > 0 && <> · {t('insights.scope.notPriced', { n: rollup.unpriced })}</>}
            </div>
            <div className="sim-ctlcluster">
              {view === 'table' && (
                <>
                  <span
                    className="sim-seg"
                    title={t('insights.density.comfortable')}
                    onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
                  >
                    ▤ {density === 'compact' ? t('insights.density.compact') : t('insights.density.comfortable')}
                  </span>
                  <span className="sim-vsep" />
                  <RangePills range={range} rangeLabel={rangeLabel} onRange={setRange} />
                </>
              )}
              {view === 'board' && (
                <>
                  <DimMenu
                    label={t('insights.board.columns')}
                    value={colDim}
                    options={[
                      { value: 'state', text: t('insights.board.dim.state') },
                      { value: 'repo', text: t('insights.board.dim.repo') },
                      { value: 'agent', text: t('insights.board.dim.agent') },
                    ]}
                    onChange={setColDim}
                  />
                  <DimMenu
                    label={t('insights.board.rows')}
                    value={rowDim}
                    options={[
                      { value: 'none', text: t('insights.board.dim.none') },
                      { value: 'state', text: t('insights.board.dim.state') },
                      { value: 'repo', text: t('insights.board.dim.repo') },
                      { value: 'agent', text: t('insights.board.dim.agent') },
                    ]}
                    onChange={setRowDim}
                  />
                  <span className="sim-vsep" />
                  <RangePills range={range} rangeLabel={rangeLabel} onRange={setRange} />
                </>
              )}
              {view === 'insights' && (
                <>
                  <span className="sim-seg">
                    <b>{t('insights.month')}</b> {curMonth ?? '—'}
                  </span>
                  <button
                    type="button"
                    className="sim-dbtn"
                    disabled={mi < 0 || mi >= months.length - 1}
                    onClick={() => setMonth(months[mi + 1])}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="sim-dbtn"
                    disabled={mi <= 0}
                    onClick={() => setMonth(months[mi - 1])}
                  >
                    ›
                  </button>
                </>
              )}
            </div>
          </div>

          {/* ===== 主内容区（docked 下右侧为滑出面板让位） ===== */}
          <div style={{ paddingRight: viewsPaddingRight }}>
            {/* 有查询但零命中：与「无数据」区分开，给一键清空（coslash Clear everything 同款） */}
            {hasQuery && filtered.length === 0 ? (
              <div className="sim-nomatch">
                <div className="sim-nm-t">{t('insights.search.noMatch', { q: debouncedKeyword.trim() })}</div>
                <div className="sim-nm-h">{t('insights.search.noMatchHint')}</div>
                {outOfRangeHits > 0 && (
                  <div className="sim-nm-h sim-nm-oor">
                    {t('insights.search.outOfRange', { n: outOfRangeHits })}
                  </div>
                )}
                <span
                  className="sim-nm-btn"
                  role="button"
                  tabIndex={0}
                  onClick={outOfRangeHits > 0 ? () => setRange('all') : clearEverything}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (outOfRangeHits > 0) setRange('all');
                      else clearEverything();
                    }
                  }}
                >
                  {outOfRangeHits > 0 ? t('insights.search.expandRange') : t('insights.search.clearAll')}
                </span>
              </div>
            ) : (
              <>
                {!error && view === 'table' && (
                  <TableView
                    filtered={filtered}
                    visibleCount={visibleCount}
                    onMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
                    sortKey={sortKey}
                    sortDesc={sortDesc}
                    onSort={toggleSort}
                    density={density}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                    terms={highlightTerms}
                    sourceMap={sourceMap}
                    pendingBySession={pendingBySession}
                    onExtract={openExtract}
                    parentTitleOf={parentTitleOf}
                  />
                )}
                {view === 'board' && (
                  <BoardView
                    filtered={filtered}
                    colDim={colDim}
                    rowDim={rowDim}
                    selectedId={selectedId}
                    onOpen={handleSelect}
                    terms={highlightTerms}
                    parentTitleOf={parentTitleOf}
                  />
                )}
                {view === 'insights' && <InsightsView filteredSessions={filtered} curMonth={curMonth} />}
              </>
            )}
          </div>
          {isInspectorOpen && (
            <InspectorPanel
              docked={docked}
              width={inspectorWidth}
              rect={contentRect}
              onResizeMouseDown={onResizeMouseDown}
              onResizeDoubleClick={resetInspectorWidth}
              onClose={closeInspector}
              panelRef={panelRef}
              closeBtnRef={closeBtnRef}
              title={selected ? sessionTitle(selected, parentTitleOf(selected)) : selectedId}
              sessionId={selectedId}
              summary={selected}
              detail={detail}
              handoff={handoff}
              synthesis={synthesis}
              loading={detailLoading}
              error={detailError}
              onRetry={() => setRetryToken((tkn) => tkn + 1)}
              selectedDiff={selectedDiff}
              onOpenDiff={(path: string) => setSelectedDiff({ path, sessionId: selectedId! })}
              onCloseDiff={() => setSelectedDiff(null)}
              sourceMap={sourceMap}
              pendingBySession={pendingBySession}
              onRequestExtract={openExtract}
              onFetchPending={fetchPendingFor}
              onGoToMyMemory={goToMyMemory}
            />
          )}
          <ExtractDialog
            open={extractOpen}
            session={extractTarget}
            onClose={() => setExtractOpen(false)}
            onDone={handleExtractDone}
          />
        </>
      )}
    </div>
  );
}

/* ================= 共享控制条子组件 ================= */

function FacetMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: [string, number][];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dropdown
      trigger="click"
      placement="bottom-start"
      appearance="pure"
      button={
        <span className={`sim-trig${selected.length ? ' on' : ''}`}>
          <b>{label}</b>
          <i className="sim-caret">▾</i>
          {selected.length > 0 && <span className="sim-badge">{selected.length}</span>}
        </span>
      }
    >
      {(close) => (
        <div className="sim-fmenu">
          {options.length === 0 && <div className="sim-fempty">—</div>}
          {options.map(([v, n]) => (
            <label key={v} className="sim-fitem">
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={(e) => {
                  onChange(e.target.checked ? [...selected, v] : selected.filter((x) => x !== v));
                }}
              />
              <span className="sim-fname" title={v}>
                {v}
              </span>
              <span className="sim-fcnt">{n}</span>
            </label>
          ))}
          {selected.length > 0 && (
            <div className="sim-fclear">
              <Button
                type="weak"
                onClick={() => {
                  onChange([]);
                  close();
                }}
              >
                {t('insights.facet.clear')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

function DimMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: DimKey;
  options: { value: DimKey; text: string }[];
  onChange: (v: DimKey) => void;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Dropdown
      trigger="click"
      placement="bottom-start"
      appearance="pure"
      button={
        <span className="sim-seg">
          <b>{label}</b> {cur?.text ?? '—'} <i className="sim-caret">▾</i>
        </span>
      }
    >
      {(close) => (
        <div className="sim-fmenu">
          {options.map((o) => (
            <div
              key={o.value}
              className={`sim-fitem${o.value === value ? ' on' : ''}`}
              onClick={() => {
                onChange(o.value);
                close();
              }}
            >
              <span className="sim-fname">{o.text}</span>
              {o.value === value && <span style={{ color: '#3554d1' }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

function RangePills({
  range,
  rangeLabel,
  onRange,
}: {
  range: RangeKey;
  rangeLabel: Record<RangeKey, string>;
  onRange: (r: RangeKey) => void;
}) {
  return (
    <div className="sim-range">
      {(['today', 'week', '7d', '30d', 'all'] as RangeKey[]).map((r) => (
        <i key={r} className={range === r ? 'on' : ''} onClick={() => onRange(r)}>
          {rangeLabel[r]}
        </i>
      ))}
    </div>
  );
}

/* ================= Table 视图（扁平列表 + 排序表头 + 密度切换） ================= */

function TableView({
  filtered,
  visibleCount,
  onMore,
  sortKey,
  sortDesc,
  onSort,
  density,
  selectedId,
  onSelect,
  terms,
  sourceMap,
  pendingBySession,
  onExtract,
  parentTitleOf,
}: {
  filtered: SessionSummary[];
  visibleCount: number;
  onMore: () => void;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (k: SortKey) => void;
  density: Density;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 搜索命中词，用于高亮（结构化前缀已剔除） */
  terms: string[];
  /** M4b · 源会话提炼状态表（vendor||session_id → 记录） */
  sourceMap: Map<string, SourceSessionRecord>;
  /** M4b · 已拉取精确「可增量」条数的会话（sessionId → pending） */
  pendingBySession: Record<string, number>;
  /** M4b · 打开「生成个人记忆」对话框 */
  onExtract: (s: SessionSummary) => void;
  /** 父标题查询（会话标题护栏） */
  parentTitleOf: (s: SessionSummary) => string | undefined;
}) {
  const { t } = useTranslation();
  const rows = filtered.slice(0, visibleCount);
  const remaining = filtered.length - rows.length;

  const arrow = (k: SortKey) => (sortKey === k ? (sortDesc ? ' ↓' : ' ↑') : '');

  return (
    <div className={`sim-tbl${density === 'compact' ? ' sim-compact' : ''}`}>
      <div className="sim-th">
        <span className={`sim-c1 sim-sort${sortKey === 'title' ? ' on' : ''}`} onClick={() => onSort('title')}>
          {t('insights.col.session')}
          {arrow('title')}
        </span>
        <span className="sim-c2">{t('insights.col.where')}</span>
        <span className="sim-c3">{t('insights.col.state')}</span>
        <span className={`sim-c4 sim-sort${sortKey === 'mtime' ? ' on' : ''}`} onClick={() => onSort('mtime')}>
          {t('insights.col.mtime')}
          {arrow('mtime')}
        </span>
        <span
          className={`sim-c5 sim-sort${sortKey === 'cost' || sortKey === 'tokens' ? ' on' : ''}`}
          onClick={() => onSort(sortKey === 'tokens' ? 'tokens' : 'cost')}
        >
          ≈ {t('insights.col.cost')}
          {arrow('cost')}
          {arrow('tokens')}
        </span>
      </div>
      {rows.map((s) => (
        <div
          key={s.sessionId}
          className={`sim-tr${selectedId === s.sessionId ? ' sel' : ''}`}
          onClick={() => onSelect(s.sessionId)}
          title={s.sessionId}
          role="button"
          tabIndex={0}
          aria-selected={selectedId === s.sessionId}
          aria-label={sessionTitle(s, parentTitleOf(s))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(s.sessionId);
            }
          }}
        >
          <span className="sim-c1">
            <span className="sim-t1">
              <Highlight text={sessionTitle(s, parentTitleOf(s))} terms={terms} />
            </span>
            {s.title && s.firstPrompt && (
              <span className="sim-t2">
                <Highlight text={s.firstPrompt} terms={terms} />
              </span>
            )}
          </span>
          <span className="sim-c2">
            <span className="sim-t2">
              {repoOf(s.sessionId)} · {s.vendor}
            </span>
          </span>
          <span className="sim-c3 sim-st">
            <span className="sim-sdot" style={{ background: stateColor(s.state) }} />
            {s.state}
          </span>
          <span className="sim-c4 sim-t2">{fmtRel(s.mtime, t)}</span>
          <span className="sim-c5 sim-cost">
            {fmtCost(s.costUsd, s.costEstimated)}
            {s.costEstimated ? ' ~' : ''}
            <span>
              {fmtCompact(s.tokens.total)} tok · {fmtInt(s.recordCount)} {t('insights.col.records')}
            </span>
          </span>
        </div>
      ))}
      {remaining > 0 && (
        <div className="sim-more" onClick={onMore}>
          {t('insights.more', { n: remaining })}
        </div>
      )}
      {filtered.length === 0 && <StatusTip status="empty" emptyText={t('insights.empty')} />}
    </div>
  );
}

/* ================= Board 视图（Columns × Rows 二维卡片看板） ================= */

function dimValue(s: SessionSummary, dim: DimKey): string | null {
  if (dim === 'none') return null;
  if (dim === 'state') return s.state || '—';
  if (dim === 'agent') return s.vendor || '—';
  return repoOf(s.sessionId);
}

function BoardView({
  filtered,
  colDim,
  rowDim,
  selectedId,
  onOpen,
  terms,
  parentTitleOf,
}: {
  filtered: SessionSummary[];
  colDim: DimKey;
  rowDim: DimKey;
  selectedId: string | null;
  onOpen: (id: string) => void;
  /** 搜索命中词，用于高亮（结构化前缀已剔除） */
  terms: string[];
  /** 父标题查询（会话标题护栏） */
  parentTitleOf: (s: SessionSummary) => string | undefined;
}) {
  const { t } = useTranslation();

  const cols = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of filtered) {
      const v = dimValue(s, colDim) ?? '—';
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filtered, colDim]);

  const rows = useMemo(() => {
    if (rowDim === 'none') return [];
    const m = new Map<string, number>();
    for (const s of filtered) {
      const v = dimValue(s, rowDim) ?? '—';
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filtered, rowDim]);

  const cells = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const c = dimValue(s, colDim) ?? '—';
      const r = rowDim === 'none' ? '' : (dimValue(s, rowDim) ?? '—');
      const key = `${r}||${c}`;
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key, [s]);
    }
    return m;
  }, [filtered, colDim, rowDim]);

  if (filtered.length === 0) {
    return (
      <div style={{ marginTop: 12 }}>
        <StatusTip status="empty" emptyText={t('insights.empty')} />
      </div>
    );
  }

  return (
    <div className="sim-board-scroll">
      <div
        className="sim-board-grid"
        style={{
          gridTemplateColumns:
            rowDim === 'none'
              ? `repeat(${Math.max(cols.length, 1)}, minmax(220px, 1fr))`
              : `minmax(140px, 180px) repeat(${cols.length}, minmax(220px, 1fr))`,
        }}
      >
        {rowDim !== 'none' && <div />}
        {cols.map(([c, n]) => (
          <div className="sim-colhead" key={c} title={c}>
            <span className="sim-st">
              {colDim === 'state' && <span className="sim-sdot" style={{ background: stateColor(c) }} />}
              <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{c}</b>
            </span>
            <span className="sim-cnt">{n}</span>
          </div>
        ))}
        {rowDim === 'none'
          ? cols.map(([c]) => (
              <div className="sim-cell" key={c}>
                    {(cells.get(`||${c}`) ?? []).map((s) => (
                      <BoardCard
                        key={s.sessionId}
                        s={s}
                        selected={s.sessionId === selectedId}
                        onOpen={onOpen}
                        terms={terms}
                        parentTitleOf={parentTitleOf}
                      />
                    ))}
              </div>
            ))
          : rows.map(([r]) => (
              <div key={r} style={{ display: 'contents' }}>
                <div className="sim-rowhead" title={r}>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r}</b>
                  <span className="sim-cnt">{rows.find((x) => x[0] === r)?.[1]}</span>
                </div>
                {cols.map(([c]) => (
                  <div className="sim-cell" key={r + c}>
                    {(cells.get(`${r}||${c}`) ?? []).map((s) => (
                      <BoardCard
                        key={s.sessionId}
                        s={s}
                        selected={s.sessionId === selectedId}
                        onOpen={onOpen}
                        terms={terms}
                        parentTitleOf={parentTitleOf}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
      </div>
    </div>
  );
}

function BoardCard({
  s,
  selected,
  onOpen,
  terms,
  parentTitleOf,
}: {
  s: SessionSummary;
  selected: boolean;
  onOpen: (id: string) => void;
  /** 搜索命中词，用于高亮（结构化前缀已剔除） */
  terms: string[];
  /** 父标题查询（会话标题护栏） */
  parentTitleOf: (s: SessionSummary) => string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`sim-card${selected ? ' sel' : ''}`}
      onClick={() => onOpen(s.sessionId)}
      title={s.sessionId}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      aria-label={sessionTitle(s, parentTitleOf(s))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(s.sessionId);
        }
      }}
    >
      <div className="sim-card-top">
        <span className="sim-vpill">{s.vendor}</span>
        <span className="sim-card-cost">
          {fmtCost(s.costUsd, s.costEstimated)}
          {s.costEstimated ? ' ~' : ''}
        </span>
      </div>
      <div className="sim-card-title">
        <Highlight text={sessionTitle(s, parentTitleOf(s))} terms={terms} />
      </div>
      {s.title && s.firstPrompt && (
        <div className="sim-card-sum">
          <Highlight text={s.firstPrompt} terms={terms} />
        </div>
      )}
      <div className="sim-card-foot">
        <span className="sim-mono2">{repoOf(s.sessionId)}</span>
        <span>{fmtRel(s.mtime, t)}</span>
      </div>
      <div className="sim-card-ready">
        <span className="sim-ready-l">
          <span className="sim-sdot" style={{ background: stateColor(s.state) }} />
          {s.state}
        </span>
        <span>{fmtCompact(s.tokens.total)} tok</span>
      </div>
    </div>
  );
}

/* ================= Insights 视图（筛选贯通 + KPI 条 + 图表） ================= */

function InsightsView({
  filteredSessions,
  curMonth,
}: {
  /** 已贯通 range + 搜索 + facets 的全量会话（未按月切分） */
  filteredSessions: SessionSummary[];
  curMonth: string | null;
}) {
  const { t } = useTranslation();

  // 月份口径（关键修复）：KPI / 饼图 / 榜单 / 每日柱状图一律只统计 curMonth 内的会话，
  // 与右簇月份切换器 ‹ › 联动。此前 aggr 直接聚合 filtered 全量，curMonth 仅用于标题文案，
  // 导致切换月份时所有指标纹丝不动（跨月数据被混算，days 还按 getDate() 把多个月的同一天叠加）。
  const scoped = useMemo(
    () => (curMonth ? filteredSessions.filter((s) => monthKeyOf(s.mtime) === curMonth) : []),
    [filteredSessions, curMonth],
  );

  const aggr = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    let cacheRead = 0;
    let input = 0;
    let estimated = 0;
    let unpriced = 0;
    const agents = new Map<string, number>();
    const models = new Map<string, number>();
    const repos = new Map<string, number>();
    const days = new Map<number, number>();
    const activeDays = new Set<string>();
    for (const s of scoped) {
      tokens += s.tokens.total;
      cost += s.costUsd;
      cacheRead += s.tokens.cacheRead;
      input += s.tokens.input;
      if (s.costEstimated) estimated += 1;
      if (s.costUsd === 0) unpriced += 1;
      agents.set(s.vendor, (agents.get(s.vendor) ?? 0) + 1);
      for (const m of s.models ?? []) models.set(m.model, (models.get(m.model) ?? 0) + 1);
      const r = repoOf(s.sessionId);
      repos.set(r, (repos.get(r) ?? 0) + 1);
      const d = new Date(s.mtime);
      days.set(d.getDate(), (days.get(d.getDate()) ?? 0) + 1);
      activeDays.add(d.toDateString());
    }
    const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      tokens,
      cost,
      cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
      estimated,
      unpriced,
      agents: top(agents, 8),
      models: top(models, 8),
      repos: top(repos, 5),
      days: [...days.entries()].sort((a, b) => a[0] - b[0]),
      activeDays: activeDays.size,
    };
  }, [scoped]);

  const card: CSSProperties = {
    border: '1px solid var(--tea-color-border, #e7e7e7)',
    borderRadius: 8,
    padding: '12px 14px',
    background: 'var(--tea-color-bg-container, #fff)',
  };

  if (!curMonth) return <StatusTip status="empty" emptyText={t('insights.empty')} />;

  // 柱状图铺满整月：天数取自月份本身（而非「当月最后一天有会话的日期」），空日显示为 0 高度灰柱。
  const [curYear, curMon] = curMonth.split('-').map(Number);
  const daysInMonth = new Date(curYear, curMon, 0).getDate();
  const maxDay = daysInMonth || Math.max(...aggr.days.map(([d]) => d), 1);
  const maxCount = Math.max(...aggr.days.map(([, n]) => n), 1);

  return (
    <div style={{ marginTop: 12 }}>
      {/* KPI 条（设计稿 §4：sessions / tokens / active days / cost）—— 口径 = curMonth 内会话 */}
      <div className="sim-kpi">
        <MetricTile label={t('insights.kpi.sessions')} value={fmtInt(scoped.length)} />
        <MetricTile label={t('insights.kpi.tokens')} value={fmtCompact(aggr.tokens)} sub={fmtInt(aggr.tokens)} />
        <MetricTile label={t('insights.kpi.activeDays')} value={fmtInt(aggr.activeDays)} />
        <MetricTile
          label={t('insights.kpi.cost')}
          value={fmtCost(aggr.cost, aggr.estimated > 0)}
          sub={aggr.estimated + aggr.unpriced > 0 ? t('insights.ins.estimated', { n: aggr.estimated, m: aggr.unpriced }) : undefined}
        />
      </div>

      {/* 饼图 + 榜单 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
        <div style={card}>
          <PieCard title={t('insights.ins.agents')} data={aggr.agents} total={scoped.length} />
        </div>
        <div style={card}>
          <PieCard title={t('insights.ins.models')} data={aggr.models} total={scoped.length} />
        </div>
        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--tea-color-text-secondary, #888)', marginBottom: 8 }}>
            {t('insights.ins.topRepos')}
          </div>
          {aggr.repos.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            aggr.repos.map(([name, n]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    width: 150,
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'right',
                  }}
                  title={name}
                >
                  {name}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 14,
                    borderRadius: 4,
                    background: 'var(--tea-color-bg-secondary, #f3f3f3)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max((n / (aggr.repos[0]?.[1] || 1)) * 100, 2)}%`,
                      height: '100%',
                      background: PALETTE[1],
                    }}
                  />
                </div>
                <span style={{ fontSize: 11, width: 26 }}>{n}</span>
              </div>
            ))
          )}
        </div>
        <div style={card}>
          <div style={{ fontSize: 12, color: 'var(--tea-color-text-secondary, #888)', marginBottom: 8 }}>
            {t('insights.ins.cacheRate')}
          </div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>
            {aggr.cacheRate == null ? '—' : `${(aggr.cacheRate * 100).toFixed(1)}%`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--tea-color-text-placeholder, #aaa)', marginTop: 4 }}>
            {t('insights.ins.estimated', { n: aggr.estimated, m: aggr.unpriced })}
          </div>
        </div>
      </div>

      {/* 每日活跃柱状图（整月铺满，空日零高度） */}
      <div style={{ ...card, marginTop: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--tea-color-text-secondary, #888)', marginBottom: 8 }}>
          {t('insights.ins.daily')} · {curMonth.replace('-', ' 年 ')} 月
        </div>
        {aggr.days.length === 0 ? (
          <Text theme="weak">{t('insights.ins.emptyMonth')}</Text>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90 }}>
            {Array.from({ length: maxDay }, (_, i) => i + 1).map((day) => {
              const n = aggr.days.find(([d]) => d === day)?.[1] ?? 0;
              return (
                <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }} title={`${curMonth}-${String(day).padStart(2, '0')} · ${n}`}>
                  <div
                    style={{
                      width: '100%',
                      maxWidth: 26,
                      height: `${Math.max((n / maxCount) * 70, n > 0 ? 4 : 1)}px`,
                      background: n > 0 ? PALETTE[0] : 'var(--tea-color-bg-secondary, #eee)',
                      borderRadius: 3,
                    }}
                  />
                  <span style={{ fontSize: 9, color: 'var(--tea-color-text-placeholder, #aaa)' }}>{day}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PieCard({
  title,
  data,
  total,
}: {
  title: string;
  data: [string, number][];
  total: number;
}) {
  const { t } = useTranslation();
  const merged = useMemo(() => {
    if (data.length <= 6) return data;
    const head = data.slice(0, 5);
    const rest = data.slice(5).reduce((a, [, n]) => a + n, 0);
    return [...head, [t('insights.ins.other'), rest] as [string, number]];
  }, [data, t]);

  const R = 34;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const sum = merged.reduce((a, [, n]) => a + n, 0) || 1;

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--tea-color-text-secondary, #888)', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <svg width="90" height="90" viewBox="0 0 90 90">
          <circle cx="45" cy="45" r={R} fill="none" stroke="var(--tea-color-bg-secondary, #f0f0f0)" strokeWidth="14" />
          {merged.map(([label, n], i) => {
            const frac = n / sum;
            const dash = `${frac * C} ${C}`;
            const offset = -acc * C;
            acc += frac;
            return (
              <circle
                key={label}
                cx="45"
                cy="45"
                r={R}
                fill="none"
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth="14"
                strokeDasharray={dash}
                strokeDashoffset={offset}
                transform="rotate(-90 45 45)"
              />
            );
          })}
        </svg>
        <div style={{ flex: 1, fontSize: 11 }}>
          {merged.map(([label, n], i) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
                {label}
              </span>
              <span style={{ color: 'var(--tea-color-text-secondary, #888)' }}>
                {n} · {Math.round((n / (total || 1)) * 100)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="sim-kpi-k">
      <div style={{ fontSize: 22, fontWeight: 600, margin: '4px 0' }}>{value}</div>
      <div className="sim-kpi-kl">{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tea-color-text-placeholder, #aaa)' }}>{sub}</div>}
    </div>
  );
}

function InspectorPanel({
  docked,
  width,
  rect,
  onResizeMouseDown,
  onResizeDoubleClick,
  onClose,
  panelRef,
  closeBtnRef,
  title,
  sessionId,
  summary,
  detail,
  handoff,
  synthesis,
  loading,
  error,
  onRetry,
  selectedDiff,
  onOpenDiff,
  onCloseDiff,
  sourceMap,
  pendingBySession,
  onRequestExtract,
  onFetchPending,
  onGoToMyMemory,
}: {
  docked: boolean;
  width: number;
  rect: { top: number; height: number } | null;
  onResizeMouseDown: (e: React.MouseEvent) => void;
  onResizeDoubleClick: () => void;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement>;
  closeBtnRef: RefObject<HTMLButtonElement>;
  title: string | null;
  sessionId: string;
  summary: SessionSummary | null;
  detail: SessionFactsResponse | null;
  handoff: HandoffResponse | null;
  synthesis: SynthesisResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedDiff: { path: string; sessionId: string } | null;
  onOpenDiff: (path: string) => void;
  onCloseDiff: () => void;
  /** M4b · 源会话提炼状态表 */
  sourceMap: Map<string, SourceSessionRecord>;
  /** M4b · 已拉取精确「可增量」条数的会话 */
  pendingBySession: Record<string, number>;
  /** M4b · 打开「生成个人记忆」对话框 */
  onRequestExtract: (s: SessionSummary) => void;
  /** M4b · 拉取某会话精确「可增量」条数 */
  onFetchPending: (s: SessionSummary) => Promise<number | null>;
  /** M4b · 跳转到「我的记忆」并预筛选该会话 */
  onGoToMyMemory: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const top = rect?.top ?? 0;
  const height = rect?.height ?? '100vh';
  // 陈旧信号（后端 M-B 注入 fresh 字段后生效；当前本地数据无此字段 → 不显示）
  const stale = !!(detail && (detail as SessionFactsResponse & { fresh?: boolean }).fresh === false);
  // 切换会话时旧 detail 不立即清空（防闪白），需校验 detail 归属当前选中，否则视为"未就绪"
  const detailMatches = !!detail && detail.facts.sessionId === sessionId;
  const sum = detailMatches ? detail.facts : summary;

  // ===== M-C 二级 diff 面板（守卫：选中会话身份须与当前面板一致，防看错版本） =====
  const diffOpen = !!selectedDiff && selectedDiff.sessionId === sessionId;
  const filesChanged = detail?.filesChanged ?? [];
  const diffFile = diffOpen ? filesChanged.find((x) => x.path === selectedDiff!.path) ?? null : null;
  const diffCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (diffOpen && diffCloseRef.current) diffCloseRef.current.focus();
  }, [diffOpen]);

  // M4b · 选中会话若已沉淀（done/partial），拉取精确「可增量」条数供按钮显示
  useEffect(() => {
    if (!sum) return;
    const rec = sourceMap.get(sourceMapKey(sum.vendor, sum.sessionId));
    if (
      rec &&
      (rec.status === 'done' || rec.status === 'partial') &&
      pendingBySession[sum.sessionId] === undefined
    ) {
      void onFetchPending(sum);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sum?.sessionId, sourceMap]);

  return (
    <>
      {!docked && <div className="sim-mask" onClick={onClose} aria-hidden="true" />}
      <aside
        ref={panelRef}
        className="sim-inspector"
        role="dialog"
        aria-modal={!docked}
        aria-label={t('insights.inspector.title')}
        style={{ top, height, width }}
      >
        {/* 左缘拖拽条（复用 useResizable 右侧语义：向左拖增大宽度） */}
        <div
          className="sim-insp-resizer"
          onMouseDown={onResizeMouseDown}
          onDoubleClick={onResizeDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('insights.inspector.resize')}
          title={t('insights.inspector.resizeHint')}
        />
        <div className="sim-insp-head">
          <div className="sim-insp-titles">
            <div className="sim-insp-t1">{title || sessionId}</div>
            <div className="sim-insp-t2">{sessionId}</div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="sim-insp-close"
            onClick={onClose}
            aria-label={t('insights.inspector.close')}
          >
            ×
          </button>
        </div>
        <div className="sim-insp-body">
          {error ? (
            <StatusTip status="error" errorText={error} onRetry={onRetry} />
          ) : !detailMatches || !sum ? (
            loading ? (
              <LoadingTip />
            ) : (
              <StatusTip status="empty" emptyText={t('insights.inspector.placeholder')} />
            )
          ) : (
            <>
              {stale && <div className="sim-stale">⚠ {t('insights.inspector.stale')}</div>}
              <Inspector summary={sum} detail={detail} handoff={handoff} synthesis={synthesis} onOpenDiff={onOpenDiff} />
              {loading && <div className="sim-updating">{t('insights.inspector.updating')}</div>}
            </>
          )}
        </div>
      </aside>

      {/* ===== M-C 二级 diff 滑出（右缘、不可拖拽；✕ / Esc / 遮罩关闭） ===== */}
      {diffOpen && (
        <>
          <div className="sim-diff-mask" onClick={onCloseDiff} aria-hidden="true" />
          <aside
            className="sim-diff"
            role="dialog"
            aria-modal={!docked}
            aria-label={t('insights.diff.title')}
            style={{ top, height }}
          >
            <div className="sim-insp-head">
              <div className="sim-insp-titles">
                <div className="sim-insp-t1" title={selectedDiff!.path}>
                  {selectedDiff!.path}
                </div>
                <div className="sim-insp-t2">{sessionId}</div>
              </div>
              <button
                ref={diffCloseRef}
                type="button"
                className="sim-insp-close"
                onClick={onCloseDiff}
                aria-label={t('insights.inspector.close')}
              >
                ×
              </button>
            </div>
            <div className="sim-insp-body">
              {filesChanged.length === 0 || !diffFile ? (
                <div className="sim-muted">{t('insights.diff.noChanges')}</div>
              ) : (
                <div>
                  {diffFile.isNew && (
                    <span className="sim-new-tag" style={{ display: 'inline-block', marginBottom: 10 }}>
                      {t('insights.diff.isNew')}
                    </span>
                  )}
                  <div className="sim-diffstat">
                    <div className="sim-diffstat-cell">
                      <span className="sim-add">+{diffFile.additions}</span>
                      <label>{t('insights.diff.additions')}</label>
                    </div>
                    <div className="sim-diffstat-cell">
                      <span className="sim-del">−{diffFile.deletions}</span>
                      <label>{t('insights.diff.deletions')}</label>
                    </div>
                    <div className="sim-diffstat-cell">
                      <span>{diffFile.edits}</span>
                      <label>{t('insights.diff.edits')}</label>
                    </div>
                  </div>
                  <div className="sim-muted" style={{ marginTop: 14 }}>
                    {t('insights.diff.snapshotNote')}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}

function Inspector({
  summary,
  detail,
  handoff,
  synthesis,
  onOpenDiff,
}: {
  summary: SessionSummary;
  detail: SessionFactsResponse;
  handoff: HandoffResponse | null;
  synthesis: SynthesisResponse | null;
  onOpenDiff: (path: string) => void;
}) {
  const { t } = useTranslation();
  const f = detail.facts;
  const debrief = detail.debrief ?? null;
  const filesChanged = detail.filesChanged ?? [];
  const commits = detail.commits ?? [];
  const todos = detail.todos ?? [];
  const commands = detail.commands ?? [];
  const newFiles = filesChanged.filter((x) => x.isNew).length;
  const subagents = f.digest?.subagent ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 1. Header facts */}
      <Section title={t('insights.inspector.headerFacts')}>
        <div style={{ fontSize: 13 }}>{sessionTitle(summary)}</div>
        <div style={{ fontSize: 12, color: 'var(--tea-color-text-secondary, #888)', marginTop: 4 }}>
          {summary.firstPrompt || '—'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, marginTop: 10 }}>
          <KV k={t('insights.kv.vendor')} v={summary.vendor} />
          <KV k={t('insights.kv.kind')} v={summary.kind} />
          <KV k={t('insights.kv.userTurns')} v={fmtInt(summary.userTurns)} />
          <KV k={t('insights.kv.assistantTurns')} v={fmtInt(summary.assistantTurns)} />
          <KV k={t('insights.kv.edits')} v={fmtInt(summary.edits.operations)} />
          <KV k={t('insights.kv.git')} v={summary.git ? gitLabel(summary.git, t) : t('insights.kv.noGit')} />
          <KV k={t('insights.kv.tokensTotal')} v={fmtInt(summary.tokens.total)} />
          <KV
            k={t('insights.kv.cost')}
            v={`${fmtCost(summary.costUsd, summary.costEstimated)}${summary.costEstimated ? ' ~' : ''}`}
          />
          <KV k={t('insights.kv.cacheRead')} v={fmtInt(summary.tokens.cacheRead)} />
          <KV k={t('insights.kv.cacheCreate')} v={fmtInt(summary.tokens.cacheCreate)} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <Tag variant="soft">user {f.digest.user}</Tag>
          <Tag variant="soft">question {f.digest.question}</Tag>
          <Tag variant="soft">todos {f.digest.todos}</Tag>
          <Tag variant="soft">plan {f.digest.plan}</Tag>
          <Tag variant="soft">compaction {f.digest.compaction}</Tag>
          <Tag variant="soft">recap {f.digest.recap}</Tag>
        </div>
      </Section>

      {/* 2. Resume·Hand off（v7：五格数值 + 配色 + 双窗 + verdict） */}
      <Section
        title={
          <span className="sim-en-title">
            RESUME OR HAND OFF
            {handoff && <VerdictBadge verdict={handoff.verdict} />}
          </span>
        }
      >
        {handoff?.readiness ? (
          <div className="sim-ready-grid">
            <ReadinessCellView label="Context used" cell={handoff.readiness.context} />
            <ReadinessCellView label="Compactions" cell={handoff.readiness.compactions} />
            <ReadinessCellView label="Branch" cell={handoff.readiness.branch} />
            <ReadinessCellView label="Working tree" cell={handoff.readiness.workspace} />
            <ReadinessCacheCell label="Prompt cache" cache={handoff.readiness.cache} />
          </div>
        ) : (
          <Text theme="weak" style={{ fontSize: 12 }}>
            —
          </Text>
        )}
      </Section>

      {/* 3. Debrief（三级兜底：GOAL 徽章 / OUTCOME 取 recap / KEY DECISIONS 合成优先） */}
      <Section
        title={
          <span className="sim-en-title">
            DEBRIEF
            {synthesis?.error ? (
              <span className="sim-syn-warn-tag" title={synthesis.error}>
                ⚠
              </span>
            ) : null}
          </span>
        }
      >
        {synthesis?.error ? (
          <div className="sim-syn-warn">{t('insights.inspector.synthesisError', { reason: synthesis.error })}</div>
        ) : null}
        <DebriefPanel debrief={debrief} synthesis={synthesis} t={t} />
      </Section>

      {/* 4. Timeline（S6 · 分类 chips + 计数 + toggle + 按天分隔） */}
      <Section title={t('insights.timeline.title', { n: (detail.digest ?? []).length })}>
        <TimelineBlock items={detail.digest ?? []} />
      </Section>

      {/* 5. Artifacts */}
      <Section title={t('insights.inspector.artifacts')}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }}>
          <ArtifactStat
            label={t('insights.inspector.artifactsFiles')}
            value={`${filesChanged.length}${newFiles ? `（${t('insights.inspector.artifactsNew')} ${newFiles}）` : ''}`}
          />
          <ArtifactStat label={t('insights.inspector.artifactsSubagents')} value={String(subagents)} />
          <ArtifactStat label={t('insights.inspector.artifactsPRs')} value="—" />
        </div>
      </Section>

      {/* 6. Files·Cmds·Commits·Todos */}
      <Section title={t('insights.inspector.filesChanged', { n: filesChanged.length })}>
        {filesChanged.length === 0 ? (
          <div className="sim-muted">{t('insights.diff.noChanges')}</div>
        ) : (
          <div className="sim-files">
            {filesChanged.map((fc) => (
              <button
                key={fc.path}
                type="button"
                className="sim-file-row"
                onClick={() => onOpenDiff(fc.path)}
                title={t('insights.diff.openHint')}
              >
                <span className="sim-file-name">{fc.path}</span>
                <span className="sim-file-stat">
                  {fc.isNew && <span className="sim-new-tag">{t('insights.diff.isNew')}</span>}
                  <span className="sim-add">+{fc.additions}</span>
                  <span className="sim-del">−{fc.deletions}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {commands.length > 0 && (
        <Section title={t('insights.inspector.commands')}>
          <div className="sim-cmdlist">
            {commands.map((c) => (
              <div key={c.name} className="sim-cmd-row">
                <span className="sim-cmd-name">{c.name}</span>
                <span className="sim-cmd-count">×{c.count}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {commits.length > 0 && (
        <Section title={t('insights.inspector.commits')}>
          <div className="sim-commitlist">
            {commits.map((c) => (
              <div key={c.hash} className="sim-commit-row">
                <span className="sim-commit-hash">{c.hash.slice(0, 8)}</span>
                <span className="sim-commit-msg">{c.message}</span>
                <span className="sim-commit-ts">{fmtRel(c.ts, t)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {todos.length > 0 && (
        <Section title={t('insights.inspector.todos')}>
          <div className="sim-todolist">
            {todos.map((td, i) => (
              <div key={i} className="sim-todo-row">
                <span className={`sim-todo-dot ${td.completed ? 'done' : ''}`} />
                <span className="sim-todo-subj">{td.subject}</span>
                <span className={`sim-todo-status ${todoStatusClass(td.status)}`}>{td.status}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 7. Footer（Copy Handoff · 八段式） */}
      <FooterBlock summary={summary} detail={detail} handoff={handoff} synthesis={synthesis} />
    </div>
  );
}

/* ================= M-C 区块辅助组件 ================= */

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="sim-block">
      <div className="sim-block-h">
        <Text theme="label" style={{ fontSize: 12 }}>
          {title}
        </Text>
      </div>
      <div className="sim-block-c">{children}</div>
    </div>
  );
}

function ArtifactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sim-artifact">
      <div className="sim-artifact-v">{value}</div>
      <div className="sim-artifact-l">{label}</div>
    </div>
  );
}

/** GOAL 来源徽章英文常量（不进 i18n，照搬 coSlash） */
function goalSourceLabel(src?: 'declared' | 'inferred' | 'floor' | string): string {
  if (src === 'declared') return 'declared';
  if (src === 'inferred') return 'inferred';
  return 'first prompt';
}

/** 把解析后的块渲染成段落 / 有序列表 / 无序列表，并按预算折叠（show full / show less） */
function DebriefProse({ blocks }: { blocks: DebriefBlock[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = useMemo(() => collapseDebriefBlocks(blocks, 4, 160), [blocks]);
  const shown = expanded ? blocks : collapsed.blocks;
  if (shown.length === 0) return <span className="sim-debrief-text">—</span>;
  return (
    <div className="sim-debrief-prose">
      {shown.map((b, i) => {
        if (b.kind === 'heading') return <div key={i} className="sim-db-heading">{b.text}</div>;
        if (b.kind === 'list') {
          const ListTag = b.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={i} className="sim-db-list">
              {b.items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={i} className="sim-debrief-text">{b.text}</p>;
      })}
      {collapsed.truncated && (
        <button type="button" className="sim-db-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'show less' : 'show full'}
        </button>
      )}
    </div>
  );
}

/** KEY DECISIONS 三级兜底 + GOAL 徽章 + OUTCOME 折叠（设计文档 §04） */
function DebriefPanel({
  debrief,
  synthesis,
  t,
}: {
  debrief: Debrief | null;
  synthesis: SynthesisResponse | null;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const syn = synthesis?.synthesis ?? null;
  const synEnabled = synthesis?.enabled ?? false;
  const pending = !!synthesis?.pending;

  // —— GOAL（合成 goals 优先 → 否则 debrief.goal + 来源徽章）——
  const goals = syn?.goals && syn.goals.length ? syn.goals : null;
  const goalBadge = goals ? 'inferred' : goalSourceLabel(debrief?.goalSource);
  const goalBlocks = goals ? blocksFromTexts(goals) : debrief?.goal ? parseDebriefText(debrief.goal) : [];

  // —— OUTCOME（合成 outcome 优先 → 否则 debrief.outcome；pending 时显示 Synthesizing）——
  const outcomeText = syn?.outcome || debrief?.outcome || '';
  const outcomeBlocks = outcomeText ? parseDebriefText(outcomeText) : [];

  // —— KEY DECISIONS（合成优先 → 启发式兜底 → 空态文案）——
  const kd = syn?.keyDecisions && syn.keyDecisions.length ? syn.keyDecisions : debrief?.keyDecisions ?? [];
  let kdState: 'loading' | 'disabled' | 'none' | 'has';
  if (pending) kdState = 'loading';
  else if (kd.length) kdState = 'has';
  else if (synEnabled) kdState = 'none';
  else kdState = 'disabled';

  return (
    <div className="sim-debrief">
      <div className="sim-db-row">
        <span className="sim-klabel">GOAL</span>
        <div className="sim-db-content">
          {goalBadge && <span className="sim-db-badge">{goalBadge}</span>}
          <DebriefProse blocks={goalBlocks} />
        </div>
      </div>

      <div className="sim-db-row">
        <span className="sim-klabel">OUTCOME</span>
        {pending ? (
          <span className="sim-db-loading">
            <span className="sim-spinner" /> Synthesizing…
          </span>
        ) : (
          <DebriefProse blocks={outcomeBlocks} />
        )}
      </div>

      <div className="sim-db-row">
        <span className="sim-klabel">KEY DECISIONS</span>
        {kdState === 'loading' ? (
          <span className="sim-db-loading">
            <span className="sim-spinner" /> Synthesizing…
          </span>
        ) : kdState === 'has' ? (
          <DebriefProse blocks={blocksFromTexts(kd)} />
        ) : kdState === 'disabled' ? (
          <div className="sim-db-empty">{t('insights.inspector.debriefDecisionsDisabled')}</div>
        ) : (
          <div className="sim-db-empty">{t('insights.inspector.debriefDecisionsNone')}</div>
        )}
      </div>
    </div>
  );
}

// S6 · TIMELINE 分类元数据（对齐 coslash DIGEST_CATEGORIES，英文标签不进 i18n）
const DIGEST_META: Record<DigestCategory, { label: string; color: string }> = {
  first_prompt: { label: 'FIRST PROMPT', color: '#00a870' },
  question: { label: 'QUESTION', color: '#3a6df0' },
  subagent: { label: 'SUBAGENT', color: '#9b59b6' },
  todos: { label: 'TODOS', color: '#8a8f99' },
  recap: { label: 'RECAP', color: '#e6a23c' },
  plan: { label: 'PLAN', color: '#e6a23c' },
  user: { label: 'USER TURN', color: '#2740a8' },
  compaction: { label: 'COMPACTION', color: '#e34d59' },
};

/** S6 · 单条 TIMELINE 事件行（对齐 coslash DigestRow：分类色标 + 描述 + 答案 + turn + 时间） */
function DigestRow({ entry, endsDay }: { entry: DigestEntry; endsDay?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = DIGEST_META[entry.category];
  const collapsible = (entry.category === 'recap' || entry.category === 'plan') && entry.description.length > 120;
  return (
    <div className={`sim-tl-row${endsDay ? '' : ' sim-tl-bb'}`}>
      <span className="sim-tl-cat" style={{ color: meta.color }}>
        {meta.label}
      </span>
      <div className="sim-tl-body">
        <div
          className={`sim-tl-desc${collapsible && !expanded ? ' sim-clamp' : ''}${
            entry.category === 'plan' ? ' sim-pre' : ''
          }`}
        >
          {entry.description}
        </div>
        {entry.answer != null && <div className="sim-tl-answer">{entry.answer}</div>}
        {collapsible && (
          <button type="button" className="sim-tl-expand" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'collapse' : `expand full ${entry.category}`}
          </button>
        )}
      </div>
      <span className="sim-tl-meta">
        <span>turn {entry.turn}</span>
        {entry.time ? <span>{fmtClock(entry.time)}</span> : null}
      </span>
    </div>
  );
}

/** S6 · TIMELINE 区块（对齐 coslash DigestSection：分类 chips + 计数 + toggle + 按天分隔） */
function TimelineBlock({ items }: { items: DigestEntry[] }) {
  const [hidden, setHidden] = useState<Set<DigestCategory>>(new Set());

  const counts = useMemo(() => {
    const m = new Map<DigestCategory, number>();
    for (const e of items) m.set(e.category, (m.get(e.category) ?? 0) + 1);
    return m;
  }, [items]);

  const { rows, starts, ends, dateRange } = useMemo(() => {
    const vis = items.filter((e) => !hidden.has(e.category));
    const starts = new Set<number>();
    const ends = new Set<number>();
    let lastKey = '';
    for (let i = 0; i < vis.length; i++) {
      const t = vis[i].time ?? 0;
      const key = t > 0 ? digestDateKey(t) : '';
      if (key && key !== lastKey) starts.add(i);
      if (i > 0 && key && lastKey && key !== lastKey) ends.add(i - 1);
      if (key) lastKey = key;
    }
    const times = vis.map((e) => e.time ?? 0).filter((t) => t > 0);
    let range: string | null = null;
    if (times.length) {
      const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const a = new Date(Math.min(...times));
      const b = new Date(Math.max(...times));
      range = a.toDateString() === b.toDateString() ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
    }
    return { rows: vis, starts, ends, dateRange: range };
  }, [items, hidden]);

  const toggle = (c: DigestCategory) =>
    setHidden((p) => {
      const n = new Set(p);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  if (items.length === 0) return <div className="sim-muted">—</div>;

  return (
    <div>
      <div className="sim-tl-head">
        <span className="sim-tl-sub">key events from this session</span>
        {dateRange && <span className="sim-tl-range">{dateRange}</span>}
      </div>
      <div className="sim-tl-chips">
        {(Object.keys(DIGEST_META) as DigestCategory[])
          .filter((c) => counts.has(c))
          .map((c) => (
            <button
              key={c}
              type="button"
              className={`sim-tl-chip${hidden.has(c) ? '' : ' on'}`}
              onClick={() => toggle(c)}
            >
              <span className="sim-tl-dot" style={{ background: DIGEST_META[c].color }} />
              {DIGEST_META[c].label} {counts.get(c)}
            </button>
          ))}
      </div>
      <div className="sim-tl-rows">
        {rows.length === 0 ? (
          <div className="sim-muted">—</div>
        ) : (
          rows.map((e, i) => (
            <div key={i}>
              {starts.has(i) && (
                <div className="sim-tl-divider">
                  {new Date(e.time ?? Date.now())
                    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
                    .toUpperCase()}
                </div>
              )}
              <DigestRow entry={e} endsDay={ends.has(i) || i === rows.length - 1} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function todoStatusClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'completed' || s === 'done') return 'done';
  if (s === 'in_progress' || s === 'progress') return 'prog';
  return 'pend';
}

const HANDOFF_MAX_BYTES = 64 * 1024;

/**
 * 八段式交接文本（设计文档 §06.1）：Objective / Current state / Key decisions / Timeline /
 * Files / Commits / Next steps / Environment。整段 > 64 KiB 时只剔除 Timeline 段并留省略标记，
 * 而不是从中间截断（保留其余七段完整）。
 */
function buildHandoff(
  summary: SessionSummary,
  detail: SessionFactsResponse,
  handoff: HandoffResponse | null,
  synthesis: SynthesisResponse | null,
): string {
  const syn = synthesis?.synthesis ?? null;
  const title = sessionTitle(summary);

  const goals = syn?.goals && syn.goals.length ? syn.goals : null;
  const goalSource = goals ? 'inferred' : goalSourceLabel(detail.debrief?.goalSource);
  const objective = goals && goals.length ? goals.join('\n') : detail.debrief?.goal || '—';

  const currentState = syn?.outcome || detail.debrief?.outcome || '—';

  const kd = syn?.keyDecisions && syn.keyDecisions.length ? syn.keyDecisions : detail.debrief?.keyDecisions ?? [];
  const keyDecisions = kd.length ? kd.map((d) => `- ${d}`).join('\n') : '—';

  // S6 · TIMELINE 段改用 digest 条目（分类 + turn + 描述），与 coslash handoff 同口径
  const timeline = (detail.digest ?? []).slice(0, 200);
  const timelineBody = timeline.length
    ? timeline.map((e) => `- [${e.category} · turn ${e.turn}] ${e.description}`).join('\n')
    : '—';

  const fc = detail.filesChanged ?? [];
  const filesBody = fc.length
    ? fc.map((x) => `  ${x.path}  +${x.additions} −${x.deletions}${x.isNew ? '  [new]' : ''}`).join('\n')
    : '—';

  const cm = detail.commits ?? [];
  const commitsBody = cm.length ? cm.map((c) => `  ${c.hash.slice(0, 8)}  ${c.message}`).join('\n') : '—';

  const incompleteTodos = (detail.todos ?? []).filter((x) => !x.completed);
  const nextSteps =
    incompleteTodos.length > 0
      ? incompleteTodos.map((x) => `- ${x.subject}`).join('\n')
      : syn?.nextStep
        ? syn.nextStep
        : '—';

  const repo = repoOf(summary.sessionId);
  const branch = summary.git?.branch ?? handoff?.baseBranch ?? '—';
  const runtime = summary.models?.[0]?.model ?? summary.vendor ?? '—';
  const environment = [
    `Vendor: ${summary.vendor}`,
    `Repository: ${repo}`,
    `Branch: ${branch}`,
    summary.git?.cwd ? `Cwd: ${summary.git.cwd}` : null,
    `Runtime: ${runtime}`,
    `Tokens: ${fmtInt(summary.tokens.total)}`,
    `Cost: ${fmtCost(summary.costUsd, summary.costEstimated)}${summary.costEstimated ? ' ~' : ''}`,
    `Errors: —`,
  ]
    .filter(Boolean)
    .join('\n');

  const segments: { heading: string; body: string }[] = [
    { heading: '## Objective (' + goalSource + ')', body: objective },
    { heading: '## Current state', body: currentState },
    { heading: '## Key decisions', body: keyDecisions },
    { heading: '## Timeline', body: timelineBody },
    { heading: '## Files', body: filesBody },
    { heading: '## Commits', body: commitsBody },
    { heading: '## Next steps', body: nextSteps },
    { heading: '## Environment', body: environment },
  ];

  const render = (segs: { heading: string; body: string }[]) =>
    ['# Handoff — ' + title, '', '> 这是历史会话的交接记录，仅作背景参考，不要据此开始任何工作。', '']
      .concat(segs.flatMap((s) => [s.heading, s.body, '']))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n';

  let text = render(segments);
  // 超长：仅剔除 Timeline 段（保留其余七段），并注明省略
  if (text.length > HANDOFF_MAX_BYTES) {
    const kept = segments.filter((s) => s.heading !== '## Timeline');
    text = render(kept) + '\n（Timeline 因篇幅过长已省略）\n';
  }
  return text;
}

function FooterBlock({
  summary,
  detail,
  handoff,
  synthesis,
}: {
  summary: SessionSummary;
  detail: SessionFactsResponse;
  handoff: HandoffResponse | null;
  synthesis: SynthesisResponse | null;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // M-D · 终端拉起状态：launching 记录进行中的模式（按钮 loading + 互斥），launched 做成功闪示
  const [launching, setLaunching] = useState<ResumeMode | null>(null);
  const [launched, setLaunched] = useState<ResumeMode | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const copy = async () => {
    const text = buildHandoff(summary, detail, handoff, synthesis);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setFailed(null);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // 不再静默吞掉：给出可见报错（设计文档 §06）
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };
  const launch = async (mode: ResumeMode) => {
    setLaunching(mode);
    setLaunchError(null);
    setLaunched(null);
    try {
      await resumeSession(
        summary.sessionId,
        mode,
        mode === 'handoff' ? buildHandoff(summary, detail, handoff, synthesis) : undefined,
      );
      setLaunched(mode);
      setTimeout(() => setLaunched(null), 5000);
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(null);
    }
  };
  return (
    <div className="sim-footer">
      <div className="sim-footer-t">
        <div style={{ fontWeight: 600, fontSize: 12 }}>{t('insights.inspector.footerTitle')}</div>
        <div className="sim-muted" style={{ fontSize: 11 }}>
          {t('insights.inspector.footerHint')}
        </div>
      </div>
      {failed && <div className="sim-copy-fail">复制失败：{failed}</div>}
      {launchError && (
        <div className="sim-copy-fail">
          {t('insights.inspector.resumeFailed')}：{launchError}
        </div>
      )}
      {launched && <div className="sim-copy-ok">{t('insights.inspector.resumeLaunched')}</div>}
      <div className="sim-footer-btns">
        <Button
          loading={launching === 'handoff'}
          disabled={launching !== null && launching !== 'handoff'}
          title={t('insights.inspector.resumeHandoffTip')}
          onClick={() => launch('handoff')}
        >
          Start fresh with handoff
        </Button>
        <Button
          loading={launching === 'fresh'}
          disabled={launching !== null && launching !== 'fresh'}
          title={t('insights.inspector.resumeFreshTip')}
          onClick={() => launch('fresh')}
        >
          Start fresh
        </Button>
        <Button type="primary" onClick={copy}>
          {copied ? t('insights.inspector.copied') : 'Copy handoff'}
        </Button>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ color: 'var(--tea-color-text-secondary, #888)' }}>{k}</div>
      <div style={{ fontWeight: 600 }}>{v}</div>
    </div>
  );
}

/** RESUME OR HAND OFF 顶部的动作推荐徽章（resume / inspect / fresh，英文常量不进 i18n） */
function VerdictBadge({ verdict }: { verdict: ReadinessVerdict }) {
  const label = verdict === 'resume' ? 'resume' : verdict === 'inspect' ? 'inspect' : 'fresh';
  const cls = verdict === 'resume' ? 'resume' : verdict === 'inspect' ? 'inspect' : 'fresh';
  return <span className={`sim-verdict ${cls}`}>{label}</span>;
}

function toneColor(tone: ReadinessTone): string {
  return tone === 'ok' ? '#00a870' : tone === 'warn' ? '#ff9c00' : tone === 'danger' ? '#e34d59' : 'var(--tea-color-text-secondary, #888)';
}

/** 通用格子（Context used / Compactions / Branch / Working tree）：value + tone 配色 */
function ReadinessCellView({ label, cell }: { label: string; cell?: ReadinessCell | null }) {
  // 防御：后端契约缺字段时降级为「—」，避免整块面板白屏
  const tone = cell?.tone ?? null;
  const value = cell?.value ?? '—';
  const color = toneColor(tone);
  return (
    <div className="sim-ready-cell" style={{ borderColor: tone ? color : 'var(--tea-color-border, #e7e7e7)' }}>
      <div className="sim-ready-label">{label}</div>
      <div className="sim-ready-dot" style={{ background: color }} />
      <div className="sim-ready-value" style={{ color }}>{value}</div>
    </div>
  );
}

/** Prompt cache 格子：warm/cold + 相对时间 + 5min / 1hr 双窗勾叉（对齐 coslash PromptCacheCell） */
function ReadinessCacheCell({ label, cache }: { label: string; cache?: CacheReadiness | null }) {
  // 防御：cache 缺失时按 cold 渲染，不抛错
  const warm = cache?.warm ?? false;
  const within5m = cache?.within5m ?? false;
  const within1h = cache?.within1h ?? false;
  const color = toneColor(cache?.tone ?? null);
  const mk = (on: boolean) => ({ color: on ? '#00a870' : '#e34d59' });
  return (
    <div className="sim-ready-cell" style={{ borderColor: color }}>
      <div className="sim-ready-label">{label}</div>
      <div className="sim-ready-cache-state" style={{ color }}>
        {warm ? 'warm' : 'cold'}
        {cache?.at ? <span className="sim-ready-ago"> · {fmtAgo(cache.at)}</span> : null}
      </div>
      <div className="sim-ready-windows">
        <span className="sim-win">
          <b style={mk(within5m)}>{within5m ? '✓' : '✗'}</b> 5 min
        </span>
        <span className="sim-win">
          <b style={mk(within1h)}>{within1h ? '✓' : '✗'}</b> 1 hr
        </span>
      </div>
    </div>
  );
}
