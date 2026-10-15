/**
 * M3 personal-scope storage contract — backend-agnostic suite.
 *
 * Encodes the three M3 DoDs from `docs/personal-memory-space-design.html`
 * §1① and the milestone contract in `docs/personal-space-plan.html` (M3):
 *
 *   DoD①  A personal-scope read with userId=X must never return another
 *         user's rows — any cross-user hit fails the test.
 *   DoD②  The team path behaves byte-identically to pre-M3: legacy rows
 *         (scope column absent → defaulted "team") and no-scope filters
 *         keep their old semantics; explicit scope="team" narrows cleanly.
 *   DoD③  A personal write carrying a teamId is a hard contract violation
 *         (IsolationError), never a silent repair.
 *
 * The suite is written against the narrow `PersonalScopeStore` surface so it
 * can run against any backend adapter. Each backend ships a thin `*.test.ts`
 * runner (see `sqlite/personal-scope.test.ts`); MongoDB pushdown is covered
 * by the pure-function unit tests in `mongodb/personal-scope-pushdown.test.ts`
 * (no server required).
 *
 * Sync-or-async: every store call is awaited, so both the synchronous SQLite
 * adapter and the async Mongo adapter satisfy the same contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type {
  IMemoryStore,
  L0CountFilter,
  L0FtsResult,
  L0PaginatedFilter,
  L0PaginatedResult,
  L0QueryRow,
  L0Record,
  L1CountFilter,
  L1FtsResult,
  L1PaginatedFilter,
  L1PaginatedResult,
  L1QueryFilter,
  L1RecordRow,
} from "../types.js";
import { IsolationError, type IsolationFilter } from "../isolation.js";

// ── Fixture identities ──────────────────────────────────────────

export const TEAM_T1 = "team-t1";
export const USER_A = "user-a";
export const USER_B = "user-b";
export const AGENT_1 = "agent-1";
export const SESS_A = "sess-a";
export const SESS_B = "sess-b";

/** Row ids seeded by {@link seedScopeMatrix}. */
export const IDS = {
  l1TeamA: "l1-team-a",
  l1Legacy: "l1-legacy",
  l1PersA1: "l1-pers-a1",
  l1PersA2: "l1-pers-a2",
  l1PersB1: "l1-pers-b1",
  l0TeamA: "l0-team-a",
  l0Legacy: "l0-legacy",
  l0PersA1: "l0-pers-a1",
  l0PersA2: "l0-pers-a2",
  l0PersB1: "l0-pers-b1",
} as const;

/**
 * The subset of `IMemoryStore` the contract exercises. Result types are the
 * canonical `store/types.ts` shapes — the SQLite adapter's local result
 * interfaces are structurally identical.
 */
export interface PersonalScopeStore {
  upsertL1(record: MemoryRecord, embedding?: Float32Array): boolean | Promise<boolean>;
  upsertL0(record: L0Record, embedding?: Float32Array): boolean | Promise<boolean>;
  deleteL1(recordId: string, filter?: IsolationFilter): boolean | Promise<boolean>;
  deleteL1Batch(recordIds: string[], filter?: IsolationFilter): boolean | Promise<boolean>;
  deleteL0(recordId: string, filter?: IsolationFilter): boolean | Promise<boolean>;
  deleteL0BySession(sessionId: string, filter?: IsolationFilter): number | Promise<number>;
  countL1(filter?: L1CountFilter): number | Promise<number>;
  countL0(filter?: L0CountFilter): number | Promise<number>;
  queryL1Records(filter?: L1QueryFilter): L1RecordRow[] | Promise<L1RecordRow[]>;
  queryL1Paginated(filter: L1PaginatedFilter): L1PaginatedResult | Promise<L1PaginatedResult>;
  queryL0Paginated(filter: L0PaginatedFilter): L0PaginatedResult | Promise<L0PaginatedResult>;
  searchL1Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): L1FtsResult[] | Promise<L1FtsResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): L0FtsResult[] | Promise<L0FtsResult[]>;
}

export interface PersonalScopeHarness {
  /** Human-readable backend name used in the suite title. */
  backend: string;
  /** Whether the backend has keyword search wired up (FTS available). */
  ftsAvailable: boolean;
  createStore(): Promise<PersonalScopeStore> | PersonalScopeStore;
  destroyStore(store: PersonalScopeStore): Promise<void> | void;
}

// ── Seed helpers (exported so runners can reuse for pushdown probes) ──

const NOW = "2026-10-12T00:00:00.000Z";

export function makeL1Record(
  id: string,
  content: string,
  dims: {
    teamId?: string;
    userId: string;
    scope?: "personal" | "team";
    ownerUserId?: string;
    sessionId?: string;
  },
): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [NOW],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    sessionKey: `sk-${dims.sessionId ?? dims.userId}`,
    sessionId: dims.sessionId ?? SESS_A,
    teamId: dims.teamId,
    userId: dims.userId,
    agentId: AGENT_1,
    scope: dims.scope,
    ownerUserId: dims.ownerUserId,
  };
}

export function makeL0Record(
  id: string,
  messageText: string,
  dims: {
    teamId?: string;
    userId: string;
    scope?: "personal" | "team";
    ownerUserId?: string;
    sessionId?: string;
    role?: string;
  },
): L0Record {
  return {
    id,
    sessionKey: `sk-${dims.sessionId ?? dims.userId}`,
    sessionId: dims.sessionId ?? SESS_A,
    teamId: dims.teamId,
    userId: dims.userId,
    agentId: AGENT_1,
    scope: dims.scope,
    ownerUserId: dims.ownerUserId,
    role: dims.role ?? "user",
    messageText,
    recordedAt: NOW,
    timestamp: Date.parse(NOW),
  };
}

/**
 * Seed the 3×3 isolation matrix used by every DoD test:
 *
 *   L1/L0 × { team row (explicit), legacy row (no scope field),
 *             personal row user A ×2, personal row user B }
 *
 * `l1-legacy` / `l0-legacy` are written WITHOUT the scope field — exactly the
 * pre-M3 write path — so the team-path regression tests observe real legacy
 * rows (scope column defaulted to "team" by the schema).
 */
export async function seedScopeMatrix(store: PersonalScopeStore): Promise<void> {
  await store.upsertL1(makeL1Record(IDS.l1TeamA, "team alpha note", { teamId: TEAM_T1, userId: USER_A, scope: "team", sessionId: SESS_A }));
  await store.upsertL1(makeL1Record(IDS.l1Legacy, "legacy alpha note", { teamId: TEAM_T1, userId: USER_A, sessionId: SESS_A }));
  await store.upsertL1(makeL1Record(IDS.l1PersA1, "personal alpha note", { userId: USER_A, scope: "personal", sessionId: SESS_A }));
  await store.upsertL1(makeL1Record(IDS.l1PersA2, "personal alpha extra", { userId: USER_A, scope: "personal", sessionId: SESS_A }));
  await store.upsertL1(makeL1Record(IDS.l1PersB1, "personal beta note", { userId: USER_B, scope: "personal", sessionId: SESS_B }));

  await store.upsertL0(makeL0Record(IDS.l0TeamA, "team alpha message", { teamId: TEAM_T1, userId: USER_A, scope: "team", sessionId: SESS_A }));
  await store.upsertL0(makeL0Record(IDS.l0Legacy, "legacy alpha message", { teamId: TEAM_T1, userId: USER_A, sessionId: SESS_A }));
  await store.upsertL0(makeL0Record(IDS.l0PersA1, "personal alpha message", { userId: USER_A, scope: "personal", sessionId: SESS_A }));
  await store.upsertL0(makeL0Record(IDS.l0PersA2, "personal alpha message extra", { userId: USER_A, scope: "personal", sessionId: SESS_A }));
  await store.upsertL0(makeL0Record(IDS.l0PersB1, "personal beta message", { userId: USER_B, scope: "personal", sessionId: SESS_B }));
}

// ── The contract suite ─────────────────────────────────────────

/**
 * Assert that calling `fn` surfaces an `IsolationError` — via a synchronous
 * throw (SQLite adapter) OR a rejected promise (async adapters). Both are
 * acceptable fail-loud shapes; what is NOT acceptable is returning normally.
 */
async function expectIsolationError(fn: () => unknown): Promise<void> {
  let threw = false;
  let thrown: unknown;
  let returned: unknown;
  try {
    returned = fn();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  if (!threw && returned instanceof Promise) {
    await expect(returned).rejects.toBeInstanceOf(IsolationError);
    return;
  }
  expect(thrown).toBeInstanceOf(IsolationError);
}

/**
 * Register the M3 personal-scope contract suite for one backend.
 * Call from a `*.test.ts` runner inside the backend's directory.
 */
export function runPersonalScopeContract(harness: PersonalScopeHarness): void {
  describe(`M3 personal-scope storage contract [${harness.backend}]`, () => {
    let store: PersonalScopeStore;

    beforeEach(async () => {
      store = await harness.createStore();
      await seedScopeMatrix(store);
    });

    afterEach(async () => {
      await harness.destroyStore(store);
    });

    // ── DoD①: cross-userId isolation (a hit = test failure) ──

    describe("DoD① cross-user isolation", () => {
      it("queryL1Records({scope:personal, userId:A}) returns only A's rows", async () => {
        const rows = await store.queryL1Records({ scope: "personal", userId: USER_A });
        const ids = rows.map((r) => r.record_id).sort();
        expect(ids).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());
        for (const r of rows) {
          expect(r.scope).toBe("personal");
          expect(r.owner_user_id).toBe(USER_A);
        }
      });

      it("queryL1Records({scope:personal, userId:B}) returns only B's rows", async () => {
        const rows = await store.queryL1Records({ scope: "personal", userId: USER_B });
        expect(rows.map((r) => r.record_id)).toEqual([IDS.l1PersB1]);
      });

      it("countL1 personal counts are per-owner", async () => {
        expect(await store.countL1({ scope: "personal", userId: USER_A })).toBe(2);
        expect(await store.countL1({ scope: "personal", userId: USER_B })).toBe(1);
        expect(await store.countL1({ scope: "personal", userId: "user-ghost" })).toBe(0);
      });

      it("queryL1Paginated personal page contains only A's rows", async () => {
        const page = await store.queryL1Paginated({ scope: "personal", userId: USER_A, limit: 10, offset: 0 });
        expect(page.total).toBe(2);
        expect(page.rows.map((r) => r.record_id).sort()).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());
      });

      it("searchL1Fts personal recall never crosses users", async () => {
        const hits = await store.searchL1Fts("alpha", 10, { scope: "personal", userId: USER_A });
        const ids = hits.map((h) => h.record_id).sort();
        expect(ids).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());
        for (const h of hits) {
          expect(h.scope).toBe("personal");
          expect(h.owner_user_id).toBe(USER_A);
        }
      });

      it("countL0 / queryL0Paginated / searchL0Fts personal isolation holds", async () => {
        expect(await store.countL0({ scope: "personal", userId: USER_A })).toBe(2);
        expect(await store.countL0({ scope: "personal", userId: USER_B })).toBe(1);

        const page = await store.queryL0Paginated({ scope: "personal", userId: USER_A, limit: 10, offset: 0 });
        expect(page.total).toBe(2);
        expect(page.rows.map((r) => r.record_id).sort()).toEqual([IDS.l0PersA1, IDS.l0PersA2].sort());

        const hits = await store.searchL0Fts("alpha", 10, { scope: "personal", userId: USER_A });
        expect(hits.map((h) => h.record_id).sort()).toEqual([IDS.l0PersA1, IDS.l0PersA2].sort());
      });

      it("ownerUserId narrows within a user's own rows", async () => {
        const rows = await store.queryL1Records({ scope: "personal", userId: USER_A, ownerUserId: USER_A });
        expect(rows.map((r) => r.record_id).sort()).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());
        // ownerUserId pointing at another user must not leak that user's rows.
        const leaked = await store.queryL1Records({ scope: "personal", userId: USER_A, ownerUserId: USER_B });
        expect(leaked).toEqual([]);
      });

      it("personal reads without userId fail loud (leak guard)", async () => {
        const guard = { scope: "personal" as const };
        await expectIsolationError(() => store.queryL1Records(guard));
        await expectIsolationError(() => store.countL1(guard));
        await expectIsolationError(() => store.countL0(guard));
        await expectIsolationError(() => store.queryL1Paginated({ ...guard, limit: 10, offset: 0 }));
        await expectIsolationError(() => store.queryL0Paginated({ ...guard, limit: 10, offset: 0 }));
        await expectIsolationError(() => store.searchL1Fts("alpha", 10, guard));
        await expectIsolationError(() => store.searchL0Fts("alpha", 10, guard));
      });

      it("personal deletes without userId fail loud (leak guard)", async () => {
        const guard = { scope: "personal" as const };
        await expectIsolationError(() => store.deleteL1(IDS.l1PersA1, guard));
        await expectIsolationError(() => store.deleteL1Batch([IDS.l1PersA1], guard));
        await expectIsolationError(() => store.deleteL0(IDS.l0PersA1, guard));
        await expectIsolationError(() => store.deleteL0BySession(SESS_A, guard));
      });

      it("deleteL1 cannot cross users (wrong-owner delete is a no-op)", async () => {
        expect(await store.deleteL1(IDS.l1PersA1, { scope: "personal", userId: USER_B })).toBe(false);
        const rows = await store.queryL1Records({ scope: "personal", userId: USER_A });
        expect(rows.map((r) => r.record_id).sort()).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());
        expect(await store.deleteL1(IDS.l1PersA1, { scope: "personal", userId: USER_A })).toBe(true);
      });

      it("deleteL1Batch only removes the caller's own rows", async () => {
        await store.deleteL1Batch([IDS.l1PersA2, IDS.l1PersB1], { scope: "personal", userId: USER_A });
        expect(await store.countL1({ scope: "personal", userId: USER_A })).toBe(1);
        expect(await store.countL1({ scope: "personal", userId: USER_B })).toBe(1);
      });

      it("deleteL0BySession only removes the caller's own rows", async () => {
        expect(await store.deleteL0BySession(SESS_A, { scope: "personal", userId: USER_B })).toBe(0);
        expect(await store.deleteL0BySession(SESS_A, { scope: "personal", userId: USER_A })).toBe(2);
        expect(await store.countL0({ scope: "personal", userId: USER_B })).toBe(1);
      });
    });

    // ── DoD②: team path zero regression ──

    describe("DoD② team path zero regression", () => {
      it("no-filter reads still see every row (pre-M3 semantics)", async () => {
        const rows = await store.queryL1Records();
        expect(rows.length).toBe(5);
        const l0Page = await store.queryL0Paginated({ limit: 10, offset: 0 });
        expect(l0Page.total).toBe(5);
      });

      it("legacy rows (no scope field written) are readable via team filters", async () => {
        const rows = await store.queryL1Records({ teamId: TEAM_T1 });
        const ids = rows.map((r) => r.record_id).sort();
        expect(ids).toEqual([IDS.l1Legacy, IDS.l1TeamA].sort());
        for (const r of rows) expect(r.scope).toBe("team");
      });

      it("scope:team narrows to team rows only", async () => {
        expect(await store.countL1({ scope: "team" })).toBe(2);
        expect(await store.countL0({ scope: "team" })).toBe(2);
        const rows = await store.queryL1Records({ scope: "team", teamId: TEAM_T1 });
        expect(rows.map((r) => r.record_id).sort()).toEqual([IDS.l1Legacy, IDS.l1TeamA].sort());
      });

      it("team filter with userId matches exactly the pre-M3 combination", async () => {
        // Pre-M3 callers passed {teamId, userId} with no scope — with an
        // explicit scope:"team" the result set must be unchanged.
        const withScope = await store.queryL1Records({ scope: "team", teamId: TEAM_T1, userId: USER_A });
        expect(withScope.map((r) => r.record_id).sort()).toEqual([IDS.l1Legacy, IDS.l1TeamA].sort());
      });

      it("searchL1Fts with scope:team never returns personal rows", async () => {
        const hits = await store.searchL1Fts("alpha", 10, { scope: "team", teamId: TEAM_T1 });
        const ids = hits.map((h) => h.record_id).sort();
        expect(ids).toEqual([IDS.l1Legacy, IDS.l1TeamA].sort());
        for (const h of hits) expect(h.scope).toBe("team");
      });

      it("team rows keep owner_user_id empty", async () => {
        const rows = await store.queryL1Records({ scope: "team" });
        for (const r of rows) expect(r.owner_user_id).toBe("");
      });

      it("team delete path unchanged: wrong team cannot delete", async () => {
        expect(await store.deleteL1(IDS.l1TeamA, { scope: "team", teamId: "team-other" })).toBe(false);
        expect(await store.deleteL1(IDS.l1TeamA, { scope: "team", teamId: TEAM_T1 })).toBe(true);
      });
    });

    // ── DoD③: personal write hard checks ──

    describe("DoD③ personal write hard checks", () => {
      it("upsertL1 personal + teamId throws IsolationError", async () => {
        await expectIsolationError(() =>
          store.upsertL1(makeL1Record("l1-bad", "x", { teamId: TEAM_T1, userId: USER_A, scope: "personal" })),
        );
      });

      it("upsertL0 personal + teamId throws IsolationError", async () => {
        await expectIsolationError(() =>
          store.upsertL0(makeL0Record("l0-bad", "x", { teamId: TEAM_T1, userId: USER_A, scope: "personal" })),
        );
      });

      it("personal write without ownerUserId defaults owner to the acting user", async () => {
        await store.upsertL1(makeL1Record("l1-pers-a3", "personal gamma note", { userId: USER_A, scope: "personal" }));
        const rows = await store.queryL1Records({ scope: "personal", userId: USER_A });
        const added = rows.find((r) => r.record_id === "l1-pers-a3");
        expect(added).toBeDefined();
        expect(added?.owner_user_id).toBe(USER_A);
      });

      it("team write keeps owner empty and scope team even when fields omitted", async () => {
        await store.upsertL1(makeL1Record("l1-team-new", "team delta note", { teamId: TEAM_T1, userId: USER_B }));
        const rows = await store.queryL1Records({ teamId: TEAM_T1, userId: USER_B });
        const added = rows.find((r) => r.record_id === "l1-team-new");
        expect(added).toBeDefined();
        expect(added?.scope).toBe("team");
        expect(added?.owner_user_id).toBe("");
      });
    });

    // ── FTS availability gate (informational; backend-declared) ──

    if (harness.ftsAvailable) {
      it("keyword search is available on this backend", async () => {
        const hits = await store.searchL1Fts("alpha", 10, { scope: "personal", userId: USER_A });
        expect(hits.length).toBeGreaterThan(0);
      });
    }
  });
}

/** Compile-time proof that the real store interface satisfies the contract surface. */
export type _ContractCoversIMemoryStore = IMemoryStore extends PersonalScopeStore ? true : never;
