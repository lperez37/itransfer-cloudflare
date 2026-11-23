import { parseUtcDate, type FileRequest, type Share } from "./api";

export const statusLabels = {
  active: "Active",
  uploading: "Uploading…",
  hidden: "Hidden",
  expired: "Expired",
  exhausted: "Exhausted",
  deleted: "Deleted",
} as const;

export type TransferStatus = keyof typeof statusLabels;

function deactivatedStatus(deactivatedAt?: string | null, expiresAt?: string | null) {
  // The expiry job records when it reclaimed the transfer. Earlier removal was manual.
  return deactivatedAt && expiresAt && parseUtcDate(deactivatedAt) >= parseUtcDate(expiresAt)
    ? "expired" : "deleted";
}

export function getShareStatus(share: Share): TransferStatus {
  if (!share.is_active && !share.confirmed_at) return "uploading";
  if (!share.is_active) return deactivatedStatus(share.deactivated_at, share.expires_at);
  if (share.expires_at && parseUtcDate(share.expires_at).getTime() < Date.now()) return "expired";
  if (share.is_paused) return "hidden";
  if (share.max_downloads != null && share.download_count >= share.max_downloads) return "exhausted";
  return "active";
}

export function getRequestStatus(req: FileRequest): TransferStatus {
  if (!req.is_active) return deactivatedStatus(req.deactivated_at, req.expires_at);
  if (req.expires_at && parseUtcDate(req.expires_at).getTime() < Date.now()) return "expired";
  if (req.max_uploads != null && req.upload_count >= req.max_uploads) return "exhausted";
  return "active";
}
