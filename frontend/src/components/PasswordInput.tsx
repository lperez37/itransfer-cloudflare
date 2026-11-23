import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Eye, EyeOff } from "lucide-react";

type Props = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  wrapperClassName?: string;
  showLabel?: string;
  hideLabel?: string;
};

export default function PasswordInput({
  id, className = "input-field", wrapperClassName = "", disabled,
  showLabel = "Show password", hideLabel = "Hide password", ...props
}: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<[number, number, "forward" | "backward" | "none"] | null>(null);
  const [visible, setVisible] = useState(false);
  const revealed = visible && !disabled;
  const label = revealed ? hideLabel : showLabel;

  useLayoutEffect(() => {
    if (selection.current && document.activeElement === input.current) {
      // Flush the type change before restoring selection; Chromium otherwise
      // resets it when laying out the input's replacement text editor.
      input.current?.getBoundingClientRect();
      input.current?.setSelectionRange(...selection.current);
    }
    selection.current = null;
  }, [revealed]);

  function toggle() {
    const field = input.current;
    // Changing input type must not lose the user's cursor or selected text.
    if (field && document.activeElement === field) {
      selection.current = [field.selectionStart ?? 0, field.selectionEnd ?? 0, field.selectionDirection ?? "none"];
    }
    setVisible(value => !value);
  }

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input {...props} ref={input} id={inputId} type={revealed ? "text" : "password"}
        disabled={disabled} className={`${className} password-input pr-12`}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button type="button" disabled={disabled} aria-label={label} title={label} aria-controls={inputId}
        onPointerDown={event => event.preventDefault()}
        onClick={event => { event.preventDefault(); toggle(); }}
        className="password-input-toggle absolute right-0 inset-y-0 w-11 flex items-center justify-center rounded-r-md text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        {revealed ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
