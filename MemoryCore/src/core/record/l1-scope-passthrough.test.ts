/**
 * M4a′ scope pass-through contract (管线 scope 透传).
 *
 * Two layers of proof that a `scope:"personal"` write request is NOT silently
 * collapsed to team:
 *
 *  A) Extractor-level (no real LLM / no real store beyond a recorder): exercises
 *     the exact write path that the plan flagged as "漏这处等于白做" — the
 *     `extractL1Memories` → `writeMemory` → `upsertL1` chain must carry scope +
 *     ownerUserId end-to-end.
 *
 *  B) Pipeline-level (real SQLite VectorStore + stub LLM): exercises the plumbing
 *     in `pipeline-factory.ts createL1Runner` — `queryL0GroupedBySessionId` now
 *     returns `scope`, the regroup groupKey carries taskId + scope, and the value
 *     is forwarded into `extractL1Memories`. A personal L0 must land as a
 *     personal L1 owned by the right user.
 *
 * See docs/personal-memory-impl-plan.html §「② 提炼管线 scope 盲」.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractL1Memories } from "./l1-extractor.js";
import { createL1Runner } from "../../utils/pipeline-factory.js";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { resolveRecordScope } from "../store/isolation.js";
import type { LLMRunner, Logger } from "../types.js";
import type { IMemoryStore, MemoryScope } from "../store/types.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Stub LLM that returns a fixed, well-formed extraction — no network/LLM. */
function makeStubLlmRunner(): LLMRunner {
  return {
    run: async () =>
      JSON.stringify([
        {
          scene_name: "偏好",
          message_ids: ["m0"],
          memories: [
            {
              content: "用户在今天的会议中明确表示，他更偏好使用 TypeScript 而不是 JavaScript 来做前端开发。",
              type: "persona",
              priority: 60,
              source_message_ids: ["m0"],
              metadata: {},
            },
          ],
        },
      ]),
  };
}

/**
 * Recording VectorStore mock — dedup is skipped (no recall capability). Mirrors
 * the real SQLite/MongoDB adapter by applying `resolveRecordScope` before the
 * row "lands", so captured values reflect what the store would actually persist.
 */
function makeRecordingStore(captured: Array<Record<string, unknown>>): IMemoryStore {
  const store = {
    countL1: () => 0,
    isFtsAvailable: () => false,
    isDegraded: () => false,
    upsertL1: (record: { scope?: string; ownerUserId?: string; teamId?: string; userId?: string } & Record<string, unknown>) => {
      const resolved = resolveRecordScope(record);
      captured.push({ ...(record as Record<string, unknown>), scope: resolved.scope, ownerUserId: resolved.ownerUserId });
      return true;
    },
  };
  return store as unknown as IMemoryStore;
}

/** Minimal in-memory storage adapter — suppresses JSONL/LOG fs writes. */
const storageMock = {
  appendFile: async () => {},
  write: async () => {},
} as unknown as never;

const baseExtractionParams = {
  sessionKey: "sess-1",
  sessionId: "sess-1",
  userId: "user-a",
  agentId: "agent-1",
  baseDir: "/tmp/l1-scope-test",
  config: {},
  storage: storageMock,
  logger: noopLogger,
  options: {
    llmRunner: makeStubLlmRunner(),
  },
} as Record<string, unknown>;

describe("M4a′ L1 scope pass-through (extractor + sink)", () => {
  it("personal scope → persisted L1 is personal, owned by acting user", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const store = makeRecordingStore(captured);
    const result = await extractL1Memories({
      ...baseExtractionParams,
      messages: [{ id: "m0", role: "user", content: "用户在今天的会议中明确表示，他更偏好使用 TypeScript 而不是 JavaScript 来做前端开发。", timestamp: Date.now() }],
      scope: "personal" as MemoryScope,
      options: { ...(baseExtractionParams.options as object), vectorStore: store },
    } as Record<string, unknown> & { messages: unknown });

    expect(result.records.length).toBe(1);
    expect(result.records[0].scope).toBe("personal");
    // Store sink (upsertL1 → resolveRecordScope) normalises owner to the acting
    // user when no explicit ownerUserId is supplied.
    expect(captured.length).toBe(1);
    expect(captured[0].scope).toBe("personal");
    expect(captured[0].ownerUserId).toBe("user-a");
  });

  it("personal scope with explicit ownerUserId is honoured", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const store = makeRecordingStore(captured);
    const result = await extractL1Memories({
      ...baseExtractionParams,
      messages: [{ id: "m0", role: "user", content: "用户在今天的会议中明确表示，他更偏好使用 TypeScript 而不是 JavaScript 来做前端开发。", timestamp: Date.now() }],
      scope: "personal" as MemoryScope,
      ownerUserId: "owner-x",
      options: { ...(baseExtractionParams.options as object), vectorStore: store },
    } as Record<string, unknown> & { messages: unknown });

    expect(result.records[0].scope).toBe("personal");
    expect(captured[0].ownerUserId).toBe("owner-x");
  });

  it("team scope (default) → persisted L1 has no stray owner", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const store = makeRecordingStore(captured);
    const result = await extractL1Memories({
      ...baseExtractionParams,
      messages: [{ id: "m0", role: "user", content: "团队约定每周三上午做一次技术方案同步评审。", timestamp: Date.now() }],
      options: { ...(baseExtractionParams.options as object), vectorStore: store },
    } as Record<string, unknown> & { messages: unknown });

    const gotScope = result.records[0].scope;
    expect(gotScope === undefined || gotScope === "team").toBe(true);
    expect(captured[0].scope).toBe("team");
    expect(captured[0].ownerUserId).toBe("");
  });
});

// ── Pipeline-level (real SQLite VectorStore + stub LLM) ──────────────────────

const tempDirs: string[] = [];
function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m4a-pipe-"));
  tempDirs.push(dir);
  return join(dir, "vectors.db");
}
afterAll(() => {
  for (const dir of tempDirs) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function makeCfg(): unknown {
  return {
    storeBackend: "sqlite",
    extraction: { enableDedup: true, maxMemoriesPerSession: 10, model: "stub", promptMode: "chat" },
    embedding: { provider: "none", conflictRecallTopK: 5, captureTimeoutMs: 1000, timeoutMs: 1000 },
  } as unknown;
}

describe("M4a′ pipeline scope pass-through (L0 personal → L1 personal)", () => {
  it("a personal-scope L0 is extracted into a personal-scope L1 owned by the user", async () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();

    const ts = Date.now();
    // Seed a personal-scope L0 message (the shape L0-recorder / upsertL0 expect).
    store.upsertL0(
      {
        id: "l0-1",
        sessionKey: "sess-1",
        sessionId: "sess-1",
        userId: "user-a",
        agentId: "agent-1",
        role: "user",
        messageText: "用户在今天的会议中明确表示，他更偏好使用 TypeScript 而不是 JavaScript 来做前端开发。",
        recordedAt: new Date(ts).toISOString(),
        timestamp: ts,
        scope: "personal",
      } as never,
      undefined,
    );

    const tempRunDir = mkdtempSync(join(tmpdir(), "m4a-run-"));
    tempDirs.push(tempRunDir);

    const runner = createL1Runner({
      pluginDataDir: tempRunDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      vectorStore: store as unknown as IMemoryStore,
      embeddingService: undefined,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });

    const out = await runner({ sessionKey: "sess-1" });
    expect(out.storedCount).toBeGreaterThanOrEqual(1);

    // Read back personal rows for user-a and assert scope + owner.
    const personalRows = store.queryL1Records({ scope: "personal", userId: "user-a" }) as Array<{ scope?: string; owner_user_id?: string }>;
    expect(personalRows.length).toBeGreaterThanOrEqual(1);
    expect(personalRows[0].scope).toBe("personal");
    expect(personalRows[0].owner_user_id).toBe("user-a");

    store.close();
  });

  it("no personal L0 → no personal L1 is produced (no silent team leak)", async () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();

    const ts = Date.now();
    store.upsertL0(
      {
        id: "l0-2",
        sessionKey: "sess-2",
        sessionId: "sess-2",
        userId: "user-a",
        agentId: "agent-1",
        role: "user",
        messageText: "团队约定每周三上午做一次技术方案同步评审。",
        recordedAt: new Date(ts).toISOString(),
        timestamp: ts,
        // explicitly team (or omitted → defaults team)
      } as never,
      undefined,
    );

    const tempRunDir = mkdtempSync(join(tmpdir(), "m4a-run2-"));
    tempDirs.push(tempRunDir);

    const runner = createL1Runner({
      pluginDataDir: tempRunDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      vectorStore: store as unknown as IMemoryStore,
      embeddingService: undefined,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });

    await runner({ sessionKey: "sess-2" });

    const personalRows = store.queryL1Records({ scope: "personal", userId: "user-a" }) as Array<{ scope?: string }>;
    expect(personalRows.length).toBe(0);

    // The team L1 that WAS produced must be normalised: scope="team", no owner.
    const teamRows = store.queryL1Records({ userId: "user-a" }) as Array<{ scope?: string; owner_user_id?: string }>;
    expect(teamRows.length).toBeGreaterThanOrEqual(1);
    expect(teamRows[0].scope).toBe("team");
    expect(teamRows[0].owner_user_id).toBe("");

    store.close();
  });
});
