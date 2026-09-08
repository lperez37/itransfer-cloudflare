/** Monthly cost estimation for Cloudflare R2 (standard storage).
 *
 * Method:
 * - Storage: current confirmed bytes under active parents, not GB-days.
 * - Class A (writes): durable estimates in the last 30 days, from confirmations -
 *   1 PUT per small file; multipart files count create + one op per part +
 *   complete (parts estimated from file size at MULTIPART_PART_SIZE).
 * - Class B (reads): public share events and request URL issuance in the last
 *   30 days (one estimated GET per file; workspace share downloads excluded).
 * - Egress: free on R2.
 * - One global free tier is assumed entirely available. This is NOT billing.
 *
 * Pricing: https://developers.cloudflare.com/r2/pricing/
 */

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
  users?: UserCostEstimate[];
  estimate_note?: string;
}

interface UserCostEstimate {
  user_id: string;
  name: string;
  email: string;
  total_storage_bytes: number;
  total_files: number;
  class_a_ops_month: number;
  class_b_ops_month: number;
  gross_monthly_cost_usd: number;
}

/** Admin-only reporting data; callers must enforce administrator authorization. */
export async function estimateCost(db: D1Database): Promise<CostEstimate> {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const windowEnd = new Date().toISOString();

  const [totals, recentUsage, userUsage] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(storage_bytes), 0) FROM cost_storage) AS total_storage_bytes,
           (SELECT COUNT(*) FROM cost_storage) AS total_files,
           (SELECT COUNT(*) FROM cost_usage WHERE kind = 'download') AS total_downloads,
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
      .prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind = 'upload' THEN operations ELSE 0 END), 0) AS a,
        COALESCE(SUM(CASE WHEN kind = 'download' THEN operations ELSE 0 END), 0) AS b
        FROM cost_usage WHERE occurred_at >= ? AND occurred_at <= ?`)
      .bind(windowStart, windowEnd)
      .first<{ a: number; b: number }>(),
    db
      .prepare(`WITH storage AS (
        SELECT owner_user_id, SUM(storage_bytes) AS bytes, COUNT(*) AS files
        FROM cost_storage GROUP BY owner_user_id
      ), usage AS (
        SELECT COALESCE(owner_user_id,
          (SELECT value FROM app_settings WHERE key = 'bootstrap_admin_id')) AS owner,
          SUM(CASE WHEN kind = 'upload' THEN operations ELSE 0 END) AS a,
          SUM(CASE WHEN kind = 'download' THEN operations ELSE 0 END) AS b
        FROM cost_usage WHERE occurred_at >= ? AND occurred_at <= ? GROUP BY owner
      ) SELECT u.id AS user_id, u.name, u.email,
        COALESCE(s.bytes, 0) AS total_storage_bytes, COALESCE(s.files, 0) AS total_files,
        COALESCE(o.a, 0) AS class_a_ops_month, COALESCE(o.b, 0) AS class_b_ops_month
      FROM users u LEFT JOIN storage s ON s.owner_user_id = u.id
      LEFT JOIN usage o ON o.owner = u.id ORDER BY u.name, u.id`)
      .bind(windowStart, windowEnd)
      .all<Omit<UserCostEstimate, 'gross_monthly_cost_usd'>>(),
  ]);

  const totalStorageBytes = totals?.total_storage_bytes ?? 0;
  const classAOps = recentUsage?.a ?? 0;
  const classBOps = recentUsage?.b ?? 0;

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
    users: userUsage.results.map((user) => ({
      ...user,
      gross_monthly_cost_usd: round(
        user.total_storage_bytes / 1024 ** 3 * PRICING.storagePerGbMonth +
        user.class_a_ops_month / 1_000_000 * PRICING.classAPerMillion +
        user.class_b_ops_month / 1_000_000 * PRICING.classBPerMillion
      ),
    })),
    estimate_note: 'Estimates, not Cloudflare billing. Storage is a current confirmed-file snapshot under active parents, not historical GB-days; unconfirmed uploads and inactive history are excluded. Failed R2 deletions may leave uncounted objects. Operations estimate confirmed uploads, public/API share download events and request download URL issuance over 30 days, not actual reads, retries, HEADs, workspace share downloads or abandoned multipart uploads. Historical backfill uses file creation dates; previously purged usage and past request downloads are unavailable. Per-user amounts are gross; the aggregate assumes one global free tier is entirely available. Legacy unassigned usage resolves to the bootstrap admin.',
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
