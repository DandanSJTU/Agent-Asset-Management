/**
 * MyMemoryPage — 我的记忆（对话记忆的 L1 / L2 / L3 分层提炼视图）。
 *
 * 2026-10-18 重设计「管道即导航」：
 *   - 管道状态条 L1/L2/L3 卡片可点击，点击后直接在卡片下方展开该层的内容列表
 *     （默认选中 L1，进页面即见记忆内容，不再需要滚到页面底部找三层 Tab）；
 *   - 原「类型分布 / 场景分布」只读统计图改造为 L1 面板内的可点击筛选器
 *     （类型 chips 单选筛选 + 场景下拉筛选），统计即操作；
 *   - 源会话选择器（提炼操作区）默认收起，内容优先；
 *   - 层级视图（MemoryHierarchyView）改为页首按钮切换。
 *
 * 数据来源：/api/v1/personal-space/*（经网关 proxy 到对话记忆管线）。
 * 支持 ?session= 预筛选（来自会话洞察「看沉淀」跳转，落 L1 + 按会话分组）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, LoadingTip, StatusTip, Tag, Text } from 'tea-component';
import {
  fetchPersonalMemories,
  fetchPersonalSourceSessions,
  fetchPersonalScenes,
  fetchPersonalPersona,
  fetchSessions,
  triggerPersonalExtract,
  type PersonalMemory,
  type SessionSummary,
  type SourceSessionRecord,
  type PersonalScene,
  type PersonalPersonaResponse,
} from '@/lib/api/personal-space';
import { MemoryHierarchyView } from '@/pages/MemoryHierarchyView';

const TYPE_COLORS: Record<string, string> = {
  persona: '#534AB7',
  instruction: '#185FA5',
  episodic: '#3B6D11',
  fact: '#185FA5',
  preference: '#534AB7',
  constraint: '#854F0B',
  event: '#3B6D11',
};
/** L1 记忆类型完整分类法（9 类），用于「类型覆盖」卡分母 */
const TYPE_TAXONOMY = ['persona', 'instruction', 'episodic', 'fact', 'preference', 'constraint', 'event', 'work_fact', 'work_task'] as const;

type LayerKey = 'L1' | 'L2' | 'L3';

function fmtWhen(s?: string | number): string {
  if (!s) return '';
  const d = Number.isFinite(Number(s)) ? new Date(Number(s)) : new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shortId(sid?: string | null): string {
  if (!sid) return '';
  const tail = sid.split('/').pop() || sid;
  return tail.slice(0, 8);
}

const C = {
  border: '#e3e6ed',
  borderWeak: '#eef0f4',
  text: '#1f2329',
  sub: '#6b7280',
  faint: '#9ca3af',
  bg: '#ffffff',
  bgSoft: '#f7f8fa',
  bgLayout: '#fafbfc',
  accent: '#0b3d6b',
  accentSoft: '#e8f0f9',
  gold: '#a67c1a',
};

function Box({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '12px 14px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** 在文本中高亮检索关键词（返回 React 节点，避免 dangerouslySetInnerHTML 的 XSS 风险） */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let from = 0;
  let idx = lower.indexOf(ql, from);
  let k = 0;
  while (idx !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={k++} style={{ background: '#fff2a8', color: 'inherit', padding: '0 1px', borderRadius: 2 }}>
        {text.slice(idx, idx + ql.length)}
      </mark>,
    );
    i = idx + ql.length;
    from = i;
    idx = lower.indexOf(ql, from);
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

const STATUS_TONE: Record<string, string> = {
  never: '#9ca3af',
  running: '#854F0B',
  done: '#0F6E56',
  failed: '#A32D2D',
  partial: '#854F0B',
};

/** 可点击的类型筛选 chip（L1 面板筛选行） */
function TypeChip({
  type,
  count,
  active,
  onClick,
}: {
  type: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const color = TYPE_COLORS[type] ?? '#555';
  return (
    <button
      onClick={onClick}
      title={active ? '点击取消筛选' : '点击筛选该类型'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        cursor: 'pointer',
        background: active ? color : C.bg,
        color: active ? '#fff' : C.sub,
        border: `1px solid ${active ? color : C.border}`,
      }}
    >
      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: active ? 'rgba(255,255,255,.75)' : color }} />
      {type}
      <b style={{ fontWeight: 600 }}>{count}</b>
    </button>
  );
}

export function MyMemoryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  /** 当前展开内容面板的层（管道卡片点击即切换） */
  const [layer, setLayer] = useState<LayerKey>('L1');
  /** content=层内容列表 / hierarchy=L0→L3 整体蒸馏结构可视化 */
  const [view, setView] = useState<'content' | 'hierarchy'>('content');
  /** L1 面板：按来源会话分组展示 */
  const [groupBySession, setGroupBySession] = useState(false);

  // ── L1 面板筛选器 ──
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [sceneFilter, setSceneFilter] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();

  // ── 管道数据（全部来自对话记忆 personal 管线）──
  const [sourceSessions, setSourceSessions] = useState<SourceSessionRecord[]>([]);
  const [memories, setMemories] = useState<PersonalMemory[]>([]);
  const [scenes, setScenes] = useState<PersonalScene[]>([]);
  const [persona, setPersona] = useState<PersonalPersonaResponse | null>(null);

  // ── 源会话选择器（提炼操作区，默认收起：内容优先）──
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showSources, setShowSources] = useState(false);
  const [srcSearch, setSrcSearch] = useState('');
  /** 本地全量会话（会话洞察同源），供「全部本地会话」模式下选择未提炼的会话 */
  const [allSessions, setAllSessions] = useState<SessionSummary[]>([]);
  /** false=只看已提炼过的源会话；true=并入本地所有会话（未提炼的可直接选来提炼） */
  const [showAllSessions, setShowAllSessions] = useState(false);

  const [titleBySid, setTitleBySid] = useState<Map<string, string>>(new Map());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const filterSession = searchParams.get('session');

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [sr, mem, sc, ps] = await Promise.all([
        fetchPersonalSourceSessions(),
        fetchPersonalMemories(),
        fetchPersonalScenes(),
        fetchPersonalPersona(),
      ]);
      setSourceSessions(sr.sessions ?? []);
      setMemories(mem.memories ?? []);
      setScenes(sc.scenes ?? []);
      setPersona(ps);

      try {
        const sess = await fetchSessions();
        setAllSessions(sess.sessions ?? []);
        const map = new Map<string, string>();
        for (const it of sess.sessions ?? []) {
          const label = (it.title || it.firstPrompt || '').trim();
          if (label) map.set(it.sessionId, label);
        }
        setTitleBySid(map);
      } catch {
        setTitleBySid(new Map());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(tm);
  }, [toast]);

  // 本地部署迭代频繁（改完即 build + 重启）：轮询 index.html 的 bundle hash，
  // 发现新版本即弹出刷新提示，省得每次都要用户硬刷新（Cmd+Shift+R）才发现没有新功能。
  const [newVersion, setNewVersion] = useState(false);
  useEffect(() => {
    const current = document.querySelector<HTMLScriptElement>('script[src*="/assets/main-"]')?.src ?? '';
    if (!current) return;
    const check = async () => {
      try {
        const html = await (await fetch(`/?_=${Date.now()}`, { cache: 'no-store' })).text();
        const m = html.match(/assets\/main-[^"']+\.js/);
        if (m && !current.includes(m[0])) setNewVersion(true);
      } catch {
        // 网络抖动：忽略，下个周期再试
      }
    };
    const timer = setInterval(check, 60_000);    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  // 从洞察跳转过来（?session=）时：落 L1 + 按会话分组，直接看到该会话沉淀的记忆
  useEffect(() => {
    if (filterSession) {
      setLayer('L1');
      setView('content');
      setGroupBySession(true);
    }
  }, [filterSession]);

  const togglePick = (sid: string) => {
    // session_id 为空（整文件摄入等无会话 ID 源）不可选中——extract 网关要求非空 sessionId
    if (!sid) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const onExtract = async () => {
    setBusy(true);
    try {
      const ids = [...picked].filter(Boolean);
      const targets = ids.length
        ? ids
        : (sourceSessions.map((s) => s.session_id).filter(Boolean) as string[]);
      if (targets.length === 0) {
        setToast(t('myMemory.run.noTarget'));
        return;
      }
      let totalL1 = 0;
      let totalL2 = 0;
      let totalL3 = 0;
      let totalIngested = 0;
      for (const sessionId of targets) {
        const r = await triggerPersonalExtract({
          sessionId,
          layers: ['L1', 'L2', 'L3'],
        });
        totalL1 += r.l1Count ?? 0;
        totalL2 += r.l2Count ?? 0;
        totalL3 += r.l3Count ?? 0;
        totalIngested += r.ingestedCount ?? 0;
      }
      if (totalIngested === 0) {
        setToast(
          t('myMemory.run.noNew', {
            defaultValue: '所选会话已是最新，无新增消息可提炼（勾选「全部本地会话」可选未提炼的对话）',
          }),
        );
      } else {
        setToast(
          t('myMemory.run.done', {
            l1: totalL1,
            l2: totalL2,
            l3: totalL3,
          }),
        );
      }
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ===== L1 记忆筛选（会话 / 类型 / 场景 / 关键词，全部纯前端）===== */
  const filteredMemories = useMemo(() => {
    let list = memories;
    if (filterSession) list = list.filter((x) => (x.sessionId || x.sessionKey) === filterSession);
    if (typeFilter) list = list.filter((m) => m.type === typeFilter);
    if (sceneFilter) list = list.filter((m) => (m.scene_name ?? '未归类') === sceneFilter);
    if (ql) {
      list = list.filter(
        (m) =>
          (m.content || '').toLowerCase().includes(ql) ||
          (m.type || '').toLowerCase().includes(ql) ||
          (m.scene_name || '').toLowerCase().includes(ql),
      );
    }
    return list;
  }, [memories, filterSession, typeFilter, sceneFilter, ql]);

  /** 本地会话消息条数（用于未提炼会话行显示「N 条消息」，提示本次提炼成本） */
  const msgCountBySid = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSessions) m.set(s.sessionId, s.recordCount ?? 0);
    return m;
  }, [allSessions]);

  /**
   * 可选源列表：默认只列已提炼过的源会话；开启「全部本地会话」后并入本地尚未提炼的
   * 会话（status='never'），否则用户只能反复选中 4 条早已 done 的会话、每次都是 0 新增。
   */
  const mergedSources = useMemo(() => {
    if (!showAllSessions) return sourceSessions;
    const known = new Set(sourceSessions.map((s) => s.session_id).filter(Boolean));
    const extra: SourceSessionRecord[] = allSessions
      .filter((s) => s.sessionId && !known.has(s.sessionId))
      .map((s) => ({
        source_key: `local:${s.sessionId}`,
        vendor: 'workbuddy',
        session_id: s.sessionId,
        status: 'never' as const,
        cursor_record_index: 0,
        l0_count: 0,
        l1_count: 0,
        l2_count: 0,
        l3_count: 0,
      }));
    return [...extra, ...sourceSessions];
  }, [sourceSessions, allSessions, showAllSessions]);

  const visibleSources = useMemo(
    () =>
      mergedSources.filter((s) => {
        if (!srcSearch) return true;
        const title = titleBySid.get(s.session_id) || '';
        return (
          title.includes(srcSearch) ||
          s.session_id.includes(srcSearch) ||
          (s.source_key || '').includes(srcSearch)
        );
      }),
    [mergedSources, srcSearch, titleBySid],
  );

  const counts = useMemo(() => {
    let l1 = 0;
    let l2 = 0;
    let l3 = 0;
    for (const s of sourceSessions) {
      l1 += s.l1_count || 0;
      l2 += s.l2_count || 0;
      l3 += s.l3_count || 0;
    }
    // 实时落库时以最新读数为准（scenes/persona 已是最新）
    return { l1: Math.max(l1, memories.length), l2: Math.max(l2, scenes.length), l3: persona?.persona ? Math.max(l3, 1) : l3 };
  }, [sourceSessions, memories.length, scenes.length, persona]);

  /* ===== 统计（类型覆盖 / 类型分布 / 场景分布）——分布同时充当筛选器选项 ===== */
  const typeCoverage = useMemo(() => {
    const present = new Set(memories.map((m) => m.type));
    return { present: present.size, total: TYPE_TAXONOMY.length };
  }, [memories]);

  const typeDist = useMemo(() => {
    const m = new Map<string, number>();
    for (const mem of memories) m.set(mem.type, (m.get(mem.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [memories]);

  const sceneOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const mem of memories) {
      const raw = mem.scene_name ?? '未归类';
      m.set(raw, (m.get(raw) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [memories]);

  /* ===== L2 / L3 检索 ===== */
  const matchL2 = useMemo(() => {
    if (!ql) return scenes;
    return scenes.filter(
      (s) =>
        (s.content || '').toLowerCase().includes(ql) ||
        (s.filename || '').toLowerCase().includes(ql),
    );
  }, [scenes, ql]);

  const matchL3 = useMemo(() => {
    if (!ql) return true;
    return (persona?.persona || '').toLowerCase().includes(ql);
  }, [persona, ql]);

  /** 管道卡片计数：无筛选时展示全量；有筛选时展示该层命中数（与面板一致） */
  const hasFilter = ql.length > 0 || !!typeFilter || !!sceneFilter || !!filterSession;
  const l1CardN = hasFilter ? filteredMemories.length : counts.l1;
  const l2CardN = ql ? matchL2.length : counts.l2;
  const l3CardN = ql ? (matchL3 ? 1 : 0) : persona?.persona ? 1 : 0;

  const groups = useMemo(() => {
    const m = new Map<string, PersonalMemory[]>();
    for (const mem of filteredMemories) {
      const key = mem.sessionId || mem.sessionKey || 'unknown';
      const arr = m.get(key);
      if (arr) arr.push(mem);
      else m.set(key, [mem]);
    }
    return m;
  }, [filteredMemories]);

  const sessionLabel = useCallback(
    (sid: string): string => {
      const title = titleBySid.get(sid);
      if (title) return `${title} · ${shortId(sid)}`;
      if (sid === 'unknown') return t('myMemory.sourceSession');
      return `${t('myMemory.sourceSession')} · ${shortId(sid)}`;
    },
    [titleBySid, t],
  );

  // ⑤ 最近运行（注意：必须位于下方 loading/error 提前返回之前，遵守 hooks 调用顺序规则）
  const recentRuns = useMemo(
    () =>
      [...sourceSessions]
        .filter((s) => s.status !== 'never' && (s.l0_count > 0 || s.last_job_id || s.last_error))
        .sort((a, b) => (b.cursor_ts ?? 0) - (a.cursor_ts ?? 0))
        .slice(0, 5),
    [sourceSessions],
  );

  const activeFilterCount =
    (ql ? 1 : 0) + (typeFilter ? 1 : 0) + (sceneFilter ? 1 : 0) + (filterSession ? 1 : 0);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <LoadingTip />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 16 }}>
        <StatusTip status="error" errorText={error} onRetry={() => void loadAll()} />
      </div>
    );
  }

  // ── 管道状态条 ──
  const stages: { key: LayerKey; label: string; count: number; desc: string; dot: string }[] = [
    { key: 'L1', label: t('myMemory.stage.l1'), count: l1CardN, desc: t('myMemory.stage.l1.desc'), dot: '#185FA5' },
    { key: 'L2', label: t('myMemory.stage.l2'), count: l2CardN, desc: t('myMemory.stage.l2.desc'), dot: '#854F0B' },
    { key: 'L3', label: t('myMemory.stage.l3'), count: l3CardN, desc: t('myMemory.stage.l3.desc'), dot: '#0F6E56' },
  ];

  return (
    <div style={{ padding: 16, color: C.text }}>
      {/* 新版本提示条 */}
      {newVersion && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: C.accent,
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 6,
            marginBottom: 10,
            fontSize: 13,
          }}
        >
          <span>页面有新版本，刷新后生效</span>
          <span style={{ flex: 1 }} />
          <Button type="weak" style={{ color: C.accent }} onClick={() => location.reload()}>
            立即刷新
          </Button>
        </div>
      )}

      {/* 页首 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('myMemory.title')}</h3>
        <span style={{ flex: 1 }} />
        <Button
          type={view === 'hierarchy' ? 'primary' : undefined}
          onClick={() => setView(view === 'hierarchy' ? 'content' : 'hierarchy')}
        >
          {view === 'hierarchy' ? '返回内容' : '层级视图'}
        </Button>
        <Button onClick={() => void loadAll()} disabled={busy}>
          {t('common.refresh', { defaultValue: '刷新' })}
        </Button>
      </div>

      {/* ① 提炼管道：L1 → L2 → L3 可点击下钻 + 类型覆盖 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{t('myMemory.pipeline.title')}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            点击 L1 / L2 / L3 卡片，可在下方直接查看该层记忆内容
          </Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap' }}>
          {stages.map((s, i) => {
            const active = view === 'content' && layer === s.key;
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 220px' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setLayer(s.key);
                    setView('content');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setLayer(s.key);
                      setView('content');
                    }
                  }}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    background: active ? C.accentSoft : C.bg,
                    border: `1px solid ${active ? C.accent : C.border}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    textAlign: 'left',
                    boxShadow: active ? '0 1px 4px rgba(11,61,107,.18)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: s.dot }} />
                    <b style={{ fontSize: 13, color: active ? C.accent : C.text }}>{s.label}</b>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 18, fontWeight: 600, color: active ? C.accent : C.sub }}>{s.count}</span>
                    <span style={{ fontSize: 12, color: active ? C.accent : C.faint }}>{active ? '▾' : '›'}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>{s.desc}</div>
                </div>
                {i < stages.length - 1 && <span style={{ color: C.faint, fontSize: 14, flex: '0 0 auto' }}>→</span>}
              </div>
            );
          })}
          {/* 第四卡：类型覆盖（已覆盖的 L1 记忆类型 / 完整 9 类） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 220px' }}>
            <div
              style={{
                flex: 1,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: '10px 12px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: C.accent }} />
                <b style={{ fontSize: 13, color: C.text }}>类型覆盖</b>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 18, fontWeight: 600, color: C.accent }}>
                  {typeCoverage.present}/{typeCoverage.total}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>
                已覆盖 L1 记忆类型 / 完整 9 类
              </div>
            </div>
          </div>
        </div>
      </div>

      {view === 'hierarchy' ? (
        /* ── 层级视图（L0→L1→L2→L3 整体蒸馏结构可视化）── */
        <MemoryHierarchyView
          sourceSessions={sourceSessions}
          memories={memories}
          scenes={scenes}
          persona={persona}
          titleBySid={titleBySid}
        />
      ) : (
        <>
          {/* ② 层内容面板：管道卡片点击后直接展开对应层的内容列表 */}
          <Box style={{ marginBottom: 14, padding: 0, overflow: 'hidden' }}>
            {/* 面板头：层名 + 计数 + 检索 + 视图开关 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '10px 14px',
                background: C.bgSoft,
                borderBottom: `1px solid ${C.borderWeak}`,
              }}
            >
              <b style={{ fontSize: 13.5, color: C.accent }}>
                {layer === 'L1'
                  ? t('myMemory.stage.l1')
                  : layer === 'L2'
                    ? t('myMemory.stage.l2')
                    : t('myMemory.stage.l3')}
              </b>
              <Text theme="label" style={{ fontSize: 12 }}>
                {layer === 'L1'
                  ? `${filteredMemories.length}${hasFilter ? ` / ${counts.l1}` : ''} 条`
                  : layer === 'L2'
                    ? `${matchL2.length}${ql ? ` / ${scenes.length}` : ''} 块`
                    : persona?.persona ? '1 份' : '0 份'}
              </Text>
              {filterSession && layer === 'L1' && (
                <Tag variant="soft" style={{ color: C.accent, borderColor: C.accent }}>
                  会话：{shortId(filterSession)}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSearchParams({})}
                    style={{ marginLeft: 6, cursor: 'pointer', fontWeight: 700 }}
                  >
                    ×
                  </span>
                </Tag>
              )}
              <span style={{ flex: 1 }} />
              {layer === 'L1' && (
                <Button type={groupBySession ? 'primary' : undefined} onClick={() => setGroupBySession((v) => !v)}>
                  {groupBySession ? '平铺列表' : '按会话分组'}
                </Button>
              )}
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={
                  layer === 'L1'
                    ? '检索 L1 记忆内容 / 类型 / 场景…'
                    : layer === 'L2'
                      ? '检索场景块…'
                      : '检索画像…'
                }
                style={{
                  width: 240,
                  padding: '5px 10px',
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  fontSize: 12.5,
                  background: C.bg,
                  color: C.text,
                }}
              />
              {q && (
                <Button onClick={() => setQ('')} disabled={busy}>
                  清除
                </Button>
              )}
            </div>

            {/* L1 筛选行：类型 chips（原「类型分布」改造）+ 场景下拉（原「场景分布」改造） */}
            {layer === 'L1' && memories.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  padding: '8px 14px',
                  borderBottom: `1px solid ${C.borderWeak}`,
                  fontSize: 12,
                }}
              >
                <span style={{ color: C.sub }}>类型</span>
                {typeDist.map(([tp, c]) => (
                  <TypeChip
                    key={tp}
                    type={t(`myMemory.type.${tp}`, { defaultValue: tp })}
                    count={c}
                    active={typeFilter === tp}
                    onClick={() => setTypeFilter(typeFilter === tp ? null : tp)}
                  />
                ))}
                <span style={{ width: 1, height: 16, background: C.border }} />
                <span style={{ color: C.sub }}>场景</span>
                <select
                  value={sceneFilter ?? ''}
                  onChange={(e) => setSceneFilter(e.target.value || null)}
                  style={{
                    maxWidth: 220,
                    padding: '3px 8px',
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    fontSize: 12,
                    background: C.bg,
                    color: C.text,
                  }}
                >
                  <option value="">全部（{sceneOptions.length}）</option>
                  {sceneOptions.map(([name, c]) => (
                    <option key={name} value={name}>
                      {name.length > 12 ? `${name.slice(0, 12)}…` : name}（{c}）
                    </option>
                  ))}
                </select>
                {activeFilterCount > 0 && (
                  <Button
                    type="weak"
                    onClick={() => {
                      setTypeFilter(null);
                      setSceneFilter(null);
                      setQ('');
                      if (filterSession) setSearchParams({});
                    }}
                  >
                    清空筛选（{activeFilterCount}）
                  </Button>
                )}
              </div>
            )}

            {/* 面板内容区 */}
            <div style={{ padding: 12, maxHeight: 560, overflowY: 'auto' }}>
              {/* ── L1 观测（对话记忆 L1 原子记忆）── */}
              {layer === 'L1' &&
                (filteredMemories.length === 0 ? (
                  <Card>
                    <StatusTip status="empty" emptyText={t('myMemory.empty')} />
                    <div style={{ marginTop: 10 }}>
                      <Text theme="label" style={{ fontSize: 12 }}>
                        {t('myMemory.emptyHint')}
                      </Text>
                    </div>
                  </Card>
                ) : groupBySession ? (
                  /* 按来源会话分组 */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {[...groups.entries()].map(([sid, mems]) => (
                      <div key={sid} style={{ border: `1px solid ${C.borderWeak}`, borderRadius: 8, overflow: 'hidden' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '7px 12px',
                            background: C.bgSoft,
                            borderBottom: `1px solid ${C.borderWeak}`,
                          }}
                        >
                          <b title={sid} style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
                            {sessionLabel(sid)}
                          </b>
                          <Tag variant="soft">{mems.length} 条</Tag>
                          <span style={{ flex: 1 }} />
                          {sid !== 'unknown' && (
                            <Button type="weak" onClick={() => navigate(`/insights?session=${encodeURIComponent(sid)}`)}>
                              {t('myMemory.viewSource')}
                            </Button>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}>
                          {mems.map((mem) => (
                            <MemoryRow key={mem.id} mem={mem} q={ql} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  /* 平铺列表 */
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filteredMemories.map((mem) => (
                      <MemoryRow key={mem.id} mem={mem} q={ql} />
                    ))}
                  </div>
                ))}

              {/* ── L2 场景（对话记忆 SceneExtractor 场景块）── */}
              {layer === 'L2' &&
                (matchL2.length === 0 ? (
                  <Card>
                    <StatusTip status="empty" emptyText={t('myMemory.emptyL2')} />
                    <div style={{ marginTop: 10 }}>
                      <Text theme="label" style={{ fontSize: 12 }}>
                        {t('myMemory.emptyL2Hint')}
                      </Text>
                    </div>
                  </Card>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {matchL2.map((sc) => (
                      <SceneCard key={sc.id} scene={sc} q={ql} />
                    ))}
                  </div>
                ))}

              {/* ── L3 画像（对话记忆 PersonaGenerator persona.md）── */}
              {layer === 'L3' &&
                (!persona?.persona || (ql && !matchL3) ? (
                  <Card>
                    <StatusTip status="empty" emptyText={t('myMemory.emptyL3')} />
                    <div style={{ marginTop: 10 }}>
                      <Text theme="label" style={{ fontSize: 12 }}>
                        {t('myMemory.emptyL3Hint')}
                      </Text>
                    </div>
                  </Card>
                ) : (
                  <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {highlight(persona.persona, ql)}
                  </div>
                ))}
            </div>
          </Box>

          {/* ③ 提炼操作区：源会话选择器（默认收起，内容优先） */}
          <Box style={{ marginBottom: 14, background: C.bgLayout }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{t('myMemory.sources.title')}</b>
              <Text theme="label" style={{ fontSize: 12 }}>
                {t('myMemory.sources.hint')}
              </Text>
              <span style={{ flex: 1 }} />
              {picked.size > 0 && (
                <Tag variant="soft" style={{ color: C.accent, borderColor: C.accent }}>
                  {t('myMemory.sources.count', { n: picked.size })}
                </Tag>
              )}
              <Button type="primary" onClick={() => void onExtract()} disabled={busy}>
                {t('myMemory.run.full')}
              </Button>
              <Button
                type={showAllSessions ? 'primary' : undefined}
                onClick={() => setShowAllSessions((v) => !v)}
              >
                {showAllSessions ? '仅已提炼' : '全部本地会话'}
              </Button>
              <Button onClick={() => setShowSources((v) => !v)}>{showSources ? '收起' : '展开源会话'}</Button>
            </div>

            {showSources && (
              <div style={{ marginTop: 10 }}>
                <input
                  value={srcSearch}
                  onChange={(e) => setSrcSearch(e.target.value)}
                  placeholder={t('layered.search')}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '6px 10px',
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    fontSize: 12.5,
                    marginBottom: 8,
                    background: C.bg,
                    color: C.text,
                  }}
                />
                {visibleSources.length === 0 ? (
                  <Text theme="label" style={{ fontSize: 12 }}>
                    {t('myMemory.sources.empty')}
                  </Text>
                ) : (
                  <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {visibleSources.map((s) => {
                      const on = picked.has(s.session_id);
                      const tone = STATUS_TONE[s.status] ?? C.faint;
                      return (
                        <label
                          key={s.source_key}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            padding: '7px 9px',
                            background: on ? C.accentSoft : C.bg,
                            border: `1px solid ${on ? C.accent : C.borderWeak}`,
                            borderRadius: 6,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!s.session_id}
                            onChange={() => togglePick(s.session_id)}
                            style={{ marginTop: 3 }}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12.5, fontWeight: on ? 600 : 400, wordBreak: 'break-all' }}>
                              {titleBySid.get(s.session_id) || s.session_id || s.source_key}
                            </div>
                            <div style={{ fontSize: 11, color: C.faint, marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ width: 6, height: 6, borderRadius: 6, background: tone }} />
                                {s.status}
                              </span>
                              <span>· L1 {s.l1_count} / L2 {s.l2_count} / L3 {s.l3_count}</span>
                              {s.source_missing ? <span>· 源已删除</span> : null}
                              {s.status === 'never' ? (
                                <span>· {msgCountBySid.get(s.session_id) ?? 0} 条消息，未提炼</span>
                              ) : null}
                              {!s.session_id ? <span>· 无会话 ID（整文件摄入），不可重新提炼</span> : null}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </Box>
        </>
      )}

      {/* ⑤ 最近运行 */}
      <div style={{ marginTop: 18 }}>
        <b style={{ fontSize: 13 }}>{t('layered.recentRuns')}</b>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {recentRuns.length === 0 ? (
            <Text theme="label" style={{ fontSize: 12 }}>
              {t('layered.noRuns')}
            </Text>
          ) : (
            recentRuns.map((s) => {
              const tone = STATUS_TONE[s.status] ?? C.faint;
              // session_id 可能为空（无会话 ID 的源，如整文件摄入）——依次回退 title → session_id → source_key
              const label = titleBySid.get(s.session_id) || shortId(s.session_id) || shortId(s.source_key);
              return (
                <Box key={s.source_key} style={{ padding: '8px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
                    <Tag variant="soft" style={{ color: tone, borderColor: tone }}>
                      {s.status}
                    </Tag>
                    <span style={{ flex: 1 }} />
                    <Text theme="label" style={{ fontSize: 11.5 }}>
                      {fmtWhen(s.cursor_ts)}
                    </Text>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.sub, marginTop: 4 }}>
                    {t('myMemory.job.detail', {
                      l0: s.l0_count,
                      l1: s.l1_count,
                      l2: s.l2_count,
                      l3: s.l3_count,
                    })}
                    {s.last_error ? ` · ${s.last_error}` : ''}
                  </div>
                </Box>
              );
            })
          )}
        </div>
      </div>

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: C.accent,
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 6,
            fontSize: 13,
            zIndex: 999,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/** L1 记忆行（平铺 / 分组共用）：类型 Tag + 优先级 + 场景名 + 时间 + 内容（含关键词高亮） */
function MemoryRow({ mem, q }: { mem: PersonalMemory; q: string }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        border: `1px solid ${C.borderWeak}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: C.bg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
        <span title={t(`myMemory.typeDesc.${mem.type}`, { defaultValue: mem.type })} style={{ cursor: 'help' }}>
          <Tag style={{ color: TYPE_COLORS[mem.type] ?? '#555', borderColor: TYPE_COLORS[mem.type] ?? '#ccc' }}>
            {t(`myMemory.type.${mem.type}`, { defaultValue: mem.type })}
          </Tag>
        </span>
        {typeof mem.priority === 'number' && mem.priority >= 0 && (
          <span title={t('myMemory.priorityHint')} style={{ fontSize: 12, color: C.faint, cursor: 'help' }}>
            P{mem.priority}
          </span>
        )}
        {mem.scene_name && <span style={{ fontSize: 12, color: '#185FA5' }}>{mem.scene_name}</span>}
        <span style={{ flex: 1 }} />
        {mem.createdAt && <Text theme="label" style={{ fontSize: 11 }}>{fmtWhen(mem.createdAt)}</Text>}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {highlight(mem.content, q)}
      </div>
    </div>
  );
}

/** L2 场景卡：默认收起为首行摘要，点击展开全文（场景块通常很长，避免撑爆列表） */
function SceneCard({ scene, q }: { scene: PersonalScene; q: string }) {
  const [open, setOpen] = useState(false);
  const plain = (scene.content || '').trim();
  const firstLine = plain.split('\n').find((l) => l.trim()) || '';
  return (
    <div style={{ border: `1px solid ${C.borderWeak}`, borderRadius: 8, background: C.bg }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          cursor: 'pointer',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12, color: C.faint }}>{open ? '▾' : '▸'}</span>
        <b style={{ fontSize: 13, color: C.accent }}>{scene.filename}</b>
        <span
          style={{
            flex: 1,
            minWidth: 120,
            fontSize: 12,
            color: C.sub,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {open ? '' : firstLine}
        </span>
        <Text theme="label" style={{ fontSize: 11 }}>
          {plain.length} 字
        </Text>
        {scene.updatedAtMs ? <Text theme="label" style={{ fontSize: 11 }}>{fmtWhen(scene.updatedAtMs)}</Text> : null}
      </div>
      {open && (
        <div
          style={{
            padding: '4px 14px 12px',
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 420,
            overflowY: 'auto',
            borderTop: `1px solid ${C.borderWeak}`,
          }}
        >
          {highlight(scene.content, q)}
        </div>
      )}
    </div>
  );
}
