import { useState, useRef, useEffect, useId } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useTranslation, LOCALE_NAMES, LOCALES } from "../i18n";

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionsId = useId();

  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    document.addEventListener("focusin", handler);
    return () => {
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("focusin", handler);
    };
  }, [open]);

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          closeAndFocus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm font-medium text-text-secondary transition-colors hover:border-border-light hover:text-text-primary"
        aria-label={locale === "en" ? "Change language" : t("language.label")}
        aria-describedby={`${optionsId}-current`}
        aria-expanded={open}
        aria-controls={open ? optionsId : undefined}
      >
        <Globe className="size-4 shrink-0" aria-hidden="true" />
        <span id={`${optionsId}-current`}>{LOCALE_NAMES[locale]}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <ul id={optionsId} className="absolute right-0 top-full z-20 mt-2 max-h-[min(27rem,65dvh)] w-42 overflow-y-auto rounded-2xl border border-border bg-surface p-1.5 shadow-lg" role="list">
          {LOCALES.map((l) => (
            <li key={l}>
              <button
                type="button"
                lang={l}
                aria-current={l === locale ? "true" : undefined}
                onClick={() => {
                  setLocale(l);
                  closeAndFocus();
                }}
                className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-sm transition-colors focus-visible:-outline-offset-2 ${
                  l === locale
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                }`}
              >
                {LOCALE_NAMES[l]}
                {l === locale && <Check className="size-4 shrink-0" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
