import { useState, useEffect } from "react";
import { cost, type CostEstimate } from "../lib/api";
import {
  HardDrive,
  FileText,
  Share2,
  Inbox,
  Download,
  DollarSign,
  Loader2,
  AlertCircle,
  Database,
  ArrowUpDown,
  Globe,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return "< $0.01";
  return "$" + amount.toFixed(2);
}

function formatUSDLarge(amount: number): string {
  return "$" + amount.toFixed(2);
}

export default function CostPage() {
  const [data, setData] = useState<CostEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    cost
      .estimate()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load cost data.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <AlertCircle className="w-10 h-10 text-danger mx-auto mb-3" />
          <p className="text-text-secondary">{error || "No data available."}</p>
        </div>
      </div>
    );
  }

  // R2 monthly free tier, for usage context when the bill is $0.
  const FREE_TIER = {
    storageBytes: 10 * 1024 ** 3,
    classAOps: 1_000_000,
    classBOps: 10_000_000,
  };

  const breakdownItems = [
    {
      label: "Storage",
      value: data.breakdown.storage,
      tierPct: (data.total_storage_bytes / FREE_TIER.storageBytes) * 100,
      tierNote: `${formatBytes(data.total_storage_bytes)} of 10 GB free`,
      icon: Database,
      color: "text-primary-light",
      barColor: "bg-primary",
    },
    {
      label: "Class A ops (writes)",
      value: data.breakdown.requests_put,
      tierPct: ((data.class_a_ops_month ?? 0) / FREE_TIER.classAOps) * 100,
      tierNote: `${(data.class_a_ops_month ?? 0).toLocaleString()} of 1M free`,
      icon: ArrowUpDown,
      color: "text-accent",
      barColor: "bg-accent",
    },
    {
      label: "Class B ops (reads)",
      value: data.breakdown.requests_get,
      tierPct: ((data.class_b_ops_month ?? 0) / FREE_TIER.classBOps) * 100,
      tierNote: `${(data.class_b_ops_month ?? 0).toLocaleString()} of 10M free`,
      icon: Download,
      color: "text-accent-light",
      barColor: "bg-accent-light",
    },
    {
      label: "Egress (free on R2)",
      value: data.breakdown.transfer,
      tierPct: null,
      tierNote: "Always free",
      icon: Globe,
      color: "text-text-secondary",
      barColor: "bg-text-secondary",
    },
  ];

  const totalBreakdown = breakdownItems.reduce(
    (sum, item) => sum + item.value,
    0
  );

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">
          Costs
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Estimated R2 usage across every workspace. Visible to administrators only.
        </p>
      </div>

      {/* Total Cost Card */}
      <div className="surface rounded-lg p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-4 mb-2">
          <div className="w-12 h-12 rounded-lg bg-primary flex items-center justify-center">
            <DollarSign className="w-6 h-6 text-background" />
          </div>
          <div>
            <p className="text-sm text-text-muted">
              All Users · Estimated Monthly R2 Cost
            </p>
            <p className="text-3xl sm:text-4xl font-bold text-primary-light font-[family-name:var(--font-display)] tracking-tight">
              {formatUSDLarge(data.estimated_monthly_cost_usd)}
            </p>
          </div>
        </div>
        {data.estimated_monthly_cost_usd === 0 ? (
          <p className="text-xs text-text-muted mt-2">
            Estimated usage fits within one shared R2 free tier, assuming that allowance
            is available to this instance. Workers, D1, and other services are not included.
          </p>
        ) : (
          data.free_tier_savings_usd !== undefined &&
          data.free_tier_savings_usd > 0 && (
            <p className="text-xs text-text-muted mt-2">
              R2 free tier covers {formatUSD(data.free_tier_savings_usd)} of{" "}
              {formatUSD(data.gross_monthly_cost_usd ?? 0)} gross usage
              {data.window_days ? ` (operations over the last ${data.window_days} days)` : ""}.
            </p>
          )
        )}
      </div>

      {data.users && (
        <section className="surface rounded-lg p-5 sm:p-6 mb-6" aria-labelledby="user-costs-title">
          <h2 id="user-costs-title" className="font-semibold text-text-primary">Cost by User</h2>
          <p className="text-sm text-text-muted mt-1 mb-5">
            Gross estimates before shared allowances. Storage reflects current files;
            operations cover the last {data.window_days ?? 30} days.
          </p>
          {data.users.length === 0 ? (
            <p className="text-sm text-text-secondary">No user usage available yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <caption className="sr-only">Per-user storage, estimated operations, and gross monthly R2 cost</caption>
                <thead className="text-text-muted border-b border-border">
                  <tr>
                    <th scope="col" className="py-3 pr-4 font-medium">User</th>
                    <th scope="col" className="py-3 px-3 text-right font-medium whitespace-nowrap">Storage</th>
                    <th scope="col" className="py-3 px-3 text-right font-medium">Files</th>
                    <th scope="col" className="py-3 px-3 text-right font-medium">Writes</th>
                    <th scope="col" className="py-3 px-3 text-right font-medium">Reads</th>
                    <th scope="col" className="py-3 pl-3 text-right font-medium whitespace-nowrap">Gross / month</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((user) => (
                    <tr key={user.user_id} className="border-b border-border last:border-0">
                      <th scope="row" className="py-4 pr-4 font-normal">
                        <span className="block font-medium text-text-primary">{user.name}</span>
                        <span className="block text-text-muted text-xs break-all">{user.email}</span>
                      </th>
                      <td className="py-4 px-3 text-right tabular-nums whitespace-nowrap">{formatBytes(user.total_storage_bytes)}</td>
                      <td className="py-4 px-3 text-right tabular-nums">{user.total_files.toLocaleString()}</td>
                      <td className="py-4 px-3 text-right tabular-nums">{user.class_a_ops_month.toLocaleString()}</td>
                      <td className="py-4 px-3 text-right tabular-nums">{user.class_b_ops_month.toLocaleString()}</td>
                      <td className="py-4 pl-3 text-right tabular-nums whitespace-nowrap">{formatUSD(user.gross_monthly_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.estimate_note && <p className="text-xs text-text-muted mt-5 leading-relaxed">{data.estimate_note}</p>}
        </section>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard
          icon={HardDrive}
          label="Total Storage"
          value={formatBytes(data.total_storage_bytes)}
        />
        <StatCard
          icon={FileText}
          label="Total Files"
          value={data.total_files.toLocaleString()}
        />
        <StatCard
          icon={Share2}
          label="Active Shares"
          value={data.active_shares.toLocaleString()}
        />
        <StatCard
          icon={Inbox}
          label="Active Requests"
          value={data.active_requests.toLocaleString()}
        />
        <StatCard
          icon={Download}
          label="Total Downloads"
          value={data.total_downloads.toLocaleString()}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      {/* Cost Breakdown */}
      <div className="surface rounded-lg p-5 sm:p-6">
        <h3 className="font-semibold text-text-primary mb-5">
          Monthly Cost Breakdown
        </h3>

        <div className="space-y-4">
          {breakdownItems.map((item) => {
            const showTier = totalBreakdown === 0;
            const pct = showTier
              ? (item.tierPct ?? 0)
              : (item.value / totalBreakdown) * 100;
            const note = showTier
              ? item.tierPct === null
                ? item.tierNote
                : `${item.tierNote} (${pct < 0.1 && pct > 0 ? "<0.1" : pct.toFixed(1)}% of free tier)`
              : `${pct.toFixed(1)}% of total`;
            return (
              <div key={item.label}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <item.icon className={`w-4 h-4 ${item.color}`} />
                    <span className="text-sm text-text-primary">
                      {item.label}
                    </span>
                  </div>
                  <span className="text-sm font-medium text-text-primary font-mono">
                    {formatUSD(item.value)}
                  </span>
                </div>
                {/* Bar */}
                <div className="h-1.5 rounded-full bg-surface-lighter overflow-hidden">
                  <div
                    className={`h-full rounded-full ${item.barColor} transition-all duration-500 ease-out`}
                    style={{ width: `${Math.min(100, Math.max(pct, 1))}%` }}
                  />
                </div>
                <p className="text-xs text-text-muted mt-1">
                  {note}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  className = "",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`card text-center ${className}`}>
      <Icon className="w-5 h-5 text-text-muted mx-auto mb-2" />
      <p className="text-lg sm:text-xl font-bold text-text-primary font-[family-name:var(--font-display)]">{value}</p>
      <p className="text-xs text-text-muted mt-0.5">{label}</p>
    </div>
  );
}
