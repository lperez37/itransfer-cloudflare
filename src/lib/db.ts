/** Thin typed query helpers over D1. */

import type { FileRow, RequestRow, ShareRow } from "../types";

export function getShare(db: D1Database, id: string): Promise<ShareRow | null> {
  return db.prepare("SELECT * FROM shares WHERE id = ?").bind(id).first<ShareRow>();
}

export function getRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return db.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<RequestRow>();
}

export function getFile(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

export async function getShareFiles(db: D1Database, shareId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM files WHERE share_id = ? ORDER BY created_at")
    .bind(shareId)
    .all<FileRow>();
  return results;
}

export async function getRequestFiles(db: D1Database, requestId: string): Promise<FileRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM files WHERE request_id = ? ORDER BY created_at")
    .bind(requestId)
    .all<FileRow>();
  return results;
}

/** Failed password attempts for a share or request since `cutoffIso`. */
export async function countRecentAttempts(
  db: D1Database,
  target: { shareId?: string; requestId?: string },
  cutoffIso: string
): Promise<number> {
  const stmt = target.shareId
    ? db
        .prepare("SELECT COUNT(*) AS n FROM password_attempts WHERE share_id = ? AND attempted_at >= ?")
        .bind(target.shareId, cutoffIso)
    : db
        .prepare("SELECT COUNT(*) AS n FROM password_attempts WHERE request_id = ? AND attempted_at >= ?")
        .bind(target.requestId, cutoffIso);
  const row = await stmt.first<{ n: number }>();
  return row?.n ?? 0;
}

export async function recordAttempt(
  db: D1Database,
  target: { shareId?: string; requestId?: string },
  attemptedAtIso: string
): Promise<void> {
  await db
    .prepare("INSERT INTO password_attempts (share_id, request_id, attempted_at) VALUES (?, ?, ?)")
    .bind(target.shareId ?? null, target.requestId ?? null, attemptedAtIso)
    .run();
}

/** Serialize a FileRow to the public FileInfo shape. */
export function toFileInfo(f: FileRow) {
  return {
    id: f.id,
    original_filename: f.original_filename,
    file_size: f.file_size,
    content_type: f.content_type,
    created_at: f.created_at,
  };
}
