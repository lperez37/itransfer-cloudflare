import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  shares as sharesApi,
  requests as requestsApi,
  parseUtcDate,
  type Share,
  type FileRequest,
} from "../lib/api";
import { downloadFiles } from "../lib/download";
import {
  Upload,
  Inbox,
  Copy,
  Trash2,
  Check,
  Clock,
  Download,
  ArrowUpCircle,
  FileText,
  HardDrive,
  Loader2,
  Plus,
  AlertCircle,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "No expiry";
  const d = parseUtcDate(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return "Expired";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days <= 1) return "Expires today";
  if (days <= 2) return "Expires tomorrow";
  if (days < 30) return `${days} days left`;
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "short" });
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

type ItemStatus = "uploading" | "active" | "hidden" | "expired" | "exhausted" | "deleted";

/** True when the row was deactivated because it expired (cron reclaim),
 * as opposed to being deleted by the admin before its expiry. */
function reclaimedAtExpiry(deactivatedAt?: string | null, expiresAt?: string | null): boolean {
  return (
    !!deactivatedAt &&
    !!expiresAt &&
    parseUtcDate(deactivatedAt).getTime() >= parseUtcDate(expiresAt).getTime()
  );
}

function getShareStatus(share: Share): ItemStatus {
  if (!share.is_active && !share.confirmed_at) return "uploading";
  if (!share.is_active) {
    return reclaimedAtExpiry(share.deactivated_at, share.expires_at) ? "expired" : "deleted";
  }
  if (share.expires_at && parseUtcDate(share.expires_at).getTime() < Date.now()) return "expired";
  if (share.is_paused) return "hidden";
  if (share.max_downloads != null && share.download_count >= share.max_downloads) return "exhausted";
  return "active";
}

function getRequestStatus(req: FileRequest): ItemStatus {
  if (!req.is_active) {
    return reclaimedAtExpiry(req.deactivated_at, req.expires_at) ? "expired" : "deleted";
  }
  if (req.expires_at && parseUtcDate(req.expires_at).getTime() < Date.now()) return "expired";
  if (req.max_uploads != null && req.upload_count >= req.max_uploads) return "exhausted";
  return "active";
}

/** Statuses whose share/download links still work for recipients. */
function isLive(status: ItemStatus): boolean {
  return status === "active" || status === "exhausted" || status === "hidden";
}

function StatusBadge({ status }: { status: ItemStatus }) {
  const config = {
    active: { bg: "bg-success/15", text: "text-emerald-400", label: "Active" },
    uploading: { bg: "bg-sky-500/15", text: "text-sky-400 animate-pulse", label: "Uploading…" },
    hidden: { bg: "bg-violet-500/15", text: "text-violet-400", label: "Hidden" },
    expired: { bg: "bg-danger/15", text: "text-red-400", label: "Expired" },
    exhausted: {
      bg: "bg-warning/15",
      text: "text-amber-400",
      label: "Exhausted",
    },
    deleted: { bg: "bg-surface-lighter/50", text: "text-text-muted", label: "Deleted" },
  }[status];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${config.bg} ${config.text}`}
    >
      {config.label}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      <span>{copied ? "Copied!" : "Copy Link"}</span>
    </button>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"shares" | "requests">("shares");
  const [shareList, setShareList] = useState<Share[]>([]);
  const [requestList, setRequestList] = useState<FileRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const startDeleting = useCallback((id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
  }, []);
  const stopDeleting = useCallback((id: string) => {
    setDeletingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const [confirmDelete, setConfirmDelete] = useState<{ type: "share" | "request" | "share-purge" | "request-purge"; id: string; title: string } | null>(null);
  const [selectedShares, setSelectedShares] = useState<Set<string>>(new Set());
  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<"active" | "expired" | "deleted" | "all">("active");
  const { search } = useOutletContext<{ search: string }>();
  const [bulkProgress, setBulkProgress] = useState<{ completed: number; total: number; failed: number; running: boolean } | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([
        sharesApi.list(),
        requestsApi.list(),
      ]);
      if (signal?.cancelled) return;
      setShareList(s);
      setRequestList(r);
    } catch {
      if (signal?.cancelled) return;
      setError("Failed to load data. Please try again.");
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const handleDeleteShare = async (id: string) => {
    startDeleting(id);
    try {
      await sharesApi.delete(id);
      setShareList((prev) => prev.map((s) => s.id === id ? { ...s, is_active: false } : s));
      return true;
    } catch {
      setError("Failed to delete share.");
      return false;
    } finally {
      stopDeleting(id);
    }
  };

  const handleDeleteRequest = async (id: string) => {
    startDeleting(id);
    try {
      await requestsApi.delete(id);
      setRequestList((prev) => prev.map((r) => r.id === id ? { ...r, is_active: false } : r));
      return true;
    } catch {
      setError("Failed to delete request.");
      return false;
    } finally {
      stopDeleting(id);
    }
  };

  const handlePurgeShare = async (id: string) => {
    startDeleting(id);
    try {
      await sharesApi.purge(id);
      setShareList((prev) => prev.filter((s) => s.id !== id));
      return true;
    } catch {
      setError("Failed to permanently delete share.");
      return false;
    } finally {
      stopDeleting(id);
    }
  };

  const handlePurgeRequest = async (id: string) => {
    startDeleting(id);
    try {
      await requestsApi.purge(id);
      setRequestList((prev) => prev.filter((r) => r.id !== id));
      return true;
    } catch {
      setError("Failed to permanently delete request.");
      return false;
    } finally {
      stopDeleting(id);
    }
  };

  const origin = window.location.origin;

  const matchesFilter = (status: ItemStatus): boolean => {
    if (statusFilter === "all") return true;
    if (statusFilter === "active")
      return status === "active" || status === "exhausted" || status === "uploading" || status === "hidden";
    return status === statusFilter;
  };
  const q = search.trim().toLowerCase();
  const matchesSearch = (title: string | null | undefined, id: string): boolean =>
    !q || id.toLowerCase().includes(q) || (title ?? "").toLowerCase().includes(q);
  const filteredShares = shareList.filter(
    (s) => matchesFilter(getShareStatus(s)) && matchesSearch(s.title, s.id)
  );
  const filteredRequests = requestList.filter(
    (r) => matchesFilter(getRequestStatus(r)) && matchesSearch(r.title, r.id)
  );
  // Bulk actions on history views remove rows for good; on live views they soft-delete.
  const bulkIsPurge = statusFilter === "deleted" || statusFilter === "expired";

  const filterCounts = (statuses: ItemStatus[]) => ({
    all: statuses.length,
    active: statuses.filter((s) => s === "active" || s === "exhausted" || s === "uploading" || s === "hidden").length,
    expired: statuses.filter((s) => s === "expired").length,
    deleted: statuses.filter((s) => s === "deleted").length,
  });
  const counts =
    tab === "shares"
      ? filterCounts(shareList.map(getShareStatus))
      : filterCounts(requestList.map(getRequestStatus));

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">
            Dashboard
          </h1>
          <p className="text-text-muted text-sm mt-1">
            Manage your shares and file requests
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <button
            onClick={() => navigate("/upload")}
            className="btn-primary flex items-center justify-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" />
            New Share
          </button>
          <button
            onClick={() => navigate("/requests/new")}
            className="btn-secondary flex items-center justify-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" />
            New Request
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        <button
          onClick={() => setTab("shares")}
          className={`flex flex-1 sm:flex-initial items-center justify-center sm:justify-start gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
            tab === "shares"
              ? "border-primary text-primary-light"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <Upload className="w-4 h-4" />
          Shares
          {filteredShares.length > 0 && (
            <span className="ml-1 bg-primary/15 text-primary-light text-xs px-1.5 py-0.5 rounded">
              {filteredShares.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("requests")}
          className={`flex flex-1 sm:flex-initial items-center justify-center sm:justify-start gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
            tab === "requests"
              ? "border-primary text-primary-light"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <Inbox className="w-4 h-4" />
          Requests
          {filteredRequests.length > 0 && (
            <span className="ml-1 bg-primary/15 text-primary-light text-xs px-1.5 py-0.5 rounded">
              {filteredRequests.length}
            </span>
          )}
        </button>
      </div>

      {/* Status filter */}
      <div className="flex flex-wrap justify-center sm:justify-start gap-2 mb-6">
        {(["active", "expired", "deleted", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors capitalize ${
              statusFilter === f
                ? "bg-primary text-background"
                : "bg-surface-light text-text-secondary hover:text-text-primary"
            }`}
          >
            {f}
            <span className={statusFilter === f ? "ml-1.5 opacity-75" : "ml-1.5 text-text-muted"}>
              {counts[f]}
            </span>
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 flex items-center gap-2 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-red-400 animate-fade-in">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        </div>
      ) : tab === "shares" ? (
        /* Shares */
        filteredShares.length === 0 ? (
          <EmptyState
            icon={<Upload className="w-10 h-10 text-text-muted" />}
            title="No shares yet"
            description="Upload files to create your first share link."
            action={
              <button
                onClick={() => navigate("/upload")}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" />
                Create Share
              </button>
            }
          />
        ) : (
          <>
          {selectedShares.size > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 bg-surface-light rounded-md px-4 py-3 animate-fade-in">
              <span className="text-sm text-text-secondary">{selectedShares.size} selected</span>
              {bulkIsPurge ? (
                <button
                  onClick={() => setConfirmDelete({ type: "share-purge", id: "bulk", title: `${selectedShares.size} shares` })}
                  className="btn-secondary text-xs !px-3 !py-1.5 flex items-center gap-1.5 text-text-muted"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove forever</span>
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDelete({ type: "share", id: "bulk", title: `${selectedShares.size} shares` })}
                  className="btn-danger text-xs !px-3 !py-1.5 flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => setSelectedShares(new Set(filteredShares.map(s => s.id)))} className="text-xs text-text-muted hover:text-text-primary">
                Select all
              </button>
              <button onClick={() => setSelectedShares(new Set())} className="text-xs text-text-muted hover:text-text-primary">
                Clear
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredShares.map((share) => (
              <div
                key={share.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button, input, a")) return;
                  navigate(`/shares/${share.id}`);
                }}
                className="card group animate-fade-in cursor-pointer"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-start flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedShares.has(share.id)}
                      onChange={(e) => {
                        e.stopPropagation();
                        setSelectedShares(prev => {
                          const next = new Set(prev);
                          if (next.has(share.id)) next.delete(share.id); else next.add(share.id);
                          return next;
                        });
                      }}
                      className="w-4 h-4 rounded accent-primary mr-2 mt-1 appearance-none bg-surface-lighter border border-border checked:bg-primary checked:border-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-text-primary truncate">
                        {share.title || "Untitled share"}
                      </h3>
                      <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                        {share.id}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={getShareStatus(share)} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 mb-4 text-sm">
                  <div className="flex items-center gap-2 text-text-secondary">
                    <FileText className="w-3.5 h-3.5" />
                    {share.file_count} file{share.file_count !== 1 ? "s" : ""}
                  </div>
                  <div className="flex items-center gap-2 text-text-secondary">
                    <HardDrive className="w-3.5 h-3.5" />
                    {formatBytes(share.total_size)}
                  </div>
                  <div className="flex items-center gap-2 text-text-secondary">
                    <Download className="w-3.5 h-3.5" />
                    {share.download_count}
                    {share.max_downloads != null
                      ? ` / ${share.max_downloads}`
                      : ""}
                  </div>
                  <div className="flex items-center gap-2 text-text-secondary">
                    <Clock className="w-3.5 h-3.5" />
                    {formatDate(share.expires_at)}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-3 border-t border-border">
                  {!isLive(getShareStatus(share)) ? (
                    <button
                      onClick={() => setConfirmDelete({ type: "share-purge", id: share.id, title: share.title || "Untitled share" })}
                      disabled={deletingIds.has(share.id)}
                      className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5 text-text-muted"
                    >
                      {deletingIds.has(share.id) ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      <span>Remove forever</span>
                    </button>
                  ) : (
                    <>
                      <CopyButton text={`${origin}/${share.id}`} />
                      {share.file_count > 0 && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const res = await sharesApi.download(share.id);
                              await downloadFiles(res.files, share.title || share.id);
                            } catch { setError("Download failed."); }
                          }}
                          className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDelete({ type: "share", id: share.id, title: share.title || "Untitled share" })}
                        disabled={deletingIds.has(share.id)}
                        className="btn-danger !px-3 !py-1.5 text-xs flex items-center gap-1.5 ml-auto"
                      >
                        {deletingIds.has(share.id) ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          </>
        )
      ) : /* Requests */
      filteredRequests.length === 0 ? (
        <EmptyState
          icon={<Inbox className="w-10 h-10 text-text-muted" />}
          title="No requests yet"
          description="Create a file request to receive uploads from others."
          action={
            <button
              onClick={() => navigate("/requests/new")}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Plus className="w-4 h-4" />
              Create Request
            </button>
          }
        />
      ) : (
        <>
        {selectedRequests.size > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-3 bg-surface-light rounded-md px-4 py-3 animate-fade-in">
            <span className="text-sm text-text-secondary">{selectedRequests.size} selected</span>
            {bulkIsPurge ? (
              <button
                onClick={() => setConfirmDelete({ type: "request-purge", id: "bulk", title: `${selectedRequests.size} requests` })}
                className="btn-secondary text-xs !px-3 !py-1.5 flex items-center gap-1.5 text-text-muted"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove forever</span>
              </button>
            ) : (
              <button
                onClick={() => setConfirmDelete({ type: "request", id: "bulk", title: `${selectedRequests.size} requests` })}
                className="btn-danger text-xs !px-3 !py-1.5 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => setSelectedRequests(new Set(filteredRequests.map(r => r.id)))} className="text-xs text-text-muted hover:text-text-primary">
              Select all
            </button>
            <button onClick={() => setSelectedRequests(new Set())} className="text-xs text-text-muted hover:text-text-primary">
              Clear
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRequests.map((req) => (
            <div key={req.id} className="card group animate-fade-in">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={selectedRequests.has(req.id)}
                    onChange={(e) => {
                      e.stopPropagation();
                      setSelectedRequests(prev => {
                        const next = new Set(prev);
                        if (next.has(req.id)) next.delete(req.id); else next.add(req.id);
                        return next;
                      });
                    }}
                    className="w-4 h-4 rounded accent-primary mr-2 mt-1 appearance-none bg-surface-lighter border border-border checked:bg-primary checked:border-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-text-primary truncate">
                      {req.title}
                    </h3>
                    <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                      {req.id}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <StatusBadge status={getRequestStatus(req)} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 mb-4 text-sm">
                <div className="flex items-center gap-2 text-text-secondary">
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  {req.upload_count}
                  {req.max_uploads != null ? ` / ${req.max_uploads}` : ""}{" "}
                  uploads
                </div>
                <div className="flex items-center gap-2 text-text-secondary">
                  <Clock className="w-3.5 h-3.5" />
                  {formatDate(req.expires_at)}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-3 border-t border-border">
                {!isLive(getRequestStatus(req)) ? (
                  <button
                    onClick={() => setConfirmDelete({ type: "request-purge", id: req.id, title: req.title })}
                    disabled={deletingIds.has(req.id)}
                    className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5 text-text-muted"
                  >
                    {deletingIds.has(req.id) ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    <span>Remove forever</span>
                  </button>
                ) : (
                  <>
                    <CopyButton text={`${origin}/${req.id}`} />
                    {(req.file_count ?? 0) > 0 && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const res = await requestsApi.download(req.id);
                            await downloadFiles(res.files, req.title || req.id);
                          } catch { setError("Download failed."); }
                        }}
                        className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </button>
                    )}
                    <button
                      onClick={() => setConfirmDelete({ type: "request", id: req.id, title: req.title })}
                      disabled={deletingIds.has(req.id)}
                      className="btn-danger !px-3 !py-1.5 text-xs flex items-center gap-1.5 ml-auto"
                    >
                      {deletingIds.has(req.id) ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        </>
      )}

      {confirmDelete && (() => {
        const isPurge = confirmDelete.type.endsWith("-purge");
        const baseType = confirmDelete.type.replace("-purge", "") as "share" | "request";
        const isBulk = confirmDelete.id === "bulk";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="surface rounded-lg p-6 max-w-sm w-full animate-fade-in">
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                {isPurge ? "Permanently remove" : "Delete"} {baseType}?
              </h3>
              <p className="text-sm text-text-muted mb-5">
                {bulkProgress
                  ? bulkProgress.running
                    ? `${bulkProgress.completed} of ${bulkProgress.total} processed${bulkProgress.failed ? `, ${bulkProgress.failed} failed` : ""}.`
                    : bulkProgress.failed
                      ? `Finished with ${bulkProgress.total - bulkProgress.failed} removed and ${bulkProgress.failed} failed. Failed items remain selected.`
                      : `All ${bulkProgress.total} items were successfully ${isPurge ? "removed forever" : "deleted"}.`
                  : isPurge
                  ? `"${confirmDelete.title}" will be permanently removed from the database. This cannot be undone.`
                  : `"${confirmDelete.title}" will be deleted along with all its files. This cannot be undone.`}
              </p>
              {bulkProgress && (
                <div className="h-2 rounded-full bg-surface-lighter overflow-hidden mb-5">
                  <div
                    className="h-full bg-primary transition-all duration-200"
                    style={{ width: `${(bulkProgress.completed / bulkProgress.total) * 100}%` }}
                  />
                </div>
              )}
              <div className="flex gap-3 justify-end">
                {!bulkProgress?.running && (
                  <button
                    onClick={() => {
                      setConfirmDelete(null);
                      setBulkProgress(null);
                    }}
                    className="btn-secondary text-sm"
                  >{bulkProgress ? "Close" : "Cancel"}</button>
                )}
                {!bulkProgress || bulkProgress.running ? (
                <button
                  disabled={bulkProgress?.running}
                  onClick={async () => {
                    if (isBulk) {
                      const ids = [...(baseType === "share" ? selectedShares : selectedRequests)];
                      const handler = baseType === "share"
                        ? (isPurge ? handlePurgeShare : handleDeleteShare)
                        : (isPurge ? handlePurgeRequest : handleDeleteRequest);
                      const failedIds: string[] = [];
                      setError(null);
                      setBulkProgress({ completed: 0, total: ids.length, failed: 0, running: true });

                      for (const [index, id] of ids.entries()) {
                        if (!await handler(id)) failedIds.push(id);
                        setBulkProgress({ completed: index + 1, total: ids.length, failed: failedIds.length, running: index + 1 < ids.length });
                      }

                      const failedSelection = new Set(failedIds);
                      if (baseType === "share") setSelectedShares(failedSelection);
                      else setSelectedRequests(failedSelection);
                      if (failedIds.length) setError(`${failedIds.length} item${failedIds.length === 1 ? "" : "s"} could not be removed.`);
                    } else {
                      if (baseType === "share") {
                        await (isPurge ? handlePurgeShare : handleDeleteShare)(confirmDelete.id);
                      } else {
                        await (isPurge ? handlePurgeRequest : handleDeleteRequest)(confirmDelete.id);
                      }
                      setConfirmDelete(null);
                    }
                  }}
                  className="btn-danger text-sm flex items-center gap-2"
                >
                  {bulkProgress?.running && <Loader2 className="w-4 h-4 animate-spin" />}
                  {bulkProgress?.running ? "Working..." : isPurge ? "Remove forever" : "Delete"}
                </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
      <div className="w-20 h-20 rounded-lg bg-surface-light flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-text-primary mb-1">{title}</h3>
      <p className="text-sm text-text-muted mb-6 max-w-sm">{description}</p>
      {action}
    </div>
  );
}
