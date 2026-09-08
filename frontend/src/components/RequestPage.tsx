import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  publicApi,
  parseUtcDate,
  type PublicRequest,
  type FileInit,
  ApiError,
} from "../lib/api";
import { useUpload } from "../hooks/useUpload";
import { useTranslation } from "../i18n";
import FileDropzone from "./FileDropzone";
import LanguageSwitcher from "./LanguageSwitcher";
import ProgressBar from "./ProgressBar";
import PasswordInput from "./PasswordInput";
import {
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Check,
  X,
  File as FileIcon,
  Upload,
  Lock,
  Clock,
} from "lucide-react";
import logoSvg from "../assets/logo.svg";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function RequestPage({
  requestId: requestIdProp,
  initialRequest,
}: { requestId?: string; initialRequest?: PublicRequest | null } = {}) {
  const params = useParams<{ id: string }>();
  const requestId = requestIdProp || params.id;
  const { t, locale } = useTranslation();
  const [req, setReq] = useState<PublicRequest | null>(initialRequest ?? null);
  const [loading, setLoading] = useState(!initialRequest);
  // Store the error *kind*, not a translated string, so the message follows the
  // active locale and the effect doesn't need `t` as a dependency.
  const [errorKind, setErrorKind] = useState<"notFound" | "load" | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"select" | "uploading" | "done">("select");
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Maps each selected local File to its server-assigned file_id (the key of
  // the useUpload progress Map) so progress is looked up directly, not by
  // positional index into the Map's keys.
  const [fileIdByFile, setFileIdByFile] = useState<Map<File, string>>(new Map());

  const { uploadFiles, progress, isUploading } = useUpload();

  useEffect(() => {
    if (!requestId) return;
    // Payload already resolved by the caller (PublicResolver) - no refetch.
    if (initialRequest) {
      setReq(initialRequest);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorKind(null);
    publicApi
      .getRequest(requestId)
      .then((r) => {
        if (!cancelled) setReq(r);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setErrorKind("notFound");
        } else {
          setErrorKind("load");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, initialRequest]);

  const isExhausted =
    req?.remaining_uploads !== undefined &&
    req.remaining_uploads !== null &&
    req.remaining_uploads <= 0;

  // Size filtering happens in FileDropzone (the single filtering layer); here we
  // just append the already-accepted files.
  const handleAddFiles = (newFiles: File[]) => {
    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleRejectedFiles = (rejected: File[]) => {
    setUploadError(
      t("request.filesTooLarge", {
        count: rejected.length,
        size: formatBytes(req?.max_file_size ?? 0),
      })
    );
  };

  const handleRemove = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpload = async () => {
    if (!requestId || files.length === 0) return;
    setUploadError(null);
    setStep("uploading");

    try {
      const fileInits: FileInit[] = files.map((f) => ({
        filename: f.name,
        content_type: f.type || "application/octet-stream",
        size: f.size,
      }));

      const res = await publicApi.uploadToRequest(requestId, fileInits, message || undefined, password || undefined);

      const configs = res.files.map((serverFile, idx) => ({
        file_id: serverFile.file_id,
        file: files[idx],
        upload_url: serverFile.upload_url,
        multipart: serverFile.multipart,
      }));

      // Build the local File -> server file_id map so progress renders by id.
      setFileIdByFile(new Map(configs.map((c) => [c.file, c.file_id])));

      await uploadFiles(
        requestId,
        configs,
        publicApi.completeMultipart
      );

      await publicApi.confirmUpload(
        requestId,
        res.files.map((f) => f.file_id),
        message || undefined
      );

      setStep("done");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setUploadError(t("request.tooManyAttempts"));
        } else if (err.status === 401) {
          setUploadError(t("request.wrongPassword"));
        } else {
          setUploadError(err.message);
        }
      } else {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      }
      setStep("select");
    }
  };

  if (loading) {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (errorKind) {
    const message =
      errorKind === "notFound"
        ? t("request.notFoundDescription")
        : t("request.loadError");
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center p-4">
        <div className="surface rounded-lg p-8 max-w-md text-center animate-slide-up">
          <div className="w-14 h-14 rounded-lg bg-danger/15 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-7 h-7 text-danger" />
          </div>
          <h2 className="text-xl font-bold text-text-primary mb-2">
            {t("request.notFound")}
          </h2>
          <p className="text-text-muted text-sm">{message}</p>
        </div>
      </div>
    );
  }

  if (!req) return null;

  return (
    <div className="min-h-dvh page-bg flex items-center justify-center p-4">
      <div className="w-full max-w-lg animate-slide-up">
        {/* Branding */}
        <div className="flex items-center justify-center gap-2 mb-4">
          <img src={logoSvg} alt="iTransfer" className="w-6 h-6" />
          <span className="text-lg font-bold text-primary font-[family-name:var(--font-display)]">
            iTransfer
          </span>
        </div>

        <div className="surface rounded-lg p-6 sm:p-8">
          {/* Exhausted */}
          {isExhausted && (
            <div className="flex items-center gap-2 bg-warning/10 border border-warning/20 rounded-md px-4 py-3 text-sm text-amber-400 mb-5">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              {t("request.uploadLimit")}
            </div>
          )}

          {/* Done */}
          {step === "done" && (
            <div className="text-center animate-fade-in">
              <div className="w-14 h-14 rounded-lg bg-success/15 flex items-center justify-center mx-auto mb-4">
                <Check className="w-7 h-7 text-success" />
              </div>
              <h2 className="text-xl font-bold text-text-primary mb-2">
                {t("request.filesUploaded")}
              </h2>
              <p className="text-text-muted text-sm">
                {t("request.filesDelivered")}
              </p>
              {req.allow_incremental && (
                <button
                  onClick={() => {
                    setStep("select"); setFiles([]); setMessage(""); setFileIdByFile(new Map());
                    if (requestId) {
                      publicApi.getRequest(requestId).then(setReq).catch(() => {});
                    }
                  }}
                  className="btn-secondary text-sm mt-4"
                >
                  {t("request.uploadMore")}
                </button>
              )}
            </div>
          )}

          {/* Uploading */}
          {step === "uploading" && (
            <div className="animate-fade-in">
              <h2 className="text-xl font-bold text-text-primary mb-1">
                {t("request.uploading")}
              </h2>
              <p className="text-text-muted text-sm mb-6">
                {t("request.keepOpen")}
              </p>
              <div className="space-y-4">
                {files.map((f, idx) => {
                  const fileId = fileIdByFile.get(f);
                  const p = (fileId ? progress.get(fileId) : undefined) || {
                    loaded: 0,
                    total: f.size,
                    status: "pending" as const,
                  };
                  const pct = p.total > 0 ? (p.loaded / p.total) * 100 : 0;
                  return (
                    <div key={idx}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm text-text-primary truncate max-w-[70%]">
                          {f.name}
                        </span>
                        <span className="text-xs text-text-muted">
                          {p.status === "done"
                            ? t("request.complete")
                            : p.status === "uploading"
                              ? `${Math.round(pct)}%`
                              : p.status === "error"
                                ? t("request.uploadFailed")
                                : t("request.waiting")}
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
                  {t("request.uploading")}
                </div>
              )}
            </div>
          )}

          {/* Select */}
          {step === "select" && !isExhausted && (
            <>
              <h2 className="text-xl font-bold text-text-primary mb-1">
                {req.title}
              </h2>
              {req.message && (
                <p className="text-text-secondary text-sm mb-4 whitespace-pre-wrap">
                  {req.message}
                </p>
              )}
              <p className="text-xs text-text-muted mb-4">
                {req.expires_at && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {t("request.expires", { date: parseUtcDate(req.expires_at).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) })}
                  </span>
                )}
                {req.remaining_uploads != null && (
                  <>
                    {req.expires_at && <> &middot; </>}
                    {t("request.uploadsRemaining", { count: req.remaining_uploads })}
                  </>
                )}
                {req.max_file_size && (
                  <> &middot; {t("request.maxFileSize", { size: formatBytes(req.max_file_size) })}</>
                )}
              </p>

              {uploadError && (
                <div className="mb-4 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-red-400 animate-fade-in">
                  {uploadError}
                </div>
              )}

              {req.password_required && (
                <div className="mb-4">
                  <label htmlFor="public-request-password" className="block text-sm font-medium text-text-secondary mb-1.5">
                    <Lock className="w-3.5 h-3.5 inline mr-1" />
                    {t("request.passwordRequired")}
                  </label>
                  <PasswordInput
                    id="public-request-password"
                    showLabel={t("common.showPassword")}
                    hideLabel={t("common.hidePassword")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-field"
                    placeholder={t("request.passwordPlaceholder")}
                  />
                </div>
              )}

              <div className="mb-4">
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  {t("request.message")} <span className="text-text-muted font-normal">{t("request.messageOptional")}</span>
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={2}
                  className="input-field resize-none"
                  placeholder={t("request.messagePlaceholder")}
                />
              </div>

              {req.allow_incremental && req.files && req.files.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs text-text-muted mb-2">{t("request.previousFiles")}</p>
                  <div className="bg-surface-light rounded-md divide-y divide-border max-h-32 overflow-y-auto">
                    {req.files.map((f) => (
                      <div key={f.id} className="flex items-center gap-3 px-4 py-2">
                        <FileIcon className="w-4 h-4 text-text-muted flex-shrink-0" />
                        <span className="text-sm text-text-secondary truncate">{f.original_filename}</span>
                        <span className="text-xs text-text-muted ml-auto">{formatBytes(f.file_size)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <FileDropzone
                onFiles={handleAddFiles}
                onRejected={handleRejectedFiles}
                maxFileSize={req.max_file_size}
                dropLabel={t("dropzone.drop")}
                dragLabel={t("dropzone.drag")}
                browseLabel={t("dropzone.browse")}
              />

              {files.length > 0 && (
                <div className="mt-4 bg-surface-light rounded-md divide-y divide-border max-h-48 overflow-y-auto">
                  {files.map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 px-4 py-2.5 group"
                    >
                      <FileIcon className="w-4 h-4 text-primary-light flex-shrink-0" />
                      <span className="text-sm text-text-primary truncate flex-1">
                        {f.name}
                      </span>
                      <span className="text-xs text-text-muted">
                        {formatBytes(f.size)}
                      </span>
                      <button
                        onClick={() => handleRemove(i)}
                        className="p-1 rounded hover:bg-danger/10 text-text-muted hover:text-danger transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {files.length > 0 && (
                <button
                  onClick={handleUpload}
                  disabled={isUploading || (req.password_required && !password)}
                  className="btn-primary w-full flex items-center justify-center gap-2 py-3 mt-5 text-base"
                >
                  <Upload className="w-5 h-5" />
                  {t("request.uploadButton", { count: files.length })}
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-center mt-4">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}
