import { derivePasswordProof, validateNewPassword, validatePasswordChallenge } from "./credentials";

const BASE = "/api";

let authIdentity: Readonly<{ userId: string | null; epoch: number }> = { userId: null, epoch: 0 };
export const getAuthIdentity = () => authIdentity;
export function setAuthIdentity(userId: string | null, force = false) {
  if (force || userId !== authIdentity.userId) authIdentity = { userId, epoch: authIdentity.epoch + 1 };
}

function assertIdentity(snapshot: typeof authIdentity) {
  if (snapshot !== authIdentity) throw new ApiError(401, "Your account changed. Sign in again before continuing.", "IDENTITY_CHANGED");
}

/** Parse a datetime string as UTC. Appends "Z" if no timezone info is present. */
export function parseUtcDate(dateStr: string): Date {
  if (!/[Z+-]\d{0,4}$/.test(dateStr)) {
    return new Date(dateStr + "Z");
  }
  return new Date(dateStr);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  actor = getAuthIdentity(),
): Promise<T> {
  const privateRequest = !path.startsWith("/public/") && !["/auth/login", "/auth/setup-password", "/auth/password-challenge", "/auth/me"].includes(path);
  const identityBound = !path.startsWith("/public/");
  if (identityBound) assertIdentity(actor);
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (privateRequest) {
    if (!actor.userId) throw new ApiError(401, "Sign in before continuing.");
    headers.set("X-Expected-User", actor.userId);
    if (/^\/(shares|requests)(\/|$)/.test(path) && !headers.has("X-Workspace-User")) headers.set("X-Workspace-User", actor.userId);
  } else headers.delete("X-Expected-User");
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...options,
    headers,
  });
  if (identityBound) assertIdentity(actor);
  const body = res.status === 204 ? undefined : res.ok ? await res.json() : await res.json().catch(() => ({}));
  // Check again after body decoding; an authorized old response must never be
  // delivered to a composer or screen after a local identity invalidation.
  if (identityBound) assertIdentity(actor);

  if (!res.ok) {
    const identityMismatch = res.status === 401 && res.headers.get("X-Identity-Mismatch") === "1";
    if (res.status === 401 && privateRequest) {
      // These endpoints also use 401 for an incorrect password. Only expire
      // the local session if the identity check confirms it is gone.
      if (identityMismatch) window.dispatchEvent(new Event("identity-mismatch"));
      else if (path === "/auth/reauth" || path === "/auth/password") {
        try {
          const current = await request<User>("/auth/me", {}, actor);
          if (current.id !== actor.userId) window.dispatchEvent(new Event("identity-mismatch"));
        } catch (error) {
          assertIdentity(actor);
          if (error instanceof ApiError && error.status === 401) window.dispatchEvent(new Event("session-expired"));
        }
      } else window.dispatchEvent(new Event("session-expired"));
    }
    const detail = body.detail;
    const msg =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join("; ")
          : body.message || res.statusText;
    throw new ApiError(res.status, msg, identityMismatch ? "IDENTITY_MISMATCH" : res.status === 403 && res.headers.get("X-Reauth-Required") === "1" ? "REAUTH_REQUIRED" : undefined);
  }

  if (res.status === 204) return undefined as T;
  return body;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: "REAUTH_REQUIRED" | "IDENTITY_CHANGED" | "IDENTITY_MISMATCH",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* ---------- Auth ---------- */

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
  password_change_required?: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

async function passwordChallenge(body: { email: string } | { token: string }, actor: ReturnType<typeof getAuthIdentity>, signal?: AbortSignal) {
  const result = await request<unknown>("/auth/password-challenge", { method: "POST", signal, body: JSON.stringify(body) }, actor);
  assertIdentity(actor);
  return validatePasswordChallenge(result);
}

async function actorPasswordChallenge(actor: ReturnType<typeof getAuthIdentity>, signal?: AbortSignal) {
  if (!actor.userId) throw new ApiError(401, "Sign in before continuing.");
  const current = await request<User>("/auth/me", { signal }, actor);
  assertIdentity(actor);
  if (current.id !== actor.userId) {
    window.dispatchEvent(new Event("identity-mismatch"));
    throw new ApiError(401, "Your signed-in account changed. Sign in again.", "IDENTITY_MISMATCH");
  }
  return passwordChallenge({ email: current.email }, actor, signal);
}

export const auth = {
  login: async (email: string, password: string) => {
    const actor = getAuthIdentity();
    const challenge = await passwordChallenge({ email }, actor);
    assertIdentity(actor);
    const proof = await derivePasswordProof(password, challenge);
    assertIdentity(actor);
    return request<User>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, proof, ...(challenge.bootstrap === true ? { bootstrap_password: password } : {}) }),
    }, actor);
  },
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: (signal?: AbortSignal) => request<User>("/auth/me", { signal }),
  reauth: async (password: string, signal?: AbortSignal) => {
    const actor = getAuthIdentity();
    const challenge = await actorPasswordChallenge(actor, signal);
    assertIdentity(actor);
    const proof = await derivePasswordProof(password, challenge, signal);
    assertIdentity(actor);
    return request<{ detail: string }>("/auth/reauth", { method: "POST", signal, body: JSON.stringify({ proof }) }, actor);
  },
  password: async (current_password: string, new_password: string) => {
    const actor = getAuthIdentity();
    validateNewPassword(new_password);
    const challenge = await actorPasswordChallenge(actor);
    assertIdentity(actor);
    const current_proof = await derivePasswordProof(current_password, challenge);
    assertIdentity(actor);
    const new_proof = await derivePasswordProof(new_password, challenge);
    assertIdentity(actor);
    return request<{ detail: string }>("/auth/password", { method: "POST", body: JSON.stringify({ current_proof, new_proof }) }, actor);
  },
  setupPassword: async (token: string, password: string) => {
    const actor = getAuthIdentity();
    validateNewPassword(password);
    const challenge = await passwordChallenge({ token }, actor);
    assertIdentity(actor);
    const proof = await derivePasswordProof(password, challenge);
    assertIdentity(actor);
    return request<{ detail: string }>("/auth/setup-password", { method: "POST", body: JSON.stringify({ token, proof }) }, actor);
  },
};

export interface SetupLink {
  setup_url: string | null;
  expires_at: string;
  mail?: {
    status: "queued" | "failed" | "unknown" | "not_configured";
    message_id?: string;
    error_code?: string;
  };
}

export interface EmailPreferences {
  share_downloads: boolean;
  request_uploads: boolean;
  password_changed: boolean;
  expiry_alerts: boolean;
  invitation_reminders: boolean;
  welcome: true;
  password_reset: true;
}
export const EMAIL_PREFERENCE_KEYS = ["share_downloads", "request_uploads", "password_changed", "expiry_alerts", "invitation_reminders"] as const;
export type EmailPreferenceChanges = Partial<Pick<EmailPreferences, typeof EMAIL_PREFERENCE_KEYS[number]>>;

export function createEmailPreferencesClient(targetId?: string) {
  const actor = getAuthIdentity();
  const path = targetId ? `/users/${targetId}/email-preferences` : "/auth/email-preferences";
  return {
    get: (signal?: AbortSignal) => request<EmailPreferences>(path, { signal }, actor),
    update: (changes: EmailPreferenceChanges) => {
      const body: EmailPreferenceChanges = {};
      for (const key of EMAIL_PREFERENCE_KEYS) {
        if (typeof changes[key] === "boolean") body[key] = changes[key];
      }
      return request<EmailPreferences>(path, { method: "PATCH", body: JSON.stringify(body) }, actor);
    },
  };
}
export const users = {
  list: () => request<{ users: User[] }>("/users"),
  create: (body: { name: string; email: string; role: User["role"] }) => request<SetupLink & { user: User }>("/users", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: { name?: string; email?: string; role?: User["role"]; status?: "active" | "disabled" }) => request<User>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  resetPassword: (id: string) => request<SetupLink>(`/users/${id}/reset-password`, { method: "POST" }),
  invitation: (id: string) => request<SetupLink>(`/users/${id}/invitation`, { method: "POST" }),
  revokeSessions: (id: string) => request<{ detail: string }>(`/users/${id}/revoke-sessions`, { method: "POST" }),
};

export function createWorkspaceClient(userId?: string, manage = false, reauthorize?: () => Promise<void>) {
  const actor = getAuthIdentity();
  const viewingOther = !!userId && userId !== actor.userId;
  const scopedRequest: typeof request = async (path, options = {}) => {
    assertIdentity(actor);
    const headers = new Headers(options.headers);
    const mutation = !!options.method && options.method !== "GET" && !path.endsWith("/download");
    if (userId || actor.userId) headers.set("X-Workspace-User", (userId || actor.userId)!);
    if (viewingOther) {
      if (manage) headers.set("X-Workspace-Mode", "manage");
      if (!manage && mutation) return Promise.reject(new ApiError(403, "This workspace is read-only. Enable management to make changes."));
    }
    // Scoped endpoints have already serialized their bodies to immutable JSON
    // strings. Keep these headers and that body, never the current UI workspace.
    const snapshot = { ...options, headers };
    try {
      return await request(path, snapshot, actor);
    } catch (error) {
      if (!viewingOther || !manage || !mutation || !reauthorize || !(error instanceof ApiError) || error.code !== "REAUTH_REQUIRED") throw error;
      await reauthorize();
      // A marked 403 is guaranteed to precede side effects. Retry only once;
      // another rejection must reach the caller, not open an infinite prompt.
      return request(path, snapshot, actor);
    }
  };
  return { shares: createShares(scopedRequest), requests: createRequests(scopedRequest) };
}

/* ---------- Shares ---------- */

export interface FileInit {
  filename: string;
  content_type: string;
  size: number;
}

export interface ShareInitResponse {
  share_id: string;
  files: Array<{
    file_id: string;
    upload_url?: string;
    multipart?: {
      upload_id: string;
      parts: Array<{ part_number: number; upload_url: string }>;
    };
  }>;
}

export interface Share {
  id: string;
  title?: string;
  id_format: string;
  file_count: number;
  total_size: number;
  download_count: number;
  max_downloads?: number;
  expires_at: string;
  created_at: string;
  is_active: boolean;
  is_paused?: boolean;
  confirmed_at?: string | null;
  deactivated_at?: string | null;
  created_by?: string;
}

export interface ShareFileInfo {
  id: string;
  original_filename: string;
  file_size: number | null;
  content_type: string | null;
  created_at: string;
}

export interface DownloadLogEntry {
  file_id: string;
  original_filename: string | null;
  downloaded_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface ShareDetail extends Share {
  files: ShareFileInfo[];
  downloads: DownloadLogEntry[];
}

type ApiRequest = typeof request;
const createShares = (request: ApiRequest) => ({
  init: (body: {
    files: FileInit[];
    expiry_days?: number;
    max_downloads?: number;
    password?: string;
    title?: string;
    id_format?: "animals" | "random";
    id_length?: number;
  }) =>
    request<ShareInitResponse>("/shares/init", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  completeMultipart: (
    shareId: string,
    body: {
      file_id: string;
      upload_id: string;
      parts: Array<{ part_number: number; etag: string }>;
    }
  ) =>
    request<void>(`/shares/${shareId}/complete-multipart`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirm: (shareId: string) =>
    request<void>(`/shares/${shareId}/confirm`, { method: "POST" }),
  list: () => request<Share[]>("/shares"),
  get: (id: string) => request<ShareDetail>(`/shares/${id}`),
  extend: (id: string, expiryDays: number) =>
    request<{ detail: string; expires_at: string }>(`/shares/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ expiry_days: expiryDays }),
    }),
  setPaused: (id: string, paused: boolean) =>
    request<{ detail: string; is_paused: boolean }>(`/shares/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_paused: paused }),
    }),
  delete: (id: string) => request<void>(`/shares/${id}`, { method: "DELETE" }),
  purge: (id: string) => request<void>(`/shares/${id}/purge`, { method: "DELETE" }),
  download: (id: string) =>
    request<DownloadResponse>(`/shares/${id}/download`, { method: "POST" }),
  downloadFile: (shareId: string, fileId: string) =>
    request<DownloadResponse>(`/shares/${shareId}/files/${fileId}/download`, {
      method: "POST",
    }),
});

/* ---------- Requests ---------- */

export interface FileRequest {
  id: string;
  title: string;
  message?: string;
  id_format: string;
  allow_incremental?: boolean;
  file_count?: number;
  upload_count: number;
  max_uploads?: number;
  max_file_size?: number;
  expires_at: string;
  created_at: string;
  is_active: boolean;
  deactivated_at?: string | null;
  created_by?: string;
}

export interface RequestCreateResponse {
  request_id: string;
}

const createRequests = (request: ApiRequest) => ({
  create: (body: {
    title: string;
    message?: string;
    expiry_days?: number;
    max_uploads?: number;
    max_file_size?: number;
    allow_incremental?: boolean;
    password?: string;
    id_format?: "animals" | "random";
    id_length?: number;
  }) =>
    request<RequestCreateResponse>("/requests", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  list: () => request<FileRequest[]>("/requests"),
  get: (id: string) => request<FileRequest>(`/requests/${id}`),
  extend: (id: string, expiryDays: number) =>
    request<{ detail: string; expires_at: string }>(`/requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ expiry_days: expiryDays }),
    }),
  delete: (id: string) =>
    request<void>(`/requests/${id}`, { method: "DELETE" }),
  purge: (id: string) =>
    request<void>(`/requests/${id}/purge`, { method: "DELETE" }),
  download: (id: string) =>
    request<DownloadResponse>(`/requests/${id}/download`, { method: "POST" }),
});

export const shares = createShares(request);
export const requests = createRequests(request);

/* ---------- Public ---------- */

export interface PublicShare {
  id: string;
  title?: string;
  file_count: number;
  files: Array<{ id: string; original_filename: string; file_size: number; content_type: string; created_at: string }>;
  password_required: boolean;
  expires_at: string;
  downloads_remaining?: number;
}

export interface DownloadResponse {
  files: Array<{ filename: string; size: number; download_url: string }>;
}

export interface PublicRequest {
  title: string;
  message?: string;
  allow_incremental?: boolean;
  password_required?: boolean;
  remaining_uploads?: number;
  max_file_size?: number;
  expires_at?: string;
  files?: Array<{ id: string; original_filename: string; file_size: number; content_type: string; created_at: string }>;
}

export interface PublicUploadResponse {
  files: Array<{
    file_id: string;
    upload_url?: string;
    multipart?: {
      upload_id: string;
      parts: Array<{ part_number: number; upload_url: string }>;
    };
  }>;
}

export interface UnlockResponse {
  files: Array<{ id: string; original_filename: string; file_size: number; content_type: string; created_at: string }>;
}

export const publicApi = {
  getShare: (id: string) => request<PublicShare>(`/public/shares/${id}`),
  unlockShare: (id: string, password: string) =>
    request<UnlockResponse>(`/public/shares/${id}/unlock`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  download: (id: string, password?: string) =>
    request<DownloadResponse>(`/public/shares/${id}/download`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  getRequest: (id: string) => request<PublicRequest>(`/public/requests/${id}`),
  uploadToRequest: (
    id: string,
    files: FileInit[],
    message?: string,
    password?: string
  ) =>
    request<PublicUploadResponse>(`/public/requests/${id}/upload`, {
      method: "POST",
      body: JSON.stringify({ files, message, password }),
    }),
  completeMultipart: (
    requestId: string,
    body: {
      file_id: string;
      upload_id: string;
      parts: Array<{ part_number: number; etag: string }>;
    }
  ) =>
    request<void>(`/public/requests/${requestId}/complete-multipart`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirmUpload: (requestId: string, fileIds: string[], message?: string) =>
    request<void>(`/public/requests/${requestId}/confirm`, {
      method: "POST",
      body: JSON.stringify({ file_ids: fileIds, message }),
    }),
};

/* ---------- Cost ---------- */

export interface CostEstimate {
  users?: Array<{ user_id: string; name: string; email: string; total_storage_bytes: number; total_files: number; class_a_ops_month: number; class_b_ops_month: number; gross_monthly_cost_usd: number }>;
  estimate_note?: string;
  total_storage_bytes: number;
  total_files: number;
  estimated_monthly_cost_usd: number;
  breakdown: {
    storage: number;
    requests_put: number;
    requests_get: number;
    transfer: number;
  };
  active_shares: number;
  active_requests: number;
  total_downloads: number;
  window_days?: number;
  class_a_ops_month?: number;
  class_b_ops_month?: number;
  gross_monthly_cost_usd?: number;
  free_tier_savings_usd?: number;
}

export const cost = {
  estimate: () => request<CostEstimate>("/cost/estimate"),
};
