/**
 * layered-refine · 类型定义（独立第二车道，不与 MemoryCore / 个人记忆管线耦合）。
 *
 * 本文件只做类型声明，不含任何运行逻辑。产物落盘位置：
 *   ~/.workbuddy/user-...-personal/context-infra/
 *     config.json / OBSERVATIONS.md / observations.jsonl
 *     candidates.json / axioms/ / jobs/runs.jsonl
 */

/** 交通灯级别（与 context-infrastructure KNOWLEDGE_BASE §3.1 对齐）。 */
export type TrafficLevel = 'high' | 'medium' | 'low';

/** 单条 L1 观测（结构化影子副本，供 UI 检索 + 证据链）。 */
export interface Observation {
  /** 稳定键：hash(tag + 归一化 text)，跨 run 去重用 */
  id: string;
  date: string; // YYYY-MM-DD
  level: TrafficLevel;
  tag: string;
  text: string;
  /** 首次出现的日期 */
  firstSeen: string;
  /** 最近一次出现的日期 */
  lastSeen: string;
  /** 跨 run 累计支撑次数 */
  supportCount: number;
  /** 命中的源会话（去重） */
  sources: string[];
  /** 是否已被晋升（软删除，保留回溯） */
  promoted: boolean;
}

/** Observer CLI 单次产出（单会话）。 */
export interface ObserverRawItem {
  level: TrafficLevel;
  tag: string;
  text: string;
}

export interface ObserverSchema {
  observations: ObserverRawItem[];
}

/** L2 晋升候选。 */
export interface Candidate {
  id: string;
  text: string;
  level: TrafficLevel;
  tag: string;
  evidence: {
    supportCount: number;
    sessions: string[];
    spanDays: number;
  };
  suggestedTarget: 'USER.md' | 'MEMORY.md' | 'axioms';
  /**
   * 稳定度：stable=同时满足支撑/跨会话/跨度三条；emerging=只满足前两条（跨度不足，
   * 例如同一批会话一次性导入时跨度天然为 0）。跨度不再一票否决——否则"首次导入"
   * 场景下 L2 永远为空，用户看不到第二层的产出。
   */
  maturity: 'stable' | 'emerging';
  status: 'pending' | 'promoted' | 'demoted' | 'dropped';
  createdAt: number;
  /** 聚合方式：llm=Reflector 语义合并 / rule=门槛回退 */
  mode: 'llm' | 'rule';
  /** 命中的观测 id（证据链） */
  sourceObsIds: string[];
}

/** L3 公理（四段结构，照抄 context-infra 上游格式）。 */
export interface Axiom {
  id: string; // A01, A02 ...
  title: string;
  tag: string;
  core: string; // 核心含义
  reasoning: string; // 深度推演
  application: string; // 应用判定
  sources: string[]; // 关联观测 id / 会话
  createdAt: number;
  updatedAt: number;
}

/** 运行日志（jobs/runs.jsonl）。 */
export interface JobRecord {
  jobId: string;
  type: 'observer' | 'reflector' | 'axiom';
  startedAt: number;
  endedAt: number | null;
  status: 'pending' | 'running' | 'success' | 'failed';
  sessions?: number;
  observations?: number;
  noiseFiltered?: number;
  /** LLM 未返回的会话数（>0 表示通道有问题，不是"没有信号"） */
  llmMissed?: number;
  /** 本次实际提炼的会话 id */
  pickedSessionIds?: string[];
  candidates?: number;
  /** Reflector 的聚合方式：llm=语义聚合 / rule=门槛回退 */
  mode?: 'llm' | 'rule';
  axioms?: number;
  error?: string | null;
}

export interface LayeredConfig {
  rootDir: string;
  windowDays: number;
  maxSessionsPerRun: number;
  maxInputBytesPerSession: number;
  maxTotalInputBytes: number;
  backend: string;
  model: string;
  timeoutMs: number;
  excludeVerdictFresh: boolean;
  excludeCompactionGte: number;
  promotion: {
    supportGte: number;
    sessionsGte: number;
    spanDaysGte: number;
  };
}

export interface StatusResponse {
  rootDir: string;
  configured: boolean;
  counts: {
    sessions: number;
    observations: number;
    candidates: number;
    axioms: number;
    pendingCandidates: number;
  };
  lastRuns: {
    observer: number | null;
    reflector: number | null;
    axiom: number | null;
  };
  config: LayeredConfig;
}

export interface ObservationQuery {
  since?: string; // YYYY-MM-DD
  level?: TrafficLevel;
  q?: string;
}
