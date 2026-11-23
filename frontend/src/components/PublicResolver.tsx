import { useState, useEffect, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  publicApi,
  ApiError,
  type PublicShare,
  type PublicRequest,
} from "../lib/api";
import { useTranslation } from "../i18n";
import LanguageSwitcher from "./LanguageSwitcher";
import SharePage from "./SharePage";
import RequestPage from "./RequestPage";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import logoSvg from "../assets/logo.svg";
import "./transfer-page.css";

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
  return <ResolvedPublicPage key={id} id={id} />;
}

function ResolvedPublicPage({ id }: { id?: string }) {
  const { t, locale } = useTranslation();
  const [type, setType] = useState<"share" | "request" | null>(null);
  const [share, setShare] = useState<PublicShare | null>(null);
  const [request, setRequest] = useState<PublicRequest | null>(null);
  const [loading, setLoading] = useState(!!id);
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

  let content: ReactNode;
  if (loading) {
    content = (
      <div className="grid min-h-32 place-items-center" aria-busy="true">
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      </div>
    );
  } else if (errorKind || !id) {
    const retryable = errorKind === "retryable";
    content = (
      <section className="transfer-page-panel text-center">
        <div className={`mx-auto mb-4 grid size-12 place-items-center rounded-xl ${retryable ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger"}`}>
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold">{t(retryable ? "loadError.title" : "notFound.title")}</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t(retryable ? "loadError.description" : "notFound.description")}
        </p>
        {retryable && (
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="btn-primary transfer-page-action mt-5"
          >
            <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
            {t("loadError.retry")}
          </button>
        )}
      </section>
    );
  } else if (type === "share") {
    // The resolved payload keeps the share page from fetching it a second time.
    content = <SharePage shareId={id} initialShare={share} />;
  } else if (type === "request") {
    content = <RequestPage requestId={id} initialRequest={request} />;
  }

  return (
    <main lang={locale} className="transfer-page" data-variant={type ?? undefined}>
      <div className="transfer-page-column">
        <header className="transfer-page-header">
          <div className="transfer-page-brand">
            <img src={logoSvg} alt="iTransfer" />
            <span aria-hidden="true">iTransfer</span>
          </div>
          <LanguageSwitcher />
        </header>
        {content}
      </div>
    </main>
  );
}
