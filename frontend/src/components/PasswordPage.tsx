import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { auth } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import EmailPreferences from "./EmailPreferences";

export default function PasswordPage({ setup = false }: { setup?: boolean }) {
  const { user, clearSession } = useAuth();
  const navigate = useNavigate();
  // Keep the bearer token in this mounted page only, never in storage or a query.
  const [token, setToken] = useState(() =>
    setup
      ? new URLSearchParams(window.location.hash.slice(1)).get("token") || ""
      : "",
  );
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  useEffect(() => {
    if (!setup) return;
    const removeFragment = () => window.history.replaceState(
      window.history.state, "", window.location.pathname,
    );
    const replaceToken = () => {
      setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
      setSuccess(false);
      setError("");
      setPassword("");
      setConfirm("");
      removeFragment();
    };
    removeFragment();
    window.addEventListener("hashchange", replaceToken);
    return () => window.removeEventListener("hashchange", replaceToken);
  }, [setup]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The passwords do not match. Please enter them again.");
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError("Use 8 to 128 characters for your new password.");
      return;
    }
    setBusy(true);
    try {
      if (setup) {
        await auth.setupPassword(token, password);
        setToken("");
        setSuccess(true);
        clearSession("Password saved. Sign in with your new password.", true);
      } else {
        await auth.password(current, password);
        clearSession(
          "Password changed. All sessions have been signed out. Sign in with your new password.",
          true,
        );
        navigate("/login", { replace: true });
      }
      setPassword("");
      setConfirm("");
      setCurrent("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not save your password. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={
        setup
          ? "min-h-dvh page-bg flex items-center justify-center p-4"
          : "max-w-xl mx-auto space-y-6"
      }
    >
      {!setup && !!user?.password_change_required && <aside role="alert" aria-label="Password update required" className="rounded-lg border border-primary/40 bg-primary/10 p-5 text-text-primary">
        <p className="font-semibold mb-2">Password update required</p>
        <p className="text-sm">Update your password to finish the upgrade. Your existing transfers are safe; choose a new password before using your workspace.</p>
      </aside>}
      <section className="surface rounded-lg p-6 sm:p-8 w-full max-w-xl text-text-primary">
        <h1 className="text-2xl font-bold">
          {setup ? "Set your password" : "My Account"}
        </h1>
        {!setup && (
          <p className="text-text-secondary text-sm mt-2 break-words">
            {user?.name} / {user?.email} /{" "}
            {user?.role === "admin" ? "Administrator" : "User"}
          </p>
        )}
        {success ? (
          <div className="mt-5 space-y-4">
            <p role="status" className="text-emerald-400">
              Your password is saved. Sign in to open your private workspace.
            </p>
            <Link className="btn-primary inline-block" to="/login">
              Go to sign in
            </Link>
          </div>
        ) : setup && !token ? (
          <div className="mt-5 space-y-4">
            <p role="alert" className="text-text-secondary">
              This setup link is missing its token. Ask your administrator to
              send a new single-use link and open it in full.
            </p>
            <Link className="btn-secondary inline-block" to="/login">
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-secondary mt-3 mb-6">
              {setup
                ? "Choose a password to activate or recover your account. This link can be used once."
                : "Change your password. This signs you out on every device, including this one."}
            </p>
            <form onSubmit={submit} className="space-y-5">
              {!setup && (
                <label className="block text-sm text-text-secondary">
                  Current password
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                    className="input-field mt-2"
                    disabled={busy}
                  />
                </label>
              )}
              <label className="block text-sm text-text-secondary">
                New password
                <input
                  required
                  type="password"
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  aria-describedby="password-hint"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field mt-2"
                  disabled={busy}
                />
              </label>
              <p id="password-hint" className="text-sm text-text-secondary">
                Use 8 to 128 characters. A long, unique passphrase works well.
              </p>
              <label className="block text-sm text-text-secondary">
                Confirm new password
                <input
                  required
                  type="password"
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="input-field mt-2"
                  disabled={busy}
                />
              </label>
              {error && (
                <div role="alert" className="text-sm text-red-400">
                  <p>{error}</p>
                  {setup && (
                    <p className="mt-2">
                      If your link has expired or was already used, contact your
                      administrator and ask them to send a new link.
                    </p>
                  )}
                </div>
              )}
              <button className="btn-primary" disabled={busy}>
                {busy
                  ? "Saving password..."
                  : setup
                    ? "Save password"
                    : "Change password and sign out"}
              </button>
            </form>
          </>
        )}
      </section>
      {!setup && <EmailPreferences key={user?.id} />}
    </div>
  );
}
