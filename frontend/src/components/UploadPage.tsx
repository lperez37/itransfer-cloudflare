import { useState, useMemo, useEffect, useRef } from "react";
import { useWorkspace } from "../context/workspace";
import { useUpload, type FileProgress } from "../hooks/useUpload";
import FileDropzone from "./FileDropzone";
import ProgressBar from "./ProgressBar";
import PasswordInput from "./PasswordInput";
import {
  X,
  File as FileIcon,
  Loader2,
  Check,
  Copy,
  Link,
  Settings2,
  Shuffle,
  Cat,
} from "lucide-react";

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

export default function UploadPage() {
  const { client: { shares } } = useWorkspace();
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [title, setTitle] = useState("");
  const [expiryDays, setExpiryDays] = useState(365);
  const [maxDownloads, setMaxDownloads] = useState("");
  const [password, setPassword] = useState("");
  const [idFormat, setIdFormat] = useState<"random" | "animals">("animals");
  const [idLength, setIdLength] = useState(10);

  const [step, setStep] = useState<"select" | "uploading" | "done">("select");
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

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const { uploadFiles, progress, isUploading } = useUpload();

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
    if (files.length === 0) return;
    setError(null);
    setStep("uploading");

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

      await uploadFiles(shareId, configs, shares.completeMultipart);
      await shares.confirm(shareId);

      setShareLink(`${window.location.origin}/${shareId}`);
      setResume(null);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStep("select");
    }
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
    setError(null);
    setResume(null);
    setFileIdByLocalId(new Map());
  };

  /* ---------- Done State ---------- */
  if (step === "done") {
    return (
      <div className="max-w-lg mx-auto animate-slide-up">
        <div className="surface rounded-lg p-8 text-center">
          <div className="w-14 h-14 rounded-lg bg-success/15 flex items-center justify-center mx-auto mb-4">
            <Check className="w-7 h-7 text-success" />
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">
            Share created!
          </h2>
          <p className="text-text-muted text-sm mb-6">
            Anyone with this link can download your files.
          </p>

          <div className="flex items-center gap-2 bg-surface-light rounded-md p-3 mb-6">
            <Link className="w-4 h-4 text-primary-light flex-shrink-0" />
            <span className="text-sm text-text-primary truncate flex-1 text-left font-mono">
              {shareLink}
            </span>
            <button
              onClick={handleCopy}
              className="btn-primary !px-3 !py-1.5 text-xs flex items-center gap-1.5 flex-shrink-0"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <button onClick={handleNew} className="btn-secondary text-sm">
            Create another share
          </button>
        </div>
      </div>
    );
  }

  /* ---------- Uploading State ---------- */
  if (step === "uploading") {
    return (
      <div className="max-w-lg mx-auto animate-fade-in">
        <div className="surface rounded-lg p-8">
          <h2 className="text-xl font-bold text-text-primary mb-1">
            Uploading files...
          </h2>
          <p className="text-text-muted text-sm mb-6">
            Please keep this page open until the upload is complete.
          </p>

          <div className="space-y-4">
            {files.map((f) => {
              const fileId = fileIdByLocalId.get(f.id);
              const p: FileProgress =
                (fileId ? progress.get(fileId) : undefined) || {
                  loaded: 0,
                  total: f.file.size,
                  status: "pending",
                };
              const pct = p.total > 0 ? (p.loaded / p.total) * 100 : 0;

              return (
                <div key={f.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-text-primary truncate max-w-[70%]">
                      {f.file.name}
                    </span>
                    <span className="text-xs text-text-muted">
                      {p.status === "done"
                        ? "Complete"
                        : p.status === "uploading"
                          ? `${Math.round(pct)}%`
                          : p.status === "error"
                            ? "Error"
                            : "Waiting..."}
                    </span>
                  </div>
                  <ProgressBar
                    value={pct}
                    color={
                      p.status === "done"
                        ? "success"
                        : p.status === "error"
                          ? "danger"
                          : "accent"
                    }
                  />
                </div>
              );
            })}
          </div>

          {isUploading && (
            <div className="flex items-center justify-center gap-2 mt-6 text-sm text-primary-light">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading to secure storage...
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- Select State ---------- */
  return (
    <div className="max-w-3xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">
          Upload Files
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Share files securely with a link
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-danger animate-fade-in">
          {error}
        </div>
      )}

      {/* Dropzone */}
      <FileDropzone onFiles={handleAddFiles} />

      {/* File List */}
      {files.length > 0 && (
        <div className="mt-6 surface rounded-lg divide-y divide-border overflow-hidden">
          {files.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-3 px-4 py-3 group"
            >
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                <FileIcon className="w-4 h-4 text-primary-light" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text-primary truncate">
                  {f.file.name}
                </p>
                <p className="text-xs text-text-muted">
                  {formatBytes(f.file.size)}
                </p>
              </div>
              <button
                onClick={() => handleRemove(f.id)}
                className="p-1.5 rounded-md hover:bg-danger/10 text-text-muted hover:text-danger transition-all sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
          <div className="px-4 py-3 bg-surface-light/50">
            <span className="text-sm text-text-secondary">
              {files.length} file{files.length !== 1 ? "s" : ""} &middot;{" "}
              {formatBytes(totalSize)}
            </span>
          </div>
        </div>
      )}

      {/* Settings */}
      {files.length > 0 && (
        <div className="mt-6 surface rounded-lg p-5 sm:p-6 animate-fade-in">
          <div className="flex items-center gap-2 mb-5">
            <Settings2 className="w-4 h-4 text-primary-light" />
            <h3 className="font-semibold text-text-primary">Settings</h3>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            {/* Title */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Title{" "}
                <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="input-field"
                placeholder="My awesome files"
              />
            </div>

            {/* Expiry */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Expires after
              </label>
              <select
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
                className="input-field"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Max Downloads */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Max downloads{" "}
                <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <input
                type="number"
                min="1"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                className="input-field"
                placeholder="Unlimited"
              />
            </div>

            {/* Password */}
            <div className="sm:col-span-2">
              <label htmlFor="share-password" className="block text-sm font-medium text-text-secondary mb-1.5">
                Password{" "}
                <span className="text-text-muted font-normal">(optional)</span>
              </label>
                <PasswordInput
                  id="share-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field"
                  placeholder="Protect your share with a password"
                />
            </div>

            {/* Link Format */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-text-secondary mb-2">
                Link format
              </label>
              <div className="flex gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setIdFormat("random")}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all flex-1 ${
                    idFormat === "random"
                      ? "bg-primary/10 text-primary-light border border-primary/30"
                      : "bg-surface-light text-text-secondary border border-border hover:border-border-light"
                  }`}
                >
                  <Shuffle className="w-4 h-4" />
                  Random characters
                </button>
                <button
                  type="button"
                  onClick={() => setIdFormat("animals")}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all flex-1 ${
                    idFormat === "animals"
                      ? "bg-primary/10 text-primary-light border border-primary/30"
                      : "bg-surface-light text-text-secondary border border-border hover:border-border-light"
                  }`}
                >
                  <Cat className="w-4 h-4" />
                  Animal combo
                </button>
              </div>

              {idFormat === "random" && (
                <div className="animate-fade-in">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-text-muted">
                      {idLength} characters
                    </span>
                  </div>
                  <input
                    type="range"
                    min="9"
                    max="64"
                    value={idLength}
                    onChange={(e) => setIdLength(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                </div>
              )}

              {idFormat === "animals" && (
                <p className="text-xs text-text-muted animate-fade-in">
                  Example: /monkey-eel-cat
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Button */}
      {files.length > 0 && (
        <div className="mt-6 flex justify-end animate-fade-in">
          <button
            onClick={handleCreate}
            disabled={isUploading || files.length === 0}
            className="btn-primary flex items-center gap-2 text-base px-8 py-3"
          >
            {resume ? "Retry upload" : "Create Share"}
          </button>
        </div>
      )}
    </div>
  );
}
