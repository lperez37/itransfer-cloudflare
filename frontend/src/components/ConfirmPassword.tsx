import { useEffect, useRef, useState, type FormEvent } from "react";
import { auth } from "../lib/api";
import PasswordInput from "./PasswordInput";

export default function ConfirmPassword({
  title,
  description,
  onConfirm,
  onCancel,
  reauthenticate = auth.reauth,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  reauthenticate?: (password: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      active.current = false;
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await reauthenticate(password);
      if (!active.current) return;
      setPassword("");
      await onConfirm();
    } catch (err) {
      if (!active.current) return;
      setError(
        err instanceof Error ? err.message : "Action failed. Please try again.",
      );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md surface rounded-lg p-6 text-text-primary backdrop:bg-black/70"
    >
      <h2 id="confirm-title" className="text-xl font-semibold">
        {title}
      </h2>
      <p
        id="confirm-description"
        className="text-sm text-text-secondary mt-2 mb-5"
      >
        {description} Confirm with your own password.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="confirm-password" className="block text-sm text-text-secondary">Your password</label>
          <PasswordInput
            id="confirm-password"
            autoFocus
            required
            autoComplete="current-password"
            wrapperClassName="mt-2"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            className="btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button disabled={busy} className="btn-primary">
            {busy ? "Confirming..." : "Confirm and continue"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
