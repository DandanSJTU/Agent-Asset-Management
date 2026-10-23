/**
 * ChatMemoryPanel — 原子能力 · 记忆。
 *
 * 本文件只保留渲染与组装；状态/数据逻辑在 useChatMemory，常量与工具在 memory-utils。
 */
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select } from 'tea-component';
import { type ScopeTab } from '../constants/types';

import { BlockDetail } from './BlockDetail';
import { ImportBlockDialog } from './ImportBlockDialog';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import { useChatMemory } from '../hooks/useChatMemory';
import '../styles/chat-memory-panel.css';

export default function ChatMemoryPanel(
  props: {
    currentUser?: string;
    activeTeamId?: string | null;
  } = {},
) {
  const { t } = useTranslation();
  const store = useChatMemory(props);

  const {
    // context
    activeTeam,
    currentUserId,
    ownedTeamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    refreshLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    isSelfChatMemory,
  } = store;

  return (
    <div className="_asset-memory-page">
      <AssetPageHeader
        title={t('memory.title')}
        subtitle={
          activeTeam
            ? t('memory.subtitle.team', { name: activeTeam.name, count: blocks.length })
            : t('memory.subtitle.global', { count: blocks.length })
        }
        scope={
          // 「我的」= 团队空间内 owner=我（含已共享 + 仅我可见）；hover 提示区分于侧边栏个人空间。
          <span title={t('memory.scope.mine.tooltip')}>
            <Segment
              value={scopeTab}
              onChange={(v) => setScopeTab(v as ScopeTab)}
              options={(['team', 'mine'] as ScopeTab[]).map((tab) => ({
                value: tab,
                text: scopeTabLabels[tab],
              }))}
            />
          </span>
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={ownedTeamAgents.length === 0}
              placeholder={t('memory.noAgent')}
              options={ownedTeamAgents.map((agent) => ({
                value: agent.agent_id,
                text: `${agent.name}（${agent.agent_id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          // 已移除「分配给 Agent」：对话记忆不再提供从本页直接装配到 Agent 的入口，
          // 绑定关系统一在 Agent 编辑弹窗（AgentEditDialog）里维护。
          <Button
            type="primary"
            onClick={() => setShowImport(true)}
            disabled={ownedTeamAgents.length === 0}
            tooltip={
              ownedTeamAgents.length === 0 ? t('memory.import.tooltip.noAgent') : undefined
            }
            data-guide="import-memory"
          >
            {t('memory.import')}
          </Button>
        }
      />

      <AssetSplitLayout
        storageKey="memory:assetSplitWidth"
        sidebar={
            <AssetListPanel
              title={t('memory.blockList')}
              count={t('memory.blockCount', { filtered: filtered.length, total: blocks.length })}
              loading={blocksLoading}
              items={filtered}
              selectedId={selectedId}
              getItemId={(b) => b.id}
              onSelect={(b) => setSelectedId(b.id)}
              isItemDisabled={(b) =>
                scopeTab === 'fixed' &&
                b.scope === 'private' &&
                b.uploaded_by_user_id !== currentUserId
              }
              emptyText={
                scopeTab === 'mine' ? t('memory.empty.mine') : t('memory.empty.filtered')
              }
              renderItem={(b) => {
                const isRevoked =
                  scopeTab === 'fixed' &&
                  b.scope === 'private' &&
                  b.uploaded_by_user_id !== currentUserId;
                const isOwner = b.uploaded_by_user_id === currentUserId;
                // 共享/私密切换：固定资产 tab 与「我的」tab 都开放（后者是唯一出路 ——
                // 私密资产要先转团队才能分配到 Agent）。团队 tab 下自己 owner 的条目
                // 也开放，与「设为私密」语义对称。
                const canToggleScope = scopeTab !== 'team' && isOwner && !!b.scope;
                const canUnbind = scopeTab === 'fixed' && !isSelfChatMemory(b);
                const l0Count = b.layer_counts?.L0_messages ?? 0;
                return (
                  <div className="_memory-card">
                    {/* 第 1 行：标题（左） + 蓝色计数徽章（右） */}
                    <div className="_memory-card-header">
                      <span className="_memory-card-title" title={b.title}>
                        {b.title}
                        {isRevoked && (
                          <span className="_memory-badge _memory-badge--warning">
                            {t('memory.list.revoked')}
                          </span>
                        )}
                      </span>
                      {l0Count > 0 && <span className="_memory-card-count">{l0Count}</span>}
                    </div>

                    {/* 第 2 行：资产真实 id，等宽灰色 */}
                    <div className="_memory-card-id" title={b.id}>{b.id}</div>

                    {/* 第 3 行：用户名（左） + 时间 / 解绑（右）
                        复用通用 AssetItemBadges + AssetItemTime，与 Skills 页结构一致 */}
                    <AssetItemBadges>
                      {b.uploaded_by_user_id && (
                        <UserBadge
                          userId={b.uploaded_by_user_id}
                          isCurrentUser={isOwner}
                          youText={t('common.you')}
                        />
                      )}
                      {canUnbind ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBlock(b.id);
                          }}
                          title={t('memory.unbind.tooltip')}
                          className="_memory-card-unbind"
                        >
                          {t('memory.unbind')}
                        </button>
                      ) : (
                        <AssetItemTime>
                          {new Date(b.updated_at_ms).toLocaleString()}
                        </AssetItemTime>
                      )}
                    </AssetItemBadges>

                    {/* 第 4 行：共享/私密切换（仅 owner 可见） */}
                    {canToggleScope && (
                      <div
                        className="_memory-card-scope"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Segment
                          value={b.scope === 'team' ? 'team' : 'private'}
                          onChange={(v) => handleToggleScope(b, v as 'team' | 'private')}
                          options={[
                            { value: 'team', text: t('memoryPersonal.shared') },
                            { value: 'private', text: t('memoryPersonal.private') },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                );
              }}
            />
          }
          detail={
            !selected ? (
              <div className="_memory-detail-empty-card">{t('memory.detail.empty')}</div>
            ) : (
              <BlockDetail
                block={selected}
                layer={layer}
                onLayerChange={setLayer}
                agentLabel={agentLabel}
                layerPage={layerPage}
                layerPageSize={pageSize}
                layerTotal={windowTotal}
                layerLoading={layerLoading}
                onLayerPageChange={handleLayerPageChange}
                onLayerItemLoad={handleLayerItemLoad}
                layerItemLoadingId={layerItemLoadingId}
                onL0LoadMore={handleL0LoadMore}
                l0MoreLoading={l0MoreLoading}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
                rangeTooLarge={rangeTooLarge}
                canEdit={selected.uploaded_by_user_id === currentUserId}
                onSaveLayerItem={handleSaveLayerItem}
                onSearchLayer={searchLayer}
                onRefresh={refreshLayer}
              />
            )
          }
      />

      {showImport && (
        <ImportBlockDialog
          onClose={() => setShowImport(false)}
          onImported={handleImport}
          agents={ownedTeamAgents.map((a) => ({ agent_id: a.agent_id, name: a.name }))}
          defaultAgentId={scopeTab === 'fixed' && agentFilter ? agentFilter : ''}
        />
      )}
    </div>
  );
}
