/**
 * M3 personal-scope contract — MongoDB pushdown unit tests (no server).
 *
 * The Mongo adapter's isolation semantics live in pure functions
 * (`isolationToMatch` / `isolationToSearchFilters` / `resolveRecordScope`)
 * plus the `$search` index definition, so the pushdown half of the M3
 * contract is fully verifiable without a mongot deployment. The
 * server-side half (queries against a live collection) is covered by the
 * backend-agnostic suite in `../__contract__/personal-scope.contract.ts`.
 *
 * These tests pin the `dynamic: false` trap: a filter path pushed into
 * `$search.compound.filter` that is missing from the index mapping makes
 * mongot reject the *entire* query — so the definition and the pushdown
 * must move together (M3 added both `scope` and `owner_user_id`).
 */

import { describe, it, expect } from "vitest";
import {
  isolationToMatch,
  isolationToSearchFilters,
  l0RecordToDoc,
  l1RecordToDoc,
} from "./doc-mappers.js";
import { MEMORY_SEARCH_DEFINITION } from "./search-index.js";
import {
  DEFAULT_MEMORY_SCOPE,
  IsolationError,
  enforcePersonalReadFilter,
  resolveRecordScope,
} from "../isolation.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { L0Record } from "../types.js";

const USER_A = "user-a";
const USER_B = "user-b";
const TEAM_T1 = "team-t1";

describe("isolationToMatch scope pushdown [mongodb]", () => {
  it("pushes scope + owner_user_id into the find/count filter", () => {
    expect(isolationToMatch({ scope: "personal", userId: USER_A, ownerUserId: USER_A })).toEqual({
      user_id: USER_A,
      scope: "personal",
      owner_user_id: USER_A,
    });
  });

  it("pushes scope alone (team) without owner", () => {
    expect(isolationToMatch({ scope: "team" })).toEqual({ scope: "team" });
  });

  it("omits scope entirely for legacy filters (zero regression)", () => {
    expect(isolationToMatch({ teamId: TEAM_T1 })).toEqual({ team_id: TEAM_T1 });
    expect(isolationToMatch(undefined)).toEqual({});
    expect(isolationToMatch({})).toEqual({});
  });
});

describe("isolationToSearchFilters scope pushdown [mongodb]", () => {
  it("emits equals clauses for scope + owner_user_id (applied before $limit)", () => {
    const clauses = isolationToSearchFilters({ scope: "personal", userId: USER_A, ownerUserId: USER_A });
    expect(clauses).toContainEqual({ equals: { path: "scope", value: "personal" } });
    expect(clauses).toContainEqual({ equals: { path: "owner_user_id", value: USER_A } });
    expect(clauses).toContainEqual({ equals: { path: "user_id", value: USER_A } });
  });

  it("emits no scope clause for legacy filters", () => {
    const clauses = isolationToSearchFilters({ teamId: TEAM_T1 });
    expect(clauses).toEqual([{ equals: { path: "team_id", value: TEAM_T1 } }]);
    expect(isolationToSearchFilters(undefined)).toEqual([]);
  });
});

describe("MEMORY_SEARCH_DEFINITION covers the pushed filter paths [mongodb]", () => {
  it("scope + owner_user_id are token-mapped (dynamic:false guard)", () => {
    const fields = (MEMORY_SEARCH_DEFINITION.mappings as { fields: Record<string, { type: string }> }).fields;
    expect(fields.scope).toEqual({ type: "token" });
    expect(fields.owner_user_id).toEqual({ type: "token" });
  });

  it("every pre-existing isolation path is still mapped (no regression)", () => {
    const fields = (MEMORY_SEARCH_DEFINITION.mappings as { fields: Record<string, unknown> }).fields;
    for (const path of ["team_id", "user_id", "agent_id", "task_id", "session_id", "session_key"]) {
      expect(fields[path], `missing mapping for ${path}`).toBeDefined();
    }
  });
});

describe("resolveRecordScope hard checks [mongodb write path]", () => {
  it("personal + teamId throws IsolationError", () => {
    expect(() => resolveRecordScope({ scope: "personal", teamId: TEAM_T1, userId: USER_A })).toThrow(IsolationError);
  });

  it("personal without ownerUserId defaults owner to the acting user", () => {
    expect(resolveRecordScope({ scope: "personal", userId: USER_A })).toEqual({
      scope: "personal",
      ownerUserId: USER_A,
    });
  });

  it("explicit ownerUserId is preserved for personal rows", () => {
    expect(resolveRecordScope({ scope: "personal", userId: USER_B, ownerUserId: USER_A })).toEqual({
      scope: "personal",
      ownerUserId: USER_A,
    });
  });

  it("team rows default to team scope with empty owner", () => {
    expect(resolveRecordScope({ teamId: TEAM_T1, userId: USER_A })).toEqual({
      scope: DEFAULT_MEMORY_SCOPE,
      ownerUserId: "",
    });
    expect(resolveRecordScope({ teamId: TEAM_T1, userId: USER_A, ownerUserId: USER_A })).toEqual({
      scope: "team",
      ownerUserId: "",
    });
  });
});

describe("recordToDoc applies the resolved scope [mongodb write path]", () => {
  const baseL1: MemoryRecord = {
    id: "l1-x",
    content: "hello",
    type: "episodic",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    version: 1,
    sessionKey: "sk",
    sessionId: "sess",
    userId: USER_A,
    agentId: "agent-1",
  };

  it("personal record maps scope + owner into the doc", () => {
    const doc = l1RecordToDoc({ ...baseL1, scope: "personal" });
    expect(doc.scope).toBe("personal");
    expect(doc.owner_user_id).toBe(USER_A);
    expect(doc.team_id).toBe("");
  });

  it("team record maps scope=team with empty owner", () => {
    const doc = l1RecordToDoc({ ...baseL1, teamId: TEAM_T1 });
    expect(doc.scope).toBe("team");
    expect(doc.owner_user_id).toBe("");
    expect(doc.team_id).toBe(TEAM_T1);
  });

  it("personal record with teamId throws at doc mapping time", () => {
    expect(() => l1RecordToDoc({ ...baseL1, scope: "personal", teamId: TEAM_T1 })).toThrow(IsolationError);
  });

  it("L0 personal record maps scope + owner into the doc", () => {
    const rec: L0Record = {
      id: "l0-x",
      sessionKey: "sk",
      sessionId: "sess",
      userId: USER_B,
      agentId: "agent-1",
      scope: "personal",
      role: "user",
      messageText: "hi",
      recordedAt: "2026-10-12T00:00:00.000Z",
      timestamp: Date.parse("2026-10-12T00:00:00.000Z"),
    };
    const doc = l0RecordToDoc(rec);
    expect(doc.scope).toBe("personal");
    expect(doc.owner_user_id).toBe(USER_B);
  });
});

describe("enforcePersonalReadFilter leak guard [mongodb read path]", () => {
  it("throws for personal scope without userId", () => {
    expect(() => enforcePersonalReadFilter({ scope: "personal" })).toThrow(IsolationError);
  });

  it("passes for personal scope with userId", () => {
    expect(() => enforcePersonalReadFilter({ scope: "personal", userId: USER_A })).not.toThrow();
  });

  it("passes for team scope and for undefined filters", () => {
    expect(() => enforcePersonalReadFilter({ scope: "team" })).not.toThrow();
    expect(() => enforcePersonalReadFilter(undefined)).not.toThrow();
    expect(() => enforcePersonalReadFilter({ teamId: TEAM_T1 })).not.toThrow();
  });
});
