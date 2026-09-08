import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  auth,
  type User,
  ApiError,
  getAuthIdentity,
  setAuthIdentity,
} from "../lib/api";

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSession: (message?: string, success?: boolean) => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const invalidate = useCallback(
    (message: string | null, success = false, broadcast = true) => {
      generation.current++;
      setAuthIdentity(null, true);
      setUser(null);
      setError(success ? null : message);
      setNotice(success ? message : null);
      setLoading(false);
      if (broadcast) channel.current?.postMessage({ type: "logout" });
    },
    [],
  );
  const clearSession = useCallback(
    (
      message = "Your session expired. Please sign in again.",
      success = false,
    ) => {
      invalidate(message, success);
    },
    [invalidate],
  );

  const refreshUser = async () => {
    const operation = ++generation.current;
    const snapshot = getAuthIdentity();
    try {
      const current = await auth.me();
      if (
        !active.current ||
        operation !== generation.current ||
        snapshot !== getAuthIdentity()
      )
        throw new ApiError(
          401,
          "Your account changed. Sign in again.",
          "IDENTITY_CHANGED",
        );
      if (current.id !== snapshot.userId) {
        clearSession(
          "Your signed-in account changed. Sign in again before continuing.",
        );
        return;
      }
      setAuthIdentity(current.id);
      setUser(current);
    } catch (err) {
      if (
        !active.current ||
        operation !== generation.current ||
        snapshot !== getAuthIdentity()
      )
        throw err;
      if (err instanceof ApiError && err.status === 401) clearSession();
      else throw err;
    }
  };

  useEffect(() => {
    active.current = true;
    const operation = ++generation.current;
    const snapshot = getAuthIdentity();
    const controller = new AbortController();
    // Cross-tab messages carry events only, never identities or session tokens.
    try {
      channel.current = new BroadcastChannel("itransfer-auth");
      channel.current.onmessage = ({ data }) => {
        if (data?.type === "login" || data?.type === "logout")
          invalidate(
            "Your account changed in another tab. Refresh or sign in again.",
            false,
            false,
          );
      };
    } catch {
      /* The expected-actor header still protects browsers without BroadcastChannel. */
    }
    const expired = () => clearSession();
    const mismatch = () =>
      clearSession(
        "Your signed-in account changed. Sign in again before continuing.",
      );
    window.addEventListener("session-expired", expired);
    window.addEventListener("identity-mismatch", mismatch);
    auth
      .me(controller.signal)
      .then((u) => {
        if (
          !active.current ||
          operation !== generation.current ||
          snapshot !== getAuthIdentity()
        )
          return;
        if (snapshot.userId && snapshot.userId !== u.id) {
          mismatch();
          return;
        }
        setAuthIdentity(u.id);
        setUser(u);
      })
      .catch(() => {
        if (
          active.current &&
          operation === generation.current &&
          snapshot === getAuthIdentity()
        )
          setUser(null);
      })
      .finally(() => {
        if (active.current && operation === generation.current)
          setLoading(false);
      });
    return () => {
      active.current = false;
      setAuthIdentity(null, true);
      controller.abort();
      channel.current?.close();
      channel.current = null;
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("identity-mismatch", mismatch);
    };
  }, [clearSession, invalidate]);

  const login = useCallback(async (email: string, password: string) => {
    const operation = ++generation.current;
    setAuthIdentity(null, true);
    const snapshot = getAuthIdentity();
    setUser(null);
    setError(null);
    setNotice(null);
    try {
      const u = await auth.login(email, password);
      if (
        !active.current ||
        operation !== generation.current ||
        snapshot !== getAuthIdentity()
      )
        throw new ApiError(
          401,
          "Your account changed. Sign in again.",
          "IDENTITY_CHANGED",
        );
      setAuthIdentity(u.id, true);
      setUser(u);
      channel.current?.postMessage({ type: "login" });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Please try again.";
      if (active.current && operation === generation.current) setError(msg);
      throw err;
    } finally {
      if (active.current && operation === generation.current) setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Start with the old expected actor, then invalidate immediately so neither
    // this tab nor another tab can consume old in-flight results during logout.
    const outgoing = auth.logout();
    invalidate(null);
    try {
      await outgoing;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "IDENTITY_CHANGED")
        throw error;
    }
  }, [invalidate]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        notice,
        login,
        logout,
        clearSession,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
