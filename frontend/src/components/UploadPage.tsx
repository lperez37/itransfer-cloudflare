import { useState, useMemo, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useWorkspace } from "../context/workspace";
import { useUpload, type FileProgress } from "../hooks/useUpload";
import FileDropzone from "./FileDropzone";
import ProgressBar from "./ProgressBar";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
import {
  ArrowLeft,
  Plus,
  Send,
  X,
  File as FileIcon,
  Loader2,
  Check,
  Copy,
  Link2,
  Shuffle,
  Cat,
} from "lucide-react";
import "./workspace-transfers.css";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

type ExpiryOption = { label: string; days: number };
const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "5 minutes", days: 5 / 1440 },
  { label: "15 minutes", days: 15 / 1440 },
  { label: "30 minutes", days: 30 / 1440 },
  { label: "1 hour", days: 1 / 24 },
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "365 days", days: 365 },
];

interface LocalFile {
  id: string;
  file: File;
}

interface UploadConfig {
  file_id: string;
  file: File;
  upload_url?: string;
  multipart?: {
    upload_id: string;
    parts: Array<{ part_number: number; upload_url: string }>;
  };
}

/** A share that was initialized on the server but whose upload/confirm stage
 * did not finish - kept so a retry resumes instead of creating a new share. */
interface ResumeState {
  shareId: string;
  configs: UploadConfig[];
}

type UploadStep = "select" | "preparing" | "uploading" | "confirming" | "cancelling" | "done";

export default function UploadPage() {
  const { client: { shares } } = useWorkspace();
  const { state } = useLocation();
  const dashboard = { pathname: "/dashboard", search: typeof state?.dashboardSearch === "string" ? state.dashboardSearch : "" };
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [title, setTitle] = useState("");
  const [expiryDays, setExpiryDays] = useState(365);
  const [maxDownloads, setMaxDownloads] = useState("");
  const [password, setPassword] = useState("");
  const [idFormat, setIdFormat] = useState<"random" | "animals">("animals");
  const [idLength, setIdLength] = useState(10);

  const [step, setStep] = useState<UploadStep>("select");
  const [shareLink, setShareLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Maps each local file id to its server-assigned file_id (the key of the
  // useUpload progress Map) so progress is looked up directly, not positionally.
  const [fileIdByLocalId, setFileIdByLocalId] = useState<Map<string, string>>(
    new Map()
  );
  const [resume, setResume] = useState<ResumeState | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellableUpload = useRef<{ cancelled: boolean } | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const { uploadFiles, progress, cancel } = useUpload();

  const totalSize = useMemo(
    () => files.reduce((sum, f) => sum + f.file.size, 0),
    [files]
  );

  // Changing the file set invalidates any half-finished share so a retry
  // re-initializes with the new files rather than resuming a stale one.
  const handleAddFiles = (newFiles: File[]) => {
    const additions = newFiles.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
    }));
    setFiles((prev) => [...prev, ...additions]);
    setResume(null);
  };

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setResume(null);
  };

  const handleCreate = async () => {
    if (files.length === 0 || step !== "select") return;
    const attempt = { cancelled: false };
    setError(null);
    setStep(resume ? "uploading" : "preparing");

    try {
      // Resume a previously initialized-but-unfinished share instead of
      // creating a duplicate; otherwise initialize a fresh one.
      let shareId = resume?.shareId;
      let configs = resume?.configs;

      if (!shareId || !configs) {
        const parsedMax = parseInt(maxDownloads, 10);
        const maxDownloadsValue =
          Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined;

        const initRes = await shares.init({
          files: files.map((f) => ({
            filename: f.file.name,
            content_type: f.file.type || "application/octet-stream",
            size: f.file.size,
          })),
          expiry_days: expiryDays,
          max_downloads: maxDownloadsValue,
          password: password || undefined,
          title: title || undefined,
          id_format: idFormat,
          id_length: idFormat === "random" ? idLength : undefined,
        });

        shareId = initRes.share_id;
        // Build file configs for upload
        configs = initRes.files.map((serverFile, idx) => ({
          file_id: serverFile.file_id,
          file: files[idx].file,
          upload_url: serverFile.upload_url,
          multipart: serverFile.multipart,
        }));
        setFileIdByLocalId(
          new Map(files.map((lf, idx) => [lf.id, initRes.files[idx].file_id]))
        );
        setResume({ shareId, configs });
      }

      cancellableUpload.current = attempt;
      setStep("uploading");
      await uploadFiles(shareId, configs, shares.completeMultipart);
      cancellableUpload.current = null;
      if (attempt.cancelled) throw new DOMException("Upload cancelled", "AbortError");

      setStep("confirming");
      await shares.confirm(shareId);

      setShareLink(`${window.location.origin}/${shareId}`);
      setResume(null);
      setStep("done");
    } catch (err) {
      cancellableUpload.current = null;
      setError(attempt.cancelled ? "Upload cancelled. Your files are ready to retry."
        : err instanceof Error ? err.message : "Upload failed");
      setStep("select");
    }
  };

  const handleCancel = () => {
    if (!cancellableUpload.current) return;
    cancellableUpload.current.cancelled = true;
    setStep("cancelling");
    cancel();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleNew = () => {
    setFiles([]);
    setTitle("");
    setExpiryDays(365);
    setMaxDownloads("");
    setPassword("");
    setIdFormat("animals");
    setIdLength(10);
    setStep("select");
    setShareLink("");
    setCopied(false);
    setError(null);
    setResume(null);
    setFileIdByLocalId(new Map());
  };

  if (step === "done") {
    return (
      <div className="workspace-transfer-flow mx-auto grid max-w-3xl gap-4">
        <TransferCover title="Share created!">
          <p className="text-sm text-white">Anyone with this link can download your files.</p>
        </TransferCover>

        <section aria-label="Share link" className="surface grid gap-4 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-xl bg-surface-light p-3">
            <Link2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <a href={shareLink} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 font-mono text-sm text-text-primary underline decoration-border hover:decoration-current [overflow-wrap:anywhere]">
              {shareLink}
            </a>
            <button onClick={handleCopy} className="btn-primary workspace-primary-action shrink-0 px-3 text-sm">
              {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleNew} className="btn-secondary min-h-11 rounded-full text-sm">
              Create another share
            </button>
            <Link to={dashboard} className="workspace-row-action">Back to dashboard</Link>
          </div>
        </section>
      </div>
    );
  }

  if (step !== "select") {
    const uploadMessage = {
      preparing: "Preparing your upload…",
      uploading: "Uploading to secure storage…",
      confirming: "Finalizing your share…",
      cancelling: "Cancelling upload…",
    }[step];

    return (
      <div className="workspace-transfer-flow mx-auto grid max-w-3xl gap-4">
        <TransferCover title="Uploading files...">
          <p className="text-sm text-white">Keep this page open until the upload is complete.</p>
        </TransferCover>
        <section aria-label="Upload progress" className="surface rounded-2xl p-4 sm:p-5">
          <p role="status" className="mb-4 flex items-center gap-2 text-sm font-semibold text-primary">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
            {uploadMessage}
          </p>
          <ul className="space-y-4" role="list">
            {files.map((f) => {
              const fileId = fileIdByLocalId.get(f.id);
              const current: FileProgress = (fileId ? progress.get(fileId) : undefined) || {
                loaded: 0,
                total: f.file.size,
                status: "pending",
              };
              const percent = current.status === "done" ? 100
                : Math.round(current.total > 0 ? (current.loaded / current.total) * 100 : 0);
              const status = {
                pending: "Waiting...",
                uploading: `${percent}%`,
                done: "Complete",
                error: "Error",
              }[current.status];

              return (
                <li key={f.id}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-sm text-text-primary [overflow-wrap:anywhere]">{f.file.name}</span>
                    <span className="shrink-0 text-xs text-text-secondary">{status}</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={f.file.name}
                    aria-valuenow={percent}
                    aria-valuetext={status}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <ProgressBar
                      value={percent}
                      color={current.status === "done" ? "success" : current.status === "error" ? "danger" : "primary"}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
        {step === "uploading" && (
          <div className="workspace-form-footer">
            <button onClick={handleCancel} className="btn-secondary inline-flex min-h-11 items-center justify-center gap-2 rounded-full text-sm">
              <X className="size-4 shrink-0" aria-hidden="true" />
              Cancel upload
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="workspace-transfer-flow mx-auto grid max-w-5xl gap-4 sm:gap-5">
      <Link to={dashboard} className="workspace-row-action justify-self-start" aria-label="Back to dashboard">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Dashboard
      </Link>
      <TransferCover title="Upload Files">
        <p className="text-sm text-white">Share files securely with a link.</p>
      </TransferCover>

      {error && (
        <div role="alert" className="workspace-transfer-notice border-danger/25 bg-danger/10 text-danger">
          {error}
        </div>
      )}

      <div className={files.length > 0 ? "grid items-start gap-4 md:grid-cols-2" : ""}>
        <div className="grid min-w-0 gap-3">
          <div className="workspace-file-picker">
            <FileDropzone onFiles={handleAddFiles}>
              <button type="button" aria-label="Add files" className="flex w-full items-center gap-3 rounded-[inherit] bg-primary/8 p-4 text-left hover:bg-primary/12 focus-visible:-outline-offset-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-background">
                  <Plus className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-text-primary">Add files</span>
                  <span className="block text-sm text-text-secondary">
                    {files.length > 0
                      ? `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(totalSize)}`
                      : "Choose or drag files from your device."}
                  </span>
                </span>
              </button>
            </FileDropzone>
          </div>
          {files.length > 0 && (
            <ul role="list" aria-label="Selected files" className="surface divide-y divide-border rounded-2xl">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="workspace-transfer-tile">
                    <FileIcon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">{f.file.name}</p>
                    <p className="text-xs text-text-secondary">{formatBytes(f.file.size)}</p>
                  </div>
                  <button
                    onClick={() => handleRemove(f.id)}
                    aria-label={`Remove ${f.file.name}`}
                    title="Remove file"
                    className="workspace-row-action workspace-row-delete"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {files.length > 0 && (
          <div className="grid min-w-0 gap-4">
            <section aria-labelledby="share-settings" className="surface grid gap-4 rounded-2xl p-4 sm:p-5">
              <h2 id="share-settings" className="text-lg font-semibold text-text-primary">Share settings</h2>
              <div>
                <label htmlFor="share-title" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Title <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <input
                  id="share-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="input-field"
                  placeholder="My awesome files"
                />
              </div>
              <div>
                <label htmlFor="share-expiry" className="mb-1.5 block text-sm font-medium text-text-primary">Expires after</label>
                <select
                  id="share-expiry"
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(Number(e.target.value))}
                  className="input-field"
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.days} value={option.days}>{option.label}</option>
                  ))}
                </select>
              </div>
              <fieldset className="min-w-0 space-y-2">
                <legend className="mb-1.5 text-sm font-medium text-text-primary">Link format</legend>
                <div className="workspace-transfer-segmented">
                  <button type="button" aria-pressed={idFormat === "random"} onClick={() => setIdFormat("random")} className="text-primary">
                    <Shuffle className="size-4" aria-hidden="true" />
                    Random characters
                  </button>
                  <button type="button" aria-pressed={idFormat === "animals"} onClick={() => setIdFormat("animals")} className="text-primary">
                    <Cat className="size-4" aria-hidden="true" />
                    Animal combo
                  </button>
                </div>
                {idFormat === "random" ? (
                  <div className="grid gap-1">
                    <label htmlFor="share-link-length" className="flex flex-wrap justify-between gap-x-2 text-xs text-text-secondary">
                      <span>Link length</span>
                      <span className="font-semibold text-primary">{idLength} characters</span>
                    </label>
                    <input
                      id="share-link-length"
                      type="range"
                      min="9"
                      max="64"
                      value={idLength}
                      aria-valuetext={`${idLength} characters`}
                      onChange={(e) => setIdLength(Number(e.target.value))}
                      className="h-8 w-full accent-primary"
                    />
                  </div>
                ) : (
                  <p className="text-xs text-text-secondary">Example: <span className="font-mono">/monkey-eel-cat</span></p>
                )}
              </fieldset>
            </section>

            <section aria-labelledby="share-limits" className="surface grid gap-4 rounded-2xl p-4 sm:p-5">
              <h2 id="share-limits" className="text-lg font-semibold text-text-primary">Password and download limit</h2>
              <div>
                <label htmlFor="share-password" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Password <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <PasswordInput
                  id="share-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Protect your share with a password"
                />
              </div>
              <div>
                <label htmlFor="share-download-limit" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Max downloads <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <input
                  id="share-download-limit"
                  type="number"
                  min="1"
                  value={maxDownloads}
                  onChange={(e) => setMaxDownloads(e.target.value)}
                  className="input-field"
                  placeholder="Unlimited"
                />
              </div>
            </section>
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="workspace-form-footer">
          <button onClick={handleCreate} className="btn-primary workspace-primary-action text-sm">
            <Send className="size-4 shrink-0" aria-hidden="true" />
            {resume ? "Retry upload" : "Create Share"}
          </button>
        </div>
      )}
    </div>
  );
}
