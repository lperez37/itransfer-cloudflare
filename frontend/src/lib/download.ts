import JSZip from "jszip";
import type { DownloadResponse } from "./api";

type DownloadFile = DownloadResponse["files"][number];

function sanitizeDownloadName(name: string, fallback: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || fallback;
}

function getUniqueZipFilename(filename: string, used: Set<string>): string {
  const cleaned = sanitizeDownloadName(filename, "file");
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }

  const dotIndex = cleaned.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && dotIndex < cleaned.length - 1;
  const basename = hasExtension ? cleaned.slice(0, dotIndex) : cleaned;
  const extension = hasExtension ? cleaned.slice(dotIndex) : "";
  let counter = 2;
  let candidate = `${basename} (${counter})${extension}`;

  while (used.has(candidate)) {
    counter += 1;
    candidate = `${basename} (${counter})${extension}`;
  }

  used.add(candidate);
  return candidate;
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadFilesAsZip(files: DownloadFile[], zipFilename: string): Promise<void> {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  const blobs = await Promise.all(
    files.map(async (file) => {
      const response = await fetch(file.download_url);
      if (!response.ok) {
        throw new Error(`Failed to download ${file.filename}`);
      }
      return response.blob();
    })
  );

  blobs.forEach((blob, index) => {
    const file = files[index];
    zip.file(getUniqueZipFilename(file.filename, usedNames), blob);
  });

  const zipBlob = await zip.generateAsync({ type: "blob" });
  triggerBlobDownload(zipBlob, zipFilename);
}

// Above this combined size we skip in-memory zipping (JSZip buffers every file
// in memory and generates the archive in memory too, so a multi-GB share would
// OOM the tab). Instead we fall back to triggering each file download directly.
const MAX_IN_MEMORY_ZIP_BYTES = 750 * 1024 * 1024; // ~750MB

async function downloadFilesIndividually(files: DownloadFile[]): Promise<void> {
  const usedNames = new Set<string>();
  for (const file of files) {
    // Sequential (not concurrent) so we don't spawn dozens of parallel
    // multi-hundred-MB streams at once.
    triggerDownload(file.download_url, getUniqueZipFilename(file.filename, usedNames));
    // Small gap so the browser registers each programmatic download.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export async function downloadFiles(
  files: DownloadFile[],
  archiveBaseName = "download"
): Promise<void> {
  if (files.length === 0) {
    throw new Error("No files available to download");
  }

  if (files.length === 1) {
    const [file] = files;
    triggerDownload(file.download_url, file.filename);
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_IN_MEMORY_ZIP_BYTES) {
    await downloadFilesIndividually(files);
    return;
  }

  const zipFilename = `${sanitizeDownloadName(archiveBaseName, "download")}.zip`;
  await downloadFilesAsZip(files, zipFilename);
}
