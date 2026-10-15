/**
 * Personal memory extraction entry (M4a — 写入通道).
 *
 * This is the missing upper-layer entry that the plan flagged as the only hard
 * blocker for "生成个人记忆": the storage sink (`upsertL0` / `upsertL1`) and the
 * L1 pipeline are already scope-aware (M4a′ / ②), but **no production code ever
 * constructs a `scope:"personal"` record**. This module is that entry.
 *
 * Responsibilities
 * ----------------
 * 1. `writePersonalL0` — ingest a source conversation's messages as `scope:"personal"`
 *    L0 records (mirrors `core/hooks/auto-capture.ts`, but pins `scope:"personal"`,
 *    `ownerUserId`, and `agentId:"personal:<vendor>"` so profile directories do not
 *    collide with real team agents — see docs/my-memory-tab-design.html §4.3).
 * 2. `runPersonalL1` — drive the production L1 runner for a personal `sessionKey`
 *    until the backlog is drained (reuses checkpoint cursor idempotency).
 * 3. `extractPersonalFromSource` — orchestrates the two above for one source
 *    session, returning L0 / L1 counts.
 *
 * Idempotency on the *source* conversation (not just the store cursor) is owned
 * by `personal-source-session-store.ts` (file fingerprint + record index), so a
 * re-run only ingests newly-appended messages.
 *
 * Scope isolation notes
 * ---------------------
 * - personal rows require an EMPTY `teamId` (enforced by `resolveRecordScope`).
 * - `agentId` is pinned to `personal:<vendor>` (default `personal:workbuddy`) so the
 *   profile output directory lands at `team:<user>|agent:personal:<vendor>` and
 *   never collides with a real team agent's profile (design doc §4.3 red callout).
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import {
  createL1Runner,
  createL2Runner,
  createL3Runner,
  discoverProfileScopes,
  scopedDataDirForScope,
} from "../../utils/pipeline-factory.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { parseProfileIsolationScope, buildProfileIsolationScope } from "../profile/profile-scope.js";
import { listLocalProfiles } from "../profile/profile-sync.js";
import type { L2RunnerResult } from "../../utils/pipeline-manager.js";
import type { IMemoryStore, L0Record, MemoryScope } from "../store/types.js";
import type { MemoryTdaiConfig } from "../../config.js";
import type { LLMRunner, Logger } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";

const TAG = "[memory-tdai][personal-extract]";

/** Default agentId namespace for personal-scope rows. */
export const DEFAULT_PERSONAL_AGENT = "personal:workbuddy";

export interface PersonalL0WriteParams {
  /** VectorStore to write L0 into (must NOT be degraded). */
  vectorStore: IMemoryStore;
  /** Personal sessionKey — use `sha1(vendor + "|" + sessionId)` (source_key). */
  sessionKey: string;
  /** Source sessionId (for lineage / L2 key). */
  sessionId: string;
  /** Acting user id (also used as the scope owner). */
  userId: string;
  /** Owning user for personal rows. Defaults to `userId`. */
  ownerUserId?: string;
  /** Vendor / agent namespace for profile isolation. */
  vendor?: string;
  /** Source conversation messages (chronological, oldest → newest). */
  messages: ConversationMessage[];
  /** Logger. */
  logger?: Logger;
  /** StorageAdapter (unused for DB stores, but accepted for symmetry). */
  storage?: StorageAdapter;
  /** EmbeddingService — when provided and store does NOT support deferred embed, each L0 is embedded inline. */
  embeddingService?: { embed(content: string): Promise<Float32Array> | Float32Array; getDimensions(): number } | undefined;
}

/**
 * Build the `L0Record` array for a personal extraction. Pure — no I/O.
 * `id` is namespaced by `sessionKey` + source message id so a re-ingest of the
 * same message is an idempotent upsert (INSERT OR REPLACE) rather than a dup.
 */
export function buildPersonalL0Records(params: PersonalL0WriteParams): L0Record[] {
  const { sessionKey, sessionId, userId, ownerUserId, vendor, messages } = params;
  const agentId = vendor ? `personal:${vendor}` : DEFAULT_PERSONAL_AGENT;
  const now = new Date().toISOString();
  return messages.map((m, i) => ({
    id: `${sessionKey}:${m.id || i}`,
    sessionKey,
    sessionId,
    // Personal rows: empty teamId (resolveRecordScope hard-checks this),
    // userId carries the owner, agentId namespaced to avoid profile collision.
    teamId: "",
    userId,
    agentId,
    taskId: undefined,
    scope: "personal" as MemoryScope,
    ownerUserId: ownerUserId || userId,
    role: m.role,
    messageText: m.content,
    recordedAt: now,
    timestamp: m.timestamp,
  }));
}

/**
 * Write a source conversation's messages as personal-scope L0 records.
 *
 * Returns the number of records upserted. The VectorStore applies
 * `resolveRecordScope` internally, so the persisted rows are guaranteed to carry
 * `scope:"personal"` + `ownerUserId` (and an empty teamId).
 */
export async function writePersonalL0(params: PersonalL0WriteParams): Promise<number> {
  const { vectorStore, logger, embeddingService } = params;
  if (!vectorStore || vectorStore.isDegraded()) {
    logger?.warn?.(`${TAG} VectorStore unavailable/degraded — refusing to write personal L0`);
    return 0;
  }
  const records = buildPersonalL0Records(params);
  const supportsDeferred = vectorStore.supportsDeferredEmbedding === true;
  let written = 0;
  for (const rec of records) {
    try {
      let embedding: Float32Array | undefined;
      if (!supportsDeferred && embeddingService && embeddingService.getDimensions() > 0) {
        embedding = await embeddingService.embed(rec.messageText);
      }
      const ok = await vectorStore.upsertL0(rec, supportsDeferred ? undefined : embedding);
      if (ok) written++;
    } catch (err) {
      logger?.warn?.(`${TAG} upsertL0 failed for ${rec.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  logger?.debug?.(`${TAG} Wrote ${written}/${records.length} personal L0 records for ${params.sessionKey}`);
  return written;
}

export interface PersonalL1RunParams {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore;
  embeddingService?: unknown;
  logger: Logger;
  llmRunner?: LLMRunner;
  storage?: StorageAdapter;
  /** Personal sessionKey to drive the L1 runner for. */
  sessionKey: string;
  /** Hard cap on L1 rounds (each round processes up to L1_BATCH_PROCESS rows). */
  maxRounds?: number;
}

/**
 * Drive the production L1 runner for a personal `sessionKey` until the backlog is
 * drained (or `maxRounds` is hit). Reuses the runner's checkpoint cursor, so a
 * partial failure leaves the cursor where it stopped and the next run resumes.
 */
export async function runPersonalL1(params: PersonalL1RunParams): Promise<{ storedCount: number; rounds: number; hasMore: boolean }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, llmRunner, storage, sessionKey, maxRounds = 64 } = params;
  if (!vectorStore || vectorStore.isDegraded()) {
    logger?.warn?.(`${TAG} VectorStore unavailable/degraded — skipping personal L1`);
    return { storedCount: 0, rounds: 0, hasMore: false };
  }
  const runner = createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    embeddingService: embeddingService as never,
    logger,
    llmRunner,
    storage,
  });

  let storedCount = 0;
  let rounds = 0;
  let hasMore = true;
  while (hasMore && rounds < maxRounds) {
    const out = await runner({ sessionKey });
    storedCount += out.storedCount;
    rounds++;
    hasMore = out.hasMore || out.hasFullBacklog;
  }
  logger?.debug?.(`${TAG} Personal L1 done: stored=${storedCount}, rounds=${rounds}, hasMore=${hasMore}`);
  return { storedCount, rounds, hasMore };
}

export interface PersonalL2RunParams {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore;
  logger: Logger;
  /** Runner with `enableTools=true` — SceneExtractor requires tool-calling. */
  llmRunnerTools?: LLMRunner;
  storage?: StorageAdapter;
  /** Personal sessionKey to drive the L2 (scene) runner for. */
  sessionKey: string;
  /** Owner user id (scope dimension). */
  userId: string;
  /** Vendor / agent namespace for profile isolation. */
  vendor?: string;
  instanceId?: string;
}

export interface PersonalL3RunParams {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore?: IMemoryStore;
  logger: Logger;
  /** Runner with `enableTools=true` — PersonaGenerator requires tool-calling. */
  llmRunnerTools?: LLMRunner;
  storage?: StorageAdapter;
  /** Owner user id (scope dimension). */
  userId: string;
  vendor?: string;
  instanceId?: string;
}

/**
 * Drive the production L2 (scene) runner for a personal `sessionKey`. Reuses the
 * Chat_Memory SceneExtractor, which groups L1 records by isolation scope and
 * writes scene blocks into `dataDir/profiles/<encoded personal scope>/scene_blocks`.
 *
 * Returns the number of scene blocks written. Requires an `enableTools=true`
 * runner (SceneExtractor calls tools); without it we skip rather than crash.
 */
export async function runPersonalL2(params: PersonalL2RunParams): Promise<{ sceneCount: number; skipped: boolean }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, llmRunnerTools, storage, sessionKey, userId, vendor, instanceId } = params;
  if (!vectorStore || vectorStore.isDegraded()) {
    logger?.warn?.(`${TAG} VectorStore unavailable/degraded — skipping personal L2`);
    return { sceneCount: 0, skipped: false };
  }
  if (!llmRunnerTools) {
    logger?.warn?.(`${TAG} No tools-enabled LLM runner — skipping personal L2 (SceneExtractor requires tool calls)`);
    return { sceneCount: 0, skipped: false };
  }
  const agentId = vendor ? `personal:${vendor}` : DEFAULT_PERSONAL_AGENT;
  // Personal L1 records are migrated to team_id="default" (DEFAULT_ISOLATION_ID) at
  // store init, so buildIsolationScope(record) — used by SceneExtractor for the
  // WRITE directory — resolves to `team:default|agent:<agentId>`. Match it here for
  // the read directory; using teamId:"" would resolve to "local" and miss the files.
  const scope = buildProfileIsolationScope({ teamId: "default", userId, agentId });
  const runner = createL2Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    logger,
    instanceId,
    llmRunner: llmRunnerTools,
    storage,
  });
  const out = await runner(sessionKey);
  const skipped = !!(out && "skipped" in out && out.skipped);
  const scopedDir = scopedDataDirForScope(pluginDataDir, scope);
  let sceneCount = 0;
  try {
    const scenes = await readSceneIndex(scopedDir, storage);
    sceneCount = scenes.length;
  } catch {
    sceneCount = 0;
  }
  logger?.debug?.(`${TAG} Personal L2 done: scenes=${sceneCount}, skipped=${skipped}`);
  return { sceneCount, skipped };
}

/**
 * Drive the production L3 (persona) runner across all discovered profiles —
 * including the personal scope. The runner auto-discovers the personal scope
 * under `dataDir/profiles/`, checks the PersonaTrigger (cold-start fires on the
 * first scene), and writes `persona.md`.
 *
 * Returns the number of L3 persona documents produced.
 */
export async function runPersonalL3(params: PersonalL3RunParams): Promise<{ personaCount: number }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, logger, llmRunnerTools, storage, userId, vendor } = params;
  if (!llmRunnerTools) {
    logger?.warn?.(`${TAG} No tools-enabled LLM runner — skipping personal L3 (PersonaGenerator requires tool calls)`);
    return { personaCount: 0 };
  }
  const agentId = vendor ? `personal:${vendor}` : DEFAULT_PERSONAL_AGENT;
  // Keep the read scope aligned with the SceneExtractor WRITE directory (team:default,
  // see runPersonalL2). L3 persona.md lands under the same resolved scope.
  const scope = buildProfileIsolationScope({ teamId: "default", userId, agentId });
  const runner = createL3Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    logger,
    llmRunner: llmRunnerTools,
    storage,
  });
  await runner();
  const scopedDir = scopedDataDirForScope(pluginDataDir, scope);
  let personaCount = 0;
  try {
    const profiles = await listLocalProfiles(scopedDir, storage, { scope, isolation: parseProfileIsolationScope(scope) });
    personaCount = profiles.filter((p) => p.type === "l3").length;
  } catch {
    personaCount = 0;
  }
  logger?.debug?.(`${TAG} Personal L3 done: personas=${personaCount}`);
  return { personaCount };
}

export interface ExtractPersonalSourceParams extends PersonalL0WriteParams {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  /** Starting message index (0-based) within `messages` — for incremental re-ingest. */
  startIndex?: number;
  /** L1 round cap. */
  maxRounds?: number;
  /** Skip L1 (L0-only ingest). Deprecated in favour of `layers`. */
  skipL1?: boolean;
  /** Which layers to run. When omitted, defaults to L1 (gated by `skipL1`). */
  layers?: Array<"L1" | "L2" | "L3">;
  /** `enableTools=true` runner for L2/L3 SceneExtractor + PersonaGenerator. */
  llmRunnerTools?: LLMRunner;
  /** Plugin instance id (passed to L2/L3 runners for metric reporting). */
  instanceId?: string;
}

/**
 * Orchestrate a personal extraction for one source session: ingest the tail of a
 * conversation as personal L0, then run the requested layers of the Chat_Memory
 * pipeline (L1 → L2 → L3). Returns per-layer counts.
 *
 * `startIndex` lets the caller feed only NEW messages (incremental), while the L1
 * runner's own checkpoint cursor handles intra-L0 progress. The caller (the job)
 * owns the source-side cursor (file fingerprint + record index) — see
 * `personal-source-session-store.ts`.
 *
 * Layer semantics
 * ---------------
 * - `L1` drains L1 atom memories from the new L0 (skipped when `skipL1` or no L0).
 * - `L2` runs the SceneExtractor over this session's L1 records → scene blocks.
 * - `L3` runs the PersonaGenerator across discovered scopes (incl. personal) → persona.md.
 * L2/L3 require `llmRunnerTools` (tool-calling); without it they are skipped.
 */
export async function extractPersonalFromSource(params: ExtractPersonalSourceParams): Promise<{ l0Count: number; l1Count: number; l1Rounds: number; l2Count: number; l3Count: number }> {
  const { messages, startIndex = 0, skipL1, layers, pluginDataDir, cfg, openclawConfig, maxRounds, logger } = params;
  const includeL1 = layers ? layers.includes("L1") : !skipL1;
  const includeL2 = layers ? layers.includes("L2") : false;
  const includeL3 = layers ? layers.includes("L3") : false;

  const tail = messages.slice(Math.max(0, startIndex));
  let l0Count = 0;
  if (tail.length > 0) {
    l0Count = await writePersonalL0({ ...params, messages: tail });
  } else {
    logger?.debug?.(`${TAG} No new source messages at startIndex=${startIndex} — skipping L0 write`);
  }
  let l1Count = 0;
  let l1Rounds = 0;
  let l2Count = 0;
  let l3Count = 0;

  if (includeL1 && l0Count > 0) {
    const r = await runPersonalL1({
      pluginDataDir,
      cfg,
      openclawConfig,
      vectorStore: params.vectorStore,
      embeddingService: params.embeddingService,
      logger,
      llmRunner: params.llmRunner,
      storage: params.storage,
      sessionKey: params.sessionKey,
      maxRounds,
    });
    l1Count = r.storedCount;
    l1Rounds = r.rounds;
  }
  if (includeL2) {
    const r2 = await runPersonalL2({
      pluginDataDir,
      cfg,
      openclawConfig,
      vectorStore: params.vectorStore,
      logger,
      llmRunnerTools: params.llmRunnerTools,
      storage: params.storage,
      sessionKey: params.sessionKey,
      userId: params.userId,
      vendor: params.vendor,
      instanceId: params.instanceId,
    });
    l2Count = r2.sceneCount;
  }
  if (includeL3) {
    const r3 = await runPersonalL3({
      pluginDataDir,
      cfg,
      openclawConfig,
      vectorStore: params.vectorStore,
      logger,
      llmRunnerTools: params.llmRunnerTools,
      storage: params.storage,
      userId: params.userId,
      vendor: params.vendor,
      instanceId: params.instanceId,
    });
    l3Count = r3.personaCount;
  }
  return { l0Count, l1Count, l1Rounds, l2Count, l3Count };
}
