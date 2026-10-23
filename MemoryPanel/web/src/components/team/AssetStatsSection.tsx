/**
 * AssetStatsSection — 「Agent 资产库」资产统计（v2，对齐 mem0 Dashboard）。
 *
 * v2 相对 v1 的升级（详见 docs/asset-stats-v2-design.html）：
 *   - 指标卡改为 mem0 风格 4 张：资产存量 / 资产召回 / 最深召回 / 对话记忆
 *   - 资产召回 = Σ team Asset.usage_count（个人侧无 usage_count 字段，P2 埋点补充）
 *   - 最深召回 = 全量资产「最近使用 − 创建」最大库龄（last_used_at / updated_at 兜底）
 *   - 对话记忆分层钻取（L0–L3）：L0=本地会话数、L1=原子记忆、L2=场景块、L3=人格画像
 *   - 资产构成：mem0 百分比横条（替代 v1 明细表，明细改为折叠展开）
 *   - 活跃贡献者 / Agent 面板（mem0 Entities 的本系统对应物）
 *   - 每张卡 ⓘ 口径说明 + Header「更新于 N 分钟前」+ 各面板独立空态
 *
 * 数据源（全部复用既有 list 接口，前端聚合，后端零改动）：
 *   knowledgeApi.wiki.teamAssets / assetsApi.listAccessible(team skill) /
 *   chatMemoryApi.teamAssets / personalListSkills / fetchPersonalMemories /
 *   fetchPersonalScenes / fetchPersonalSourceSessions / fetchPersonalPersona /
 *   fetchSessions（L0 分母）
 *
 * P1（analytics：上下文节省 / 检索调用趋势 / 渗透率）依赖 space 级 + ClickHouse，
 * 本地部署未配置，本期不实装，避免展示坏数据；后续接入见设计文档分期。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshIcon } from 'tea-icons-react';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { assetsApi } from '@/lib/api/assets';
import { readAuth } from '@/components/LoginGate';
import { chatMemoryApi } from '@/lib/api/chat-memory';
import { personalListSkills } from '@/lib/api/skill-api';
import {
  fetchPersonalMemories,
  fetchPersonalScenes,
  fetchPersonalSourceSessions,
  fetchPersonalPersona,
  fetchSessions,
} from '@/lib/api/personal-space';
import MemberAssetMatrix, { type MatrixRow } from './MemberAssetMatrix';
import './asset-stats-section.css';

// =================== Types ===================

export type AssetStatsRange = 'all' | '24h' | '7d' | '30d' | '90d';

const RANGE_ORDER: AssetStatsRange[] = ['all', '24h', '7d', '30d', '90d'];

interface DatedItem {
  ts: number;
}

interface AgeItem {
  name: string;
  createdMs?: number;
  usedMs?: number;
}

interface LayerCounts {
  L0: number;
  L1: number;
  L2: number;
  L3: number;
}

interface Contributor {
  key: string;
  label: string;
  count: number;
}

/**
 * 统计口径：
 *   - all  团队资产 + 我的（并集：我的部分只取"仅我可见"，已共享的已在团队池里，不重复计）
 *   - team 只看团队池（团队内 visibility=team）
 *   - mine 只看我的（团队内 owner=我 的资产，含"已共享"与"仅我可见"两部分
 *          + 个人空间记忆/技能库）
 *
 * 注意口径与三张资产页一致：mine 里的「团队内」部分是 team_id=当前团队
 * 且 owner=我 的资产；「个人空间」是 team_id='personal' 的另一份数据，两者并列计入。
 * 「我的」与「团队」两档存在交集（我共享出去的资产同时属于两档），这与
 * GitHub 的 All / Mine 视图一致；卡片上的「共享中 / 仅我可见」切换器即状态标识。
 */
export type AssetStatsScope = 'all' | 'team' | 'mine';

interface Deepest {
  days: number | null;
  name: string | null;
}

interface AssetStatsData {
  teamWikiCount: number;
  teamWikiPages: number;
  teamWikiItems: DatedItem[];
  teamSkillItems: DatedItem[];
  teamSkillUsage: number;
  teamMemoryItems: DatedItem[];
  teamMemoryLayer: LayerCounts;
  personalSkillItems: DatedItem[];
  personalMemoryItems: DatedItem[];
  personalSceneCount: number;
  /** 「我的」口径：团队空间内 owner=我（含已共享的 team + 仅我可见的 private） */
  myWikiCount: number;
  myWikiItems: DatedItem[];
  mySkillItems: DatedItem[];
  myMemoryItems: DatedItem[];
  myMemoryLayer: { L1: number; L2: number; L3: number };
  /**
   * 「我的」里**仅我可见**的那部分（visibility/scope='private'）。
   * 「我的」与「团队」两档有交集（我共享出去的资产两边都在），所以 all 口径
   * 只能用这部分做并集，否则同一条会被计两次。
   */
  myPrivateWikiCount: number;
  myPrivateWikiItems: DatedItem[];
  myPrivateSkillItems: DatedItem[];
  myPrivateMemoryItems: DatedItem[];
  /** 对话记忆分层（L0–L3） */
  layer: LayerCounts;
  /** 各口径的最深召回（最大库龄） */
  deepest: { all: Deepest; team: Deepest; mine: Deepest };
  /** 最深召回（全量资产最大库龄） */
  deepestAgeDays: number | null;
  deepestName: string | null;
  /** 资产召回累计（团队侧 usage_count 之和） */
  recallTotal: number;
  /** 活跃贡献者 Top */
  contributors: Contributor[];
  /** 成员 × 资产矩阵（P0 精简版：L1 / Skill / Wiki） */
  memberRows: MatrixRow[];
  partialError: boolean;
}

interface Bucket {
  startMs: number;
  endMs: number;
  wiki: number;
  skill: number;
  memory: number;
}

// =================== Helpers ===================

function toMs(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return Number.NaN;
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : Number.NaN;
}

function rangeStartMs(range: AssetStatsRange, now: number): number {
  const hour = 3600_000;
  const day = 24 * hour;
  switch (range) {
    case '24h': return now - day;
    case '7d': return now - 7 * day;
    case '30d': return now - 30 * day;
    case '90d': return now - 90 * day;
    default: return 0;
  }
}

/** 一组资产里库龄最大的一条（最近使用 − 创建），用于「最深召回」卡。 */
function computeDeepest(items: AgeItem[]): Deepest {
  let days: number | null = null;
  let name: string | null = null;
  for (const it of items) {
    if (
      it.createdMs !== undefined &&
      it.usedMs !== undefined &&
      Number.isFinite(it.createdMs) &&
      Number.isFinite(it.usedMs)
    ) {
      const d = Math.floor((it.usedMs - it.createdMs) / 86_400_000);
      if (d >= 0 && (days === null || d > days)) {
        days = d;
        name = it.name;
      }
    }
  }
  return { days, name };
}

function buildBuckets(range: AssetStatsRange, now: number): Bucket[] {
  const hour = 3600_000;
  const day = 24 * hour;
  if (range === 'all') return [];
  if (range === '24h') {
    const start = now - day;
    const buckets: Bucket[] = [];
    for (let i = 0; i < 24; i++) {
      buckets.push({ startMs: start + i * hour, endMs: start + (i + 1) * hour, wiki: 0, skill: 0, memory: 0 });
    }
    return buckets;
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const lastDayStart = new Date(now); lastDayStart.setHours(0, 0, 0, 0);
  const firstStart = lastDayStart.getTime() - (days - 1) * day;
  const buckets: Bucket[] = [];
  for (let i = 0; i < days; i++) {
    buckets.push({ startMs: firstStart + i * day, endMs: firstStart + (i + 1) * day, wiki: 0, skill: 0, memory: 0 });
  }
  return buckets;
}

function fillBuckets(buckets: Bucket[], items: DatedItem[], key: 'wiki' | 'skill' | 'memory'): void {
  for (const it of items) {
    if (!Number.isFinite(it.ts)) continue;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (it.ts >= buckets[i].startMs) {
        if (it.ts < buckets[i].endMs) buckets[i][key] += 1;
        break;
      }
    }
  }
}

function fmtBucketLabel(ms: number, hourly: boolean): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  if (hourly) return `${p(d.getHours())}:00`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// =================== Member matrix (P0) ===================

/** team-7xulumcvyl 成员目录：user_id → 展示名/角色/Agent/头像字母。
 *  仅用于矩阵展示标注；若 user_id 不在表中，回落为原始 id，不影响统计正确性。 */
const MEMBER_DIR: Record<string, { name: string; role: string; agent: string; letter: string }> = {
  'usr-0rwbvul43m': { name: 'admin', role: '产品', agent: 'agt-rec-product', letter: 'A' },
  'usr-ar449snyl0': { name: 'PengShi', role: '工程', agent: 'agt-ar4478rrd5', letter: 'P' },
  'usr-ar6gbwfwon': { name: 'PengChengZhuo', role: '算法', agent: 'agt-ar6gyp3yv7', letter: 'P' },
  'usr-ar6zd4p8vv': { name: 'YaoYao', role: '质量', agent: 'agt-ar6z1agmqn', letter: 'Y' },
};

/** 共享 Wiki 识别：name 含「共享」或 knowledge_id 以 -shared 结尾（前端无 agent_id 字段，按 name 兜底）。 */
function isSharedWiki(w: { name?: string; wiki_id?: string }): boolean {
  return (w.name || '').includes('共享') || (w.wiki_id || '').endsWith('-shared');
}

function buildMemberRows(args: {
  memoryBlocks: any[];
  skills: any[];
  wikiItems: any[];
  l1ByBlock: Record<string, number>;
}): MatrixRow[] {
  const map = new Map<string, MatrixRow>();
  const getRow = (key: string): MatrixRow => {
    let r = map.get(key);
    if (!r) {
      r = { key, label: key, l1: 0, skill: 0, wikiLibs: 0, wikiPages: 0 };
      map.set(key, r);
    }
    return r;
  };
  const shared: MatrixRow = { key: 'shared', label: '团队共享', isShared: true, l1: 0, skill: 0, wikiLibs: 0, wikiPages: 0 };

  for (const b of args.memoryBlocks) {
    const uid = b.uploaded_by_user_id;
    if (!uid) continue;
    const r = getRow(uid);
    const dir = MEMBER_DIR[uid];
    r.label = dir?.name ?? uid;
    r.role = dir?.role;
    r.agentId = dir?.agent;
    r.letter = dir?.letter ?? uid.slice(0, 1).toUpperCase();
    r.l1 = args.l1ByBlock[b.id] ?? 0;
    r.updatedAtMs = Math.max(r.updatedAtMs ?? 0, b.updated_at_ms ?? 0);
  }
  for (const s of args.skills) {
    const uid = s.owner_user_id;
    if (!uid) continue;
    const r = getRow(uid);
    r.skill += 1;
    r.updatedAtMs = Math.max(r.updatedAtMs ?? 0, toMs(s.updated_at));
  }
  for (const w of args.wikiItems) {
    if (isSharedWiki(w)) {
      shared.wikiLibs += 1;
      shared.wikiPages += w.page_count ?? 0;
      shared.updatedAtMs = Math.max(shared.updatedAtMs ?? 0, toMs(w.updated_at));
    } else {
      const uid = w.owner_user_id;
      if (!uid) continue;
      const r = getRow(uid);
      r.wikiLibs += 1;
      r.wikiPages += w.page_count ?? 0;
      r.updatedAtMs = Math.max(r.updatedAtMs ?? 0, toMs(w.updated_at));
    }
  }

  const rows = [shared, ...Array.from(map.values()).sort((a, b) => b.l1 + b.skill + b.wikiLibs - (a.l1 + a.skill + a.wikiLibs))];
  return rows;
}

// =================== Data hook ===================

function useAssetStats(teamId: string | undefined) {
  const [data, setData] = useState<AssetStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);
  /** 当前登录用户 id，用于「我的」口径按 owner 收敛（list-accessible 不带
   *  visibility 时会返回"团队共享 + 我自己的 private"两部分，需再按 owner 筛）。 */
  const currentUserId = readAuth()?.user_id ?? '';

  useEffect(() => {
    let cancelled = false;
    const seq = reloadSeq;
    setLoading(true);

    const settled = async () => {
      const [
        wiki, teamSkills, teamMemory, pSkills, pMemories, pScenes,
        srcSessions, persona, sessions,
        myWiki, mySkills, myMemory,
      ] = await Promise.allSettled([
        teamId ? knowledgeApi.wiki.teamAssets(teamId) : Promise.resolve([] as any[]),
        teamId
          ? assetsApi.listAccessible(teamId, { asset_type: 'skill', action: 'read', visibility: 'team' })
          : Promise.resolve([] as any[]),
        teamId ? chatMemoryApi.teamAssets(teamId) : Promise.resolve({ items: [] as any[], total: 0 }),
        personalListSkills({ pagination: { limit: 500 } }),
        fetchPersonalMemories(),
        fetchPersonalScenes(),
        fetchPersonalSourceSessions(),
        fetchPersonalPersona(),
        fetchSessions(),
        // 「我的」口径补充拉取：owner=我 的团队资产（含已共享的 team + 仅我可见的 private）。
        //   不带 visibility → 返回"团队共享 + 我自己的 private"；他人 private 由内核
        //   SQL 层直接挡掉，响应体里根本不会出现。前端再按 owner_user_id 收敛即可。
        //   chat-memory/mine 本身就是 owner=我 的全量，无需再按 scope 过滤。
        teamId
          ? assetsApi.listAccessible(teamId, { asset_type: 'llm_wiki', action: 'read' })
          : Promise.resolve([] as any[]),
        teamId
          ? assetsApi.listAccessible(teamId, { asset_type: 'skill', action: 'read' })
          : Promise.resolve([] as any[]),
        teamId ? chatMemoryApi.mine(teamId) : Promise.resolve({ items: [] as any[], total: 0 }),
      ]);

      if (cancelled || seq !== reloadSeq) return;
      const failed = [wiki, teamSkills, teamMemory, pSkills, pMemories, pScenes, srcSessions, persona, sessions]
        .some((r) => r.status === 'rejected');

      const wikiItems: any[] = wiki.status === 'fulfilled' ? wiki.value : [];
      const skills: any[] = teamSkills.status === 'fulfilled' ? teamSkills.value : [];
      const memoryBlocks: any[] = teamMemory.status === 'fulfilled' ? teamMemory.value.items : [];
      // owner=我 收敛（currentUserId 缺失时不筛，退化为"全部可访问"，避免整档空白）
      const ownedByMe = (a: any) => !currentUserId || a.owner_user_id === currentUserId;
      const myWikiItems: any[] =
        myWiki.status === 'fulfilled' ? myWiki.value.filter(ownedByMe) : [];
      const mySkillItems: any[] =
        mySkills.status === 'fulfilled' ? mySkills.value.filter(ownedByMe) : [];
      const myMemoryBlocks: any[] =
        myMemory.status === 'fulfilled' ? (myMemory.value.items ?? []) : [];
      // 「我的」里仅我可见的部分：all 口径做并集用（避免与团队档重复计数）
      const myPrivateWiki = myWikiItems.filter((w: any) => w.visibility === 'private');
      const myPrivateSkills = mySkillItems.filter((s: any) => s.visibility === 'private');
      const myPrivateMemories = myMemoryBlocks.filter((m: any) => m.scope === 'private');
      const pSkillList: any[] = pSkills.status === 'fulfilled' ? pSkills.value.items : [];
      const pMemoryList: any[] = pMemories.status === 'fulfilled' ? pMemories.value.memories : [];
      const scenes: any[] = pScenes.status === 'fulfilled' ? pScenes.value.scenes : [];
      const personaResp: any = persona.status === 'fulfilled' ? persona.value : null;
      const localSessions: any[] = sessions.status === 'fulfilled' ? sessions.value.sessions : [];

      // ===== 对话记忆分层（L0–L3）=====
      const l1Personal = pMemoryList.length;
      const l2Personal = scenes.length;
      const l3Personal = personaResp?.persona ? 1 : 0;
      let l1Team = 0; let l2Team = 0; let l3Team = 0;
      for (const b of memoryBlocks) {
        const lc = b.layer_counts ?? {};
        l1Team += lc.L1 ?? 0;
        l2Team += lc.L2 ?? 0;
        l3Team += lc.L3 ?? 0;
      }
      let l1My = 0; let l2My = 0; let l3My = 0;
      for (const b of myMemoryBlocks) {
        const lc = b.layer_counts ?? {};
        l1My += lc.L1 ?? 0;
        l2My += lc.L2 ?? 0;
        l3My += lc.L3 ?? 0;
      }
      const layer: LayerCounts = {
        L0: localSessions.length,
        L1: l1Personal + l1Team,
        L2: l2Personal + l2Team,
        L3: l3Personal + l3Team,
      };

      // ===== 最深召回（最大库龄，天）：按口径分组，切档时数字随之收窄 =====
      const teamAge: AgeItem[] = [];
      for (const s of skills) teamAge.push({ name: s.name ?? 'skill', createdMs: toMs(s.created_at), usedMs: toMs(s.last_used_at) });
      for (const w of wikiItems) teamAge.push({ name: w.name ?? 'wiki', createdMs: toMs(w.created_at) });
      for (const m of memoryBlocks) teamAge.push({ name: m.title ?? 'memory', usedMs: toMs(m.updated_at_ms) });
      const personalAge: AgeItem[] = [];
      for (const s of pSkillList) personalAge.push({ name: s.name ?? 'skill', createdMs: s.created_at_ms, usedMs: s.updated_at_ms });
      for (const m of pMemoryList) personalAge.push({ name: (m.content ?? '').slice(0, 16) || 'memory', createdMs: toMs(m.createdAt), usedMs: toMs(m.updatedAt) });
      for (const sc of scenes) personalAge.push({ name: sc.filename ?? 'scene', createdMs: sc.createdAtMs, usedMs: sc.updatedAtMs });
      const myAge: AgeItem[] = [
        ...mySkillItems.map((s: any) => ({ name: s.name ?? 'skill', createdMs: toMs(s.created_at), usedMs: toMs(s.last_used_at ?? s.updated_at) })),
        ...myWikiItems.map((w: any) => ({ name: w.name ?? 'wiki', createdMs: toMs(w.created_at), usedMs: toMs(w.updated_at) })),
        ...myMemoryBlocks.map((m: any) => ({ name: m.title ?? 'memory', usedMs: toMs(m.updated_at_ms) })),
        ...personalAge,
      ];
      const deepest = {
        all: computeDeepest([...teamAge, ...myAge]),
        team: computeDeepest(teamAge),
        mine: computeDeepest(myAge),
      };

      // ===== 资产召回累计（团队侧 usage_count）=====
      let recallTotal = 0;
      for (const s of skills) if (typeof s.usage_count === 'number') recallTotal += s.usage_count;

      // ===== 活跃贡献者 =====
      const contribMap = new Map<string, Contributor>();
      const bump = (key: string, label: string) => {
        const c = contribMap.get(key);
        if (c) c.count += 1;
        else contribMap.set(key, { key, label, count: 1 });
      };
      for (const w of wikiItems) bump(w.owner_user_id ? String(w.owner_user_id) : 'team', w.owner_user_id ? String(w.owner_user_id).slice(0, 8) : '团队');
      for (const s of skills) bump(s.owner_user_id ? String(s.owner_user_id) : 'team', s.owner_user_id ? String(s.owner_user_id).slice(0, 8) : '团队');
      for (const m of memoryBlocks) bump(m.uploaded_by_user_id ? String(m.uploaded_by_user_id) : 'team', m.uploaded_by_user_id ? String(m.uploaded_by_user_id).slice(0, 8) : '团队');
      pSkillList.forEach(() => bump('personal', '我（个人库）'));
      pMemoryList.forEach(() => bump('personal', '我（个人库）'));
      const contributors = Array.from(contribMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);

      // ===== 成员矩阵：逐块取真实 L1（team-assets 的 layer_counts 恒为 0，不可用）=====
      // 串行调用，规避 chat-memory/layer 并发 403/404（见设计文档并发坑）。
      const l1ByBlock: Record<string, number> = {};
      for (const b of memoryBlocks) {
        try {
          const lr = await chatMemoryApi.layer(b.id, 'L1', 1);
          l1ByBlock[b.id] = lr.total ?? 0;
        } catch {
          l1ByBlock[b.id] = 0;
        }
      }
      if (cancelled || seq !== reloadSeq) return;
      const memberRows = buildMemberRows({ memoryBlocks, skills, wikiItems, l1ByBlock });

      setData({
        teamWikiCount: wikiItems.length,
        teamWikiPages: wikiItems.reduce((acc, w) => acc + (w.page_count ?? 0), 0),
        teamWikiItems: wikiItems.map((w) => ({ ts: toMs(w.created_at) })).filter((x) => Number.isFinite(x.ts)),
        teamSkillItems: skills.map((s) => ({ ts: toMs(s.created_at) })).filter((x) => Number.isFinite(x.ts)),
        teamSkillUsage: recallTotal,
        teamMemoryItems: memoryBlocks.map((m) => ({ ts: toMs(m.updated_at_ms) })).filter((x) => Number.isFinite(x.ts)),
        teamMemoryLayer: { L0: 0, L1: l1Team, L2: l2Team, L3: l3Team },
        personalSkillItems: pSkillList.map((s) => ({ ts: toMs(s.created_at_ms) })).filter((x) => Number.isFinite(x.ts)),
        personalMemoryItems: pMemoryList.map((m) => ({ ts: toMs(m.createdAt) })).filter((x) => Number.isFinite(x.ts)),
        personalSceneCount: scenes.length,
        myWikiCount: myWikiItems.length,
        myWikiItems: myWikiItems.map((w) => ({ ts: toMs(w.created_at) })).filter((x) => Number.isFinite(x.ts)),
        mySkillItems: mySkillItems.map((s) => ({ ts: toMs(s.created_at) })).filter((x) => Number.isFinite(x.ts)),
        myMemoryItems: myMemoryBlocks.map((m) => ({ ts: toMs(m.updated_at_ms) })).filter((x) => Number.isFinite(x.ts)),
        myMemoryLayer: { L1: l1My, L2: l2My, L3: l3My },
        myPrivateWikiCount: myPrivateWiki.length,
        myPrivateWikiItems: myPrivateWiki.map((w) => ({ ts: toMs(w.created_at) })).filter((x) => Number.isFinite(x.ts)),
        myPrivateSkillItems: myPrivateSkills.map((s) => ({ ts: toMs(s.created_at) })).filter((x) => Number.isFinite(x.ts)),
        myPrivateMemoryItems: myPrivateMemories.map((m) => ({ ts: toMs(m.updated_at_ms) })).filter((x) => Number.isFinite(x.ts)),
        layer,
        deepest,
        deepestAgeDays: deepest.all.days,
        deepestName: deepest.all.name,
        recallTotal,
        contributors,
        memberRows,
        partialError: failed,
      });
      setLoadedAt(Date.now());
      setLoading(false);
    };

    void settled();

    return () => {
      cancelled = true;
    };
  }, [teamId, reloadSeq]);

  const refresh = useCallback(() => setReloadSeq((s) => s + 1), []);
  return { data, loading, loadedAt, refresh };
}

// =================== Sub components ===================

function InfoTip({ text }: { text: string }) {
  return (
    <span className="_astats-info" tabIndex={0} role="note">
      ⓘ
      <span className="_astats-tip">{text}</span>
    </span>
  );
}

function StatCard(props: {
  icon: string;
  label: string;
  total: number | string;
  lines: string[];
  tip?: string;
  highlight?: boolean;
  faded?: boolean;
}) {
  return (
    <div className={`_astats-card${props.highlight ? ' _astats-card--accent' : ''}${props.faded ? ' _astats-card--faded' : ''}`}>
      <div className="_astats-card-head">
        <span className="_astats-card-icon">{props.icon}</span>
        <span className="_astats-card-label">{props.label}</span>
        {props.tip && <InfoTip text={props.tip} />}
      </div>
      <div className="_astats-card-value">{props.total}</div>
      {props.lines.map((line, i) => (
        <div key={i} className="_astats-card-sub">
          {line}
        </div>
      ))}
    </div>
  );
}

/** 新增趋势堆叠柱状图（纯 SVG，浅色主题） */
function TrendChart({ buckets, range }: { buckets: Bucket[]; range: AssetStatsRange }) {
  const { t } = useTranslation();
  const hourly = range === '24h';
  const W = 640;
  const H = 190;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (buckets.length === 0) return null;
  const max = Math.max(1, ...buckets.map((b) => b.wiki + b.skill + b.memory));
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const yMax = Math.ceil(max / pow) * pow || max;
  const step = plotW / buckets.length;
  const barW = Math.max(2, Math.min(18, step * 0.62));

  const yTicks = [0, yMax / 2, yMax];
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <svg className="_astats-trend-svg" viewBox={`0 0 ${W} ${H}`} role="img">
      {yTicks.map((v, i) => {
        const y = padT + plotH - (v / yMax) * plotH;
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} className="_astats-trend-grid" />
            <text x={padL - 6} y={y + 3} textAnchor="end" className="_astats-trend-ytick">
              {v}
            </text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const total = b.wiki + b.skill + b.memory;
        const x = padL + i * step + (step - barW) / 2;
        let yCursor = padT + plotH;
        const segs: Array<{ key: 'wiki' | 'skill' | 'memory'; h: number }> = [];
        for (const key of ['memory', 'skill', 'wiki'] as const) {
          const h = (b[key] / yMax) * plotH;
          if (b[key] > 0) segs.push({ key, h });
        }
        return (
          <g key={i}>
            {segs.map((seg) => {
              yCursor -= seg.h;
              return (
                <rect
                  key={seg.key}
                  x={x}
                  y={yCursor}
                  width={barW}
                  height={Math.max(seg.h - 0.5, 0.5)}
                  rx={1}
                  className={`_astats-bar--${seg.key}`}
                />
              );
            })}
            {total > 0 && <title>{`${fmtBucketLabel(b.startMs, hourly)} · ${total}`}</title>}
          </g>
        );
      })}
      {buckets.map((b, i) =>
        i % labelEvery === 0 ? (
          <text
            key={i}
            x={padL + i * step + step / 2}
            y={H - 6}
            textAnchor="middle"
            className="_astats-trend-xtick"
          >
            {fmtBucketLabel(b.startMs, hourly)}
          </text>
        ) : null,
      )}
      <text x={4} y={padT - 2} className="_astats-trend-unit">
        {t('assetStats.trend.newAssets')}
      </text>
    </svg>
  );
}

/** mem0 风格资产构成横条 */
function CompositionBars({ wiki, skill, memory }: { wiki: number; skill: number; memory: number }) {
  const { t } = useTranslation();
  const total = wiki + skill + memory;
  const rows = [
    { key: 'skill', label: t('assetStats.row.skill'), value: skill, cls: '_astats-bar--skill' },
    { key: 'memory', label: t('assetStats.row.memory'), value: memory, cls: '_astats-bar--memory' },
    { key: 'wiki', label: t('assetStats.row.wiki'), value: wiki, cls: '_astats-bar--wiki' },
  ];
  return (
    <div className="_astats-comp">
      {rows.map((r) => {
        const pct = total > 0 ? (r.value / total) * 100 : 0;
        return (
          <div key={r.key} className="_astats-comp-row">
            <span className="_astats-comp-label">{r.label}</span>
            <span className="_astats-comp-track">
              {pct >= 1 ? <span className={`_astats-comp-fill ${r.cls}`} style={{ width: `${pct}%` }} /> : <span className="_astats-comp-fill _astats-comp-fill--na" />}
            </span>
            <span className="_astats-comp-pct">{pct >= 1 ? `${pct.toFixed(1)}%` : '—'}</span>
            <span className="_astats-comp-val">{r.value}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 对话记忆分层钻取（L0–L3 提炼漏斗） */
function LayerLadder({ layer }: { layer: LayerCounts }) {
  const { t } = useTranslation();
  const order: Array<{ key: keyof LayerCounts; label: string; cls: string }> = [
    { key: 'L0', label: t('assetStats.layer.L0'), cls: '_astats-lad--l0' },
    { key: 'L1', label: t('assetStats.layer.L1'), cls: '_astats-lad--l1' },
    { key: 'L2', label: t('assetStats.layer.L2'), cls: '_astats-lad--l2' },
    { key: 'L3', label: t('assetStats.layer.L3'), cls: '_astats-lad--l3' },
  ];
  const denom = Math.max(1, layer.L0);
  return (
    <div className="_astats-lad">
      <div className="_astats-lad-track">
        {order.map((o) => {
          const w = Math.min(100, (layer[o.key] / denom) * 100);
          return (
            <span
              key={o.key}
              className={`_astats-lad-seg ${o.cls}`}
              style={{ width: `${w}%` }}
              title={`${o.label} · ${layer[o.key]}`}
            >
              {w >= 6 ? `${o.label} ${layer[o.key]}` : ''}
            </span>
          );
        })}
        <span className="_astats-lad-rest" style={{ width: `${Math.max(0, 100 - Math.min(100, (layer.L1 / denom) * 100))}%` }} />
      </div>
      <div className="_astats-lad-cap">
        {order.map((o) => (
          <span key={o.key}>
            <i className={o.cls} />
            {o.label} {layer[o.key]}
            {o.key !== 'L0' && denom > 0 ? `（${((layer[o.key] / denom) * 100).toFixed(1)}%）` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// =================== Main ===================

/** 口径顺序：全部 / 团队 / 我的 */
const SCOPE_ORDER: AssetStatsScope[] = ['all', 'team', 'mine'];

export default function AssetStatsSection({ teamId }: { teamId?: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<AssetStatsRange>('7d');
  const [scope, setScope] = useState<AssetStatsScope>('all');
  const [showDetail, setShowDetail] = useState(false);
  const [, setTick] = useState(0);
  const { data, loading, loadedAt, refresh } = useAssetStats(teamId);
  const now = Date.now();

  const scopeLabel = (s: AssetStatsScope) => t(`assetStats.scope.${s}`);

  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const startMs = useMemo(() => rangeStartMs(range, now), [range, now]);

  /**
   * 按口径挑选参与统计的条目：
   *   all  团队 + 我的
   *   team 只团队池
   *   mine 只我的（团队内 private + 个人空间）
   */
  const picked = useMemo(() => {
    if (!data) return null;
    const useTeam = scope !== 'mine';
    const useMine = scope !== 'team';
    // 「我的」与「团队」有交集（我共享出去的资产两档都在）：
    //   all  口径下只取「仅我可见」那部分做并集，否则同一条会被计两次；
    //   mine 口径下取 owner=我 的全量。
    const myWikis = scope === 'mine' ? data.myWikiItems : data.myPrivateWikiItems;
    const mySkills = scope === 'mine' ? data.mySkillItems : data.myPrivateSkillItems;
    const myMemories = scope === 'mine' ? data.myMemoryItems : data.myPrivateMemoryItems;
    return {
      wikiItems: useTeam ? data.teamWikiItems : [],
      skillItems: [
        ...(useTeam ? data.teamSkillItems : []),
        ...(useMine ? [...mySkills, ...data.personalSkillItems] : []),
      ],
      memoryItems: [
        ...(useTeam ? data.teamMemoryItems : []),
        ...(useMine ? [...myMemories, ...data.personalMemoryItems] : []),
      ],
      myWikiItems: useMine ? myWikis : [],
    };
  }, [data, scope]);

  const buckets = useMemo(() => {
    if (!picked) return [];
    const bs = buildBuckets(range, now);
    fillBuckets(bs, [...picked.wikiItems, ...picked.myWikiItems], 'wiki');
    fillBuckets(bs, picked.skillItems, 'skill');
    fillBuckets(bs, picked.memoryItems, 'memory');
    return bs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, range]);

  const countNew = (items: DatedItem[]) => items.filter((x) => x.ts >= startMs).length;

  const stats = useMemo(() => {
    if (!data || !picked) return null;
    const useTeam = scope !== 'mine';
    const useMine = scope !== 'team';

    // mine 口径取 owner=我 全量；all 口径只取「仅我可见」部分（已共享的已在 team 列）
    const myWikiPart = scope === 'mine' ? data.myWikiCount : data.myPrivateWikiCount;
    const mySkillPart =
      scope === 'mine' ? data.mySkillItems.length : data.myPrivateSkillItems.length;
    const myMemPart =
      scope === 'mine' ? data.myMemoryItems.length : data.myPrivateMemoryItems.length;

    const wikiTeam = useTeam ? data.teamWikiCount : 0;
    const wikiMine = useMine ? myWikiPart : 0;
    const wikiNew = countNew([...picked.wikiItems, ...picked.myWikiItems]);

    const skillTeam = useTeam ? data.teamSkillItems.length : 0;
    const skillMine = useMine ? mySkillPart + data.personalSkillItems.length : 0;
    const skillNew = countNew(picked.skillItems);

    const memTeam = useTeam ? data.teamMemoryItems.length : 0;
    const memMine = useMine ? myMemPart + data.personalMemoryItems.length : 0;
    const memNew = countNew(picked.memoryItems);

    // 构成表语义：team 列 = 团队池，personal 列 = 我的（private + 个人空间）
    return {
      wiki: { total: wikiTeam + wikiMine, team: wikiTeam, personal: wikiMine, newInRange: wikiNew },
      skill: { total: skillTeam + skillMine, team: skillTeam, personal: skillMine, newInRange: skillNew },
      memory: { total: memTeam + memMine, team: memTeam, personal: memMine, newInRange: memNew },
      grand: {
        total: wikiTeam + wikiMine + skillTeam + skillMine + memTeam + memMine,
        newInRange: wikiNew + skillNew + memNew,
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, picked, startMs, scope]);

  /** 当前口径下的最深召回 */
  const deepest = data?.deepest[scope] ?? { days: null, name: null };
  /** 当前口径下的对话记忆分层 */
  const layer = useMemo(() => {
    if (!data) return { L0: 0, L1: 0, L2: 0, L3: 0 };
    const useTeam = scope !== 'mine';
    const useMine = scope !== 'team';
    const pL1 = data.layer.L1 - data.teamMemoryLayer.L1 - data.myMemoryLayer.L1;
    const pL2 = data.layer.L2 - data.teamMemoryLayer.L2 - data.myMemoryLayer.L2;
    const pL3 = data.layer.L3 - data.teamMemoryLayer.L3 - data.myMemoryLayer.L3;
    return {
      L0: data.layer.L0,
      L1: (useTeam ? data.teamMemoryLayer.L1 : 0) + (useMine ? data.myMemoryLayer.L1 + pL1 : 0),
      L2: (useTeam ? data.teamMemoryLayer.L2 : 0) + (useMine ? data.myMemoryLayer.L2 + pL2 : 0),
      L3: (useTeam ? data.teamMemoryLayer.L3 : 0) + (useMine ? data.myMemoryLayer.L3 + pL3 : 0),
    };
  }, [data, scope]);

  const rangeLabel = (r: AssetStatsRange) => t(`assetStats.range.${r}`);

  return (
    <div className="_astats-wrap _memory-panel-card">
      {/* ===== Header ===== */}
      <div className="_astats-header">
        <div className="_astats-header-info">
          <div className="_astats-title">{t('assetStats.title')}</div>
          <div className="_astats-subtitle">{t('assetStats.subtitle')}</div>
        </div>
        <div className="_astats-header-ops">
          {/* 口径切换：全部 / 团队 / 我的。默认全部，避免丢掉原有混合视角。 */}
          <div className="_astats-ranges _astats-scopes" role="tablist" title={t('assetStats.scope.tip')}>
            {SCOPE_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className={`_astats-range-pill${scope === s ? ' _astats-range-pill--active' : ''}`}
                onClick={() => setScope(s)}
              >
                {scopeLabel(s)}
              </button>
            ))}
          </div>
          <div className="_astats-ranges" role="tablist">
            {RANGE_ORDER.map((r) => (
              <button
                key={r}
                type="button"
                className={`_astats-range-pill${range === r ? ' _astats-range-pill--active' : ''}`}
                onClick={() => setRange(r)}
              >
                {rangeLabel(r)}
              </button>
            ))}
          </div>
          <button type="button" className="_astats-refresh" onClick={refresh} title={t('assetStats.refresh')}>
            <RefreshIcon size={14} />
            {t('assetStats.refresh')}
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="_astats-loading">{t('assetStats.loading')}</div>
      ) : !data || !stats ? null : (
        <>
          {data.partialError && <div className="_astats-warn">{t('assetStats.error.partial')}</div>}
          <div className="_astats-updated">
            {loadedAt ? `更新于 ${fmtAgo(loadedAt, Date.now())}` : ''}
          </div>

          {/* ===== 指标卡（mem0 风格 4 张） ===== */}
          <div className="_astats-cards">
            <StatCard
              icon="📦"
              label={t('assetStats.card.total')}
              total={stats.grand.total.toLocaleString()}
              highlight
              tip={t('assetStats.tip.total')}
              lines={[
                t('assetStats.sub.scopeHint'),
                range === 'all' ? t('assetStats.sub.allTime') : t('assetStats.newInRange', { count: stats.grand.newInRange }),
              ]}
            />
            <StatCard
              icon="🔁"
              label={t('assetStats.card.recall')}
              total={data.recallTotal > 0 ? data.recallTotal.toLocaleString() : '—'}
              faded={data.recallTotal === 0}
              tip={t('assetStats.tip.recall')}
              lines={[
                t('assetStats.sub.recallTeam', { count: data.recallTotal }),
                t('assetStats.sub.recallPersonalPending'),
              ]}
            />
            <StatCard
              icon="⏳"
              label={t('assetStats.card.deepest')}
              total={deepest.days !== null ? (deepest.days > 0 ? `${deepest.days}d` : '<1d') : '—'}
              faded={deepest.days === null}
              tip={t('assetStats.tip.deepest')}
              lines={[
                deepest.name ? t('assetStats.sub.deepestName', { name: deepest.name }) : t('assetStats.sub.noAge'),
                t('assetStats.sub.deepestHint'),
              ]}
            />
            <StatCard
              icon="💬"
              label={t('assetStats.card.memory')}
              total={stats.memory.total.toLocaleString()}
              tip={t('assetStats.tip.memory', { l1: layer.L1, l2: layer.L2, l3: layer.L3 })}
              lines={[
                `${t('assetStats.sub.team', { count: stats.memory.team })} · ${t('assetStats.sub.personal', { count: stats.memory.personal })}`,
                range === 'all' ? t('assetStats.sub.scenes', { count: data.personalSceneCount }) : t('assetStats.newInRange', { count: stats.memory.newInRange }),
              ]}
            />
          </div>

          {/* ===== 成员资产矩阵（P0 精简版）=====
               「我的」口径下只有自己一个人，成员维度没有意义，整块隐藏。 */}
          {teamId && scope !== 'mine' && data.memberRows.length > 0 && (
            <MemberAssetMatrix rows={data.memberRows} />
          )}

          {/* ===== 第二行：新增趋势 + 资产构成横条 ===== */}
          <div className="_astats-panels">
            <div className="_astats-panel">
              <div className="_astats-panel-title">{t('assetStats.trend.title')}</div>
              {range === 'all' ? (
                <div className="_astats-empty">{t('assetStats.trend.pickRange')}</div>
              ) : buckets.every((b) => b.wiki + b.skill + b.memory === 0) ? (
                <div className="_astats-empty">{t('assetStats.trend.empty')}</div>
              ) : (
                <TrendChart buckets={buckets} range={range} />
              )}
              <div className="_astats-legend">
                <span className="_astats-legend-item"><i className="_astats-dot _astats-dot--wiki" />{t('assetStats.row.wiki')}</span>
                <span className="_astats-legend-item"><i className="_astats-dot _astats-dot--skill" />{t('assetStats.row.skill')}</span>
                <span className="_astats-legend-item"><i className="_astats-dot _astats-dot--memory" />{t('assetStats.row.memory')}</span>
              </div>
            </div>

            <div className="_astats-panel">
              <div className="_astats-panel-title">
                {t('assetStats.breakdown.title')}
                <button type="button" className="_astats-link" onClick={() => setShowDetail((s) => !s)}>
                  {showDetail ? t('assetStats.detail.hide') : t('assetStats.detail.show')}
                </button>
              </div>
              <CompositionBars wiki={stats.wiki.total} skill={stats.skill.total} memory={stats.memory.total} />
              {showDetail && (
                <table className="_astats-table">
                  <thead>
                    <tr>
                      <th>{t('assetStats.breakdown.type')}</th>
                      <th className="_astats-num">{t('assetStats.breakdown.team')}</th>
                      <th className="_astats-num">{t('assetStats.breakdown.personal')}</th>
                      <th className="_astats-num">{t('assetStats.breakdown.total')}</th>
                      {range !== 'all' && <th className="_astats-num">{t('assetStats.breakdown.new')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{t('assetStats.row.wiki')}</td>
                      <td className="_astats-num">{stats.wiki.team}</td>
                      <td className="_astats-num">{stats.wiki.personal}</td>
                      <td className="_astats-num _astats-strong">{stats.wiki.total}</td>
                      {range !== 'all' && <td className="_astats-num">+{stats.wiki.newInRange}</td>}
                    </tr>
                    <tr>
                      <td>{t('assetStats.row.skill')}</td>
                      <td className="_astats-num">{stats.skill.team}</td>
                      <td className="_astats-num">{stats.skill.personal}</td>
                      <td className="_astats-num _astats-strong">{stats.skill.total}</td>
                      {range !== 'all' && <td className="_astats-num">+{stats.skill.newInRange}</td>}
                    </tr>
                    <tr>
                      <td>{t('assetStats.row.memory')}</td>
                      <td className="_astats-num">{stats.memory.team}</td>
                      <td className="_astats-num">{stats.memory.personal}</td>
                      <td className="_astats-num _astats-strong">{stats.memory.total}</td>
                      {range !== 'all' && <td className="_astats-num">+{stats.memory.newInRange}</td>}
                    </tr>
                    <tr className="_astats-table-total">
                      <td>{t('assetStats.breakdown.grand')}</td>
                      <td className="_astats-num">{stats.wiki.team + stats.skill.team + stats.memory.team}</td>
                      <td className="_astats-num">{stats.skill.personal + stats.memory.personal}</td>
                      <td className="_astats-num _astats-strong">{stats.grand.total}</td>
                      {range !== 'all' && <td className="_astats-num">+{stats.grand.newInRange}</td>}
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* ===== 第三行：对话记忆分层 + 活跃贡献者 ===== */}
          <div className="_astats-panels">
            <div className="_astats-panel">
              <div className="_astats-panel-title">
                {t('assetStats.layer.title')}
                <InfoTip text={t('assetStats.tip.layer')} />
              </div>
              {layer.L0 === 0 ? (
                <div className="_astats-empty">{t('assetStats.layer.empty')}</div>
              ) : (
                <LayerLadder layer={layer} />
              )}
              <div className="_astats-note">{t('assetStats.note.layerUnit')}</div>
            </div>

            {/* 活跃贡献者：「我的」口径下同样无成员维度，隐藏 */}
            {scope !== 'mine' && (
            <div className="_astats-panel">
              <div className="_astats-panel-title">{t('assetStats.contributor.title')}</div>
              {data.contributors.length === 0 ? (
                <div className="_astats-empty">{t('assetStats.contributor.empty')}</div>
              ) : (
                <ul className="_astats-contrib">
                  {data.contributors.map((c) => (
                    <li key={c.key}>
                      <span className="_astats-contrib-dot" />
                      <span className="_astats-contrib-label">{c.label}</span>
                      <span className="_astats-contrib-val">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
