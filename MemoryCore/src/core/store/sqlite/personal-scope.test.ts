/**
 * M3 personal-scope contract — SQLite (VectorStore) runner.
 *
 * Spins up a throwaway on-disk SQLite DB per test (dimensions=0 →
 * metadata/FTS-only mode, no sqlite-vec load needed) and runs the
 * backend-agnostic suite from `../__contract__/personal-scope.contract.ts`.
 *
 * Backend-specific additions on top of the contract:
 *   - pushdown proof: `EXPLAIN QUERY PLAN` shows the scope predicates are
 *     served by `idx_l1_scope_user` / `idx_l1_scope_owner` (not a table scan)
 *   - FTS5 path proof: `searchL1Fts` over-retrieve + `rowMatchesIsolation`
 *     post-filter is exercised with a multi-user corpus
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";
import {
  runPersonalScopeContract,
  seedScopeMatrix,
  IDS,
  TEAM_T1,
  USER_A,
  USER_B,
  type PersonalScopeStore,
} from "../__contract__/personal-scope.contract.js";

const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m3-scope-sqlite-"));
  tempDirs.push(dir);
  return join(dir, "vectors.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

runPersonalScopeContract({
  backend: "sqlite",
  ftsAvailable: true,
  createStore() {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();
    return store as unknown as PersonalScopeStore;
  },
  destroyStore(store) {
    (store as unknown as VectorStore).close();
  },
});

describe("M3 scope pushdown [sqlite specifics]", () => {
  it("EXPLAIN QUERY PLAN serves scope predicates via scope indexes", () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();
    const db = store.getRawDb();

    const planUser = db
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM l1_records WHERE scope = 'personal' AND user_id = ?")
      .all(USER_A) as Array<{ detail: string }>;
    const planOwner = db
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM l1_records WHERE scope = 'personal' AND owner_user_id = ?")
      .all(USER_A) as Array<{ detail: string }>;

    const detailUser = planUser.map((r) => r.detail).join(" | ");
    const detailOwner = planOwner.map((r) => r.detail).join(" | ");

    // The scope predicates must be index-served — never a full table scan.
    expect(detailUser).not.toContain("SCAN l1_records");
    expect(detailUser).toContain("idx_l1_scope_user");
    expect(detailOwner).not.toContain("SCAN l1_records");
    expect(detailOwner).toContain("idx_l1_scope_owner");

    store.close();
  });

  it("L0 scope predicates are index-served too", () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();
    const db = store.getRawDb();

    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM l0_conversations WHERE scope = 'personal' AND user_id = ?")
      .all(USER_A) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" | ");

    expect(detail).not.toContain("SCAN l0_conversations");
    expect(detail).toContain("idx_l0_scope_user");

    store.close();
  });

  it("FTS5 over-retrieve keeps cross-user rows out of the final window", async () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();
    await seedScopeMatrix(store as unknown as PersonalScopeStore);

    // "beta" lives ONLY in user B's personal row — the unfiltered corpus must
    // retrieve it (so the post-filter below is proven meaningful), yet the
    // personal-scoped query for user A must never surface it.
    const unfilteredBeta = await (store as unknown as PersonalScopeStore).searchL1Fts("beta", 10);
    expect(unfilteredBeta.map((h) => h.record_id)).toContain(IDS.l1PersB1);

    const scopedBeta = await (store as unknown as PersonalScopeStore).searchL1Fts("beta", 10, {
      scope: "personal",
      userId: USER_A,
    });
    expect(scopedBeta).toEqual([]);

    const ownerBeta = await (store as unknown as PersonalScopeStore).searchL1Fts("beta", 10, {
      scope: "personal",
      userId: USER_B,
    });
    expect(ownerBeta.map((h) => h.record_id)).toEqual([IDS.l1PersB1]);

    // "alpha" hits both users' personal rows plus the two team rows — the
    // scoped window must contain exactly user A's two rows.
    const scoped = await (store as unknown as PersonalScopeStore).searchL1Fts("alpha", 10, {
      scope: "personal",
      userId: USER_A,
    });
    expect(scoped.map((h) => h.record_id).sort()).toEqual([IDS.l1PersA1, IDS.l1PersA2].sort());

    // limit=1 still must not leak B's row even though it shares the corpus.
    const tiny = await (store as unknown as PersonalScopeStore).searchL1Fts("alpha", 1, {
      scope: "personal",
      userId: USER_A,
    });
    expect(tiny.length).toBe(1);
    expect(tiny[0].owner_user_id).toBe(USER_A);

    store.close();
  });

  it("team rows remain FTS-visible under scope:team", async () => {
    const store = new VectorStore(makeTempDbPath(), 0);
    store.init();
    await seedScopeMatrix(store as unknown as PersonalScopeStore);

    const hits = await (store as unknown as PersonalScopeStore).searchL1Fts("alpha", 10, {
      scope: "team",
      teamId: TEAM_T1,
    });
    expect(hits.map((h) => h.record_id).sort()).toEqual([IDS.l1Legacy, IDS.l1TeamA].sort());

    store.close();
  });
});
