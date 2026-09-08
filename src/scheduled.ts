/** Hourly best-effort cron cleanup (R2 failures can leave orphaned objects):
 *
 * 1. Unconfirmed shares older than 24h (browser closed mid-upload):
 *    R2 objects + all DB rows removed.
 * 2. Unconfirmed file rows older than 24h (request uploads that were never
 *    confirmed): R2 objects + file rows removed.
 * 3. Expired shares/requests still active: R2 objects removed at expiry,
 *    row deactivated (kept for the admin dashboard history).
 * 4. Password attempts older than 7 days, download records older than 90 days,
 *    and rate-limit hits older than 1 day pruned.
 * 5. Expired account sessions/tokens, auth attempts older than one day, and
 *    account audit entries older than 365 days pruned in bounded batches.
 *    Cost usage is retained independently of content/download history purges.
 *
 * Every SELECT is capped with LIMIT so a single run stays bounded; the hourly
 * cadence drains any backlog. Each phase is isolated so one failure does not
 * abort the rest.
 *
 * Incomplete multipart uploads are aborted by an R2 bucket lifecycle rule
 * (see README), since upload ids are not tracked server-side.
 */

import type { Env, FileRow, RequestRow, ShareRow } from "./types";
import { sendExpiryAlerts } from "./lib/email-preferences";
import { getRequestFiles, getShareFiles } from "./lib/db";
import { deleteObjects } from "./lib/r2";

const ORPHAN_AGE_HOURS = 24;
const ATTEMPT_RETENTION_DAYS = 7;
const DOWNLOAD_RETENTION_DAYS = 90;
const RATE_HITS_RETENTION_DAYS = 1;
const ACCOUNT_AUDIT_RETENTION_DAYS = 365;
/** Rows processed per cleanup phase per run - keeps each invocation bounded. */
const CLEANUP_BATCH_LIMIT = 100;

async function cleanupOrphanedShares(env: Env, cutoff: string): Promise<void> {
  const { results: orphans } = await env.DB.prepare(
    "SELECT * FROM shares WHERE confirmed_at IS NULL AND is_active = 0 AND created_at < ? LIMIT ?"
  )
    .bind(cutoff, CLEANUP_BATCH_LIMIT)
    .all<ShareRow>();

  for (const share of orphans) {
    try {
      const files = await getShareFiles(env.DB, share.id);
      await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
      await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(share.id).run();
    } catch (err) {
      console.warn(`Orphan cleanup failed for share ${share.id}`, err);
    }
  }
  if (orphans.length > 0) {
    console.log(`Cleaned up ${orphans.length} orphaned unconfirmed shares`);
  }
}

async function cleanupUnconfirmedFiles(env: Env, cutoff: string): Promise<void> {
  const { results: stale } = await env.DB.prepare(
    "SELECT * FROM files WHERE confirmed = 0 AND created_at < ? LIMIT ?"
  )
    .bind(cutoff, CLEANUP_BATCH_LIMIT)
    .all<FileRow>();
  if (stale.length === 0) return;

  try {
    await deleteObjects(env, stale.map((f) => f.r2_key).filter(Boolean));
    const del = env.DB.prepare("DELETE FROM files WHERE id = ?");
    await env.DB.batch(stale.map((f) => del.bind(f.id)));
    console.log(`Cleaned up ${stale.length} unconfirmed files`);
  } catch (err) {
    console.warn("Unconfirmed file cleanup failed", err);
  }
}

/** Reclaim storage for expired shares/requests; keep rows for history. */
async function cleanupExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();

  const { results: expiredShares } = await env.DB.prepare(
    "SELECT * FROM shares WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?"
  )
    .bind(now, CLEANUP_BATCH_LIMIT)
    .all<ShareRow>();
  for (const share of expiredShares) {
    try {
      const files = await getShareFiles(env.DB, share.id);
      await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
      await env.DB.prepare("UPDATE shares SET is_active = 0, deactivated_at = ? WHERE id = ?")
        .bind(now, share.id)
        .run();
    } catch (err) {
      console.warn(`Expired cleanup failed for share ${share.id}`, err);
    }
  }

  const { results: expiredRequests } = await env.DB.prepare(
    "SELECT * FROM requests WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?"
  )
    .bind(now, CLEANUP_BATCH_LIMIT)
    .all<RequestRow>();
  for (const req of expiredRequests) {
    try {
      const files = await getRequestFiles(env.DB, req.id);
      await deleteObjects(env, files.map((f) => f.r2_key).filter(Boolean));
      await env.DB.prepare("UPDATE requests SET is_active = 0, deactivated_at = ? WHERE id = ?")
        .bind(now, req.id)
        .run();
    } catch (err) {
      console.warn(`Expired cleanup failed for request ${req.id}`, err);
    }
  }

  const total = expiredShares.length + expiredRequests.length;
  if (total > 0) console.log(`Reclaimed storage for ${total} expired shares/requests`);
}

/** Purge deactivated history rows older than HISTORY_RETENTION_DAYS
 * (default 30; set to 0 to keep history forever). */
async function autoPurgeHistory(env: Env): Promise<void> {
  const days = Number(env.HISTORY_RETENTION_DAYS ?? "30");
  if (!Number.isFinite(days) || days <= 0) return;

  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Rows deactivated before this column existed get stamped now, so they
  // start their retention clock instead of lingering forever.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE shares SET deactivated_at = ? WHERE is_active = 0 AND deactivated_at IS NULL AND confirmed_at IS NOT NULL"
    ).bind(now),
    env.DB.prepare(
      "UPDATE requests SET deactivated_at = ? WHERE is_active = 0 AND deactivated_at IS NULL"
    ).bind(now),
  ]);

  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM shares WHERE is_active = 0 AND deactivated_at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM requests WHERE is_active = 0 AND deactivated_at < ?").bind(cutoff),
  ]);
  const purged = result.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  if (purged > 0) console.log(`Auto-purged ${purged} history rows older than ${days} days`);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** Prune append-only bookkeeping tables that would otherwise grow unbounded. */
async function pruneBookkeeping(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare("DELETE FROM password_attempts WHERE attempted_at < ?")
      .bind(daysAgoIso(ATTEMPT_RETENTION_DAYS)),
    env.DB
      .prepare("DELETE FROM downloads WHERE downloaded_at < ?")
      .bind(daysAgoIso(DOWNLOAD_RETENTION_DAYS)),
    env.DB.prepare("DELETE FROM rate_hits WHERE at < ?").bind(daysAgoIso(RATE_HITS_RETENTION_DAYS)),
  ]);
}

export async function runCleanup(env: Env): Promise<void> {
  const orphanCutoff = daysAgoIso(ORPHAN_AGE_HOURS / 24);

  // Each phase is isolated: a failure in one (e.g. a transient R2/D1 error) is
  // logged but never prevents the remaining phases from running.
  const phases: Array<[string, () => Promise<void>]> = [
    ["orphaned shares", () => cleanupOrphanedShares(env, orphanCutoff)],
    ["unconfirmed files", () => cleanupUnconfirmedFiles(env, orphanCutoff)],
    ["expired shares/requests", () => cleanupExpired(env)],
    ["history purge", () => autoPurgeHistory(env)],
    ["bookkeeping prune", () => pruneBookkeeping(env)],
    ["account bookkeeping prune", () => pruneAccountBookkeeping(env)],
    ["expiry email alerts", () => sendExpiryAlerts(env)],
  ];

  const outcomes = await Promise.allSettled(phases.map(([, run]) => run()));
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      console.warn(`Cleanup phase '${phases[i]![0]}' failed`, outcome.reason);
    }
  });
}

/** Epoch seconds for auth expiry; ISO UTC for audit dates. Each indexed delete
 * is capped independently so the hourly cron gradually drains large backlogs.
 */
async function pruneAccountBookkeeping(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM notification_claims WHERE event_key IN
      (SELECT event_key FROM notification_claims WHERE created_at < ? ORDER BY created_at LIMIT ?)`)
      .bind(now - 7 * 86400, CLEANUP_BATCH_LIMIT),
    env.DB.prepare(`DELETE FROM user_sessions WHERE token_hash IN
      (SELECT token_hash FROM user_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
      .bind(now, CLEANUP_BATCH_LIMIT),
    env.DB.prepare(`DELETE FROM password_tokens WHERE token_hash IN
      (SELECT token_hash FROM password_tokens WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
      .bind(now, CLEANUP_BATCH_LIMIT),
    env.DB.prepare(`DELETE FROM auth_attempts WHERE id IN
      (SELECT id FROM auth_attempts WHERE at < ? ORDER BY at LIMIT ?)`)
      .bind(now - 86400, CLEANUP_BATCH_LIMIT),
    env.DB.prepare(`DELETE FROM account_audit WHERE id IN
      (SELECT id FROM account_audit WHERE created_at < ? ORDER BY created_at LIMIT ?)`)
      .bind(daysAgoIso(ACCOUNT_AUDIT_RETENTION_DAYS), CLEANUP_BATCH_LIMIT),
  ]);
}
