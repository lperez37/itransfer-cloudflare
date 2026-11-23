import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { publicApi, parseUtcDate, type PublicShare, ApiError } from "../lib/api";
import { downloadFiles } from "../lib/download";
import { useTranslation } from "../i18n";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
import {
  Download,
  File as FileIcon,
  Lock,
  Loader2,
  AlertTriangle,
  Clock,
  ShieldAlert,
  Check,
  Unlock,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

interface UnlockedFile {
  id: string;
  original_filename: string;
  file_size: number;
  content_type: string;
  created_at: string;
}

export default function SharePage({
  shareId: shareIdProp,
  initialShare,
}: { shareId?: string; initialShare?: PublicShare | null } = {}) {
  const params = useParams<{ id: string }>();
  const shareId = shareIdProp || params.id;
  const { t, locale } = useTranslation();
  const [share, setShare] = useState<PublicShare | null>(initialShare ?? null);
  const [loading, setLoading] = useState(!initialShare);
  // Store the error *kind*, not a translated string, so the message follows the
  // active locale and the effect doesn't need `t` as a dependency.
  const [errorKind, setErrorKind] = useState<"notFound" | "load" | null>(null);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [unlockedFiles, setUnlockedFiles] = useState<UnlockedFile[]>([]);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);

  useEffect(() => {
    if (!shareId) return;
    // Payload already resolved by the caller (PublicResolver) - no refetch.
    if (initialShare) {
      setShare(initialShare);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorKind(null);
    publicApi
      .getShare(shareId)
      .then((s) => {
        if (!cancelled) setShare(s);
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
  }, [shareId, initialShare]);

  const isExpired =
    share && parseUtcDate(share.expires_at).getTime() < Date.now();
  const isExhausted =
    share?.downloads_remaining !== undefined &&
    share.downloads_remaining !== null &&
    share.downloads_remaining <= 0;

  const handleUnlock = async () => {
    if (!shareId || !share || !password) return;
    setUnlockError(null);
    setUnlocking(true);

    try {
      const res = await publicApi.unlockShare(shareId, password);
      setUnlockedFiles(res.files);
      setUnlocked(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setUnlockError(t("share.tooManyAttempts"));
        } else if (err.status === 401 || err.status === 403) {
          setUnlockError(t("share.wrongPassword"));
        } else {
          setUnlockError(err.message);
        }
      } else {
        setUnlockError(t("share.unlockFailed"));
      }
    } finally {
      setUnlocking(false);
    }
  };

  const handleDownload = async () => {
    if (!shareId || !share) return;
    setDownloadError(null);
    setDownloading(true);

    try {
      const res = await publicApi.download(
        shareId,
        share.password_required ? password : undefined
      );

      await downloadFiles(res.files, share.title || shareId);
      setDownloadStarted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setDownloadError(t("share.tooManyAttempts"));
        } else if (err.status === 401 || err.status === 403) {
          setDownloadError(t("share.wrongPassword"));
        } else {
          setDownloadError(err.message);
        }
      } else {
        setDownloadError(t("share.downloadFailed"));
      }
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="grid min-h-32 place-items-center" aria-busy="true">
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      </div>
    );
  }

  if (errorKind) {
    const message =
      errorKind === "notFound"
        ? t("share.notFoundDescription")
        : t("share.loadError");
    return (
      <section className="transfer-page-panel text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-danger/10 text-danger">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold">{t("share.notFound")}</h1>
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
      </section>
    );
  }

  if (!share) return null;

  // Determine which files to display
  const displayFiles = share.password_required ? unlockedFiles : share.files;
  const needsPassword = share.password_required && !unlocked;
  const canDownload = !isExpired && !isExhausted && (!share.password_required || unlocked);
  const fileCount = displayFiles.length > 0 ? displayFiles.length : share.file_count;
  const totalBytes = displayFiles.reduce((sum, file) => sum + (file.file_size || 0), 0);
  let expiryDetail: string | undefined;
  if (share.expires_at && !isExpired) {
    const expiry = parseUtcDate(share.expires_at);
    const msLeft = expiry.getTime() - Date.now();
    const minsLeft = Math.ceil(msLeft / 60000);
    const hoursLeft = Math.ceil(msLeft / 3600000);
    const daysLeft = Math.ceil(msLeft / 86400000);
    const date = expiry.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
    const timeLeft = minsLeft < 60
      ? t("share.minutesLeft", { count: minsLeft })
      : hoursLeft < 24
        ? t("share.hoursLeft", { count: hoursLeft })
        : t("share.daysLeft", { count: daysLeft });
    expiryDetail = `${t("share.expires", { date })} ${timeLeft}`;
  }

  return (
    <>
      <TransferCover title={share.title || t("share.defaultTitle")} headingLevel={1} />
      <div className="transfer-page-panel grid gap-5">
        {isExpired && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("share.expired")}
          </div>
        )}
        {!isExpired && isExhausted && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("share.downloadLimit")}
          </div>
        )}

        <ul className="transfer-page-metadata" role="list">
          <li>
            <span>
              {t("share.fileCount", { count: fileCount })}
              {displayFiles.length > 0 && <> &middot; {formatBytes(totalBytes)}</>}
            </span>
          </li>
          {share.downloads_remaining != null && (
            <li>{t("share.downloadsLeft", { count: share.downloads_remaining })}</li>
          )}
          {expiryDetail && (
            <li>
              <Clock className="size-3.5 shrink-0" aria-hidden="true" />
              <span>{expiryDetail}</span>
            </li>
          )}
        </ul>

        {needsPassword && (
          <>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-light px-4 py-3 text-sm text-text-secondary">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Lock className="size-4.5" aria-hidden="true" />
              </div>
              <p>{t("share.lockedFiles", { count: share.file_count })}</p>
            </div>

            {!isExpired && !isExhausted && (
              <form className="grid gap-4" onSubmit={(e) => {
                e.preventDefault();
                if (!unlocking) void handleUnlock();
              }}>
                {unlockError && (
                  <div role="alert" className="rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {unlockError}
                  </div>
                )}

                <div>
                  <label htmlFor="public-share-password" className="mb-1.5 block text-sm font-semibold">
                    {t("share.password")}
                  </label>
                  <PasswordInput
                    id="public-share-password"
                    showLabel={t("common.showPassword")}
                    hideLabel={t("common.hidePassword")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("share.passwordPlaceholder")}
                    disabled={unlocking}
                  />
                </div>

                <button type="submit" disabled={unlocking || !password} className="btn-primary transfer-page-action">
                  {unlocking ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  ) : (
                    <Unlock className="size-5 shrink-0" aria-hidden="true" />
                  )}
                  {t(unlocking ? "share.verifying" : "share.unlock")}
                </button>
              </form>
            )}
          </>
        )}

        {!needsPassword && displayFiles.length > 0 && (
          <ul className="max-h-[35dvh] divide-y divide-border overflow-y-auto rounded-xl border border-border bg-surface-light" role="list">
            {displayFiles.map((file) => (
              <li key={file.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <FileIcon className="size-4.5" aria-hidden="true" />
                </div>
                <p className="min-w-0 flex-1 text-sm font-medium">{file.original_filename}</p>
                <p className="shrink-0 text-xs tabular-nums text-text-muted">
                  {formatBytes(file.file_size || 0)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {downloadError && (
          <div role="alert" className="rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            {downloadError}
          </div>
        )}

        {downloadStarted && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("share.downloadStarted")}
          </div>
        )}

        {canDownload && (
          <button type="button" onClick={handleDownload} disabled={downloading} className="btn-primary transfer-page-action">
            {downloading ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-5 shrink-0" aria-hidden="true" />
            )}
            {t(downloading ? "share.preparing" : "share.downloadAll")}
          </button>
        )}
      </div>
    </>
  );
}
