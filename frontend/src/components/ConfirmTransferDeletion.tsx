import { useEffect, useId, useRef } from "react";
import { Loader2 } from "lucide-react";

export default function ConfirmTransferDeletion({
  title,
  description,
  progress,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  progress: { completed: number; total: number } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!progress) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md surface rounded-xl p-6 text-text-primary backdrop:bg-background/75"
    >
      <h2 id={titleId} className="text-xl font-semibold">{title}</h2>
      <p id={descriptionId} className="mt-2 mb-5 break-words text-sm text-text-secondary">{description}</p>
      {progress && progress.total > 1 && (
        <progress
          className="mb-4 w-full accent-primary"
          value={progress.completed}
          max={progress.total}
          aria-label="Permanent deletion progress"
        />
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" autoFocus disabled={!!progress} onClick={onCancel} className="btn-secondary text-sm">
          Cancel
        </button>
        <button type="button" disabled={!!progress} onClick={onConfirm} className="btn-danger flex items-center gap-2 text-sm">
          {progress && <Loader2 className="size-4 animate-spin" />}
          {progress ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </dialog>
  );
}
