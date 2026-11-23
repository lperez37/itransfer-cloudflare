import { useState, useEffect, useRef, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useWorkspace } from "../context/workspace";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
import {
  ArrowLeft,
  Loader2,
  Check,
  Copy,
  Link2,
  Shuffle,
  Cat,
  Inbox,
} from "lucide-react";
import "./workspace-transfers.css";

export default function CreateRequestPage() {
  const { client: { requests } } = useWorkspace();
  const { state } = useLocation();
  const dashboard = { pathname: "/dashboard", search: typeof state?.dashboardSearch === "string" ? state.dashboardSearch : "" };
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [expiryDays, setExpiryDays] = useState(7);
  const [maxUploads, setMaxUploads] = useState("");
  const [maxFileSize, setMaxFileSize] = useState("");
  const [fileSizeUnit, setFileSizeUnit] = useState<"MB" | "GB">("GB");
  const [idFormat, setIdFormat] = useState<"random" | "animals">("random");
  const [idLength, setIdLength] = useState(10);
  const [allowIncremental, setAllowIncremental] = useState(false);
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [requestLink, setRequestLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || loading) return;
    setError(null);
    setLoading(true);

    try {
      let maxFileSizeBytes: number | undefined;
      if (maxFileSize) {
        const num = parseFloat(maxFileSize);
        if (Number.isFinite(num) && num > 0) {
          maxFileSizeBytes =
            fileSizeUnit === "GB"
              ? num * 1024 * 1024 * 1024
              : num * 1024 * 1024;
        }
      }

      const parsedMaxUploads = parseInt(maxUploads, 10);
      const maxUploadsValue =
        Number.isFinite(parsedMaxUploads) && parsedMaxUploads > 0
          ? parsedMaxUploads
          : undefined;

      const res = await requests.create({
        title: title.trim(),
        message: message.trim() || undefined,
        expiry_days: expiryDays,
        max_uploads: maxUploadsValue,
        max_file_size: maxFileSizeBytes,
        allow_incremental: allowIncremental || undefined,
        password: password || undefined,
        id_format: idFormat,
        id_length: idFormat === "random" ? idLength : undefined,
      });

      setRequestLink(`${window.location.origin}/${res.request_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create request");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(requestLink);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleNew = () => {
    setTitle("");
    setMessage("");
    setExpiryDays(7);
    setMaxUploads("");
    setMaxFileSize("");
    setAllowIncremental(false);
    setPassword("");
    setRequestLink("");
    setCopied(false);
    setError(null);
  };

  if (requestLink) {
    return (
      <div className="workspace-transfer-flow mx-auto grid max-w-3xl gap-4" data-variant="request">
        <TransferCover title="Request created!" variant="request">
          <p className="text-sm text-white">Share this link with anyone to receive files.</p>
        </TransferCover>
        <section aria-label="Request link" className="surface grid gap-4 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-xl bg-surface-light p-3">
            <Link2 className="size-4 shrink-0 text-accent" aria-hidden="true" />
            <a href={requestLink} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 font-mono text-sm text-text-primary underline decoration-border hover:decoration-current [overflow-wrap:anywhere]">
              {requestLink}
            </a>
            <button onClick={handleCopy} className="btn-primary workspace-primary-action shrink-0 px-3 text-sm">
              {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleNew} className="btn-secondary min-h-11 rounded-full text-sm">
              Create another request
            </button>
            <Link to={dashboard} className="workspace-row-action">Back to dashboard</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="workspace-transfer-flow mx-auto grid max-w-5xl gap-4 sm:gap-5" data-variant="request">
      <Link to={dashboard} className="workspace-row-action justify-self-start" aria-label="Back to dashboard">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Dashboard
      </Link>
      <TransferCover title="Create File Request" variant="request">
        <p className="text-sm text-white">Generate a link for others to upload files to you.</p>
      </TransferCover>

      {error && (
        <div role="alert" className="workspace-transfer-notice border-danger/25 bg-danger/10 text-danger">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid gap-4">
        <fieldset disabled={loading} className="grid min-w-0 items-start gap-4 md:grid-cols-2">
          <section aria-labelledby="request-details" className="surface grid min-w-0 gap-4 rounded-2xl p-4 sm:p-5">
            <h2 id="request-details" className="text-lg font-semibold text-text-primary">Request Details</h2>

            <div>
              <label htmlFor="request-title" className="mb-1.5 block text-sm font-medium text-text-primary">
                Title <span className="text-danger" aria-hidden="true">*</span>
              </label>
              <input
                id="request-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="input-field"
                placeholder="e.g., Project deliverables"
                required
              />
            </div>

            <div>
              <label htmlFor="request-message" className="mb-1.5 block text-sm font-medium text-text-primary">
                Message <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <textarea
                id="request-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="input-field resize-y"
                placeholder="Instructions for the uploader..."
              />
            </div>

            <div>
              <label htmlFor="request-expiry" className="mb-1.5 block text-sm font-medium text-text-primary">Expires after</label>
              <select
                id="request-expiry"
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
                className="input-field"
              >
                <option value={5 / 1440}>5 minutes</option>
                <option value={15 / 1440}>15 minutes</option>
                <option value={30 / 1440}>30 minutes</option>
                <option value={1 / 24}>1 hour</option>
                <option value={1}>24 hours</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>365 days</option>
              </select>
            </div>

            <fieldset className="min-w-0 space-y-2">
              <legend className="mb-1.5 text-sm font-medium text-text-primary">Link format</legend>
              <div className="workspace-transfer-segmented">
                <button type="button" aria-pressed={idFormat === "random"} onClick={() => setIdFormat("random")} className="text-accent">
                  <Shuffle className="size-4" aria-hidden="true" />
                  Random
                </button>
                <button type="button" aria-pressed={idFormat === "animals"} onClick={() => setIdFormat("animals")} className="text-accent">
                  <Cat className="size-4" aria-hidden="true" />
                  Animal combo
                </button>
              </div>
              {idFormat === "random" ? (
                <div className="grid gap-1">
                  <label htmlFor="request-link-length" className="flex flex-wrap justify-between gap-x-2 text-xs text-text-secondary">
                    <span>Link length</span>
                    <span className="font-semibold text-accent">{idLength} characters</span>
                  </label>
                  <input
                    id="request-link-length"
                    type="range"
                    min="9"
                    max="64"
                    value={idLength}
                    aria-valuetext={`${idLength} characters`}
                    onChange={(e) => setIdLength(Number(e.target.value))}
                    className="h-8 w-full accent-accent"
                  />
                </div>
              ) : (
                <p className="text-xs text-text-secondary">Example: <span className="font-mono">/monkey-eel-cat</span></p>
              )}
            </fieldset>
          </section>

          <section aria-labelledby="request-limits" className="surface grid min-w-0 gap-4 rounded-2xl p-4 sm:p-5">
            <h2 id="request-limits" className="text-lg font-semibold text-text-primary">Password and upload limits</h2>

            <div>
              <label htmlFor="request-password" className="mb-1.5 block text-sm font-medium text-text-primary">
                Password <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <PasswordInput
                id="request-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Protect uploads with a password"
              />
            </div>

            <div>
              <label htmlFor="request-upload-limit" className="mb-1.5 block text-sm font-medium text-text-primary">
                Max uploads <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <input
                id="request-upload-limit"
                type="number"
                min="1"
                value={maxUploads}
                onChange={(e) => setMaxUploads(e.target.value)}
                className="input-field"
                placeholder="Unlimited"
              />
            </div>

            <div>
              <label htmlFor="request-size-limit" className="mb-1.5 block text-sm font-medium text-text-primary">
                Max file size <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  id="request-size-limit"
                  type="number"
                  min="1"
                  value={maxFileSize}
                  onChange={(e) => setMaxFileSize(e.target.value)}
                  className="input-field min-w-0 flex-1"
                  placeholder="No limit"
                />
                <select
                  aria-label="File size unit"
                  value={fileSizeUnit}
                  onChange={(e) => setFileSizeUnit(e.target.value as "MB" | "GB")}
                  className="input-field w-20 shrink-0"
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={allowIncremental}
              aria-labelledby="request-incremental-label"
              aria-describedby="request-incremental-hint"
              onClick={() => setAllowIncremental((previous) => !previous)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-left hover:bg-surface-light"
            >
              <span className="min-w-0">
                <span id="request-incremental-label" className="block text-sm font-medium text-text-primary">Allow incremental uploads</span>
                <span id="request-incremental-hint" className="block text-xs text-text-secondary">Uploaders can return to add more files.</span>
              </span>
              <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full border border-border transition-colors ${allowIncremental ? "bg-accent" : "bg-surface-lighter"}`}>
                <span className={`absolute left-0.5 top-0.5 size-4.5 rounded-full transition-transform ${allowIncremental ? "translate-x-5 bg-background" : "bg-text-secondary"}`} />
              </span>
            </button>
          </section>
        </fieldset>

        <div className="workspace-form-footer">
          <button
            type="submit"
            disabled={loading || !title.trim()}
            className="btn-primary workspace-primary-action text-sm"
          >
            {loading ? <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : <Inbox className="size-4 shrink-0" aria-hidden="true" />}
            {loading ? "Creating..." : "Create Request"}
          </button>
        </div>
      </form>
    </div>
  );
}
