import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import {
  publicApi,
  ApiError,
  type PublicShare,
  type PublicRequest,
} from "../lib/api";
import { useTranslation } from "../i18n";
import SharePage from "./SharePage";
import RequestPage from "./RequestPage";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";

// HTTP statuses meaning "this resource existed but is gone" - we still render
// the share/request page (which shows the expired/exhausted state). A plain 404
// means "not this type, try the other one"; anything else (network failure, 5xx)
// is a transient error the user can retry.
const GONE_STATUSES = new Set([410]);

function isGone(err: unknown): boolean {
  return err instanceof ApiError && GONE_STATUSES.has(err.status);
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export default function PublicResolver() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [type, setType] = useState<"share" | "request" | null>(null);
  const [share, setShare] = useState<PublicShare | null>(null);
  const [request, setRequest] = useState<PublicRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKind, setErrorKind] = useState<"notFound" | "retryable" | null>(
    null
  );
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setErrorKind(null);
    setType(null);

    (async () => {
      try {
        const s = await publicApi.getShare(id);
        if (cancelled) return;
        setShare(s);
        setType("share");
      } catch (shareErr) {
        if (cancelled) return;

        // Share exists but is gone - still render the (expired) share page.
        if (isGone(shareErr)) {
          setType("share");
          return;
        }

        // Not a share - try resolving the id as a request instead.
        if (isNotFound(shareErr)) {
          try {
            const r = await publicApi.getRequest(id);
            if (cancelled) return;
            setRequest(r);
            setType("request");
          } catch (reqErr) {
            if (cancelled) return;
            if (isNotFound(reqErr) || isGone(reqErr)) {
              setErrorKind("notFound");
            } else {
              // Network failure or 5xx while checking the request - retryable.
              setErrorKind("retryable");
            }
          }
          return;
        }

        // Network failure or 5xx on the share lookup - retryable, not "gone".
        setErrorKind("retryable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (loading) {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (errorKind === "retryable") {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center p-4">
        <div className="surface rounded-lg p-8 max-w-md text-center animate-slide-up">
          <div className="w-14 h-14 rounded-lg bg-warning/15 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-7 h-7 text-warning" />
          </div>
          <h2 className="text-xl font-bold text-text-primary mb-2">
            {t("loadError.title")}
          </h2>
          <p className="text-text-muted text-sm mb-5">
            {t("loadError.description")}
          </p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="btn-primary inline-flex items-center gap-2 text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            {t("loadError.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (errorKind === "notFound" || !id) {
    return (
      <div className="min-h-dvh page-bg flex items-center justify-center p-4">
        <div className="surface rounded-lg p-8 max-w-md text-center animate-slide-up">
          <div className="w-14 h-14 rounded-lg bg-danger/15 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-7 h-7 text-danger" />
          </div>
          <h2 className="text-xl font-bold text-text-primary mb-2">
            {t("notFound.title")}
          </h2>
          <p className="text-text-muted text-sm">
            {t("notFound.description")}
          </p>
        </div>
      </div>
    );
  }

  // Pass the already-resolved payload down so the page doesn't refetch it.
  if (type === "share") return <SharePage shareId={id} initialShare={share} />;
  if (type === "request")
    return <RequestPage requestId={id} initialRequest={request} />;
  return null;
}
