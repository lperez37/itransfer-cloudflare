import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { users, parseUtcDate, type User, type SetupLink } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useWorkspace } from "../context/workspace";
import ConfirmPassword from "./ConfirmPassword";
import EmailPreferences from "./EmailPreferences";

type Action = { title: string; description: string; run: () => Promise<void> };
function recoveryLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^https:\/\//i.test(value) ||
    value.includes("\\") ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/set-password" ||
      url.search ||
      !/^#token=[a-fA-F0-9]{64}$/.test(url.hash)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
const linkCopy = {
  welcome: {
    email: "Welcome",
    issued: "User created",
    detail: "The account was created",
    queued:
      "The welcome email explains how to use iTransfer and includes the setup link.",
    backup: "Backup setup link",
    retry: "recreate the account",
  },
  reset: {
    email: "Password reset",
    issued: "Password reset link issued",
    detail: "The reset link was issued",
    queued: "The email includes the single-use password reset link.",
    backup: "Backup password reset link",
    retry: "generate another reset link",
  },
  invitation: {
    email: "Invitation reminder",
    issued: "Invitation link issued",
    detail: "An invitation link was issued",
    queued:
      "The email reminds the pending user to finish setup with a new single-use link that expires in 24 hours.",
    backup: "Backup invitation link",
    retry: "generate another invitation link",
  },
};
export default function UsersPage() {
  const { user: me, refreshUser, clearSession } = useAuth();
  const { view } = useWorkspace();
  const navigate = useNavigate();
  const [rows, setRows] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<User | "new" | null>(null);
  const [preferencesUser, setPreferencesUser] = useState<User | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [link, setLink] = useState<
    (SetupLink & { email: string; kind: keyof typeof linkCopy }) | null
  >(null);
  const [copyStatus, setCopyStatus] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setRows((await users.list()).users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    users
      .list()
      .then((data) => {
        if (!cancelled) setRows(data.users);
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Could not load users.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  function showLink(
    data: SetupLink,
    email: string,
    kind: keyof typeof linkCopy,
  ) {
    setLink({ ...data, setup_url: recoveryLink(data?.setup_url), email, kind });
    setNotice("");
    setCopyStatus("");
  }
  function ask(next: Action) {
    setNotice("");
    setAction(next);
  }
  const filtered = rows.filter((row) =>
    `${row.name} ${row.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="text-text-primary space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4 sm:items-center">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Users</h1>
          <p className="text-sm text-text-secondary mt-1">
            Private workspaces, account access, and welcome or password reset
            emails.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => {
            setEditor("new");
            setLink(null);
          }}
        >
          Add user
        </button>
      </div>
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="text-sm text-danger flex flex-wrap gap-3 items-center"
        >
          {error}
          <button className="btn-secondary" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {link && (
        <section
          className="surface rounded-[1.25rem] p-5 space-y-3"
          aria-label="Single-use password link"
        >
          <div
            role={
              link.setup_url && link.mail?.status === "queued"
                ? "status"
                : "alert"
            }
            className="space-y-2"
          >
            <h2 className="font-semibold break-words">
              {!link.setup_url
                ? `Recovery link unavailable for ${link.email}`
                : link.mail?.status === "queued"
                  ? `${linkCopy[link.kind].email} email queued for ${link.email}`
                  : `${linkCopy[link.kind].issued} for ${link.email}`}
            </h2>
            <p className="text-sm text-text-secondary">
              {!link.setup_url
                ? "A recovery link is unavailable. Ask the administrator to correct the public origin before issuing another link."
                : link.mail?.status === "queued"
                  ? `The email provider accepted the message for sending. This does not confirm delivery. ${linkCopy[link.kind].queued}`
                  : link.mail?.status === "failed"
                    ? `Email was not queued. ${linkCopy[link.kind].detail}. Share this same link privately and check the email configuration. Do not ${linkCopy[link.kind].retry} to retry the email.`
                    : link.mail?.status === "not_configured"
                      ? `Email is not configured. Share this same link privately with the user. ${linkCopy[link.kind].detail}.`
                      : "Email acceptance could not be confirmed. It may already be queued. Do not generate a new link merely to resend; share this same link if needed."}
            </p>
          </div>
          {link.setup_url && (
            <details
              key={`${link.setup_url}:${link.kind}:${link.mail?.status}`}
              open={link.mail?.status !== "queued"}
            >
              <summary className="cursor-pointer rounded-md py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                {link.mail?.status === "queued"
                  ? linkCopy[link.kind].backup
                  : "Private fallback link"}
              </summary>
              <div className="space-y-3 pt-2">
                <p className="text-sm text-text-secondary">
                  Share this link privately. It expires{" "}
                  {parseUtcDate(link.expires_at).toLocaleString()} and works
                  once.
                </p>
                <label className="block text-sm text-text-secondary">
                  Single-use link
                  <input
                    readOnly
                    className="input-field mt-2"
                    value={link.setup_url}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    className="btn-primary"
                    onClick={async () => {
                      if (!link.setup_url) return;
                      try {
                        await navigator.clipboard.writeText(link.setup_url);
                        setCopyStatus("Link copied. Share it privately.");
                      } catch {
                        setCopyStatus(
                          "Clipboard unavailable. Select the link above and copy it manually.",
                        );
                      }
                    }}
                  >
                    Copy link
                  </button>
                </div>
                <p role="status" className="text-sm text-text-secondary">
                  {copyStatus}
                </p>
              </div>
            </details>
          )}
          <button className="btn-secondary" onClick={() => setLink(null)}>
            {link.setup_url ? "Dismiss link" : "Dismiss notice"}
          </button>
        </section>
      )}
      {preferencesUser && (
        <EmailPreferences
          key={`${me?.id}:${preferencesUser.id}`}
          target={
            rows.find((row) => row.id === preferencesUser.id) || preferencesUser
          }
          onClose={() => setPreferencesUser(null)}
        />
      )}
      {editor && (
        <UserEditor
          key={editor === "new" ? "new" : editor.id}
          user={editor === "new" ? null : editor}
          onCancel={() => setEditor(null)}
          onSave={(fields) => {
            const edited = editor;
            ask({
              title:
                edited === "new"
                  ? "Create user and send welcome email"
                  : "Save user changes",
              description:
                edited === "new"
                  ? `Create a ${fields.role} account for ${fields.email} and send a welcome email explaining how iTransfer works, with a single-use setup link. A private fallback link will also be available.`
                  : `Update ${edited.email}. Role or access changes may sign the user out.`,
              run: async () => {
                if (edited === "new") {
                  const result = await users.create(fields);
                  if (!result?.user || typeof result.user.id !== "string")
                    throw new Error(
                      "The server did not return a valid account. Refresh the user list before trying again.",
                    );
                  setRows((old) => [...old, result.user]);
                  showLink(result, fields.email, "welcome");
                } else {
                  const result = await users.update(edited.id, fields);
                  setRows((old) =>
                    old.map((row) => (row.id === result.id ? result : row)),
                  );
                  setNotice("User updated.");
                  if (edited.id === me?.id) await refreshUser();
                }
                setEditor(null);
              },
            });
          }}
        />
      )}
      <label className="block text-sm text-text-secondary max-w-md">
        Find a user
        <input
          type="search"
          className="input-field mt-2"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or email"
        />
      </label>
      {loading ? (
        <p role="status" className="text-text-secondary py-8">
          Loading users...
        </p>
      ) : !rows.length && !error ? (
        <p className="text-text-secondary py-8">
          No users found. Add a user to create a private workspace.
        </p>
      ) : !filtered.length && !error ? (
        <p className="text-text-secondary py-8">
          No users match your search. Try another name or email.
        </p>
      ) : (
        <div className="surface rounded-[1.25rem] divide-y divide-border">
          {filtered.map((row) => (
            <article
              key={row.id}
              className="p-4 sm:p-5 flex flex-col lg:flex-row gap-4 lg:items-center"
            >
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold break-words">
                  {row.name}{" "}
                  {row.id === me?.id && (
                    <span className="text-sm text-text-secondary">(you)</span>
                  )}
                </h2>
                <p className="text-sm text-text-secondary break-words">
                  {row.email}
                </p>
                <p className="text-xs text-text-secondary mt-2">
                  <span className="capitalize">
                    {row.role} / {row.status}
                  </span>{" "}
                  / Last sign in:{" "}
                  {row.last_login_at
                    ? parseUtcDate(row.last_login_at).toLocaleString()
                    : "Never"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-sm lg:max-w-xl">
                <button
                  className="btn-secondary"
                  onClick={() => {
                    view(row.id === me?.id ? null : row);
                    navigate("/dashboard");
                  }}
                >
                  {row.id === me?.id ? "My workspace" : "View workspace"}
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setEditor(row)}
                >
                  Edit
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setPreferencesUser(row)}
                >
                  Email preferences
                </button>
                {row.status === "pending" && (
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      ask({
                        title: "Send invitation reminder",
                        description: `Remind ${row.email} to finish setup. This replaces the previous setup link and emails a new single-use link valid for 24 hours. Invitation reminders must already be enabled in Email preferences; this action does not enable them.`,
                        run: async () =>
                          showLink(
                            await users.invitation(row.id),
                            row.email,
                            "invitation",
                          ),
                      })
                    }
                  >
                    Send invitation reminder
                  </button>
                )}
                <button
                  className="btn-secondary"
                  disabled={row.status === "disabled"}
                  title={
                    row.status === "disabled"
                      ? "Enable this account before creating a reset link"
                      : undefined
                  }
                  onClick={() =>
                    ask({
                      title: "Send password reset email",
                      description: `Generate a single-use password link for ${row.email} and send it by email. This signs the user out on every device and replaces any earlier setup or reset link. A private fallback link will also be available.${row.id === me?.id ? " Copy the backup link before leaving this page; your current session will also be revoked." : ""}`,
                      run: async () => {
                        showLink(
                          await users.resetPassword(row.id),
                          row.email,
                          "reset",
                        );
                      },
                    })
                  }
                >
                  Reset password
                </button>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    ask({
                      title: "Revoke sessions",
                      description: `Sign ${row.email} out on every device.${row.id === me?.id ? " This includes your current session." : ""}`,
                      run: async () => {
                        await users.revokeSessions(row.id);
                        if (row.id === me?.id)
                          clearSession(
                            "All your sessions were revoked. Please sign in again.",
                          );
                        else
                          setNotice(`All sessions revoked for ${row.email}.`);
                      },
                    })
                  }
                >
                  Revoke sessions
                </button>
                <button
                  className={
                    row.status === "disabled" ? "btn-secondary" : "btn-danger"
                  }
                  onClick={() =>
                    ask({
                      title:
                        row.status === "disabled"
                          ? "Enable account"
                          : "Disable account",
                      description:
                        row.status === "disabled"
                          ? `Restore access for ${row.email}.`
                          : `Block sign-in and revoke account sessions for ${row.email}. Their workspace files are retained, and existing public share and request links remain active. Disable those links separately if needed.`,
                      run: async () => {
                        const result = await users.update(row.id, {
                          status:
                            row.status === "disabled" ? "active" : "disabled",
                        });
                        setRows((old) =>
                          old.map((u) => (u.id === row.id ? result : u)),
                        );
                        setNotice(`Account ${result.status}.`);
                        if (row.id === me?.id) await refreshUser();
                      },
                    })
                  }
                >
                  {row.status === "disabled" ? "Enable" : "Disable"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {action && (
        <ConfirmPassword
          title={action.title}
          description={action.description}
          onCancel={() => setAction(null)}
          onConfirm={async () => {
            await action.run();
            setAction(null);
          }}
        />
      )}
    </div>
  );
}

function UserEditor({
  user,
  onCancel,
  onSave,
}: {
  user: User | null;
  onCancel: () => void;
  onSave: (fields: { name: string; email: string; role: User["role"] }) => void;
}) {
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [role, setRole] = useState<User["role"]>(user?.role || "user");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) onSave({ name: name.trim(), email: email.trim(), role });
  }
  return (
    <section className="surface rounded-[1.25rem] p-5">
      <h2 className="text-lg font-semibold mb-4">
        {user ? `Edit ${user.name}` : "Add user"}
      </h2>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="text-sm text-text-secondary">
            Name
            <input
              autoFocus
              required
              maxLength={100}
              className="input-field mt-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-sm text-text-secondary">
            Email
            <input
              type="email"
              autoComplete="off"
              required
              className="input-field mt-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </div>
        <label className="block text-sm text-text-secondary max-w-sm">
          Role
          <select
            className="input-field mt-2"
            value={role}
            onChange={(e) => setRole(e.target.value as User["role"])}
          >
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <p className="text-sm text-text-secondary">
          Administrators can manage accounts, view other workspaces, and see
          costs. Users only see their own workspace.
        </p>
        <div className="flex flex-wrap gap-3">
          <button className="btn-primary" disabled={!name.trim()}>
            {user ? "Review changes" : "Create user"}
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
