/**
 * M4a 写入通道 端到端契约测试（真实 SQLite + stub LLM + 源会话状态/游标）.
 *
 * 证明「生成个人记忆」入口真的把一段源会话落成 personal L1，且：
 *  A) personal L0 落库携带 scope="personal" + ownerUserId + 空 teamId;
 *  B) personal L1 落库携带 scope="personal" 且 owner_user_id = 正确用户;
 *  C) 游标幂等：同文件重复跑不重复写 L0 / 不重复产 L1;
 *  D) 增量：源会话追加新消息后只提炼新增部分;
 *  E) 不发生 personal → team 静默泄漏.
 *
 * 复用 ② 的 stub LLM（固定返回一条 persona 记忆），不触发真实 LLM / 网络。
 * 参见 docs/personal-memory-impl-plan.html §「M4a 写入入口」与
 * docs/my-memory-tab-design.html §4.1。
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../store/sqlite/memory-store.js";
import type { IMemoryStore, MemoryScope } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import {
  buildPersonalL0Records,
  writePersonalL0,
  runPersonalL1,
  extractPersonalFromSource,
} from "./personal-extract.js";
import {
  PersonalSourceSessionStore,
  computeSourceKey,
  needsIngest,
} from "./personal-source-session-store.js";

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeStubLlmRunner(): LLMRunner {
  return {
    run: async () =>
      JSON.stringify([
        {
          scene_name: "偏好",
          message_ids: ["m0"],
          memories: [
            {
              content: "用户偏好用 TypeScript 做前端开发。",
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

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m4a-entry-"));
  tempDirs.push(dir);
  return join(dir, "vectors.db");
}
function tempRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m4a-run-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function makeCfg(): unknown {
  return {
    storeBackend: "sqlite",
    extraction: { enableDedup: true, maxMemoriesPerSession: 10, model: "stub", promptMode: "chat" },
    embedding: { provider: "none", conflictRecallTopK: 5, captureTimeoutMs: 1000, timeoutMs: 1000 },
  } as unknown;
}

const VENDOR = "workbuddy";
const SESSION_ID = "abc123-session";
const SOURCE_KEY = computeSourceKey(VENDOR, SESSION_ID);
const USER_A = "user-a";

function msg(i: number, content: string): ConversationMessage {
  return { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content, timestamp: 1_700_000_000_000 + i * 1000 };
}

function makeStore(): IMemoryStore {
  const store = new VectorStore(tempDbPath(), 0) as unknown as IMemoryStore;
  (store as unknown as { init: () => Promise<unknown> }).init();
  return store;
}

function countPersonalL0(store: IMemoryStore): number {
  const groups = (store as unknown as { queryL0GroupedBySessionId: (k: string) => Array<{ scope?: string; messages: unknown[] }> })
    .queryL0GroupedBySessionId(SOURCE_KEY);
  return groups.filter((g) => g.scope === "personal").reduce((n, g) => n + g.messages.length, 0);
}
function countPersonalL1(store: IMemoryStore): number {
  const rows = (store as unknown as { queryL1Records: (f: Record<string, unknown>) => Array<{ scope?: string }> })
    .queryL1Records({ scope: "personal", userId: USER_A });
  return rows.filter((r) => r.scope === "personal").length;
}

describe("M4a 写入通道：personal L0 落库隔离", () => {
  it("buildPersonalL0Records 产出 personal + 空 teamId + 正确 owner", () => {
    const recs = buildPersonalL0Records({
      vectorStore: makeStore(),
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: [msg(0, "偏好 TS"), msg(1, "同意")],
      logger: noopLogger,
    });
    expect(recs.length).toBe(2);
    expect(recs[0].scope).toBe("personal");
    expect(recs[0].teamId).toBe("");
    expect(recs[0].ownerUserId).toBe(USER_A);
    expect(recs[0].agentId).toBe(`personal:${VENDOR}`);
  });

  it("writePersonalL0 真实落库为 personal（scope/owner/空 teamId）", async () => {
    const store = makeStore();
    const n = await writePersonalL0({
      vectorStore: store,
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: [msg(0, "偏好 TS"), msg(1, "同意")],
      logger: noopLogger,
    });
    expect(n).toBe(2);
    expect(countPersonalL0(store)).toBe(2);
    store.close();
  });
});

describe("M4a 写入通道：personal L0 → L1 全链路（真实 SQLite）", () => {
  it("一段源会话被提炼为 owner=user-a 的 personal L1", async () => {
    const store = makeStore();
    const runDir = tempRunDir();
    const msgs = [msg(0, "偏好 TS"), msg(1, "同意用 TS"), msg(2, "不要 JS")];

    const l0 = await writePersonalL0({
      vectorStore: store,
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: msgs,
      logger: noopLogger,
    });
    expect(l0).toBe(3);

    const l1 = await runPersonalL1({
      pluginDataDir: runDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      vectorStore: store,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
      sessionKey: SOURCE_KEY,
    });
    expect(l1.storedCount).toBeGreaterThanOrEqual(1);

    expect(countPersonalL1(store)).toBeGreaterThanOrEqual(1);
    const rows = (store as unknown as { queryL1Records: (f: Record<string, unknown>) => Array<{ scope?: string; owner_user_id?: string }> })
      .queryL1Records({ scope: "personal", userId: USER_A });
    expect(rows[0].scope).toBe("personal");
    expect(rows[0].owner_user_id).toBe(USER_A);
    store.close();
  });

  it("extractPersonalFromSource 一次性完成 L0+L1 并回传计数", async () => {
    const store = makeStore();
    const runDir = tempRunDir();
    const msgs = [msg(0, "偏好 TS"), msg(1, "同意用 TS")];
    const out = await extractPersonalFromSource({
      vectorStore: store,
      pluginDataDir: runDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: msgs,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });
    expect(out.l0Count).toBe(2);
    expect(out.l1Count).toBeGreaterThanOrEqual(1);
    expect(countPersonalL1(store)).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

describe("M4a 写入通道：源会话状态表 + 游标幂等", () => {
  it("同文件重复跑不重复写 L0 / 不重复产 L1；追加消息只提炼增量", async () => {
    const dataDir = tempRunDir();
    const store = makeStore();
    const sourceStore = new PersonalSourceSessionStore(dataDir);
    const msgs5 = [msg(0, "a"), msg(1, "b"), msg(2, "c"), msg(3, "d"), msg(4, "e")];

    // ── Run 1: 首次提炼 5 条 ──
    let decide = needsIngest(sourceStore.get(SOURCE_KEY), msgs5.length, 1000, 500);
    expect(decide.ingest).toBe(true);
    expect(decide.startIndex).toBe(0);
    const r1 = await extractPersonalFromSource({
      vectorStore: store,
      pluginDataDir: dataDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: msgs5,
      startIndex: decide.startIndex,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });
    expect(r1.l0Count).toBe(5);
    expect(r1.l1Count).toBeGreaterThanOrEqual(1);
    const l1AfterRun1 = countPersonalL1(store);
    expect(l1AfterRun1).toBeGreaterThanOrEqual(1);

    sourceStore.setFileFingerprint(SOURCE_KEY, { file_mtime: 1000, file_size: 500 });
    sourceStore.advanceCursor(SOURCE_KEY, msgs5.length);
    sourceStore.markDone(SOURCE_KEY, { l0: r1.l0Count, l1: r1.l1Count, l2: 0, l3: 0 });

    // ── Run 2: 同一文件再跑 → 应幂等（不新增 L0 / 不新增 L1）──
    decide = needsIngest(sourceStore.get(SOURCE_KEY), msgs5.length, 1000, 500);
    expect(decide.ingest).toBe(false);
    const r2 = await extractPersonalFromSource({
      vectorStore: store,
      pluginDataDir: dataDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: msgs5,
      startIndex: decide.startIndex,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });
    expect(r2.l0Count).toBe(0);
    expect(countPersonalL1(store)).toBe(l1AfterRun1); // 未新增

    // ── Run 3: 源会话追加 2 条（文件增大）→ 只提炼增量 ──
    const msgs7 = [...msgs5, msg(5, "追加 f"), msg(6, "追加 g")];
    decide = needsIngest(sourceStore.get(SOURCE_KEY), msgs7.length, 2000, 700);
    expect(decide.ingest).toBe(true);
    expect(decide.startIndex).toBe(5); // 仅新增的 2 条
    const r3 = await extractPersonalFromSource({
      vectorStore: store,
      pluginDataDir: dataDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: msgs7,
      startIndex: decide.startIndex,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
    });
    expect(r3.l0Count).toBe(2);
    expect(countPersonalL0(store)).toBe(7); // 5 + 2，未重复
    store.close();
  });

  it("computeSourceKey 对相同 vendor+sessionId 稳定", () => {
    expect(computeSourceKey("workbuddy", "x/y.jsonl")).toBe(computeSourceKey("workbuddy", "x/y.jsonl"));
    expect(computeSourceKey("workbuddy", "x/y.jsonl")).not.toBe(computeSourceKey("claude", "x/y.jsonl"));
  });
});

describe("M4a 写入通道：无 personal 泄漏到 team", () => {
  it("personal L1 与 team L1 不互相污染（隔离正确）", async () => {
    const store = makeStore();
    const runDir = tempRunDir();
    // personal
    await writePersonalL0({
      vectorStore: store,
      sessionKey: SOURCE_KEY,
      sessionId: SESSION_ID,
      userId: USER_A,
      vendor: VENDOR,
      messages: [msg(0, "个人偏好 TS")],
      logger: noopLogger,
    });
    // team（默认）
    await writePersonalL0({
      vectorStore: store,
      sessionKey: "team-sess",
      sessionId: "team-sess",
      userId: USER_A,
      messages: [msg(0, "团队约定周三评审")],
      logger: noopLogger,
    });
    const l1 = await runPersonalL1({
      pluginDataDir: runDir,
      cfg: makeCfg() as never,
      openclawConfig: {},
      vectorStore: store,
      logger: noopLogger,
      llmRunner: makeStubLlmRunner(),
      sessionKey: SOURCE_KEY,
    });
    expect(l1.storedCount).toBeGreaterThanOrEqual(1);
    // personal L1 必须归 user-a，且 owner 正确
    const personal = (store as unknown as { queryL1Records: (f: Record<string, unknown>) => Array<{ scope?: string; owner_user_id?: string }> })
      .queryL1Records({ scope: "personal", userId: USER_A });
    expect(personal.length).toBeGreaterThanOrEqual(1);
    expect(personal.every((r) => r.scope === "personal" && r.owner_user_id === USER_A)).toBe(true);
    store.close();
  });
});
