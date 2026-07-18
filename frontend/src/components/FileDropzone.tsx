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

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        relative cursor-pointer rounded-lg border-2 border-dashed p-8 transition-all duration-200 text-center
        ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border-light hover:border-primary/40 hover:bg-surface/50"
        }
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
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
        <div className="flex flex-col items-center gap-4 py-6">
          <div
            className={`
              w-14 h-14 rounded-lg flex items-center justify-center transition-all duration-200
              ${isDragging ? "bg-primary/15 scale-105" : "bg-surface-light"}
            `}
          >
            {isDragging ? (
              <CloudUpload className="w-7 h-7 text-primary-light" />
            ) : (
              <Upload className="w-7 h-7 text-text-muted" />
            )}
          </div>
          <div>
            <p className="text-base font-semibold text-text-primary">
              {isDragging ? dropLabel : dragLabel}
            </p>
            <p className="text-sm text-text-muted mt-1">
              {browseLabel}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
