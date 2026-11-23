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
import { useTranslation, type Locale } from "../i18n";
import FileDropzone from "./FileDropzone";
import ProgressBar from "./ProgressBar";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
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

const removeFileLabels: Record<Locale, string> = {
  en: "Remove file",
  es: "Quitar archivo",
  fr: "Retirer le fichier",
  pt: "Remover ficheiro",
  nl: "Bestand verwijderen",
  it: "Rimuovi il file",
  ca: "Treu el fitxer",
  pl: "Usuń plik",
  da: "Fjern fil",
  sv: "Ta bort fil",
};

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
        setUploadError(err instanceof Error ? err.message : t("request.uploadFailed"));
      }
      setStep("select");
    }
  };

  if (loading) {
    return (
      <div className="grid min-h-32 place-items-center" aria-busy="true">
        <Loader2 className="size-8 animate-spin text-accent" aria-hidden="true" />
      </div>
    );
  }

  if (errorKind) {
    const message =
      errorKind === "notFound"
        ? t("request.notFoundDescription")
        : t("request.loadError");
    return (
      <section className="transfer-page-panel text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-danger/10 text-danger">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold">{t("request.notFound")}</h1>
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
      </section>
    );
  }

  if (!req) return null;
  const expiry = req.expires_at && parseUtcDate(req.expires_at).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <>
      <TransferCover variant="request" title={req.title} headingLevel={1} />
      <div className="transfer-page-panel grid gap-5">
        {isExhausted && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("request.uploadLimit")}
          </div>
        )}

        {step === "done" && (
          <div className="text-center">
            <div role="status">
              <div className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-success/15 text-success">
                <Check className="size-6" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-bold">{t("request.filesUploaded")}</h2>
              <p className="mt-1 text-sm text-text-secondary">{t("request.filesDelivered")}</p>
            </div>
            {req.allow_incremental && (
              <button
                type="button"
                onClick={() => {
                  setStep("select");
                  setFiles([]);
                  setMessage("");
                  setFileIdByFile(new Map());
                  if (requestId) {
                    publicApi.getRequest(requestId).then(setReq).catch(() => {});
                  }
                }}
                className="btn-secondary transfer-page-action mt-5"
              >
                {t("request.uploadMore")}
              </button>
            )}
          </div>
        )}

        {step === "uploading" && (
          <section className="grid gap-4">
            <div role="status" className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-xl font-bold">{t("request.uploading")}</h2>
                <p className="text-sm text-text-secondary">{t("request.keepOpen")}</p>
              </div>
            </div>

            <ul className="grid gap-2.5" role="list">
              {files.map((file, idx) => {
                const fileId = fileIdByFile.get(file);
                const p = (fileId ? progress.get(fileId) : undefined) || {
                  loaded: 0,
                  total: file.size,
                  status: "pending" as const,
                };
                const pct = p.total > 0 ? (p.loaded / p.total) * 100 : 0;
                const statusText = p.status === "done"
                  ? t("request.complete")
                  : p.status === "uploading"
                    ? `${Math.round(pct)}%`
                    : p.status === "error"
                      ? t("request.uploadFailed")
                      : t("request.waiting");
                return (
                  <li key={idx} className="grid gap-2 rounded-xl border border-border bg-surface-light p-3">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 text-sm font-medium">{file.name}</span>
                      <span className="max-w-[45%] shrink-0 text-right text-xs tabular-nums text-text-secondary">{statusText}</span>
                    </div>
                    <ProgressBar
                      value={pct}
                      label={file.name}
                      valueText={statusText}
                      color={
                        p.status === "done"
                          ? "success"
                          : p.status === "error"
                            ? "danger"
                            : "accent"
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {step === "select" && !isExhausted && (
          <>
            {req.message && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
                {req.message}
              </p>
            )}
            {(expiry || req.remaining_uploads != null || !!req.max_file_size) && (
              <ul className="transfer-page-metadata" role="list">
                {expiry && (
                  <li>
                    <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                    <span>{t("request.expires", { date: expiry })}</span>
                  </li>
                )}
                {req.remaining_uploads != null && (
                  <li>{t("request.uploadsRemaining", { count: req.remaining_uploads })}</li>
                )}
                {!!req.max_file_size && (
                  <li>{t("request.maxFileSize", { size: formatBytes(req.max_file_size) })}</li>
                )}
              </ul>
            )}

            {uploadError && (
              <div role="alert" className="rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                {uploadError}
              </div>
            )}

            {req.password_required && (
              <div>
                <label htmlFor="public-request-password" className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
                  <Lock className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                  {t("request.passwordRequired")}
                </label>
                <PasswordInput
                  id="public-request-password"
                  showLabel={t("common.showPassword")}
                  hideLabel={t("common.hidePassword")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("request.passwordPlaceholder")}
                />
              </div>
            )}

            <div>
              <label htmlFor="public-request-message" className="mb-1.5 block text-sm font-semibold">
                {t("request.message")} <span className="font-normal text-text-muted">{t("request.messageOptional")}</span>
              </label>
              <textarea
                id="public-request-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                className="input-field block resize-y"
                placeholder={t("request.messagePlaceholder")}
              />
            </div>

            <FileDropzone
              onFiles={handleAddFiles}
              onRejected={handleRejectedFiles}
              maxFileSize={req.max_file_size}
              dropLabel={t("dropzone.drop")}
              dragLabel={t("dropzone.drag")}
              browseLabel={t("dropzone.browse")}
            />

            {files.length > 0 && (
              <>
                <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-surface-light" role="list">
                  {files.map((file, i) => (
                    <li key={i} className="flex items-center gap-2 px-3 py-1.5 sm:gap-3">
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                        <FileIcon className="size-4.5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p id={`request-file-${i}`} className="text-sm font-medium">{file.name}</p>
                        <p className="text-xs tabular-nums text-text-muted">{formatBytes(file.size)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemove(i)}
                        aria-label={removeFileLabels[locale]}
                        aria-describedby={`request-file-${i}`}
                        className="grid size-11 shrink-0 place-items-center rounded-xl text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={isUploading || (req.password_required && !password)}
                  className="btn-primary transfer-page-action"
                >
                  <Upload className="size-5 shrink-0" aria-hidden="true" />
                  {t("request.uploadButton", { count: files.length })}
                </button>
              </>
            )}

            {req.allow_incremental && req.files && req.files.length > 0 && (
              <section className="grid gap-2">
                <h2 className="text-base font-semibold">{t("request.previousFiles")}</h2>
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-surface-light" role="list">
                  {req.files.map((file) => (
                    <li key={file.id} className="flex items-center gap-3 px-3 py-2.5">
                      <FileIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-sm text-text-secondary">{file.original_filename}</span>
                      <span className="shrink-0 text-xs tabular-nums text-text-muted">{formatBytes(file.file_size)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
