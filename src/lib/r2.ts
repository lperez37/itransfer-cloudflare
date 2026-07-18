/** R2 access via the S3-compatible API (presigned URLs + multipart control).
 *
 * File bytes never pass through the Worker: browsers PUT/GET directly against
 * presigned R2 URLs, so Workers request-body limits do not apply. Server-side
 * object operations (head/delete) use the native R2 binding instead.
 */

import { AwsClient } from "aws4fetch";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { MULTIPART_PART_SIZE, UPLOAD_URL_EXPIRY, DOWNLOAD_URL_EXPIRY } from "../types";

function s3Client(env: Env): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID) {
    throw new HTTPException(503, {
      message:
        "R2 credentials not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID secrets.",
    });
  }
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function objectUrl(env: Env, key: string): URL {
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodeKey(key)}`
  );
}

async function presign(
  env: Env,
  url: URL,
  method: string,
  expiresIn: number,
  signedHeaders?: Record<string, string>
): Promise<string> {
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  // Pass the URL as a string (not a Request) so aws4fetch builds an unguarded
  // Headers object: a Request would silently drop forbidden headers such as
  // Content-Length, which must be included in the signature to be enforced.
  const signed = await s3Client(env).sign(url.toString(), {
    method,
    headers: signedHeaders,
    aws: { signQuery: true },
  });
  return signed.url;
}

/** ASCII-only Content-Disposition value with an RFC 5987 filename* extension so
 * non-ASCII filenames survive the round trip while ASCII clients still get a
 * sane fallback. */
function contentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Presigned PUT for direct browser upload. Content-Type is deliberately not
 * signed so clients are free to send any (or no) Content-Type header. When
 * `maxSize` is provided the exact Content-Length is folded into the signature,
 * so R2 rejects any upload whose byte count differs from the declared size -
 * the storage-layer guard against oversize objects. */
export function presignedPut(
  env: Env,
  key: string,
  maxSize?: number,
  expiresIn = UPLOAD_URL_EXPIRY
): Promise<string> {
  const headers =
    maxSize !== undefined && Number.isFinite(maxSize)
      ? { "content-length": String(Math.floor(maxSize)) }
      : undefined;
  return presign(env, objectUrl(env, key), "PUT", expiresIn, headers);
}

/** Presigned GET for direct browser download, forcing attachment disposition. */
export function presignedGet(
  env: Env,
  key: string,
  filename: string,
  expiresIn = DOWNLOAD_URL_EXPIRY
): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set("response-content-disposition", contentDisposition(filename));
  return presign(env, url, "GET", expiresIn);
}

/** Start a multipart upload and return the upload id. */
export async function createMultipartUpload(
  env: Env,
  key: string,
  contentType: string
): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set("uploads", "");
  const res = await s3Client(env).fetch(url.toString(), {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : undefined,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new HTTPException(502, { message: `R2 create multipart failed (${res.status})` });
  }
  const match = body.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!match?.[1]) {
    throw new HTTPException(502, { message: "R2 create multipart returned no upload id" });
  }
  return match[1];
}

/** Presigned URLs for every part of a multipart upload. */
export async function presignedUploadParts(
  env: Env,
  key: string,
  uploadId: string,
  numParts: number,
  expiresIn = UPLOAD_URL_EXPIRY
): Promise<Array<{ part_number: number; upload_url: string }>> {
  // Each part signs independently, so presign them concurrently rather than
  // serially - meaningful for large files with many parts.
  return Promise.all(
    Array.from({ length: numParts }, async (_unused, i) => {
      const partNumber = i + 1;
      const url = objectUrl(env, key);
      url.searchParams.set("partNumber", String(partNumber));
      url.searchParams.set("uploadId", uploadId);
      return { part_number: partNumber, upload_url: await presign(env, url, "PUT", expiresIn) };
    })
  );
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Complete a multipart upload from the ETags collected by the browser. */
export async function completeMultipartUpload(
  env: Env,
  key: string,
  uploadId: string,
  parts: Array<{ part_number: number; etag: string }>
): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.part_number - b.part_number);
  const body =
    "<CompleteMultipartUpload>" +
    sorted
      .map(
        (p) =>
          `<Part><PartNumber>${p.part_number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`
      )
      .join("") +
    "</CompleteMultipartUpload>";
  const url = objectUrl(env, key);
  url.searchParams.set("uploadId", uploadId);
  const res = await s3Client(env).fetch(url.toString(), { method: "POST", body });
  const text = await res.text();
  // S3-style APIs can return 200 with an <Error> body for this operation.
  if (!res.ok || text.includes("<Error>")) {
    throw new HTTPException(502, { message: `R2 complete multipart failed (${res.status})` });
  }
}

/** Number of parts for a multipart upload at MULTIPART_PART_SIZE. */
export function calculateNumParts(fileSize: number): number {
  return Math.max(1, Math.ceil(fileSize / MULTIPART_PART_SIZE));
}

/** Object size via the native R2 binding, or null if it does not exist. */
export async function getObjectSize(env: Env, key: string): Promise<number | null> {
  const head = await env.BUCKET.head(key);
  return head ? head.size : null;
}

/** Delete objects via the native R2 binding (batches of 1000). */
export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000));
  }
}

/** Standard object key: {shares|requests}/{parent_id}/{file_id}/{filename} */
export function buildObjectKey(
  prefix: "shares" | "requests",
  parentId: string,
  fileId: string,
  filename: string
): string {
  return `${prefix}/${parentId}/${fileId}/${filename}`;
}
