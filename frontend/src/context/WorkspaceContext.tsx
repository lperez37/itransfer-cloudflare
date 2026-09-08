import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { workspace, WorkspaceContext } from "./workspace";
import { useAuth } from "./AuthContext";
import { ApiError, auth } from "../lib/api";
import ConfirmPassword from "../components/ConfirmPassword";

interface Confirmation {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  controller: AbortController;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, clearSession } = useAuth();
  const [state, setState] = useState(() => workspace(null));
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pending = useRef<Confirmation | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current?.controller.abort();
      pending.current?.reject(
        new Error("Session ended. Sign in again before retrying."),
      );
      pending.current = null;
    };
  }, []);

  const requestConfirmation = useCallback(() => {
    if (!active.current)
      return Promise.reject(
        new Error("Session ended. Sign in again before retrying."),
      );
    if (pending.current) return pending.current.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const next = {
      promise,
      resolve,
      reject,
      controller: new AbortController(),
    };
    pending.current = next;
    setConfirmation(next);
    return promise;
  }, []);

  async function verifyIdentity(item: Confirmation) {
    if (!active.current || pending.current !== item)
      throw new Error("This confirmation is no longer active.");
    let current;
    try {
      current = await auth.me(item.controller.signal);
    } catch (error) {
      if (active.current && error instanceof ApiError && error.status === 401)
        clearSession();
      throw error;
    }
    if (!active.current || pending.current !== item)
      throw new Error("This confirmation is no longer active.");
    if (
      current.id !== user?.id ||
      current.role !== "admin" ||
      current.status !== "active"
    ) {
      clearSession(
        "Your signed-in account changed. Sign in again before retrying.",
      );
      throw new Error("Your signed-in account changed.");
    }
  }
  return (
    <WorkspaceContext.Provider
      value={{
        ...state,
        readOnly: !!state.target && !state.manage,
        view: (user, manage = false) =>
          setState(workspace(user, manage, requestConfirmation)),
      }}
    >
      {children}
      {confirmation && (
        <ConfirmPassword
          title="Continue workspace operation"
          description={`Password confirmation for ${user?.email} has expired. Confirm to retry the paused operation in its original workspace. Completed file uploads will not be repeated.`}
          reauthenticate={async (password) => {
            // Recheck both sides of reauth: another tab can change the session
            // cookie while this provider still displays the original identity.
            await verifyIdentity(confirmation);
            await auth.reauth(password, confirmation.controller.signal);
            await verifyIdentity(confirmation);
          }}
          onCancel={() => {
            confirmation.controller.abort();
            confirmation.reject(
              new Error(
                "Password confirmation cancelled. Retry when you are ready to continue.",
              ),
            );
            pending.current = null;
            setConfirmation(null);
          }}
          onConfirm={async () => {
            if (!active.current || pending.current !== confirmation) return;
            pending.current = null;
            setConfirmation(null);
            confirmation.resolve();
          }}
        />
      )}
    </WorkspaceContext.Provider>
  );
}
