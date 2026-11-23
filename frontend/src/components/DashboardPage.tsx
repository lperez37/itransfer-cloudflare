import { useState, useEffect, useId, useRef } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import {
  parseUtcDate,
  type Share,
  type FileRequest,
} from "../lib/api";
import { downloadFiles } from "../lib/download";
import { getRequestStatus, getShareStatus, statusLabels, type TransferStatus } from "../lib/transferStatus";
import { useWorkspace } from "../context/workspace";
import ConfirmTransferDeletion from "./ConfirmTransferDeletion";
import TransferCover from "./TransferCover";
import {
  Inbox,
  Copy,
  Trash2,
  Check,
  Download,
  Ellipsis,
  FileText,
  Loader2,
  ListChecks,
  Plus,
  AlertCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import "./workspace-transfers.css";

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

const STATUS_FILTERS = ["active", "expired", "deleted", "all"] as const;

function matchesFilter(status: TransferStatus, filter: typeof STATUS_FILTERS[number]) {
  if (filter === "all") return true;
  if (filter === "active") return isLive(status) || status === "uploading";
  return status === filter;
}

function isLive(status: TransferStatus): boolean {
  return status === "active" || status === "exhausted" || status === "hidden";
}

function StatusBadge({ status }: { status: TransferStatus }) {
  return (
    <span className="workspace-transfer-status" data-status={status}>
      {statusLabels[status]}
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

  const handleCopy = async () => {
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
      aria-label="Copy Link"
      title={copied ? "Copied!" : "Copy Link"}
      className="workspace-row-action"
    >
      {copied ? <Check className="size-4 text-success" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      <span className="workspace-row-action-label" aria-hidden="true">{copied ? "Copied!" : "Copy Link"}</span>
      <span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
    </button>
  );
}

function TransferRowActions({
  kind, title, titleId, copyLink, onDownload, downloading, onDelete,
}: {
  kind: "share" | "request";
  title: string;
  titleId: string;
  copyLink?: string;
  onDownload?: () => void;
  downloading: boolean;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!expanded) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !group.current?.contains(event.target)) {
        setExpanded(false);
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [expanded]);

  function closeDisclosure() {
    if (!expanded) return;
    toggle.current?.focus();
    setExpanded(false);
  }

  return (
    <div
      ref={group}
      className="workspace-transfer-actions"
      role="group"
      aria-labelledby={titleId}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeDisclosure();
        }
      }}
    >
      {copyLink && <CopyButton text={copyLink} />}
      {(onDownload || onDelete) && (
        <>
          <button
            ref={toggle}
            aria-label={`Actions for ${title}`}
            title="More actions"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((open) => !open)}
            className="workspace-row-action workspace-overflow-toggle"
          >
            <Ellipsis className="size-5" aria-hidden="true" />
          </button>
          <div className="workspace-secondary-actions" id={panelId} data-expanded={expanded}>
            {onDownload && (
              <button
                onClick={() => { closeDisclosure(); onDownload(); }}
                disabled={downloading}
                aria-label="Download"
                aria-busy={downloading}
                title="Download"
                className="workspace-row-action"
              >
                {downloading ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                <span className="workspace-row-action-label" aria-hidden="true">Download</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => { closeDisclosure(); onDelete(); }}
                aria-label={`Permanently delete ${kind}`}
                title="Delete permanently"
                className="workspace-row-action workspace-row-delete"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                <span className="workspace-overflow-label" aria-hidden="true">Delete permanently</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { client: { shares: sharesApi, requests: requestsApi }, readOnly } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "requests" ? "requests" : "shares";
  const statusFilter = STATUS_FILTERS.find((filter) => filter === searchParams.get("status")) ?? "active";
  const [shareList, setShareList] = useState<Share[]>([]);
  const [requestList, setRequestList] = useState<FileRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ type: "share" | "request"; ids: string[]; title?: string } | null>(null);
  const [selectedShares, setSelectedShares] = useState<Set<string>>(new Set());
  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const { search } = useOutletContext<{ search: string }>();
  const [deleteProgress, setDeleteProgress] = useState<{ completed: number; total: number } | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [shares, requests] = await Promise.all([sharesApi.list(), requestsApi.list()]);
        if (cancelled) return;
        setShareList(shares);
        setRequestList(requests);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load data. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [loadVersion, sharesApi, requestsApi]);

  const permanentlyDelete = async () => {
    if (!confirmDelete || readOnly || deleteProgress) return;
    const { type, ids } = confirmDelete;
    const api = type === "share" ? sharesApi : requestsApi;
    const removed = new Set<string>();
    let firstError: string | null = null;
    setError(null);
    setDeleteProgress({ completed: 0, total: ids.length });
    for (const [index, id] of ids.entries()) {
      try {
        await api.purge(id);
        removed.add(id);
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : "Please try again.";
      }
      setDeleteProgress({ completed: index + 1, total: ids.length });
    }
    const keepSelected = (selected: Set<string>) => new Set([...selected].filter((id) => !removed.has(id)));
    if (type === "share") {
      setShareList((rows) => rows.filter((row) => !removed.has(row.id)));
      setSelectedShares(keepSelected);
    } else {
      setRequestList((rows) => rows.filter((row) => !removed.has(row.id)));
      setSelectedRequests(keepSelected);
    }
    if (firstError) {
      const failed = ids.length - removed.size;
      setError(failed === 1 ? `Could not permanently delete the ${type}. ${firstError}`
        : `Could not permanently delete ${failed} ${type}s. ${firstError}`);
    }
    setConfirmDelete(null);
    setDeleteProgress(null);
  };

  const isShare = tab === "shares";
  const kind = isShare ? "share" : "request";
  const tabLabel = isShare ? "Shares" : "Requests";
  const createLabel = isShare ? "New Share" : "New Request";
  const composerPath = isShare ? "/upload" : "/requests/new";
  const dashboardState = { dashboardSearch: location.search };
  const selected = isShare ? selectedShares : selectedRequests;
  const setSelected = isShare ? setSelectedShares : setSelectedRequests;
  const selecting = selectionMode || selected.size > 0;

  const entries = isShare
    ? shareList.map((share) => ({
      id: share.id,
      title: share.title,
      status: getShareStatus(share),
      expiresAt: share.expires_at,
      canDownload: share.file_count > 0,
      summary: [
        fileCountLabel(share.file_count),
        formatBytes(share.total_size),
        transferCountLabel(share.download_count, share.max_downloads, "download"),
      ],
    }))
    : requestList.map((req) => ({
      id: req.id,
      title: req.title,
      status: getRequestStatus(req),
      expiresAt: req.expires_at,
      canDownload: (req.file_count ?? 0) > 0,
      summary: [
        req.file_count != null ? fileCountLabel(req.file_count) : null,
        transferCountLabel(req.upload_count, req.max_uploads, "upload"),
      ],
    }));
  const urlQuery = (searchParams.get("q") ?? "").trim();
  const query = (search.trim() || urlQuery).toLowerCase();
  const visible = entries.filter((entry) =>
    matchesFilter(entry.status, statusFilter)
    && (!query || entry.id.toLowerCase().includes(query) || entry.title?.toLowerCase().includes(query)),
  );
  const counts = STATUS_FILTERS.map((filter) => entries.filter((entry) => matchesFilter(entry.status, filter)).length);
  const titleCounts = new Map<string, number>();
  for (const { title } of visible) {
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  function setViewParam(key: "tab" | "status" | "q", value: string, defaultValue: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { preventScrollReset: true });
  }

  function refresh() {
    setLoadVersion((version) => version + 1);
  }

  function selectTab(nextTab: "shares" | "requests") {
    if (tab === nextTab) return;
    setSelectionMode(false);
    setViewParam("tab", nextTab, "shares");
  }

  function toggleSelectionMode() {
    if (selecting) setSelected(new Set());
    setSelectionMode(!selecting);
  }

  function toggleSelection(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function download(id: string, title: string) {
    const key = `${kind}:${id}`;
    setDownloadingIds((previous) => new Set(previous).add(key));
    try {
      const api = isShare ? sharesApi : requestsApi;
      const result = await api.download(id);
      await downloadFiles(result.files, title || id);
    } catch {
      setError("Download failed.");
    } finally {
      setDownloadingIds((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="workspace-dashboard mx-auto grid max-w-6xl gap-4" data-variant={kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-text-primary">Dashboard</h1>
        {!readOnly && (
          <button
            onClick={() => navigate(isShare ? "/requests/new" : "/upload", { state: dashboardState })}
            className="btn-secondary inline-flex min-h-11 items-center gap-2 rounded-full text-sm"
          >
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            {isShare ? "New Request" : "New Share"}
          </button>
        )}
      </div>

      <TransferCover title={tabLabel} variant={kind} headingLevel={2}>
        {!readOnly && (
          <button
            onClick={() => navigate(composerPath, { state: dashboardState })}
            className="btn-primary inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-left text-sm"
          >
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            {createLabel}
          </button>
        )}
      </TransferCover>

      <div className="workspace-dashboard-toolbar">
        <div className="workspace-transfer-segmented" role="group" aria-label="Transfer type">
          <button
            aria-pressed={isShare}
            onClick={() => selectTab("shares")}
            className="text-primary"
          >
            <Send className="size-4" aria-hidden="true" />
            Shares
          </button>
          <button
            aria-pressed={!isShare}
            onClick={() => selectTab("requests")}
            className="text-accent"
          >
            <Inbox className="size-4" aria-hidden="true" />
            Requests
          </button>
        </div>

        <div className="workspace-dashboard-tools flex items-center">
          {!readOnly && (
            <button
              aria-label={`Select ${tab}`}
              aria-pressed={selecting}
              title={selecting ? "Exit selection" : `Select ${tab}`}
              onClick={toggleSelectionMode}
              disabled={loading || (!selecting && visible.length === 0)}
              className="workspace-row-action workspace-select-toggle"
            >
              <ListChecks className="size-5" aria-hidden="true" />
            </button>
          )}
          <button
            aria-label={`Refresh ${tab}`}
            title={`Refresh ${tab}`}
            onClick={refresh}
            disabled={loading}
            className="workspace-row-action"
          >
            <RefreshCw className={`size-4${loading ? " motion-safe:animate-spin" : ""}`} aria-hidden="true" />
          </button>
        </div>
        <div className="workspace-dashboard-filters flex flex-wrap items-center gap-1" role="group" aria-label="Transfer status">
          {STATUS_FILTERS.map((filter, index) => (
            <button
              key={filter}
              aria-pressed={statusFilter === filter}
              onClick={() => { if (statusFilter !== filter) setViewParam("status", filter, "active"); }}
              className="workspace-status-filter"
            >
              {filter.charAt(0).toUpperCase() + filter.slice(1)}
              <span className="font-normal tabular-nums">{counts[index]}</span>
            </button>
          ))}
        </div>
      </div>

      {!search.trim() && urlQuery && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 rounded-xl bg-surface-light px-3 text-sm text-text-secondary">
          <p className="min-w-0 py-2 [overflow-wrap:anywhere]">Search results for “{urlQuery}”</p>
          <button className="workspace-row-action" onClick={() => setViewParam("q", "", "")}>Clear search</button>
        </div>
      )}

      {error && (
        <div role="alert" className="workspace-transfer-notice border-danger/25 bg-danger/10 text-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">{error}</p>
          <button className="btn-secondary min-h-11 text-sm" disabled={loading} onClick={refresh}>Retry</button>
        </div>
      )}

      {!readOnly && !loading && visible.length > 0 && selecting && (
        <div role="group" aria-label="Selection actions" className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-light px-3 py-2">
          <span role="status" className="mr-auto text-sm font-semibold text-text-primary">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set(visible.map((entry) => entry.id)))} className="workspace-row-action">
            Select all
          </button>
          <button onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="workspace-row-action">
            Clear
          </button>
          <button
            onClick={() => setConfirmDelete({ type: kind, ids: [...selected] })}
            disabled={selected.size === 0}
            className="btn-danger inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm"
          >
            <Trash2 className="size-4 shrink-0" aria-hidden="true" />
            Delete permanently
          </button>
        </div>
      )}

      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-text-secondary">
          <Loader2 className="size-5 text-primary motion-safe:animate-spin" aria-hidden="true" />
          Loading {tab}…
        </div>
      ) : visible.length > 0 ? (
        <ul className="workspace-transfer-list" role="list" aria-label={tabLabel}>
          {visible.map((entry) => {
            const title = entry.title || (isShare ? "Untitled share" : "Untitled request");
            const isSelected = selected.has(entry.id);
            const live = isLive(entry.status);
            const downloading = downloadingIds.has(`${kind}:${entry.id}`);
            const titleId = `transfer-title-${entry.id}`;
            const matchesIdOnly = query && entry.id.toLowerCase().includes(query) && !title.toLowerCase().includes(query);
            const secondaryId = Boolean(entry.title && titleCounts.get(title) === 1 && !matchesIdOnly);
            const summary = (
              <>
                <span className="workspace-transfer-tile">
                  {isShare ? <FileText className="size-5" aria-hidden="true" /> : <Inbox className="size-5" aria-hidden="true" />}
                </span>
                <div className="min-w-0">
                  <h3 className="workspace-transfer-title" id={titleId} title={title}>{title}</h3>
                  {normalizeTitle(title) !== normalizeTitle(entry.id) && (
                    <p className="workspace-transfer-id truncate font-mono text-xs text-text-muted" data-secondary={secondaryId} title={entry.id}>{entry.id}</p>
                  )}
                </div>
                <div className="workspace-transfer-metadata">
                  <p>{entry.summary.filter(Boolean).join(" · ")}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <StatusBadge status={entry.status} />
                    {entry.status !== "expired" && <span>{formatDate(entry.expiresAt)}</span>}
                  </div>
                </div>
              </>
            );
            return (
              <li key={entry.id} className="workspace-transfer-row" data-selected={isSelected} data-selecting={selecting}>
                <div className="workspace-transfer-row-main">
                  {!readOnly && (
                    <label className="workspace-transfer-checkbox">
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.title || entry.id}`}
                        checked={isSelected}
                        onChange={() => toggleSelection(entry.id)}
                      />
                    </label>
                  )}
                  {isShare ? (
                    <Link
                      to={`/shares/${entry.id}`}
                      state={dashboardState}
                      aria-labelledby={titleId}
                      className="workspace-transfer-summary"
                    >
                      {summary}
                    </Link>
                  ) : (
                    <div className="workspace-transfer-summary">{summary}</div>
                  )}
                </div>
                {(live || !readOnly) && (
                  <TransferRowActions
                    kind={kind}
                    title={title}
                    titleId={titleId}
                    copyLink={live ? `${window.location.origin}/${entry.id}` : undefined}
                    onDownload={live && entry.canDownload ? () => download(entry.id, entry.title || entry.id) : undefined}
                    downloading={downloading}
                    onDelete={readOnly ? undefined : () => setConfirmDelete({ type: kind, ids: [entry.id], title })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : !error && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4">
          <span className="workspace-transfer-tile">
            {isShare ? <Send className="size-5" aria-hidden="true" /> : <Inbox className="size-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-text-primary">
              {entries.length === 0 && !query ? `No ${tab} yet` : `No matching ${tab}`}
            </h3>
            {(entries.length > 0 || query) && (
              <p className="text-sm text-text-secondary">Try another filter or search.</p>
            )}
          </div>
          {!readOnly && entries.length === 0 && !query && (
            <button
              onClick={() => navigate(composerPath, { state: dashboardState })}
              className="workspace-row-action"
            >
              {isShare ? "Create Share" : "Create Request"}
            </button>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmTransferDeletion
          title={`Permanently delete ${confirmDelete.type}${confirmDelete.ids.length > 1 ? "s" : ""}?`}
          description={`${confirmDelete.title ? `“${confirmDelete.title}”` : confirmDelete.ids.length === 1
            ? `The selected ${confirmDelete.type}` : `${confirmDelete.ids.length} selected ${confirmDelete.type}s`} and all associated files and history will be permanently deleted.`}
          progress={deleteProgress}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={permanentlyDelete}
        />
      )}
    </div>
  );
}

function fileCountLabel(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function transferCountLabel(count: number, limit: number | undefined, noun: "download" | "upload") {
  return `${count}${limit != null ? ` / ${limit}` : ""} ${noun}${(limit ?? count) === 1 ? "" : "s"}`;
}

function normalizeTitle(title: string) {
  return title.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
