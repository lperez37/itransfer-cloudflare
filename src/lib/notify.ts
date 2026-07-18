/** ntfy.sh-compatible push notifications, fired via ctx.waitUntil so they
 * never block or fail a request. */

import type { Context } from "hono";
import type { AppEnv } from "../types";

async function post(
  ntfyUrl: string,
  title: string,
  message: string,
  tags: string
): Promise<void> {
  try {
    const res = await fetch(ntfyUrl, {
      method: "POST",
      body: message,
      headers: { Title: title, Priority: "default", Tags: tags },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`Notification failed (${res.status}): ${title}`);
    }
  } catch (err) {
    console.warn(`Notification error: ${title}`, err);
  }
}

/** Fire-and-forget notification; no-op when NTFY_URL is not configured. */
export function sendNotification(
  c: Context<AppEnv>,
  title: string,
  message: string,
  tags = ""
): void {
  const url = c.env.NTFY_URL;
  if (!url) return;
  c.executionCtx.waitUntil(post(url, title, message, tags));
}

/** Cloudflare request metadata suffix used in notification bodies. */
export function requestMetaSuffix(c: Context<AppEnv>, includeDevice = true): string {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const country = c.req.header("CF-IPCountry") ?? "unknown";
  const ua = c.req.header("User-Agent") ?? "";
  let suffix = `\nIP: ${ip} (${country})`;
  if (includeDevice) {
    const device = c.req.header("CF-Device-Type") ?? "unknown";
    suffix += `\nDevice: ${device}\nUA: ${ua.slice(0, 60)}`;
  }
  return suffix;
}
