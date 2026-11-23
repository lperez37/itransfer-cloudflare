import { useState, useRef, useCallback, type ReactNode } from "react";
import { Upload, CloudUpload } from "lucide-react";

interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  /** Called with any files rejected for exceeding `maxFileSize`. */
  onRejected?: (rejected: File[]) => void;
  maxFileSize?: number;
  children?: ReactNode;
  disabled?: boolean;
  dropLabel?: string;
  dragLabel?: string;
  browseLabel?: string;
}

export default function FileDropzone({
  onFiles,
  onRejected,
  maxFileSize,
  children,
  disabled = false,
  dropLabel = "Drop files here",
  dragLabel = "Drag & drop files here",
  browseLabel = "or click to browse from your device",
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  // Size enforcement lives here only - the single filtering layer. Consumers
  // receive the accepted files via `onFiles` and any rejects via `onRejected`.
  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || disabled) return;
      const all = Array.from(fileList);
      if (maxFileSize) {
        const accepted = all.filter((f) => f.size <= maxFileSize);
        const rejected = all.filter((f) => f.size > maxFileSize);
        if (rejected.length > 0) onRejected?.(rejected);
        if (accepted.length > 0) onFiles(accepted);
      } else if (all.length > 0) {
        onFiles(all);
      }
    },
    [onFiles, onRejected, maxFileSize, disabled]
  );

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={children ? (e) => {
        if (e.target !== inputRef.current) openPicker();
      } : undefined}
      data-dragging={isDragging || undefined}
      className={`
        file-dropzone relative rounded-2xl border border-dashed bg-surface-light text-center transition-colors
        ${
          isDragging
            ? "border-primary"
            : "border-border-light hover:border-primary"
        }
        ${children ? "p-8" : ""}
        ${disabled ? "opacity-50" : ""}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled}
      />

      {children || (
        <button
          type="button"
          onClick={openPicker}
          disabled={disabled}
          className="flex w-full cursor-pointer flex-col items-center gap-2.5 rounded-2xl px-4 py-5 disabled:cursor-not-allowed sm:py-6"
        >
          <span className={`file-dropzone-icon grid size-11 place-items-center rounded-xl text-primary transition-colors ${isDragging ? "bg-primary/20" : "bg-primary/10"}`}>
            {isDragging ? (
              <CloudUpload className="size-5" aria-hidden="true" />
            ) : (
              <Upload className="size-5" aria-hidden="true" />
            )}
          </span>
          <span>
            <span className="block text-base font-semibold text-text-primary">
              {isDragging ? dropLabel : dragLabel}
            </span>
            <span className="mt-0.5 block text-sm text-text-secondary">
              {browseLabel}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
