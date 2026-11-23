import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { publicApi, parseUtcDate, type PublicShare, ApiError } from "../lib/api";
import { downloadFiles } from "../lib/download";
import { useTranslation } from "../i18n";
import LanguageSwitcher from "./LanguageSwitcher";
import PasswordInput from "./PasswordInput";
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
import logoSvg from "../assets/logo.svg";

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
      <div className="min-h-dvh page-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (errorKind) {
    const message =
      errorKind === "notFound"
        ? t("share.notFoundDescription")
        : t("share.loadError");
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center p-4">
        <div className="surface rounded-lg p-8 max-w-md text-center animate-slide-up">
          <div className="w-14 h-14 rounded-lg bg-danger/15 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-7 h-7 text-danger" />
          </div>
          <h2 className="text-xl font-bold text-text-primary mb-2">
            {t("share.notFound")}
          </h2>
          <p className="text-text-muted text-sm">{message}</p>
        </div>
      </div>
    );
  }

  if (!share) return null;

  // Determine which files to display
  const displayFiles = share.password_required ? unlockedFiles : share.files;
  const needsPassword = share.password_required && !unlocked;
  const canDownload = !isExpired && !isExhausted && (!share.password_required || unlocked);
  const fileCount = displayFiles.length > 0 ? displayFiles.length : share.file_count;

  return (
    <div className="min-h-dvh page-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-slide-up">
        {/* Branding */}
        <div className="flex items-center justify-center gap-2 mb-4">
          <img src={logoSvg} alt="iTransfer" className="w-6 h-6" />
          <span className="text-lg font-bold text-primary font-[family-name:var(--font-display)]">
            iTransfer
          </span>
        </div>

        <div className="surface rounded-lg p-6 sm:p-8">
          {/* Expired / Exhausted */}
          {isExpired && (
            <div className="flex items-center gap-2 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-danger mb-5">
              <Clock className="w-4 h-4 flex-shrink-0" />
              {t("share.expired")}
            </div>
          )}
          {!isExpired && isExhausted && (
            <div className="flex items-center gap-2 bg-warning/10 border border-warning/20 rounded-md px-4 py-3 text-sm text-warning mb-5">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              {t("share.downloadLimit")}
            </div>
          )}

          {/* Title */}
          <h2 className="text-xl font-bold text-text-primary mb-1">
            {share.title || t("share.defaultTitle")}
          </h2>
          <p className="text-text-muted text-sm mb-5">
            {t("share.fileCount", { count: fileCount })}
            {displayFiles.length > 0 && <> &middot; {formatBytes(displayFiles.reduce((sum, f) => sum + (f.file_size || 0), 0))}</>}
            {share.downloads_remaining != null && (
              <> &middot; {t("share.downloadsLeft", { count: share.downloads_remaining })}</>
            )}
            {share.expires_at && !isExpired && (() => {
              const msLeft = parseUtcDate(share.expires_at).getTime() - Date.now();
              const minsLeft = Math.ceil(msLeft / 60000);
              const hoursLeft = Math.ceil(msLeft / 3600000);
              const daysLeft = Math.ceil(msLeft / 86400000);
              const dateStr = parseUtcDate(share.expires_at).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
              const timeLeft = minsLeft < 60
                ? t("share.minutesLeft", { count: minsLeft })
                : hoursLeft < 24
                  ? t("share.hoursLeft", { count: hoursLeft })
                  : t("share.daysLeft", { count: daysLeft });
              return <> &middot; {t("share.expires", { date: dateStr })} {timeLeft}</>;
            })()}
          </p>

          {/* Locked state: password needed, files hidden */}
          {needsPassword && (
            <>
              <div className="bg-surface-light rounded-md px-4 py-6 text-center mb-5">
                <Lock className="w-6 h-6 text-text-muted mx-auto mb-2" />
                <p className="text-sm text-text-muted">
                  {t("share.lockedFiles", { count: share.file_count })}
                </p>
              </div>

              {!isExpired && !isExhausted && (
                <>
                  {unlockError && (
                    <div className="mb-4 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-danger animate-fade-in">
                      {unlockError}
                    </div>
                  )}

                  <div className="mb-4">
                    <label htmlFor="public-share-password" className="block text-sm font-medium text-text-secondary mb-1.5">
                      <Lock className="w-3.5 h-3.5 inline mr-1" />
                      {t("share.password")}
                    </label>
                    <PasswordInput
                      id="public-share-password"
                      showLabel={t("common.showPassword")}
                      hideLabel={t("common.hidePassword")}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && password) handleUnlock(); }}
                      className="input-field"
                      placeholder={t("share.passwordPlaceholder")}
                    />
                  </div>

                  <button
                    onClick={handleUnlock}
                    disabled={unlocking || !password}
                    className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
                  >
                    {unlocking ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t("share.verifying")}
                      </>
                    ) : (
                      <>
                        <Unlock className="w-5 h-5" />
                        {t("share.unlock")}
                      </>
                    )}
                  </button>
                </>
              )}
            </>
          )}

          {/* Unlocked state: files visible */}
          {!needsPassword && displayFiles.length > 0 && (
            <div className="bg-surface-light rounded-md divide-y divide-border mb-5 max-h-[35dvh] overflow-y-auto animate-fade-in">
              {displayFiles.map((f, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <FileIcon className="w-4 h-4 text-primary-light" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate">
                      {f.original_filename}
                    </p>
                    <p className="text-xs text-text-muted">
                      {formatBytes(f.file_size || 0)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Download Error */}
          {downloadError && (
            <div className="mb-4 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-danger animate-fade-in">
              {downloadError}
            </div>
          )}

          {/* Download Success */}
          {downloadStarted && (
            <div className="mb-4 flex items-center gap-2 bg-success/10 border border-success/20 rounded-md px-4 py-3 text-sm text-success animate-fade-in">
              <Check className="w-4 h-4 flex-shrink-0" />
              {t("share.downloadStarted")}
            </div>
          )}

          {/* Download Button - only shown when files are visible */}
          {canDownload && (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base animate-fade-in"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("share.preparing")}
                </>
              ) : (
                <>
                  <Download className="w-5 h-5" />
                  {t("share.downloadAll")}
                </>
              )}
            </button>
          )}
        </div>

        <div className="flex items-center justify-center mt-4">
          <LanguageSwitcher />
        </div>
      </div>
    </div>
  );
}
