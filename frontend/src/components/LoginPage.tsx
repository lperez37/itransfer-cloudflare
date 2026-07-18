import { useState, useEffect, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Mail, Lock, Loader2, AlertCircle } from "lucide-react";
import logoSvg from "../assets/logo.svg";

export default function LoginPage() {
  const { login, error } = useAuth();
  const navigate = useNavigate();
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
      navigate("/dashboard");
    } catch {
      // error is set in auth context
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh page-bg-animated flex items-center justify-center p-4">
      <div className="relative z-10 w-full max-w-sm animate-slide-up">
        {/* Card */}
        <div className="surface rounded-lg p-8 sm:p-10">
          {/* Logo + Heading */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <div className="w-14 h-14 rounded-lg bg-primary/10 flex items-center justify-center">
                <img src={logoSvg} alt="iTransfer" className="w-9 h-9" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-text-primary">
              Welcome back
            </h1>
            <p className="text-text-muted mt-1 text-sm">
              Sign in to your iTransfer account
            </p>
          </div>

          {/* Error */}
          {displayError && (
            <div className="mb-6 flex items-center gap-2 bg-danger/10 border border-danger/20 rounded-md px-4 py-3 text-sm text-red-400 animate-fade-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {displayError}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-field pl-10"
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                <input
                  type="password"
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
              className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
