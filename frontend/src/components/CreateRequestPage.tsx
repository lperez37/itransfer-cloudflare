import { useState, useEffect, useRef, type FormEvent } from "react";
import { useWorkspace } from "../context/workspace";
import {
  Loader2,
  Check,
  Copy,
  Link,
  Shuffle,
  Cat,
  Inbox,
  Eye,
  EyeOff,
} from "lucide-react";

export default function CreateRequestPage() {
  const { client: { requests } } = useWorkspace();
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
  const [showPassword, setShowPassword] = useState(false);

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
    if (!title.trim()) return;
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
    setError(null);
  };

  /* ---------- Done ---------- */
  if (requestLink) {
    return (
      <div className="max-w-lg mx-auto animate-slide-up">
        <div className="surface rounded-lg p-8 text-center">
          <div className="w-14 h-14 rounded-lg bg-success/15 flex items-center justify-center mx-auto mb-4">
            <Check className="w-7 h-7 text-success" />
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">
            Request created!
          </h2>
          <p className="text-text-muted text-sm mb-6">
            Share this link with anyone to receive files.
          </p>

          <div className="flex items-center gap-2 bg-surface-light rounded-md p-3 mb-6">
            <Link className="w-4 h-4 text-primary-light flex-shrink-0" />
            <span className="text-sm text-text-primary truncate flex-1 text-left font-mono">
              {requestLink}
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
            Create another request
          </button>
        </div>
      </div>
    );
  }

  /* ---------- Form ---------- */
  return (
    <div className="max-w-2xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">
          Create File Request
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Generate a link for others to upload files to you
        </p>
      </div>

      {error && (
        <div className="mb-4 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-red-400 animate-fade-in">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="surface rounded-lg p-5 sm:p-6 space-y-5">
          <div className="flex items-center gap-2 mb-1">
            <Inbox className="w-4 h-4 text-primary-light" />
            <h3 className="font-semibold text-text-primary">
              Request Details
            </h3>
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Title <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input-field"
              placeholder="e.g., Project deliverables"
              required
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Message{" "}
              <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="input-field resize-none"
              placeholder="Instructions for the uploader..."
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
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

            {/* Max Uploads */}
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Max uploads{" "}
                <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <input
                type="number"
                min="1"
                value={maxUploads}
                onChange={(e) => setMaxUploads(e.target.value)}
                className="input-field"
                placeholder="Unlimited"
              />
            </div>

            {/* Max File Size */}
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Max file size{" "}
                <span className="text-text-muted font-normal">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  value={maxFileSize}
                  onChange={(e) => setMaxFileSize(e.target.value)}
                  className="input-field flex-1"
                  placeholder="No limit"
                />
                <select
                  value={fileSizeUnit}
                  onChange={(e) =>
                    setFileSizeUnit(e.target.value as "MB" | "GB")
                  }
                  className="input-field !w-20"
                >
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Password{" "}
              <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field pr-10"
                placeholder="Protect uploads with a password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Link Format */}
          <div>
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
                Random
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

          {/* Allow Incremental */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-secondary">Allow incremental uploads</p>
              <p className="text-xs text-text-muted mt-0.5">Uploaders can return to add more files</p>
            </div>
            <button
              type="button"
              onClick={() => setAllowIncremental(!allowIncremental)}
              className={`relative w-11 h-6 rounded-full transition-colors ${allowIncremental ? "bg-primary" : "bg-surface-lighter"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${allowIncremental ? "translate-x-5" : ""}`} />
            </button>
          </div>
        </div>

        {/* Submit */}
        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            disabled={loading || !title.trim()}
            className="btn-primary flex items-center gap-2 text-base px-8 py-3"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Request"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
