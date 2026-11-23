import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  parseUtcDate,
  type ShareDetail,
  type DownloadLogEntry,
} from "../lib/api";
import { downloadFiles } from "../lib/download";
import ConfirmTransferDeletion from "./ConfirmTransferDeletion";
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
  const [share, setShare] = useState<ShareDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [extending, setExtending] = useState(false);
  const [showExtend, setShowExtend] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setShare(await sharesApi.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load share.");
    } finally {
      setLoading(false);
    }
  }, [id, sharesApi]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/${id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExtend = async (days: number) => {
    if (!id) return;
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
    if (!id || !share) return;
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
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to permanently delete share.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleDownloadFile = async (fileId: string, filename: string) => {
    if (!id) return;
    setDownloadingId(fileId);
    try {
      const res = await sharesApi.downloadFile(id, fileId);
      await downloadFiles(res.files, filename);
    } catch {
      setError("Download failed.");
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!share) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="w-10 h-10 text-danger mb-3" />
        <p className="text-text-secondary mb-4">{error || "Share not found."}</p>
        <Link to="/dashboard" className="btn-secondary text-sm">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const isLive = share.is_active;

  return (
    <div className="animate-fade-in max-w-4xl mx-auto">
      {/* Header */}
      <button
        onClick={() => navigate("/dashboard")}
        className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Dashboard
      </button>

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight truncate">
            {share.title || "Untitled share"}
          </h1>
          <p className="text-sm text-text-muted mt-1 font-mono break-all">{share.id}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isLive && (
            <>
            <button
              onClick={handleCopy}
              aria-label="Copy link"
              className="btn-secondary !px-3 sm:!px-4 text-sm flex items-center gap-2"
            >
              {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              <span className="hidden sm:inline">{copied ? "Copied!" : "Copy Link"}</span>
            </button>
            <button
              onClick={handleTogglePause}
              disabled={readOnly || togglingPause}
              className="btn-secondary text-sm flex items-center gap-2"
            >
              {togglingPause ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : share.is_paused ? (
                <Eye className="w-4 h-4" />
              ) : (
                <EyeOff className="w-4 h-4" />
              )}
              {share.is_paused ? "Unhide" : "Hide"}
            </button>
            <button
              onClick={() => setShowExtend(!showExtend)}
              disabled={readOnly}
              className="btn-primary text-sm flex items-center gap-2"
            >
              <CalendarPlus className="w-4 h-4" />
              Extend
            </button>
            </>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={readOnly}
            aria-label="Permanently delete share"
            title="Delete permanently"
            className="btn-danger !px-3 text-sm flex items-center"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Hidden notice */}
      {isLive && share.is_paused && (
        <div className="mb-6 flex items-center gap-2 bg-warning/10 border border-warning/20 rounded-md px-4 py-3 text-sm text-warning animate-fade-in">
          <EyeOff className="w-4 h-4 flex-shrink-0" />
          This share is hidden. Recipients get "not found" until you unhide it; files are kept.
        </div>
      )}

      {/* Extend picker */}
      {showExtend && (
        <div className="mb-6 surface rounded-lg p-4 animate-fade-in">
          <p className="text-sm text-text-secondary mb-3">
            Set a new expiry, counted from now:
          </p>
          <div className="flex flex-wrap gap-2">
            {EXTEND_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                disabled={extending}
                onClick={() => handleExtend(opt.days)}
                className="btn-secondary text-sm flex items-center gap-1.5"
              >
                {extending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 flex items-center gap-2 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-danger">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatTile icon={<FileText className="w-4 h-4" />} label="Files" value={String(share.file_count)} />
        <StatTile icon={<HardDrive className="w-4 h-4" />} label="Size" value={formatBytes(share.total_size)} />
        <StatTile
          icon={<Download className="w-4 h-4" />}
          label="Downloads"
          value={`${share.download_count}${share.max_downloads != null ? ` / ${share.max_downloads}` : ""}`}
        />
        <StatTile
          icon={<Clock className="w-4 h-4" />}
          label="Expires"
          value={share.expires_at ? formatDateTime(share.expires_at) : "Never"}
        />
      </div>

      {/* Files */}
      <div className="surface rounded-lg p-5 mb-6">
        <h2 className="font-semibold text-text-primary mb-4">Files</h2>
        {share.files.length === 0 ? (
          <p className="text-sm text-text-muted">No files.</p>
        ) : (
          <div className="divide-y divide-border">
            {share.files.map((f) => (
              <div key={f.id} className="flex items-center gap-3 py-3">
                <FileText className="w-4 h-4 text-text-muted flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{f.original_filename}</p>
                  <p className="text-xs text-text-muted">{formatBytes(f.file_size)}</p>
                </div>
                {isLive && (
                  <button
                    onClick={() => handleDownloadFile(f.id, f.original_filename)}
                    disabled={downloadingId === f.id}
                    className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5 flex-shrink-0"
                  >
                    {downloadingId === f.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    Download
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <ConfirmTransferDeletion
          title="Permanently delete share?"
          description={`“${share.title || "Untitled share"}” and all associated files and download history will be permanently deleted.`}
          progress={deleting ? { completed: 0, total: 1 } : null}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDelete}
        />
      )}

      {/* Download log */}
      <div className="surface rounded-lg p-5">
        <h2 className="font-semibold text-text-primary mb-1">Download log</h2>
        <p className="text-xs text-text-muted mb-4">
          Most recent download events (each file in a bundle logs separately).
        </p>
        {share.downloads.length === 0 ? (
          <p className="text-sm text-text-muted">No downloads yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {share.downloads.map((d, i) => (
              <DownloadLogRow key={i} entry={d} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="surface rounded-lg p-4">
      <div className="flex items-center gap-2 text-text-muted text-xs mb-1.5">
        {icon}
        {label}
      </div>
      <p className="text-sm font-semibold text-text-primary truncate">{value}</p>
    </div>
  );
}

function DownloadLogRow({ entry }: { entry: DownloadLogEntry }) {
  return (
    <div className="py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-text-primary">{formatDateTime(entry.downloaded_at)}</span>
        {entry.ip_address && (
          <span className="flex items-center gap-1 text-text-secondary text-xs">
            <Globe className="w-3 h-3" />
            {entry.ip_address}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-xs text-text-muted">
        {entry.original_filename && <span className="truncate">{entry.original_filename}</span>}
        {entry.user_agent && <span className="truncate max-w-full">{entry.user_agent.slice(0, 80)}</span>}
      </div>
    </div>
  );
}
