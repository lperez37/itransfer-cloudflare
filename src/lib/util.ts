/** Small shared helpers. */

export function utcNow(): string {
  return new Date().toISOString();
}

export function isoInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

export function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) < Date.now();
}

export function formatFileSize(sizeBytes: number | null | undefined): string {
  if (!sizeBytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}
