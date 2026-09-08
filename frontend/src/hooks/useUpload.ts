import { useState, useCallback, useRef } from "react";

export interface FileProgress {
  loaded: number;
  total: number;
  status: "pending" | "uploading" | "done" | "error";
}

interface FileConfig {
  file_id: string;
  file: File;
  upload_url?: string;
  multipart?: {
    upload_id: string;
    parts: Array<{ part_number: number; upload_url: string }>;
  };
}

interface CompleteMultipartFn {
  (
    id: string,
    body: {
      file_id: string;
      upload_id: string;
      parts: Array<{ part_number: number; etag: string }>;
    }
  ): Promise<void>;
}

const PART_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Thrown for failures that will never succeed on retry (e.g. storage CORS not
// exposing the ETag header). The retry wrapper rethrows these immediately
// instead of re-uploading the part.
class NonRetryableUploadError extends Error {}

export function useUpload() {
  const [progress, setProgress] = useState<Map<string, FileProgress>>(
    new Map()
  );
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const completedFiles = useRef(new WeakMap<FileConfig, string>());
  const uploadedParts = useRef(new Map<string, Array<{ part_number: number; etag: string }>>());

  // SEAM CONTRACT: the `progress` Map is keyed by the server `file_id`
  // (FileConfig.file_id), never the array index. All seeding/updates below use
  // fileId so consumers can look up progress by the id the server assigned.
  const updateProgress = useCallback(
    (fileId: string, update: Partial<FileProgress>) => {
      setProgress((prev) => {
        const next = new Map(prev);
        const current = next.get(fileId) || {
          loaded: 0,
          total: 0,
          status: "pending" as const,
        };
        next.set(fileId, { ...current, ...update });
        return next;
      });
    },
    []
  );

  const uploadSmallFile = useCallback(
    (fileId: string, file: File, url: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

        // Named handler + cleanup so the shared AbortSignal doesn't retain a
        // listener (and the aborted xhr) after the request settles.
        const onAbortSignal = () => xhr.abort();
        const cleanup = () => {
          abortRef.current?.signal.removeEventListener("abort", onAbortSignal);
        };

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            updateProgress(fileId, {
              loaded: e.loaded,
              total: e.total,
              status: "uploading",
            });
          }
        };

        xhr.onload = () => {
          cleanup();
          if (xhr.status >= 200 && xhr.status < 300) {
            updateProgress(fileId, { loaded: file.size, total: file.size, status: "done" });
            resolve();
          } else {
            updateProgress(fileId, { status: "error" });
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          cleanup();
          updateProgress(fileId, { status: "error" });
          reject(new Error("Network error during upload"));
        };

        // xhr.abort() fires 'abort', not 'error'/'load' - settle the promise so
        // cancelling an upload doesn't hang forever.
        xhr.onabort = () => {
          cleanup();
          updateProgress(fileId, { status: "error" });
          reject(new DOMException("Aborted", "AbortError"));
        };

        abortRef.current?.signal.addEventListener("abort", onAbortSignal, { once: true });
        xhr.send(file);
      });
    },
    [updateProgress]
  );

  const uploadPartOnce = useCallback(
    (
      url: string,
      blob: Blob,
      onProgress?: (loaded: number) => void
    ): Promise<string> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);

        // Named handler + cleanup so each part doesn't leak a listener (and the
        // aborted xhr) on the shared AbortSignal after it settles.
        const onAbortSignal = () => xhr.abort();
        const cleanup = () => {
          abortRef.current?.signal.removeEventListener("abort", onAbortSignal);
        };

        if (onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded);
          };
        }

        xhr.onload = () => {
          cleanup();
          if (xhr.status >= 200 && xhr.status < 300) {
            const etag = xhr.getResponseHeader("ETag");
            // A missing/empty ETag means R2 CORS isn't exposing the header.
            // An empty-string fallback would silently corrupt the completion
            // payload after uploading every part, so fail fast on this part.
            if (!etag) {
              reject(
                new NonRetryableUploadError(
                  "ETag not exposed by storage CORS config"
                )
              );
              return;
            }
            resolve(etag);
          } else {
            reject(new Error(`Part upload failed: ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          cleanup();
          reject(new Error("Network error"));
        };

        // xhr.abort() fires 'abort', not 'error'/'load' - settle the promise so
        // cancelling an upload doesn't hang forever.
        xhr.onabort = () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        };

        abortRef.current?.signal.addEventListener("abort", onAbortSignal, { once: true });
        xhr.send(blob);
      });
    },
    []
  );

  const uploadPartWithRetry = useCallback(
    async (
      url: string,
      blob: Blob,
      onProgress?: (loaded: number) => void
    ): Promise<string> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          return await uploadPartOnce(url, blob, onProgress);
        } catch (err) {
          // Permanent failures (e.g. missing ETag) won't succeed on retry.
          if (err instanceof NonRetryableUploadError) throw err;
          if (attempt === MAX_RETRIES) throw err;
          if (abortRef.current?.signal.aborted) throw err;
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw new Error("Unreachable");
    },
    [uploadPartOnce]
  );

  const uploadMultipartFile = useCallback(
    async (
      resourceId: string,
      fileId: string,
      file: File,
      multipart: { upload_id: string; parts: Array<{ part_number: number; upload_url: string }> },
      completeFn: CompleteMultipartFn
    ): Promise<void> => {
      const cacheKey = JSON.stringify([resourceId, fileId, multipart.upload_id]);
      const cachedParts = uploadedParts.current.get(cacheKey);
      const completedParts: Array<{ part_number: number; etag: string }> = cachedParts || [];
      const totalParts = multipart.parts.length;

      updateProgress(fileId, { loaded: cachedParts ? file.size : 0, total: file.size, status: "uploading" });

      // Upload parts with concurrency limit
      const queue = cachedParts ? [] : [...multipart.parts];
      const workers: Promise<void>[] = [];

      // Track bytes uploaded per part (including in-flight parts) so the bar
      // advances within a 50MB part instead of freezing between parts.
      const partLoaded = new Map<number, number>();
      const emitProgress = () => {
        let loaded = 0;
        for (const value of partLoaded.values()) loaded += value;
        updateProgress(fileId, { loaded, total: file.size, status: "uploading" });
      };

      const processQueue = async () => {
        while (queue.length > 0) {
          if (abortRef.current?.signal.aborted) return;
          const part = queue.shift()!;
          const start = (part.part_number - 1) * PART_SIZE;
          const end = Math.min(start + PART_SIZE, file.size);
          const blob = file.slice(start, end);

          try {
            const etag = await uploadPartWithRetry(
              part.upload_url,
              blob,
              (loaded) => {
                partLoaded.set(part.part_number, loaded);
                emitProgress();
              }
            );
            completedParts.push({ part_number: part.part_number, etag });
            partLoaded.set(part.part_number, blob.size);
            emitProgress();
          } catch (err) {
            // This part exhausted its retries (or hit a permanent error).
            // Abort the shared controller so sibling workers stop pushing
            // parts, then surface the error.
            abortRef.current?.abort();
            throw err;
          }
        }
      };

      for (let i = 0; i < Math.min(MAX_CONCURRENT, totalParts); i++) {
        workers.push(processQueue());
      }

      await Promise.all(workers);
      if (abortRef.current?.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");

      // Complete multipart
      completedParts.sort((a, b) => a.part_number - b.part_number);
      // Keep uploaded ETags when confirmation is cancelled or completion fails.
      // A retry of the same initialized upload only repeats its API completion.
      uploadedParts.current.set(cacheKey, completedParts);
      await completeFn(resourceId, {
        file_id: fileId,
        upload_id: multipart.upload_id,
        parts: completedParts,
      });
      uploadedParts.current.delete(cacheKey);

      updateProgress(fileId, { loaded: file.size, total: file.size, status: "done" });
    },
    [updateProgress, uploadPartWithRetry]
  );

  const uploadFiles = useCallback(
    async (
      resourceId: string,
      fileConfigs: FileConfig[],
      completeFn: CompleteMultipartFn
    ) => {
      setIsUploading(true);
      setError(null);
      abortRef.current = new AbortController();

      // Initialize progress
      const initial = new Map<string, FileProgress>();
      fileConfigs.forEach((fc) => {
        initial.set(fc.file_id, {
          loaded: 0,
          total: fc.file.size,
          status: "pending",
        });
      });
      setProgress(initial);

      try {
        for (const fc of fileConfigs) {
          if (abortRef.current.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
          if (completedFiles.current.get(fc) === resourceId) {
            updateProgress(fc.file_id, { loaded: fc.file.size, total: fc.file.size, status: "done" });
            continue;
          }

          if (fc.multipart) {
            await uploadMultipartFile(
              resourceId,
              fc.file_id,
              fc.file,
              fc.multipart,
              completeFn
            );
          } else if (fc.upload_url) {
            await uploadSmallFile(fc.file_id, fc.file, fc.upload_url);
          }
          completedFiles.current.set(fc, resourceId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        setError(msg);
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    [uploadMultipartFile, uploadSmallFile, updateProgress]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsUploading(false);
  }, []);

  return { uploadFiles, progress, isUploading, error, cancel };
}
