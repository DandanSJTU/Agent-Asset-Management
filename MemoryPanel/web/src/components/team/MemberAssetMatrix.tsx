/**
 * MemberAssetMatrix — 团队资产统计「成员 × 资产」矩阵（team-7xulumcvyl 成员维度）。
 *
 * P0 精简版（见 docs/team-asset-stats-member-matrix-design.html）：
 *   - 行 = 团队共享 + 4 成员；列 = 对话记忆(L1) / Skill / Wiki / 合计 / 最近更新
 *   - L1 来自每块 chat-memory/layer 的真实 total（team-assets 的 layer_counts 恒为 0，不可用）
 *   - Skill 来自 meta/asset/list-accessible（面板权威列表，含 12 角色技能）
 *   - Wiki 来自 knowledge/wiki/team-assets；共享库按 name 含「共享」识别，归入团队共享行
 *   - e2e 测试记忆已在本机清理（agt-8fum8r07ob 的 5 条 L1），故本表不再做前端 e2e 过滤
 *
 * P1（待后端聚合接口）：补 L2/L3 列、默认模板开关、行下钻、列头排序增强。
 *
 * 样式隔离：全部走 _mamat-* 类，不复用/污染 _astats-*。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './member-asset-matrix.css';

export interface MatrixRow {
  key: string;
  label: string;
  role?: string;
  agentId?: string;
  letter?: string;
  isShared?: boolean;
  l1: number;
  skill: number;
  wikiLibs: number;
  wikiPages: number;
  updatedAtMs?: number;
}

type SortKey = 'l1' | 'skill' | 'wikiLibs' | 'total';

export default function MemberAssetMatrix({ rows }: { rows: MatrixRow[] }) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [asc, setAsc] = useState(false);

  const maxL1 = useMemo(() => Math.max(1, ...rows.map((r) => r.l1)), [rows]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let d = 0;
      if (sortKey === 'total') d = a.l1 + a.skill + a.wikiLibs - (b.l1 + b.skill + b.wikiLibs);
      else d = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
      return asc ? d : -d;
    });
    return arr;
  }, [rows, sortKey, asc]);

  if (rows.length === 0) {
    return <div className="_mamat-wrap _memory-panel-card"><div className="_mamat-empty">{t('assetStats.matrix.empty')}</div></div>;
  }

  const onSort = (k: SortKey) => {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(false);
    }
  };

  const arrow = (k: SortKey) => (sortKey === k ? (asc ? ' ▲' : ' ▼') : '');

  const fmtDate = (ms?: number) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const totals = rows.reduce(
    (acc, r) => {
      acc.l1 += r.l1;
      acc.skill += r.skill;
      acc.wikiLibs += r.wikiLibs;
      acc.wikiPages += r.wikiPages;
      return acc;
    },
    { l1: 0, skill: 0, wikiLibs: 0, wikiPages: 0 },
  );

  return (
    <div className="_mamat-wrap _memory-panel-card">
      <div className="_mamat-head">
        <div className="_mamat-title">
          {t('assetStats.matrix.title')}
          <span className="_mamat-info" tabIndex={0} role="note">
            ⓘ
            <span className="_mamat-tip">{t('assetStats.matrix.tip')}</span>
          </span>
        </div>
        <div className="_mamat-sorthint">{t('assetStats.matrix.sortHint')}</div>
      </div>

      <div className="_mamat-scroll">
        <table className="_mamat-table">
          <thead>
            <tr>
              <th className="_mamat-th-owner">{t('assetStats.matrix.col.owner')}</th>
              <th className="_mamat-th _mamat-sortable" onClick={() => onSort('l1')}>
                {t('assetStats.matrix.col.memory')}
                {arrow('l1')}
              </th>
              <th className="_mamat-th _mamat-sortable" onClick={() => onSort('skill')}>
                {t('assetStats.matrix.col.skill')}
                {arrow('skill')}
              </th>
              <th className="_mamat-th _mamat-sortable" onClick={() => onSort('wikiLibs')}>
                {t('assetStats.matrix.col.wiki')}
                {arrow('wikiLibs')}
              </th>
              <th className="_mamat-th _mamat-sortable" onClick={() => onSort('total')}>
                {t('assetStats.matrix.col.total')}
                {arrow('total')}
              </th>
              <th className="_mamat-th _mamat-th-upd">{t('assetStats.matrix.col.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} className={r.isShared ? '_mamat-row _mamat-row--shared' : '_mamat-row'}>
                <td className="_mamat-td-owner">
                  <span className={`_mamat-avatar${r.isShared ? ' _mamat-avatar--shared' : ''}`}>
                    {r.isShared ? '共' : (r.letter || r.label.slice(0, 1).toUpperCase())}
                  </span>
                  <span className="_mamat-owner-meta">
                    <span className="_mamat-owner-name">{r.isShared ? t('assetStats.matrix.shared') : r.label}</span>
                    <span className="_mamat-owner-sub">
                      {r.isShared
                        ? t('assetStats.matrix.sharedHint')
                        : r.role
                          ? `${r.role}${r.agentId ? ` · ${r.agentId}` : ''}`
                          : ''}
                    </span>
                  </span>
                </td>
                <td className="_mamat-td-num">
                  <span className="_mamat-num _mamat-num--mem">{r.l1}</span>
                  <span className="_mamat-mini">
                    <span className="_mamat-mini-fill _mamat-mini--mem" style={{ width: `${(r.l1 / maxL1) * 100}%` }} />
                  </span>
                </td>
                <td className="_mamat-td-num">
                  <span className="_mamat-num _mamat-num--skill">{r.skill}</span>
                </td>
                <td className="_mamat-td-num">
                  <span className="_mamat-num _mamat-num--wiki">{r.wikiLibs}</span>
                  <span className="_mamat-wiki-sub">
                    {r.wikiPages > 0 ? ` · ${t('assetStats.matrix.wikiPages', { count: r.wikiPages })}` : ''}
                  </span>
                </td>
                <td className="_mamat-td-num _mamat-td-total">{r.l1 + r.skill + r.wikiLibs}</td>
                <td className="_mamat-td-upd">{fmtDate(r.updatedAtMs)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="_mamat-foot">
              <td className="_mamat-foot-label">{t('assetStats.matrix.col.total')}</td>
              <td className="_mamat-td-num">
                <span className="_mamat-num _mamat-num--mem">{totals.l1}</span>
              </td>
              <td className="_mamat-td-num">
                <span className="_mamat-num _mamat-num--skill">{totals.skill}</span>
              </td>
              <td className="_mamat-td-num">
                <span className="_mamat-num _mamat-num--wiki">{totals.wikiLibs}</span>
                <span className="_mamat-wiki-sub"> · {t('assetStats.matrix.wikiPages', { count: totals.wikiPages })}</span>
              </td>
              <td className="_mamat-td-num _mamat-td-total">{totals.l1 + totals.skill + totals.wikiLibs}</td>
              <td className="_mamat-td-upd" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
