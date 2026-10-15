/**
 * mockApi.ts — 对话记忆 tab 的演示用 API 实现。
 *
 * `mockChatMemoryApi` 与真实 `chatMemoryApi` 保持同形状（类型 = typeof chatMemoryApi），
 * 由 useChatMemory 在演示模式下选用。写操作（导入 / 分配 / 解绑 / 编辑等）在演示模式下
 * 均为「乐观成功」的空操作，仅用于让 UI 流程不报错。
 *
 * 演示开关检测优先级：`?demo=1`（URL） > localStorage `chat-memory-demo` > 关闭。
 */
import { chatMemoryApi } from '@/lib/teamApi';
import type { ChatMemoryLayerItem, ChatMemorySearchHit } from '@/lib/teamApi';
import { MOCK_BLOCKS, getMockLayer } from './mockData';

/** 与真实 chatMemoryApi 完全一致的运行时类型，便于在 hook 中无缝替换 */
export type ChatMemoryApiLike = typeof chatMemoryApi;

const delay = (ms = 140) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** L0 按时间倒序（最新在前），与后端约定一致 */
function sortDesc(items: ChatMemoryLayerItem[]): ChatMemoryLayerItem[] {
  return [...items].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
  );
}

export const mockChatMemoryApi: ChatMemoryApiLike = {
  teamAssets: async (_teamId: string) => {
    await delay();
    return { items: MOCK_BLOCKS, total: MOCK_BLOCKS.length };
  },

  agentFixed: async (_agentId: string) => {
    await delay();
    return { items: [], total: 0 };
  },

  myAgents: async (_teamId: string) => {
    await delay();
    return { items: [] };
  },

  layer: async (
    blockId: string,
    layer: 'L0' | 'L1' | 'L2' | 'L3',
    limit = 50,
    offset = 0,
    _path?: string,
    beforeTs?: string,
    _timeStart?: string,
    _timeEnd?: string,
  ) => {
    await delay();
    let items = getMockLayer(blockId, layer);
    if (layer === 'L0') {
      items = sortDesc(items);
      // 「加载更早」游标：只返回早于 beforeTs 的消息
      if (beforeTs) items = items.filter((i) => String(i.created_at ?? '') < beforeTs);
    }
    // 注：演示数据忽略时间筛选（timeStart/timeEnd），确保内容始终可见。
    const total = items.length;
    const page = items.slice(offset, offset + limit);
    return { layer, items: page, total, limit, offset };
  },

  searchLayer: async (
    blockId: string,
    layer: 'L0' | 'L1',
    query: string,
    limit = 30,
  ) => {
    await delay(80);
    const items = getMockLayer(blockId, layer);
    const q = query.trim().toLowerCase();
    const hits = q
      ? items.filter((i) => `${i.title ?? ''} ${i.body ?? ''}`.toLowerCase().includes(q))
      : items;
    const scored: ChatMemorySearchHit[] = hits.slice(0, limit).map((i, idx) => ({
      ...i,
      score: Math.max(0.5, 1 - idx * 0.05),
    }));
    return { items: scored, total: hits.length };
  },

  setAgentFixed: async () => {
    await delay(40);
    return { updated: true, agent_id: '', block_ids: [] };
  },

  allocate: async (_teamId: string, blockId: string, agentId: string) => {
    await delay(40);
    return { allocated: true, agent_id: agentId, block_id: blockId };
  },

  unbind: async (_teamId: string, blockId: string, agentId: string) => {
    await delay(40);
    return { unbound: true, agent_id: agentId, block_id: blockId };
  },

  create: async () => {
    await delay(40);
    return MOCK_BLOCKS[0];
  },

  patchScope: async (blockId: string, scope: 'team' | 'private') => {
    await delay(40);
    return { updated: true, id: blockId, scope };
  },

  import: async (params: { messages?: Array<{ role: string; content: string }> }) => {
    await delay(40);
    return {
      imported: true,
      block_id: 'mock-block',
      session_id: 'mock-session',
      accepted_count: params?.messages?.length ?? 0,
    };
  },

  importRecords: async (params: {
    records?: Array<{ content: string; type: string; priority?: number; scene_name?: string }>;
  }) => {
    await delay(40);
    return {
      imported: true,
      block_id: 'mock-block',
      session_id: 'mock-session',
      added_count: params?.records?.length ?? 0,
      ids: [],
    };
  },

  updateLayer: async (_blockId: string, _layer: 'L1' | 'L2' | 'L3', params: { id?: string }) => {
    await delay(40);
    return { id: params?.id, updated_at: new Date().toISOString() };
  },
};

const DEMO_STORAGE_KEY = 'chat-memory-demo';

/** 当前是否处于演示模式（URL `?demo=1` 或 localStorage 标记） */
export function isDemoMode(): boolean {
  try {
    if (typeof window !== 'undefined') {
      if (new URLSearchParams(window.location.search).get('demo') === '1') return true;
      if (/[?&]demo=1/.test(window.location.hash)) return true;
      if (localStorage.getItem(DEMO_STORAGE_KEY) === '1') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 持久化演示开关（localStorage） */
export function persistDemoMode(value: boolean): void {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** 根据演示开关返回对应 API 实现 */
export function getChatMemoryApi(demo: boolean): ChatMemoryApiLike {
  return demo ? mockChatMemoryApi : chatMemoryApi;
}
