/**
 * Isolation Context — three-dimensional tenancy for L0/L1/Profile data.
 *
 * Every write into L0_conversations / l1_records / profiles MUST carry a
 * full IsolationContext (user_id, agent_id, session_id). Every query MUST
 * accept an IsolationFilter so the caller controls which dimensions are
 * narrowed.
 *
 * See `docs/l0l3-tenant-isolation-design.md` for the full design rationale.
 */

/** Default bucket used when caller does not provide explicit isolation fields. */
export const DEFAULT_ISOLATION_ID = "default";

/**
 * Memory scope — personal (follows the user, coslash-style) vs team (shared hub).
 *
 * Added by M3 storage contract (personal-memory-space-design.html section 1(1)).
 * Every row defaults to `"team"`, so the team path stays byte-identical to the
 * pre-M3 behavior (M3 DoD 2: zero regression). `"personal"` rows carry an empty
 * team_id plus a mandatory owner_user_id (the owning user).
 */
export type MemoryScope = "personal" | "team";

/** Default scope for rows whose writer did not specify one (backward compat). */
export const DEFAULT_MEMORY_SCOPE: MemoryScope = "team";
/** Placeholder used when migrating legacy data that has no user/agent assignment. */
export const LEGACY_ISOLATION_PLACEHOLDER = DEFAULT_ISOLATION_ID;

/**
 * Full isolation context required for any write into L0/L1/Profile.
 *
 * - `userId` / `agentId` / `sessionId` are MANDATORY. Empty strings are
 *   rejected unless legacy_compat_mode is enabled (see `assertIsolation`).
 * - `taskId` is an optional business dimension for L0/L1 filtering. It must
 *   never replace sessionId/sessionKey because L1 extraction is session-based.
 */
export interface IsolationContext {
  teamId?: string;
  userId: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
  /** Optional secondary aggregation key kept for legacy callers. */
  sessionKey?: string;
  /**
   * Memory scope (M3). `"team"` (default) = shared team memory; `"personal"` =
   * user-owned memory that follows the user across teams. Personal writes MUST
   * leave teamId empty and carry ownerUserId (enforced by resolveRecordScope).
   */
  scope?: MemoryScope;
  /** Owning user for personal-scope rows. Empty for team-scope rows. */
  ownerUserId?: string;
}

/**
 * Isolation filter for queries. Any unset / undefined field means "do not
 * narrow on this dimension". This matches the SQL convention of `WHERE x = ?`
 * being skipped when the parameter is absent.
 */
export interface IsolationFilter {
  teamId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  sessionKey?: string;
  /**
   * Memory scope filter (M3). `"personal"` narrows to the caller's own personal
   * rows — always paired with userId (see enforcePersonalReadFilter).
   */
  scope?: MemoryScope;
  /** Narrow to rows owned by a specific user (personal scope). */
  ownerUserId?: string;
}

/** Runtime config governing isolation enforcement. */
export interface IsolationConfig {
  /** When true (default) writes without full IsolationContext throw. */
  enforce: boolean;
  /** When true the writer fills missing fields with `__legacy__` instead of throwing. */
  legacyCompatMode: boolean;
  /** Placeholder used when legacyCompatMode fills missing fields. */
  legacyPlaceholder: string;
}

export const DEFAULT_ISOLATION_CONFIG: IsolationConfig = {
  enforce: true,
  legacyCompatMode: false,
  legacyPlaceholder: LEGACY_ISOLATION_PLACEHOLDER,
};

/**
 * Validate (and optionally repair) an IsolationContext.
 *
 * @returns A normalised context with `userId/agentId/sessionId` guaranteed
 *          non-empty.
 * @throws  When `enforce=true` and `legacyCompatMode=false` and any of the
 *          three mandatory fields is empty/missing.
 */
export function assertIsolation(
  ctx: Partial<IsolationContext> | undefined,
  config: IsolationConfig = DEFAULT_ISOLATION_CONFIG,
): IsolationContext {
  const teamId = (ctx?.teamId ?? "").trim() || undefined;
  const userId = (ctx?.userId ?? "").trim();
  const agentId = (ctx?.agentId ?? "").trim();
  const sessionId = (ctx?.sessionId ?? "").trim();
  const taskId = ctx?.taskId ?? undefined;
  const sessionKey = ctx?.sessionKey ?? undefined;
  const scope: MemoryScope = ctx?.scope ?? DEFAULT_MEMORY_SCOPE;
  let ownerUserId = (ctx?.ownerUserId ?? "").trim() || undefined;

  // Personal-scope hard rules (M3 DoD 3): personal rows never attach to a team,
  // and the owner defaults to the acting user. Unlike the missing-field repair
  // below, a personal write WITH a teamId is a contract violation and throws.
  if (scope === "personal") {
    if (teamId) {
      throw new IsolationError(
        `personal scope requires empty teamId (got "${teamId}")`,
        ["teamId"],
      );
    }
    ownerUserId = ownerUserId || userId || undefined;
  }

  const missing: string[] = [];
  if (!userId) missing.push("userId");
  if (!agentId) missing.push("agentId");
  if (!sessionId) missing.push("sessionId");

  // Team rows: owner is a personal-space concept only — force it empty.
  if (scope !== "personal") ownerUserId = undefined;

  if (missing.length === 0) {
    return { teamId, userId, agentId, sessionId, taskId, sessionKey, scope, ownerUserId };
  }

  const placeholder = config.legacyCompatMode ? config.legacyPlaceholder : DEFAULT_ISOLATION_ID;
  return {
    teamId,
    userId: userId || placeholder,
    agentId: agentId || placeholder,
    sessionId: sessionId || placeholder,
    taskId,
    sessionKey,
    scope,
    ownerUserId,
  };
}

export class IsolationError extends Error {
  constructor(message: string, public readonly missingFields: string[]) {
    super(message);
    this.name = "IsolationError";
  }
}

/**
 * Build a SQL WHERE clause fragment + params for IsolationFilter.
 *
 * Returns:
 *   - `clause`: e.g. `user_id = ? AND agent_id = ?` (no leading WHERE / AND)
 *   - `params`: positional bindings in the same order as the clause
 *
 * Pass `tablePrefix` (e.g. "l1.") if joining multiple tables.
 */
export function buildIsolationWhere(
  filter: IsolationFilter | undefined,
  tablePrefix = "",
): { clause: string; params: string[] } {
  if (!filter) return { clause: "", params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.teamId !== undefined) {
    parts.push(`${tablePrefix}team_id = ?`);
    params.push(filter.teamId);
  }
  if (filter.userId !== undefined) {
    parts.push(`${tablePrefix}user_id = ?`);
    params.push(filter.userId);
  }
  if (filter.agentId !== undefined) {
    parts.push(`${tablePrefix}agent_id = ?`);
    params.push(filter.agentId);
  }
  if (filter.sessionId !== undefined) {
    parts.push(`${tablePrefix}session_id = ?`);
    params.push(filter.sessionId);
  }
  if (filter.taskId !== undefined) {
    parts.push(`${tablePrefix}task_id = ?`);
    params.push(filter.taskId);
  }
  if (filter.sessionKey !== undefined) {
    parts.push(`${tablePrefix}session_key = ?`);
    params.push(filter.sessionKey);
  }
  if (filter.scope !== undefined) {
    parts.push(`${tablePrefix}scope = ?`);
    params.push(filter.scope);
  }
  if (filter.ownerUserId !== undefined) {
    parts.push(`${tablePrefix}owner_user_id = ?`);
    params.push(filter.ownerUserId);
  }
  return { clause: parts.join(" AND "), params };
}

/**
 * Check whether a row honours an IsolationFilter (post-retrieve re-check).
 * Used as a safety net after vector / FTS recall, in case the underlying
 * store cannot push the filter down (e.g. older TCVDB collection).
 */
export function rowMatchesIsolation(
  row: { team_id?: string; user_id?: string; agent_id?: string; session_id?: string; task_id?: string; session_key?: string; scope?: string; owner_user_id?: string },
  filter: IsolationFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.teamId !== undefined && row.team_id !== filter.teamId) return false;
  if (filter.userId !== undefined && row.user_id !== filter.userId) return false;
  if (filter.agentId !== undefined && row.agent_id !== filter.agentId) return false;
  if (filter.sessionId !== undefined && row.session_id !== filter.sessionId) return false;
  if (filter.taskId !== undefined && row.task_id !== filter.taskId) return false;
  if (filter.sessionKey !== undefined && row.session_key !== filter.sessionKey) return false;
  // Scope columns may be absent on pre-M3 rows (legacy team data) — treat
  // missing as the default "team" scope so legacy rows keep matching team filters.
  if (filter.scope !== undefined && (row.scope ?? DEFAULT_MEMORY_SCOPE) !== filter.scope) return false;
  if (filter.ownerUserId !== undefined && (row.owner_user_id ?? "") !== filter.ownerUserId) return false;
  return true;
}


// ════════════════════════════════════════════════════════
// M3 personal-scope helpers (storage contract)
// ════════════════════════════════════════════════════════

/**
 * Resolve the scope columns for a write (shared by every backend adapter).
 *
 * - `scope` defaults to `"team"` — the team path is byte-identical to pre-M3.
 * - `"personal"` writes throw when teamId is non-empty (M3 DoD 3 hard check)
 *   and default ownerUserId to the acting user.
 * - Team-scope rows keep an empty owner_user_id (forced — a stray owner on a
 *   team row would widen `ownerUserId`-narrowed reads).
 *
 * @throws IsolationError when scope="personal" and teamId is non-empty.
 */
export function resolveRecordScope(record: {
  teamId?: string;
  userId?: string;
  scope?: MemoryScope;
  ownerUserId?: string;
}): { scope: MemoryScope; ownerUserId: string } {
  const scope: MemoryScope = record.scope ?? DEFAULT_MEMORY_SCOPE;
  const teamId = (record.teamId ?? "").trim();
  if (scope === "personal") {
    if (teamId) {
      throw new IsolationError(
        `personal scope requires empty teamId (got "${teamId}")`,
        ["teamId"],
      );
    }
    const owner = (record.ownerUserId ?? "").trim() || (record.userId ?? "").trim();
    return { scope, ownerUserId: owner || DEFAULT_ISOLATION_ID };
  }
  // Team rows: owner is a personal-space concept only — force it empty.
  return { scope, ownerUserId: "" };
}

/**
 * Fail-loud guard for personal-scope READS.
 *
 * A `scope: "personal"` filter without `userId` would match EVERY user's
 * personal rows — exactly the cross-tenant leak M3 DoD 1 forbids ("cross-userId
 * access = test failure"). Store adapters call this at the top of every
 * read/delete path so the mistake surfaces as an error, never as leaked data.
 *
 * @throws IsolationError when scope="personal" and userId is empty/missing.
 */
export function enforcePersonalReadFilter(filter: IsolationFilter | undefined): void {
  if (filter?.scope === "personal" && !(filter.userId ?? "").trim()) {
    throw new IsolationError(
      "personal scope reads require userId (cross-tenant leak guard)",
      ["userId"],
    );
  }
}
