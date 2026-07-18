/** Monthly cost estimation for Cloudflare R2 (standard storage).
 *
 * Method:
 * - Storage: current bytes across all file records, billed per GB-month.
 * - Class A (writes): operations in the last 30 days, derived from uploads -
 *   1 PUT per small file; multipart files count create + one op per part +
 *   complete (parts estimated from file size at MULTIPART_PART_SIZE).
 * - Class B (reads): download events in the last 30 days (one GET per file).
 * - Egress: free on R2.
 * - The monthly free tier is then subtracted, so the estimate reflects what
 *   would actually be billed.
 *
 * Pricing: https://developers.cloudflare.com/r2/pricing/
 */

import { MULTIPART_PART_SIZE, MULTIPART_THRESHOLD } from "../types";

const PRICING = {
  storagePerGbMonth: 0.015,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  freeTier: {
    storageGbMonth: 10,
    classAOps: 1_000_000,
    classBOps: 10_000_000,
  },
} as const;

const WINDOW_DAYS = 30;

export interface CostEstimate {
  total_storage_bytes: number;
  total_files: number;
  estimated_monthly_cost_usd: number;
  breakdown: {
    storage: number;
    requests_put: number;
    requests_get: number;
    transfer: number;
  };
  active_shares: number;
  active_requests: number;
  total_downloads: number;
  // R2-specific detail (additive; the admin UI renders it when present)
  window_days: number;
  class_a_ops_month: number;
  class_b_ops_month: number;
  gross_monthly_cost_usd: number;
  free_tier_savings_usd: number;
}

/** Class A operations needed to upload one file of `size` bytes. */
function classAOpsForFile(size: number): number {
  if (size <= MULTIPART_THRESHOLD) return 1; // single PUT
  // CreateMultipartUpload + one UploadPart per part + CompleteMultipartUpload
  return Math.ceil(size / MULTIPART_PART_SIZE) + 2;
}

export async function estimateCost(db: D1Database): Promise<CostEstimate> {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const [totals, recentFiles, recentDownloads] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(file_size), 0) FROM files) AS total_storage_bytes,
           (SELECT COUNT(*) FROM files) AS total_files,
           (SELECT COUNT(*) FROM downloads) AS total_downloads,
           (SELECT COUNT(*) FROM shares WHERE is_active = 1) AS active_shares,
           (SELECT COUNT(*) FROM requests WHERE is_active = 1) AS active_requests`
      )
      .first<{
        total_storage_bytes: number;
        total_files: number;
        total_downloads: number;
        active_shares: number;
        active_requests: number;
      }>(),
    db
      .prepare("SELECT COALESCE(file_size, 0) AS size FROM files WHERE created_at >= ?")
      .bind(windowStart)
      .all<{ size: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM downloads WHERE downloaded_at >= ?")
      .bind(windowStart)
      .first<{ n: number }>(),
  ]);

  const totalStorageBytes = totals?.total_storage_bytes ?? 0;
  const classAOps = recentFiles.results.reduce((sum, f) => sum + classAOpsForFile(f.size), 0);
  const classBOps = recentDownloads?.n ?? 0;

  const storageGbMonth = totalStorageBytes / 1024 ** 3;
  const grossStorage = storageGbMonth * PRICING.storagePerGbMonth;
  const grossClassA = (classAOps / 1_000_000) * PRICING.classAPerMillion;
  const grossClassB = (classBOps / 1_000_000) * PRICING.classBPerMillion;
  const gross = grossStorage + grossClassA + grossClassB;

  const billableStorage =
    Math.max(0, storageGbMonth - PRICING.freeTier.storageGbMonth) * PRICING.storagePerGbMonth;
  const billableClassA =
    (Math.max(0, classAOps - PRICING.freeTier.classAOps) / 1_000_000) * PRICING.classAPerMillion;
  const billableClassB =
    (Math.max(0, classBOps - PRICING.freeTier.classBOps) / 1_000_000) * PRICING.classBPerMillion;
  const billable = billableStorage + billableClassA + billableClassB;

  const round = (n: number) => Math.round(n * 10_000) / 10_000;

  return {
    total_storage_bytes: totalStorageBytes,
    total_files: totals?.total_files ?? 0,
    estimated_monthly_cost_usd: round(billable),
    breakdown: {
      storage: round(billableStorage),
      requests_put: round(billableClassA),
      requests_get: round(billableClassB),
      transfer: 0, // R2 egress is free
    },
    active_shares: totals?.active_shares ?? 0,
    active_requests: totals?.active_requests ?? 0,
    total_downloads: totals?.total_downloads ?? 0,
    window_days: WINDOW_DAYS,
    class_a_ops_month: classAOps,
    class_b_ops_month: classBOps,
    gross_monthly_cost_usd: round(gross),
    free_tier_savings_usd: round(Math.max(0, gross - billable)),
  };
}
