/**
 * MemoryHierarchyView — 「我的记忆」的层级可视化视图。
 *
 * 把 L0 源会话 → L1 原子记忆 → L2 场景块 → L3 画像 的整体蒸馏结构一目了然：
 *   ① 蒸馏管线概览（指标卡 + 漏斗，看清逐级收敛比）
 *   ② 衍生知识（L3 画像 + L2 场景块，点场景高亮关联原子）
 *   ③ 层级树（L0 源会话 → L1 原子记忆，按会话分组，可搜索/折叠）
 *   ④ 分布统计（类型分布 + 优先级分布）
 *
 * 数据由父组件 MyMemoryPage 经 personal-space 客户端（panel 同源代理）加载后传入，
 * 因此无跨域问题，始终为实时数据（刷新即走 loadAll）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'tea-component';
import type {
  PersonalMemory,
  SourceSessionRecord,
  PersonalScene,
  PersonalPersonaResponse,
} from '@/lib/api/personal-space';

const TYPE_COLORS: Record<string, string> = {
  fact: '#185FA5',
  instruction: '#0F6E56',
  preference: '#534AB7',
  constraint: '#854F0B',
  event: '#A32D2D',
  persona: '#712B13',
  episodic: '#3B6D11',
};
const TYPE_LABEL: Record<string, string> = {
  fact: '事实',
  instruction: '指令',
  preference: '偏好',
  constraint: '约束',
  event: '事件',
  persona: '画像',
  episodic: '片段',
};
const TYPE_ORDER = ['fact', 'instruction', 'preference', 'constraint', 'event', 'persona', 'episodic'];
const LAYER = { l0: '#5f5e5a', l1: '#185FA5', l2: '#854F0B', l3: '#0F6E56' };

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

function fmtWhen(ms?: number | string): string {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const esc = (s?: string | null) =>
  (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

interface SessionRow {
  sid: string;
  title: string;
  status: string;
  l0: number;
  l1: number;
  l2: number;
  l3: number;
  missing: boolean;
}

interface Props {
  sourceSessions: SourceSessionRecord[];
  memories: PersonalMemory[];
  scenes: PersonalScene[];
  persona: PersonalPersonaResponse | null;
  titleBySid: Map<string, string>;
}

function Badge({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ fontSize: 11, color: C.sub, background: C.borderWeak, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {label} <b style={{ color: C.text }}>{value}</b>
    </span>
  );
}

function Atom({ mem, dim, expanded, onToggle }: { mem: PersonalMemory; dim: boolean; expanded: boolean; onToggle: () => void }) {
  const col = TYPE_COLORS[mem.type] || '#888';
  const long = (mem.content || '').length > 90;
  const contentStyle: React.CSSProperties = {
    fontSize: 13,
    marginTop: 7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
  if (long && !expanded) {
    contentStyle.display = '-webkit-box';
    contentStyle.WebkitLineClamp = 3;
    contentStyle.WebkitBoxOrient = 'vertical';
    contentStyle.overflow = 'hidden';
  }
  return (
    <div
      style={{
        border: `1px solid ${C.borderWeak}`,
        borderRadius: 10,
        padding: '10px 12px',
        background: C.bg,
        opacity: dim ? 0.28 : 1,
        transition: 'opacity .15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 12,
            fontWeight: 500,
            color: col,
            border: `1px solid ${col}`,
            padding: '1px 8px',
            borderRadius: 20,
          }}
        >
          {TYPE_LABEL[mem.type] || mem.type}
        </span>
        {typeof mem.priority === 'number' && <span style={{ fontSize: 11, color: C.faint }}>P{mem.priority}</span>}
        {mem.scene_name && <span style={{ fontSize: 11, color: LAYER.l2 }}>#{mem.scene_name}</span>}
      </div>
      <div style={contentStyle}>{mem.content}</div>
      {long && (
        <span onClick={onToggle} style={{ fontSize: 12, color: C.accent, cursor: 'pointer', marginTop: 4, display: 'inline-block' }}>
          {expanded ? '收起 ▴' : '展开全文 ▾'}
        </span>
      )}
    </div>
  );
}

export function MemoryHierarchyView({ sourceSessions, memories, scenes, persona, titleBySid }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [activeScene, setActiveScene] = useState<string | null>(null);
  const [expandedAtoms, setExpandedAtoms] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ title: string; body: string } | null>(null);

  const memBySid = useMemo(() => {
    const m = new Map<string, PersonalMemory[]>();
    for (const mem of memories) {
      const key = mem.sessionId || mem.sessionKey || 'unknown';
      const arr = m.get(key);
      if (arr) arr.push(mem);
      else m.set(key, [mem]);
    }
    return m;
  }, [memories]);

  const sessions = useMemo<SessionRow[]>(
    () =>
      (sourceSessions || []).map((s) => {
        const sid = s.session_id || '';
        const title = titleBySid.get(sid) || (sid ? sid : t('myMemory.sourceSessionNoId', { defaultValue: '(无会话ID的整文件源)' }));
        return {
          sid,
          title,
          status: s.status,
          l0: s.l0_count || 0,
          l1: memBySid.get(sid)?.length ?? 0,
          l2: s.l2_count || 0,
          l3: s.l3_count || 0,
          missing: !!s.source_missing,
        };
      }),
    [sourceSessions, memBySid, titleBySid, t],
  );

  const totalL0 = sessions.reduce((a, b) => a + b.l0, 0);
  const l1Count = memories.length;
  const l2Count = scenes.length;
  const l3Count = persona?.persona ? 1 : 0;

  const sortedSessions = useMemo(
    () => sessions.slice().sort((a, b) => (memBySid.get(b.sid)?.length ?? 0) - (memBySid.get(a.sid)?.length ?? 0)),
    [sessions, memBySid],
  );

  const query = q.trim().toLowerCase();

  const typeDist = useMemo(() => {
    const tc: Record<string, number> = {};
    for (const m of memories) tc[m.type] = (tc[m.type] || 0) + 1;
    return TYPE_ORDER.filter((tp) => tc[tp]).map((tp) => ({ type: tp, n: tc[tp] }));
  }, [memories]);
  const typeMax = Math.max(1, ...typeDist.map((x) => x.n));

  const prioDist = useMemo(() => {
    const b: Record<string, number> = {};
    for (const m of memories) {
      if (typeof m.priority === 'number') {
        const k = `P${m.priority}`;
        b[k] = (b[k] || 0) + 1;
      }
    }
    const keys = Object.keys(b).sort((a, c) => Number(a.slice(1)) - Number(c.slice(1)));
    return keys.map((k) => ({ k, n: b[k] }));
  }, [memories]);
  const prioMax = Math.max(1, ...prioDist.map((x) => x.n));

  const toggleCollapse = (i: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const onSceneClick = (sc: PersonalScene) => {
    setActiveScene((prev) => (prev === sc.filename ? null : sc.filename));
    setModal({ title: `L2 场景块 · ${sc.filename}`, body: sc.content || '(空)' });
  };

  const cardStyle: React.CSSProperties = {
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: '14px 16px',
    position: 'relative',
    overflow: 'hidden',
  };
  const miniBtn: React.CSSProperties = {
    border: `1px solid ${C.border}`,
    background: C.bg,
    color: C.text,
    padding: '6px 12px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 13,
  };

  return (
    <div style={{ color: C.text }}>
      {/* ① 蒸馏管线概览 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>① {t('myMemory.hv.overview', { defaultValue: '蒸馏管线概览' })}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.hv.overviewHint', { defaultValue: '每层沉淀量与逐级收敛比' })}
          </Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {[
            { c: LAYER.l0, label: 'L0 源会话', num: sessions.length, meta: `${totalL0} 条原始消息` },
            { c: LAYER.l1, label: 'L1 原子记忆', num: l1Count, meta: '7 类 · 按会话分组' },
            { c: LAYER.l2, label: 'L2 场景块', num: l2Count, meta: '叙事化知识' },
            { c: LAYER.l3, label: 'L3 画像', num: l3Count, meta: persona?.persona ? 'persona.md' : '尚未生成' },
          ].map((x) => (
            <div key={x.label} style={{ ...cardStyle, borderLeft: `4px solid ${x.c}` }}>
              <div style={{ fontSize: 12.5, color: C.sub }}>{x.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1, color: x.c }}>{x.num}</div>
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>{x.meta}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, marginTop: 14, flexWrap: 'wrap' }}>
          {[
            { l: 'L0 源会话', n: `${totalL0} 消息`, d: `${sessions.length} 个会话`, c: LAYER.l0 },
            { l: 'L1 原子记忆', n: `${l1Count} 条`, d: '提炼自对话', c: LAYER.l1 },
            { l: 'L2 场景块', n: `${l2Count} 块`, d: '场景化归纳', c: LAYER.l2 },
            { l: 'L3 画像', n: `${l3Count} 份`, d: '长期画像', c: LAYER.l3 },
          ].map((s, i) => (
            <div key={s.l} style={{ display: 'flex', alignItems: 'stretch' }}>
              <div
                style={{
                  flex: '1 1 150px',
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  borderLeft: `4px solid ${s.c}`,
                }}
              >
                <div style={{ fontSize: 12, color: C.sub }}>{s.l}</div>
                <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2, color: s.c }}>{s.n}</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>{s.d}</div>
              </div>
              {i < 3 && <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px', color: C.faint, fontSize: 18 }}>→</div>}
            </div>
          ))}
        </div>
      </div>

      {/* ② 衍生知识 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>② {t('myMemory.hv.derived', { defaultValue: '衍生知识' })}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.hv.derivedHint', { defaultValue: 'L2 场景块 + L3 画像（点击场景可高亮相关原子）' })}
          </Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: 12, alignItems: 'start' }}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setModal({ title: 'L3 画像 · persona.md', body: persona?.persona || '(尚未生成)' })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setModal({ title: 'L3 画像 · persona.md', body: persona?.persona || '(尚未生成)' });
            }}
            style={{ background: 'linear-gradient(0deg,#fff,#f6fbf9)', border: `1px solid ${LAYER.l3}`, borderRadius: 12, padding: 14, cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 600, color: LAYER.l3, fontSize: 13.5 }}>L3 画像 · persona.md</div>
            <div style={{ fontSize: 12.5, color: C.sub, marginTop: 8, maxHeight: 120, overflow: 'hidden' }}>
              {persona?.persona ? `${persona.persona.slice(0, 180)}…` : t('myMemory.emptyL3', { defaultValue: '尚未生成画像' })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {scenes.length === 0 ? (
              <Text theme="label" style={{ fontSize: 12, gridColumn: '1 / -1' }}>
                {t('myMemory.emptyL2', { defaultValue: '暂无场景块' })}
              </Text>
            ) : (
              scenes.map((sc) => (
                <div
                  key={sc.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSceneClick(sc)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSceneClick(sc);
                  }}
                  style={{
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 10,
                    padding: '11px 13px',
                    cursor: 'pointer',
                    outline: activeScene === sc.filename ? `2px solid ${LAYER.l2}` : 'none',
                  }}
                >
                  <div style={{ fontWeight: 600, color: LAYER.l2, fontSize: 13, wordBreak: 'break-all' }}>{sc.filename}</div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>
                    {(sc.content || '').length} 字 · {fmtWhen(sc.updatedAtMs)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ③ 层级树 */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>③ {t('myMemory.hv.tree', { defaultValue: '层级树' })}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.hv.treeHint', { defaultValue: 'L0 源会话 → L1 原子记忆，按会话分组' })}
          </Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('myMemory.hv.search', { defaultValue: '搜索记忆内容 / 类型 / 场景…' })}
            style={{ flex: '1 1 200px', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, background: C.bg, color: C.text }}
          />
          <button onClick={() => setCollapsed(new Set())} style={miniBtn}>
            {t('myMemory.hv.expandAll', { defaultValue: '全部展开' })}
          </button>
          <button onClick={() => setCollapsed(new Set(sortedSessions.map((_, i) => i)))} style={miniBtn}>
            {t('myMemory.hv.collapseAll', { defaultValue: '全部折叠' })}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sortedSessions.length === 0 ? (
            <Text theme="label" style={{ fontSize: 12 }}>
              {t('myMemory.empty', { defaultValue: '暂无记忆' })}
            </Text>
          ) : (
            sortedSessions.map((s, si) => {
              const mems = memBySid.get(s.sid) || [];
              const visible = mems.filter(
                (m) =>
                  !query ||
                  (m.content || '').toLowerCase().includes(query) ||
                  (m.type || '').includes(query) ||
                  (m.scene_name || '').toLowerCase().includes(query),
              );
              if (query && visible.length === 0 && !(s.title || '').toLowerCase().includes(query)) return null;
              const isCollapsed = collapsed.has(si);
              const typeCount: Record<string, number> = {};
              mems.forEach((m) => {
                typeCount[m.type] = (typeCount[m.type] || 0) + 1;
              });
              return (
                <div key={s.sid || `s${si}`} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleCollapse(si)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') toggleCollapse(si);
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', background: isCollapsed ? C.bg : C.bgLayout }}
                  >
                    <span style={{ fontSize: 12, color: C.faint }}>{isCollapsed ? '▸' : '▾'}</span>
                    <span
                      title={s.title}
                      style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {s.title}
                    </span>
                    <span style={{ fontSize: 11, color: C.faint, fontFamily: 'ui-monospace, monospace' }}>{esc(s.sid.slice(0, 18)) || '无ID'}</span>
                    <Badge label="L0" value={s.l0} />
                    <Badge label="L1" value={mems.length} />
                    <Badge label="L2" value={s.l2} />
                    <Badge label="L3" value={s.l3} />
                    <span style={{ fontSize: 11, color: C.sub, background: C.borderWeak, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                      {s.status}
                      {s.missing ? ' · 源缺失' : ''}
                    </span>
                  </div>
                  {!isCollapsed && (
                    <>
                      <div style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                        {visible.length === 0 ? (
                          <div style={{ color: C.faint, fontSize: 12 }}>{t('myMemory.hv.noAtoms', { defaultValue: '该会话暂无 L1 原子记忆' })}</div>
                        ) : (
                          visible.map((m) => (
                            <Atom
                              key={m.id}
                              mem={m}
                              dim={activeScene != null && m.scene_name !== activeScene}
                              expanded={expandedAtoms.has(m.id)}
                              onToggle={() =>
                                setExpandedAtoms((prev) => {
                                  const n = new Set(prev);
                                  if (n.has(m.id)) n.delete(m.id);
                                  else n.add(m.id);
                                  return n;
                                })
                              }
                            />
                          ))
                        )}
                      </div>
                      {Object.keys(typeCount).length > 0 && (
                        <div style={{ padding: '0 14px 10px', display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                          {Object.entries(typeCount).map(([tp, n]) => (
                            <span key={tp} style={{ fontSize: 11, color: C.sub, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_COLORS[tp] || '#888', display: 'inline-block' }} />
                              {TYPE_LABEL[tp] || tp} {n}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ④ 分布统计 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <b style={{ fontSize: 14 }}>④ {t('myMemory.hv.stats', { defaultValue: '分布统计' })}</b>
          <Text theme="label" style={{ fontSize: 12 }}>
            {t('myMemory.hv.statsHint', { defaultValue: '记忆类型与优先级' })}
          </Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>{t('myMemory.hv.typeDist', { defaultValue: '类型分布' })}</div>
            {typeDist.length === 0 ? (
              <Text theme="label" style={{ fontSize: 12 }}>
                —
              </Text>
            ) : (
              typeDist.map((x) => (
                <div key={x.type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, fontSize: 12.5 }}>
                  <span style={{ width: 78, color: C.sub, flex: 'none' }}>{TYPE_LABEL[x.type] || x.type}</span>
                  <span style={{ flex: 1, height: 14, background: C.borderWeak, borderRadius: 7, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${(x.n / typeMax) * 100}%`, background: TYPE_COLORS[x.type] || '#888', borderRadius: 7 }} />
                  </span>
                  <span style={{ width: 30, textAlign: 'right', color: C.text, flex: 'none' }}>{x.n}</span>
                </div>
              ))
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, fontSize: 12, color: C.sub }}>
              {typeDist.map((x) => (
                <span key={x.type} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: TYPE_COLORS[x.type] || '#888', display: 'inline-block' }} />
                  {TYPE_LABEL[x.type] || x.type}
                </span>
              ))}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>{t('myMemory.hv.prioDist', { defaultValue: '优先级分布（P55–P85）' })}</div>
            {prioDist.length === 0 ? (
              <Text theme="label" style={{ fontSize: 12 }}>
                无优先级数据
              </Text>
            ) : (
              prioDist.map((x) => (
                <div key={x.k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, fontSize: 12.5 }}>
                  <span style={{ width: 78, color: C.sub, flex: 'none' }}>{x.k}</span>
                  <span style={{ flex: 1, height: 14, background: C.borderWeak, borderRadius: 7, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${(x.n / prioMax) * 100}%`, background: C.gold, borderRadius: 7 }} />
                  </span>
                  <span style={{ width: 30, textAlign: 'right', color: C.text, flex: 'none' }}>{x.n}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* modal */}
      {modal && (
        <div
          onClick={() => setModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,41,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.bg, borderRadius: 14, maxWidth: 760, width: '100%', maxHeight: '82vh', overflow: 'auto', padding: '20px 22px' }}
          >
            <span onClick={() => setModal(null)} style={{ float: 'right', cursor: 'pointer', color: C.sub, fontSize: 13 }}>
              关闭 ✕
            </span>
            <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.accent }}>{modal.title}</h3>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.75, margin: 0 }}>{modal.body}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
