/**
 * MyMemoryPage — 我的记忆（对话记忆的 L1 / L2 / L3 分层提炼视图）。
 *
 * 2026-10-15 收敛：原本「分层提炼」车道（observations/candidates/axioms）由
 * agents/layered-refine 自研引擎（codebuddy CLI）驱动，与对话记忆的提炼
 * 是平行双实现。现统一复用对话记忆的提炼管线：
 *   - L1 观测：/api/v1/personal/memories（对话记忆 L1 原子记忆）
 *   - L2 场景：/api/v1/personal/scenes（对话记忆 SceneExtractor 场景块）
 *   - L3 画像：/api/v1/personal/persona（对话记忆 PersonaGenerator persona.md）
 *   - 触发：POST /api/v1/personal/extract?layers=L1,L2,L3（经 panel proxy）
 * 全部数据走 personal-space 客户端（与网关 personal 端点对接），agents/layered-refine
 * 引擎已不再是数据源。
 *
 * 结构：
 *   ① 管道状态条：三层卡片（计数 + 状态灯），点击即切到该层；
 *   ② 源会话选择器：勾选要提炼的本地对话，跑流程的输入端；
 *   ③ 三层子 Tab：L1 观测 / L2 场景 / L3 画像；
 *   ④ 已沉淀记忆：按来源会话分组的 L1 记忆浏览；
 *   ⑤ 最近运行：源会话提炼状态与产出计数。
 *
 * 数据来源：/api/v1/personal-space/*（经网关 proxy 到对话记忆管线）。
 * 支持 ?session= 预筛选（来自会话洞察「看沉淀」跳转）。
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
const TYPE_ORDER = ['persona', 'instruction', 'episodic', 'fact', 'preference', 'constraint', 'event'] as const;

type TabKey = 'L1' | 'L2' | 'L3' | 'saved' | 'hierarchy';

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

const STATUS_TONE: Record<string, string> = {
  never: '#9ca3af',
  running: '#854F0B',
  done: '#0F6E56',
  failed: '#A32D2D',
  partial: '#854F0B',
};

export function MyMemoryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [tab, setTab] = useState<TabKey>('L1');

  // ── 管道数据（全部来自对话记忆 personal 管线）──
  const [sourceSessions, setSourceSessions] = useState<SourceSessionRecord[]>([]);
  const [memories, setMemories] = useState<PersonalMemory[]>([]);
  const [scenes, setScenes] = useState<PersonalScene[]>([]);
  const [persona, setPersona] = useState<PersonalPersonaResponse | null>(null);

  // ── 源会话选择器 ──
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showSources, setShowSources] = useState(true);
  const [srcSearch, setSrcSearch] = useState('');

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

  // 从洞察跳转过来（?session=）时，默认落在已沉淀记忆并按会话筛选
  useEffect(() => {
    if (filterSession) setTab('saved');
  }, [filterSession]);

  const [q, setQ] = useState('');

  const togglePick = (sid: string) => {
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
      const ids = [...picked];
      const targets = ids.length ? ids : (sourceSessions.map((s) => s.session_id).filter(Boolean) as string[]);
      if (targets.length === 0) {
        setToast(t('myMemory.run.noTarget'));
        return;
      }
      let totalL1 = 0;
      let totalL2 = 0;
      let totalL3 = 0;
      for (const sessionId of targets) {
        const r = await triggerPersonalExtract({
          sessionId,
          layers: ['L1', 'L2', 'L3'],
        });
        totalL1 += r.l1Count ?? 0;
        totalL2 += r.l2Count ?? 0;
        totalL3 += r.l3Count ?? 0;
      }
      setToast(
        t('myMemory.run.done', {
          l1: totalL1,
          l2: totalL2,
          l3: totalL3,
        }),
      );
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const visibleMemories = useMemo(() => {
    const list = filterSession
      ? memories.filter((x) => (x.sessionId || x.sessionKey) === filterSession)
      : memories;
    return q ? list.filter((m) => (m.content || '').includes(q) || (m.type || '').includes(q)) : list;
  }, [memories, filterSession, q]);

  const visibleSources = useMemo(
    () =>
      sourceSessions.filter((s) => {
        if (!srcSearch) return true;
        const title = titleBySid.get(s.session_id) || '';
        return (
          title.includes(srcSearch) ||
          s.session_id.includes(srcSearch) ||
          (s.source_key || '').includes(srcSearch)
        );
      }),
    [sourceSessions, srcSearch, titleBySid],
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

  const groups = useMemo(() => {
    const m = new Map<string, PersonalMemory[]>();
    for (const mem of memories) {
      const key = mem.sessionId || mem.sessionKey || 'unknown';
      const arr = m.get(key);
      if (arr) arr.push(mem);
      else m.set(key, [mem]);
    }
    return m;
  }, [memories]);

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
  const stages: { key: TabKey; label: string; count: number; desc: string; dot: string }[] = [
    { key: 'L1', label: t('myMemory.stage.l1'), count: counts.l1, desc: t('myMemory.stage.l1.desc'), dot: '#185FA5' },
    { key: 'L2', label: t('myMemory.stage.l2'), count: counts.l2, desc: t('myMemory.stage.l2.desc'), dot: '#854F0B' },
    { key: 'L3', label: t('myMemory.stage.l3'), count: counts.l3, desc: t('myMemory.stage.l3.desc'), dot: '#0F6E56' },
  ];

  return (
    <div style={{ padding: 16, color: C.text }}>
      {/* 页首 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('myMemory.title')}</h3>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void loadAll()} disabled={busy}>
          {t('common.refresh', { defaultValue: '刷新' })}
        </Button>
      </div>

      {/* ① 管道状态条 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>{t('myMemory.pipeline.title')}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.pipeline.hint')}
          </Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap' }}>
          {stages.map((s, i) => {
            const active = tab === s.key;
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 220px' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setTab(s.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setTab(s.key);
                  }}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    background: active ? C.accentSoft : C.bg,
                    border: `1px solid ${active ? C.accent : C.border}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: s.dot }} />
                    <b style={{ fontSize: 13, color: active ? C.accent : C.text }}>{s.label}</b>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 18, fontWeight: 600, color: active ? C.accent : C.sub }}>{s.count}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, lineHeight: 1.5 }}>{s.desc}</div>
                </div>
                {i < stages.length - 1 && <span style={{ color: C.faint, fontSize: 14, flex: '0 0 auto' }}>→</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ② 源会话选择器 */}
      <Box style={{ marginBottom: 14, background: C.bgLayout }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13 }}>{t('myMemory.sources.title')}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.sources.hint')}
          </Text>
          <span style={{ flex: 1 }} />
          <Tag variant="soft" style={{ color: C.accent, borderColor: C.accent }}>
            {t('myMemory.sources.count', { n: picked.size })}
          </Tag>
          <Button onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
            {t('myMemory.sources.clear')}
          </Button>
          <Button onClick={() => setShowSources((v) => !v)}>{showSources ? '收起' : '展开'}</Button>
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
                      <input type="checkbox" checked={on} onChange={() => togglePick(s.session_id)} style={{ marginTop: 3 }} />
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

      {/* 运行按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <Button type="primary" onClick={() => void onExtract()} disabled={busy}>
          {t('myMemory.run.full')}
        </Button>
        <span style={{ flex: 1 }} />
        <Text theme="label" style={{ fontSize: 12 }}>
          {picked.size > 0
            ? t('myMemory.run.selectedHint', { n: picked.size })
            : t('myMemory.run.autoHint')}
        </Text>
      </div>

      {/* ③ 三层子 Tab */}
      <div style={{ display: 'flex', gap: 6, borderBottom: `1px solid ${C.border}`, marginBottom: 12 }}>
        {(['L1', 'L2', 'L3', 'saved', 'hierarchy'] as TabKey[]).map((k) => {
          const active = tab === k;
          const label =
            k === 'L1' ? t('myMemory.tab.l1') : k === 'L2' ? t('myMemory.tab.l2') : k === 'L3' ? t('myMemory.tab.l3') : k === 'saved' ? t('myMemory.tab.saved') : t('myMemory.tab.hierarchy', { defaultValue: '层级视图' });
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? C.accent : C.sub,
                borderBottom: `2px solid ${active ? C.accent : 'transparent'}`,
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ── L1 观测（对话记忆 L1 原子记忆）── */}
      {tab === 'L1' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('layered.search')}
              style={{ flex: '1 1 200px', padding: '5px 9px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, background: C.bg, color: C.text }}
            />
            <Text theme="label" style={{ fontSize: 12 }}>
              {t('myMemory.count', { n: visibleMemories.length })}
            </Text>
          </div>
          {visibleMemories.length === 0 ? (
            <Card>
              <StatusTip status="empty" emptyText={t('myMemory.empty')} />
              <div style={{ marginTop: 10 }}>
                <Text theme="label" style={{ fontSize: 12 }}>
                  {t('myMemory.emptyHint')}
                </Text>
              </div>
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {visibleMemories.map((mem) => (
                <Box key={mem.id} style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
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
                    {mem.createdAt && <Text theme="label" style={{ fontSize: 11.5 }}>{fmtWhen(mem.createdAt)}</Text>}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {mem.content}
                  </div>
                </Box>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── L2 场景（对话记忆 SceneExtractor 场景块）── */}
      {tab === 'L2' && (
        <div>
          {scenes.length === 0 ? (
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
              {scenes.map((sc) => (
                <Box key={sc.id} style={{ padding: '11px 13px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13, color: C.accent }}>{sc.filename}</b>
                    <span style={{ flex: 1 }} />
                    {sc.updatedAtMs ? <Text theme="label" style={{ fontSize: 11.5 }}>{fmtWhen(sc.updatedAtMs)}</Text> : null}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 420, overflowY: 'auto' }}>
                    {sc.content}
                  </div>
                </Box>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── L3 画像（对话记忆 PersonaGenerator persona.md）── */}
      {tab === 'L3' && (
        <div>
          {!persona?.persona ? (
            <Card>
              <StatusTip status="empty" emptyText={t('myMemory.emptyL3')} />
              <div style={{ marginTop: 10 }}>
                <Text theme="label" style={{ fontSize: 12 }}>
                  {t('myMemory.emptyL3Hint')}
                </Text>
              </div>
            </Card>
          ) : (
            <Box style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <b style={{ fontSize: 13.5, color: C.accent }}>persona.md</b>
                <span style={{ flex: 1 }} />
                {persona.updatedAtMs ? <Text theme="label" style={{ fontSize: 11.5 }}>{fmtWhen(persona.updatedAtMs)}</Text> : null}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {persona.persona}
              </div>
            </Box>
          )}
        </div>
      )}

      {/* ── 已沉淀记忆（按来源会话分组）── */}
      {tab === 'saved' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            {filterSession && (
              <>
                <Tag variant="soft" style={{ color: C.accent, borderColor: C.accent }}>
                  {t('myMemory.filteredBy', { s: shortId(filterSession) })}
                </Tag>
                <Button
                  onClick={() => {
                    setSearchParams({});
                  }}
                >
                  {t('myMemory.clearFilter')}
                </Button>
              </>
            )}
            <span style={{ flex: 1 }} />
            <Text theme="label" style={{ fontSize: 12 }}>
              {t('myMemory.count', { n: memories.length })}
            </Text>
          </div>

          <div
            style={{
              border: `1px solid ${C.borderWeak}`,
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 14,
              background: C.bgLayout,
            }}
          >
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>{t('myMemory.intro')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
              <span style={{ fontSize: 12, color: C.sub }}>{t('myMemory.legendTypes')}：</span>
              {TYPE_ORDER.map((tp) => (
                <span
                  key={tp}
                  title={t(`myMemory.typeDesc.${tp}`)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'help' }}
                >
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: TYPE_COLORS[tp] }} />
                  {t(`myMemory.type.${tp}`)}
                </span>
              ))}
              <span title={t('myMemory.priorityHint')} style={{ fontSize: 12, color: C.sub, cursor: 'help' }}>
                {t('myMemory.priorityShort')}
              </span>
              <span style={{ flex: 1 }} />
              <Button onClick={() => navigate('/insights')}>{t('myMemory.openInsights')}</Button>
            </div>
          </div>

          {groups.size === 0 ? (
            <Card>
              <StatusTip status="empty" emptyText={t('myMemory.empty')} />
              <div style={{ marginTop: 12 }}>
                <Text theme="label" style={{ fontSize: 12 }}>
                  {t('myMemory.emptyHint')}
                </Text>
              </div>
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[...groups.entries()].map(([sid, mems]) => (
                <Card key={sid}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <b title={sid} style={{ fontSize: 13, wordBreak: 'break-all' }}>
                      {t('myMemory.groupFrom', { s: sessionLabel(sid) })}
                    </b>
                    <span style={{ flex: 1 }} />
                    <Button onClick={() => navigate(`/insights?session=${encodeURIComponent(sid)}`)}>
                      {t('myMemory.viewSource')}
                    </Button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {mems.map((mem) => (
                      <div
                        key={mem.id}
                        style={{
                          border: `1px solid ${C.borderWeak}`,
                          borderRadius: 8,
                          padding: '8px 10px',
                          background: C.bg,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
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
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {mem.content}
                        </div>
                        {mem.createdAt && (
                          <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>
                            {t('myMemory.createdAt')}：{fmtWhen(mem.createdAt)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 层级视图（L0→L1→L2→L3 整体蒸馏结构可视化）── */}
      {tab === 'hierarchy' && (
        <MemoryHierarchyView
          sourceSessions={sourceSessions}
          memories={memories}
          scenes={scenes}
          persona={persona}
          titleBySid={titleBySid}
        />
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
