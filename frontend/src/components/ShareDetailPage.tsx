import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
import {
  parseUtcDate,
  type ShareDetail,
  type DownloadLogEntry,
} from "../lib/api";
import { downloadFiles } from "../lib/download";
import ConfirmTransferDeletion from "./ConfirmTransferDeletion";
import TransferCover from "./TransferCover";
import { getShareStatus, statusLabels } from "../lib/transferStatus";
import { useWorkspace } from "../context/workspace";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  Globe,
  HardDrive,
  Loader2,
  AlertCircle,
  Clock,
  Trash2,
} from "lucide-react";
import "./workspace-transfers.css";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDateTime(iso: string): string {
  return parseUtcDate(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EXTEND_OPTIONS = [
  { label: "+7 days", days: 7 },
  { label: "+30 days", days: 30 },
  { label: "+90 days", days: 90 },
  { label: "+1 year", days: 365 },
];

export default function ShareDetailPage() {
  const { client: { shares: sharesApi }, readOnly } = useWorkspace();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { state } = useLocation();
  const dashboard = { pathname: "/dashboard", search: typeof state?.dashboardSearch === "string" ? state.dashboardSearch : "" };
  const [share, setShare] = useState<ShareDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [extending, setExtending] = useState(false);
  const [showExtend, setShowExtend] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [togglingPause, setTogglingPause] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setShare(null);
    setError(null);
    async function load(shareId: string) {
      try {
        const result = await sharesApi.get(shareId);
        if (!cancelled) setShare(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load share.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load(id);
    return () => { cancelled = true; };
  }, [id, sharesApi, loadVersion]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${id}`);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the share link.");
    }
  };

  const handleExtend = async (days: number) => {
    if (!id || readOnly || extending) return;
    setExtending(true);
    setError(null);
    try {
      const res = await sharesApi.extend(id, days);
      setShare((prev) => (prev ? { ...prev, expires_at: res.expires_at } : prev));
      setShowExtend(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to extend share.");
    } finally {
      setExtending(false);
    }
  };

  const handleTogglePause = async () => {
    if (!id || !share || readOnly || togglingPause) return;
    setTogglingPause(true);
    setError(null);
    try {
      const res = await sharesApi.setPaused(id, !share.is_paused);
      setShare((prev) => (prev ? { ...prev, is_paused: res.is_paused } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update share.");
    } finally {
      setTogglingPause(false);
    }
  };

  const handleDelete = async () => {
    if (!id || readOnly || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await sharesApi.purge(id);
      navigate(dashboard);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to permanently delete share.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleDownloadFile = async (fileId: string, filename: string) => {
    if (!id || downloadingIds.has(fileId)) return;
    setDownloadingIds((previous) => new Set(previous).add(fileId));
    try {
      const res = await sharesApi.downloadFile(id, fileId);
      await downloadFiles(res.files, filename);
    } catch {
      setError("Download failed.");
    } finally {
      setDownloadingIds((previous) => {
        const next = new Set(previous);
        next.delete(fileId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-text-secondary">
        <Loader2 className="size-5 text-primary motion-safe:animate-spin" aria-hidden="true" />
        Loading share details…
      </div>
    );
  }

  if (!share) {
    return (
      <div className="surface mx-auto grid max-w-lg justify-items-start gap-3 rounded-2xl p-5">
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          {error || "Share not found."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setLoadVersion((version) => version + 1)} className="btn-secondary text-sm">Retry</button>
          <Link to={dashboard} className="workspace-row-action">Back to dashboard</Link>
        </div>
      </div>
    );
  }

  const isLive = share.is_active;
  const status = getShareStatus(share);

  return (
    <div className="workspace-transfer-flow mx-auto grid max-w-5xl gap-4 sm:gap-5">
      <button onClick={() => navigate(dashboard)} className="workspace-row-action justify-self-start">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Dashboard
      </button>

      <TransferCover title={share.title || "Untitled share"} />

      <div className="surface flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <span className="workspace-transfer-status" data-status={status}>{statusLabels[status]}</span>
          <span className="min-w-0 font-mono text-sm text-text-secondary [overflow-wrap:anywhere]">{share.id}</span>
        </div>

        {(isLive || !readOnly) && (
          <div role="group" aria-label="Share actions" className="flex flex-wrap gap-2">
            {isLive && (
              <button
                onClick={handleCopy}
                aria-label="Copy link"
                className="btn-secondary inline-flex items-center gap-2 rounded-xl px-3 text-sm"
              >
                {copied ? <Check className="size-4 text-success" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                {copied ? "Copied!" : "Copy Link"}
              </button>
            )}
            {isLive && !readOnly && (
              <>
                <button
                  onClick={handleTogglePause}
                  disabled={togglingPause}
                  className="btn-secondary inline-flex items-center gap-2 rounded-xl px-3 text-sm"
                >
                  {togglingPause ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                    : share.is_paused ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                  {share.is_paused ? "Unhide" : "Hide"}
                </button>
                <button
                  onClick={() => setShowExtend((previous) => !previous)}
                  aria-expanded={showExtend}
                  aria-controls={showExtend ? "share-expiry-options" : undefined}
                  className="btn-secondary inline-flex items-center gap-2 rounded-xl px-3 text-sm"
                >
                  <CalendarPlus className="size-4" aria-hidden="true" />
                  Extend
                </button>
              </>
            )}
            {!readOnly && (
              <button
                onClick={() => setConfirmDelete(true)}
                aria-label="Permanently delete share"
                title="Delete permanently"
                className="workspace-row-action workspace-row-delete"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            )}
            <span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
          </div>
        )}
      </div>

      {isLive && share.is_paused && (
        <div role="status" className="workspace-transfer-notice border-warning/25 bg-warning-container text-on-warning-container">
          <EyeOff className="size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">This share is hidden. Recipients see a “not found” message until you unhide it.</p>
        </div>
      )}

      {isLive && !readOnly && showExtend && (
        <div id="share-expiry-options" role="group" aria-label="New expiry" className="surface rounded-2xl p-4">
          <p className="mb-3 text-sm text-text-secondary">Set a new expiry counted from now.</p>
          <div className="flex flex-wrap gap-2">
            {EXTEND_OPTIONS.map((option) => (
              <button
                key={option.days}
                disabled={extending}
                onClick={() => handleExtend(option.days)}
                className="btn-secondary inline-flex items-center gap-1.5 rounded-full text-sm"
              >
                {extending && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />}
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="workspace-transfer-notice border-danger/25 bg-danger/10 text-danger">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">{error}</p>
        </div>
      )}

      <dl className="surface grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl px-4 py-4 sm:grid-cols-4 sm:px-5">
        <StatTile icon={<FileText className="size-4" aria-hidden="true" />} label="Files" value={String(share.file_count)} />
        <StatTile icon={<HardDrive className="size-4" aria-hidden="true" />} label="Size" value={formatBytes(share.total_size)} />
        <StatTile
          icon={<Download className="size-4" aria-hidden="true" />}
          label="Downloads"
          value={`${share.download_count}${share.max_downloads != null ? ` / ${share.max_downloads}` : ""}`}
        />
        <StatTile
          icon={<Clock className="size-4" aria-hidden="true" />}
          label="Expires"
          value={share.expires_at ? formatDateTime(share.expires_at) : "Never"}
        />
      </dl>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="share-files" className="surface min-w-0 rounded-2xl">
          <h2 id="share-files" className="px-4 py-3 text-lg font-semibold text-text-primary">Files</h2>
          {share.files.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-text-secondary">No files.</p>
          ) : (
            <ul className="divide-y divide-border border-t border-border" role="list">
              {share.files.map((file) => {
                const downloading = downloadingIds.has(file.id);
                const filenameId = `share-file-${file.id}`;
                return (
                  <li key={file.id} className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
                    <span className="workspace-transfer-tile">
                      <FileText className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p id={filenameId} className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">{file.original_filename}</p>
                      <p className="text-xs text-text-secondary">{formatBytes(file.file_size)}</p>
                    </div>
                    {isLive && (
                      <button
                        onClick={() => handleDownloadFile(file.id, file.original_filename)}
                        disabled={downloading}
                        aria-label="Download"
                        aria-describedby={filenameId}
                        aria-busy={downloading}
                        title="Download"
                        className="workspace-row-action"
                      >
                        {downloading ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                          : <Download className="size-4" aria-hidden="true" />}
                        <span className="hidden sm:inline" aria-hidden="true">Download</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="download-log" className="surface min-w-0 rounded-2xl">
          <div className="px-4 py-3">
            <h2 id="download-log" className="text-lg font-semibold text-text-primary">Download log</h2>
            {share.downloads.length > 0 && (
              <p className="mt-1 text-xs text-text-secondary">Most recent download events. Files in a bundle are logged separately.</p>
            )}
          </div>
          {share.downloads.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-text-secondary">No downloads yet.</p>
          ) : (
            <ul className="divide-y divide-border border-t border-border" role="list">
              {share.downloads.map((entry, index) => <DownloadLogRow key={index} entry={entry} />)}
            </ul>
          )}
        </section>
      </div>

      {confirmDelete && (
        <ConfirmTransferDeletion
          title="Permanently delete share?"
          description={`“${share.title || "Untitled share"}” and all associated files and download history will be permanently deleted.`}
          progress={deleting ? { completed: 0, total: 1 } : null}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-xs text-text-secondary">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-text-primary [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function DownloadLogRow({ entry }: { entry: DownloadLogEntry }) {
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <time dateTime={entry.downloaded_at} className="font-medium text-text-primary">{formatDateTime(entry.downloaded_at)}</time>
        {entry.ip_address && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
            <Globe className="size-3 shrink-0" aria-hidden="true" />
            <span className="[overflow-wrap:anywhere]">{entry.ip_address}</span>
          </span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        {entry.original_filename && <span className="truncate">{entry.original_filename}</span>}
        {entry.user_agent && <span className="max-w-full truncate">{entry.user_agent.slice(0, 80)}</span>}
      </div>
    </li>
  );
}
