import type { FileRow } from '../types';

/** Request download URL issuance is a GET estimate, not proof of an R2 read.
 * Share issuance is already recorded by the downloads SQL trigger. Fail open
 * for telemetry errors so public downloads retain their existing behavior.
 */
export async function recordRequestDownloadUsage(db: D1Database, files: FileRow[]): Promise<void> {
  const requests = files.filter((file) => file.request_id && !file.share_id);
  if (requests.length === 0) return;
  try {
    const now = new Date().toISOString();
    await db.batch(requests.map((file) => db.prepare(
      `INSERT INTO cost_usage(event_key, owner_user_id, kind, operations, occurred_at)
       SELECT ?, COALESCE(owner_user_id,
         (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')),
         'download', 1, ? FROM requests WHERE id = ?`
    ).bind(`request-download:${crypto.randomUUID()}`, now, file.request_id)));
  } catch {
    console.warn('Request download usage estimate could not be recorded');
  }
}
