import { useEffect, useId, useState, type FormEvent } from "react";
import {
  createEmailPreferencesClient,
  EMAIL_PREFERENCE_KEYS,
  type EmailPreferences as Preferences,
  type EmailPreferenceChanges,
  type User,
} from "../lib/api";
import { useAuth } from "../context/AuthContext";
import ConfirmPassword from "./ConfirmPassword";

const options = [
  { key: "share_downloads", label: "Files downloaded", description: "" },
  {
    key: "request_uploads",
    label: "Files received via requests",
    description: "",
  },
  {
    key: "password_changed",
    label: "Password changed",
    description: "Email when this account's password changes.",
  },
  {
    key: "expiry_alerts",
    label: "Transfers expiring soon",
    description:
      "Email when a transfer will expire within 24 hours. These are not cost notifications.",
  },
  {
    key: "invitation_reminders",
    label: "Invitation reminders",
    description:
      "Allow an administrator to remind a pending account to finish setup. Sending a reminder replaces the previous setup link.",
  },
] as const;

export default function EmailPreferences({
  target,
  onClose,
}: {
  target?: User;
  onClose?: () => void;
}) {
  const { user } = useAuth();
  const allowed = !target || user?.role === "admin";
  const headingId = useId();
  const [client] = useState(() => createEmailPreferencesClient(target?.id));
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<EmailPreferenceChanges>({});
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<EmailPreferenceChanges | null>(null);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    client
      .get(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (
          !data ||
          EMAIL_PREFERENCE_KEYS.some((key) => typeof data[key] !== "boolean")
        )
          throw new Error(
            "Invalid email preferences. Please try loading them again.",
          );
        setSaved(data);
        setDraft({
          share_downloads: data.share_downloads,
          request_uploads: data.request_uploads,
          password_changed: data.password_changed,
          expiry_alerts: data.expiry_alerts,
          invitation_reminders: data.invitation_reminders,
        });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error
              ? err.message
              : "Could not load email preferences.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, reload, allowed]);

  const changes: EmailPreferenceChanges = {};
  for (const key of EMAIL_PREFERENCE_KEYS) {
    if (saved && draft[key] !== saved[key]) changes[key] = draft[key];
  }
  const dirty = Object.keys(changes).length > 0;

  async function save(patch: EmailPreferenceChanges) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await client.update(patch);
      if (
        !result ||
        EMAIL_PREFERENCE_KEYS.some((key) => typeof result[key] !== "boolean")
      )
        throw new Error(
          "Invalid email preferences response. Your changes are still here.",
        );
      setSaved(result);
      setDraft({
        share_downloads: result.share_downloads,
        request_uploads: result.request_uploads,
        password_changed: result.password_changed,
        expiry_alerts: result.expiry_alerts,
        invitation_reminders: result.invitation_reminders,
      });
      setNotice("Email preferences saved.");
      setPending(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not save email preferences. Your changes are still here.",
      );
      throw err;
    } finally {
      setSaving(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!allowed || !saved || !dirty || saving) return;
    if (target) setPending(changes);
    else void save(changes).catch(() => {});
  }

  if (!allowed) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="surface rounded-[1.25rem] p-6 sm:p-8 text-text-primary space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-xl font-semibold">
            Email preferences
          </h2>
          {target && (
            <p className="text-sm text-text-secondary mt-1 break-words">
              {target.name} / {target.email}
            </p>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            className="btn-secondary text-sm"
            disabled={saving}
            onClick={onClose}
          >
            Close preferences
          </button>
        )}
      </div>
      <p className="text-sm text-text-secondary">
        All emails are plain text. Welcome and password reset emails are always
        on. Optional emails are off by default. These are not marketing emails,
        and there is no email-confirmation flow.
      </p>
      {target?.status === "disabled" && (
        <p className="text-sm text-text-secondary">
          Preferences can be edited, but email delivery is blocked while this
          account is disabled.
        </p>
      )}
      <dl className="divide-y divide-border text-sm">
        <div className="flex justify-between gap-4 py-3">
          <dt>Welcome email</dt>
          <dd className="text-text-secondary">Always on</dd>
        </div>
        <div className="flex justify-between gap-4 py-3">
          <dt>Password reset email</dt>
          <dd className="text-text-secondary">Always on</dd>
        </div>
      </dl>
      {loading && (
        <p role="status" className="text-sm text-text-secondary">
          Loading email preferences...
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!loading && !saved && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setError("");
            setLoading(true);
            setReload((value) => value + 1);
          }}
        >
          Retry loading preferences
        </button>
      )}
      <form onSubmit={submit} className="space-y-4">
        {saved && (
          <fieldset disabled={loading || saving} className="space-y-3">
            <legend className="text-sm font-medium mb-3">
              Optional emails
            </legend>
            {options.map(({ key, label, description }) => (
              <div key={key}>
                <label className="flex items-center gap-3 py-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={draft[key] === true}
                    aria-describedby={
                      description ? `${headingId}-${key}` : undefined
                    }
                    onChange={(event) => {
                      setDraft({ ...draft, [key]: event.target.checked });
                      setNotice("");
                    }}
                  />
                  {label}
                </label>
                {description && (
                  <p
                    id={`${headingId}-${key}`}
                    className="ml-7 text-sm text-text-secondary"
                  >
                    {description}
                  </p>
                )}
              </div>
            ))}
          </fieldset>
        )}
        <button
          className="btn-primary"
          disabled={loading || saving || !saved || !dirty}
        >
          {saving ? "Saving preferences..." : "Save email preferences"}
        </button>
        {notice && (
          <p role="status" className="text-sm text-success">
            {notice}
          </p>
        )}
      </form>
      {pending && target && (
        <ConfirmPassword
          title="Save email preferences"
          description={`Update optional emails for ${target.email}. Welcome and password reset emails stay on.`}
          onCancel={() => setPending(null)}
          onConfirm={() => save(pending)}
        />
      )}
    </section>
  );
}
