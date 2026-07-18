/** Shared upload-URL orchestration for shares, requests and the v1 API:
 * insert file rows, then hand out a presigned PUT (small files) or a
 * multipart upload id + presigned part URLs (large files). */

import type { Env } from "../types";
import { MULTIPART_THRESHOLD } from "../types";
import {
  buildObjectKey,
  calculateNumParts,
  createMultipartUpload,
  presignedPut,
  presignedUploadParts,
} from "./r2";
import { generateUuid } from "./ids";
import { utcNow } from "./util";

export interface FileInput {
  filename: string;
  content_type: string;
  size: number;
}

export interface FileUploadResponse {
  file_id: string;
  upload_url?: string;
  multipart?: {
    upload_id: string;
    parts: Array<{ part_number: number; upload_url: string }>;
  };
}

export async function prepareFileUploads(
  env: Env,
  prefix: "shares" | "requests",
  parentId: string,
  files: FileInput[]
): Promise<FileUploadResponse[]> {
  const now = utcNow();
  const insertStmt = env.DB.prepare(
    `INSERT INTO files (id, original_filename, r2_key, file_size, content_type, share_id, request_id, confirmed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );

  // Each file's presign work is independent, so fan them out concurrently
  // instead of awaiting one R2 round-trip at a time. Input order is preserved
  // so the returned responses and batched inserts stay aligned with `files`.
  const prepared = await Promise.all(
    files.map(async (file): Promise<{ insert: D1PreparedStatement; response: FileUploadResponse }> => {
      const fileId = generateUuid();
      const key = buildObjectKey(prefix, parentId, fileId, file.filename);
      const insert = insertStmt.bind(
        fileId,
        file.filename,
        key,
        file.size,
        file.content_type,
        prefix === "shares" ? parentId : null,
        prefix === "requests" ? parentId : null,
        now
      );

      if (file.size > MULTIPART_THRESHOLD) {
        const uploadId = await createMultipartUpload(env, key, file.content_type);
        const parts = await presignedUploadParts(env, key, uploadId, calculateNumParts(file.size));
        return { insert, response: { file_id: fileId, multipart: { upload_id: uploadId, parts } } };
      }
      return { insert, response: { file_id: fileId, upload_url: await presignedPut(env, key, file.size) } };
    })
  );

  await env.DB.batch(prepared.map((p) => p.insert));
  return prepared.map((p) => p.response);
}
