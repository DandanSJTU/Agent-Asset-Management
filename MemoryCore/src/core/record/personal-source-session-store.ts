/**
 * Personal source-session status store (M4a — 源会话状态表 + 游标幂等).
 *
 * Tracks, per *source* conversation (session insights side), the ingestion state
 * used for the "沉淀" badge and incremental extraction:
 *
 *   - file fingerprint (mtime + size) → detect "会话又长了新的"
 *   - cursor_record_index  → how many source messages have been ingested
 *   - status / counts / last job → UI 徽标 + 排障
 *
 * This is a JSON-file-backed implementation (under `.metadata/`), deliberately
 * chosen over a new DB table so M4a ships without a schema migration. The shape
 * mirrors the `personal_source_session` table in
 * docs/my-memory-tab-design.html §4.1 exactly, so swapping to a real table later
 * is a drop-in.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TAG = "[memory-tdai][personal-source-store]";
const STORE_FILE = "personal-source-sessions.json";

export type SourceSessionStatus = "never" | "running" | "done" | "failed" | "partial";

export interface SourceSessionRecord {
  /** Unique key = sha1(vendor + "|" + sessionId). */
  source_key: string;
  vendor: string;
  session_id: string;
  file_path?: string;
  file_mtime?: number;
  file_size?: number;
  status: SourceSessionStatus;
  /** Number of source messages already ingested (incremental cursor). */
  cursor_record_index: number;
  cursor_ts?: number;
  l0_count: number;
  l1_count: number;
  l2_count: number;
  l3_count: number;
  last_job_id?: string;
  last_error?: string;
  last_cost_usd?: number;
  last_duration_ms?: number;
  /** Source file was deleted — memories retained, lineage greyed out. */
  source_missing?: boolean;
}

/** Compute the source_key (namespace the insights sessionId, which is a path). */
export function computeSourceKey(vendor: string, sessionId: string): string {
  return crypto.createHash("sha1").update(`${vendor}|${sessionId}`).digest("hex");
}

export class PersonalSourceSessionStore {
  private readonly file: string;
  private cache: Map<string, SourceSessionRecord> = new Map();
  private loaded = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, ".metadata", STORE_FILE);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const arr = JSON.parse(raw) as SourceSessionRecord[];
      for (const r of arr) this.cache.set(r.source_key, r);
    } catch {
      // No file yet — start empty.
    }
    this.loaded = true;
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(this.cache.values());
    fs.writeFileSync(this.file, JSON.stringify(arr, null, 2), "utf-8");
  }

  get(sourceKey: string): SourceSessionRecord | undefined {
    this.ensureLoaded();
    return this.cache.get(sourceKey);
  }

  list(): SourceSessionRecord[] {
    this.ensureLoaded();
    return Array.from(this.cache.values());
  }

  upsert(record: SourceSessionRecord): void {
    this.ensureLoaded();
    this.cache.set(record.source_key, record);
    this.persist();
  }

  /**
   * 写入/回填源会话身份（vendor + session_id）。
   *
   * 背景（2026-10-16 修复）：status 类方法只接收 sourceKey，新建记录时
   * `vendor`/`session_id` 恒为空 —— 首次提炼的会话在源会话列表里退化成
   * 无 ID 的「幽灵行」（UI 无法选择、无法做增量探测、无法回显标题）。
   * 必须在任何 status 变更**之前**调用本方法建立身份。
   *
   * 幂等：已有记录且身份完整时不动；身份为空时回填（用于修复历史幽灵行）。
   */
  ensureIdentity(sourceKey: string, vendor: string, sessionId: string): void {
    if (!vendor && !sessionId) return;
    const cur = this.get(sourceKey);
    if (cur && cur.session_id && cur.vendor) return;
    this.upsert({
      ...(cur ?? ({} as SourceSessionRecord)),
      source_key: sourceKey,
      vendor: vendor || cur?.vendor || '',
      session_id: sessionId || cur?.session_id || '',
      status: cur?.status ?? 'never',
      cursor_record_index: cur?.cursor_record_index ?? 0,
      l0_count: cur?.l0_count ?? 0,
      l1_count: cur?.l1_count ?? 0,
      l2_count: cur?.l2_count ?? 0,
      l3_count: cur?.l3_count ?? 0,
    });
  }

  /** Mark running + record the active job id. */
  markRunning(sourceKey: string, jobId: string): void {
    const cur = this.get(sourceKey);
    this.upsert({ ...(cur ?? ({} as SourceSessionRecord)), source_key: sourceKey, status: "running", last_job_id: jobId });
  }

  /** Mark done (or partial if some but not all expected layers produced). */
  markDone(
    sourceKey: string,
    delta: { l0: number; l1: number; l2: number; l3: number; costUsd?: number; durationMs?: number },
  ): void {
    const cur = this.get(sourceKey) ?? ({} as SourceSessionRecord);
    const l0 = (cur.l0_count ?? 0) + delta.l0;
    const l1 = (cur.l1_count ?? 0) + delta.l1;
    const l2 = (cur.l2_count ?? 0) + delta.l2;
    const l3 = (cur.l3_count ?? 0) + delta.l3;
    this.upsert({
      ...cur,
      source_key: sourceKey,
      status: "done",
      l0_count: l0,
      l1_count: l1,
      l2_count: l2,
      l3_count: l3,
      last_cost_usd: delta.costUsd ?? cur.last_cost_usd,
      last_duration_ms: delta.durationMs ?? cur.last_duration_ms,
      last_error: undefined,
    });
  }

  markFailed(sourceKey: string, error: string): void {
    const cur = this.get(sourceKey) ?? ({} as SourceSessionRecord);
    this.upsert({ ...cur, source_key: sourceKey, status: "failed", last_error: error });
  }

  /** Advance the source-side cursor (how many source messages ingested). */
  advanceCursor(sourceKey: string, recordIndex: number, ts?: number): void {
    const cur = this.get(sourceKey) ?? ({} as SourceSessionRecord);
    this.upsert({ ...cur, source_key: sourceKey, cursor_record_index: recordIndex, cursor_ts: ts ?? Date.now() });
  }

  setFileFingerprint(sourceKey: string, fp: { file_mtime?: number; file_size?: number; source_missing?: boolean }): void {
    const cur = this.get(sourceKey) ?? ({} as SourceSessionRecord);
    this.upsert({
      ...cur,
      source_key: sourceKey,
      file_mtime: fp.file_mtime ?? cur.file_mtime,
      file_size: fp.file_size ?? cur.file_size,
      source_missing: fp.source_missing ?? cur.source_missing,
    });
  }
}

/**
 * Decide whether a re-ingest is needed. True when:
 *  - status is never/failed, OR
 *  - the source file changed (mtime or size differ) AND it grew (more messages), OR
 *  - the source now has more messages than the cursor ingested.
 * `messageCount` = total messages currently in the source conversation.
 */
export function needsIngest(
  record: SourceSessionRecord | undefined,
  messageCount: number,
  fileMtime?: number,
  fileSize?: number,
): { ingest: boolean; startIndex: number } {
  if (!record || record.status === "never" || record.status === "failed") {
    return { ingest: true, startIndex: 0 };
  }
  // Source file changed?
  const fileChanged =
    (fileMtime != null && record.file_mtime != null && fileMtime !== record.file_mtime) ||
    (fileSize != null && record.file_size != null && fileSize !== record.file_size);
  if (fileChanged || messageCount > record.cursor_record_index) {
    return { ingest: true, startIndex: Math.min(record.cursor_record_index, messageCount) };
  }
  return { ingest: false, startIndex: record.cursor_record_index };
}
