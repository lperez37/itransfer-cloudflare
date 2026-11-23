import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { auth } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import logoSvg from "../assets/logo.svg";
import EmailPreferences from "./EmailPreferences";
import PasswordInput from "./PasswordInput";
import TransferCover from "./TransferCover";
import "./transfer-page.css";

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
  const passwordPanel = (
    <section className={setup ? "transfer-page-panel" : "surface rounded-lg p-6 sm:p-8 w-full max-w-xl text-text-primary"}>
      {!setup && (
        <>
          <h1 className="text-2xl font-bold">My Account</h1>
          <p className="text-text-secondary text-sm mt-2 break-words">
            {user?.name} / {user?.email} /{" "}
            {user?.role === "admin" ? "Administrator" : "User"}
          </p>
        </>
      )}
      {success ? (
        <div className="space-y-4">
          <p role="status" className="text-success">
            Your password is saved. Sign in to open your private workspace.
          </p>
          <Link className="btn-primary transfer-page-action" to="/login">
            Go to sign in
          </Link>
        </div>
      ) : setup && !token ? (
        <div className="space-y-4">
          <p role="alert" className="text-text-secondary">
            This setup link is missing its token. Ask your administrator to
            send a new single-use link and open it in full.
          </p>
          <Link className="btn-secondary transfer-page-action" to="/login">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className={`mb-5 text-sm text-text-secondary ${setup ? "" : "mt-3"}`}>
            {setup
              ? "Choose a password to activate or recover your account. This link can be used once."
              : "Change your password. This signs you out on every device, including this one."}
          </p>
          <form onSubmit={submit} className="space-y-5">
            {!setup && (
              <div>
                <label htmlFor="account-current-password" className="block text-sm text-text-secondary">Current password</label>
                <PasswordInput
                  id="account-current-password"
                  showLabel="Show current password"
                  hideLabel="Hide current password"
                  required
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  wrapperClassName="mt-2"
                  disabled={busy}
                />
              </div>
            )}
            <div>
              <label htmlFor="account-new-password" className="block text-sm text-text-secondary">New password</label>
              <PasswordInput
                id="account-new-password"
                showLabel="Show new password"
                hideLabel="Hide new password"
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                aria-describedby="password-hint"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                wrapperClassName="mt-2"
                disabled={busy}
              />
              <p id="password-hint" className="mt-2 text-sm text-text-secondary">
                Use 8 to 128 characters. A long, unique passphrase works well.
              </p>
            </div>
            <div>
              <label htmlFor="account-confirm-password" className="block text-sm text-text-secondary">Confirm new password</label>
              <PasswordInput
                id="account-confirm-password"
                showLabel="Show confirmed password"
                hideLabel="Hide confirmed password"
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                wrapperClassName="mt-2"
                disabled={busy}
              />
            </div>
            {error && (
              <div role="alert" className={`text-sm text-danger ${setup ? "rounded-xl border border-danger/20 bg-danger/10 px-4 py-3" : ""}`}>
                <p>{error}</p>
                {setup && (
                  <p className="mt-2">
                    If your link has expired or was already used, contact your
                    administrator and ask them to send a new link.
                  </p>
                )}
              </div>
            )}
            <button type="submit" className={setup ? "btn-primary transfer-page-action" : "btn-primary"} disabled={busy}>
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
  );

  if (setup) {
    return (
      <main className="transfer-page transfer-page--auth">
        <div className="transfer-page-column">
          <header className="transfer-page-header">
            <div className="transfer-page-brand">
              <img src={logoSvg} alt="iTransfer" />
              <span aria-hidden="true">iTransfer</span>
            </div>
          </header>
          <TransferCover title="Set your password" headingLevel={1} />
          {passwordPanel}
        </div>
      </main>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {!!user?.password_change_required && <aside role="alert" aria-label="Password update required" className="rounded-lg border border-primary/40 bg-primary/10 p-5 text-text-primary">
        <p className="font-semibold mb-2">Password update required</p>
        <p className="text-sm">Update your password to finish the upgrade. Your existing transfers are safe; choose a new password before using your workspace.</p>
      </aside>}
      {passwordPanel}
      <EmailPreferences key={user?.id} />
    </div>
  );
}
