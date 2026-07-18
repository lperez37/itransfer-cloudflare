const BASE = "/api";

/** Parse a datetime string as UTC. Appends "Z" if no timezone info is present. */
export function parseUtcDate(dateStr: string): Date {
  if (!/[Z+-]\d{0,4}$/.test(dateStr)) {
    return new Date(dateStr + "Z");
  }
  return new Date(dateStr);
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    const msg =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join("; ")
          : body.message || res.statusText;
    throw new ApiError(res.status, msg);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* ---------- Auth ---------- */

export interface User {
  email: string;
}

export const auth = {
  login: (email: string, password: string) =>
    request<User>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<User>("/auth/me"),
};

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

export const shares = {
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
};

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

export const requests = {
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
};

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
