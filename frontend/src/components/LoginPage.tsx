import { useState, useEffect, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { Mail, Lock, Loader2, AlertCircle } from "lucide-react";
import logoSvg from "../assets/logo.svg";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
import "./transfer-page.css";

export default function LoginPage() {
  const { login, error, notice } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const logoutError = sessionStorage.getItem("logout-error");
      if (logoutError) {
        setLocalError(logoutError);
        sessionStorage.removeItem("logout-error");
      }
    } catch {
      /* sessionStorage unavailable - non-fatal */
    }
  }, []);

  const displayError = localError || error;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setLocalError("Please enter email and password.");
      return;
    }
    setLocalError(null);
    setLoading(true);
    try {
      await login(email, password);
      // PublicOnlyRoute chooses Account or Dashboard from the returned identity.
    } catch {
      // error is set in auth context
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="transfer-page transfer-page--auth">
      <div className="transfer-page-column">
        <header className="transfer-page-header">
          <div className="transfer-page-brand">
            <img src={logoSvg} alt="iTransfer" />
            <span aria-hidden="true">iTransfer</span>
          </div>
        </header>

        <TransferCover title="Welcome back" headingLevel={1}>
          <p className="text-sm leading-relaxed text-text-secondary">Sign in to your iTransfer account</p>
        </TransferCover>

        <div className="transfer-page-panel">
          {displayError && (
            <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {displayError}
            </div>
          )}

          {notice && <p role="status" className="mb-5 text-sm text-success">{notice}</p>}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-sm font-semibold">
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
                <input
                  type="email"
                  id="login-email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-field pl-10"
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-sm font-semibold">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
                <PasswordInput
                  id="login-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field pl-10"
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary transfer-page-action"
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
          <p className="mt-6 border-t border-border pt-4 text-sm leading-relaxed text-text-secondary">
            Need access or forgot your password? Ask your administrator to send a new single-use setup or password reset link.
          </p>
        </div>
      </div>
    </main>
  );
}
