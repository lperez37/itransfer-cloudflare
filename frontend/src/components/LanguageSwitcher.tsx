import { useState, useRef, useEffect } from "react";
import { Globe } from "lucide-react";
import { useTranslation, LOCALE_NAMES, LOCALES } from "../i18n";

export default function LanguageSwitcher() {
  const { locale, setLocale } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-text-muted hover:text-text-secondary transition-colors text-xs"
        aria-label="Change language"
      >
        <Globe className="w-3.5 h-3.5" />
        {LOCALE_NAMES[locale]}
      </button>

      {/* Mobile: fixed centered overlay */}
      {open && (
        <>
          <div
            className="sm:hidden fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="sm:hidden fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 surface border border-border rounded-lg shadow-lg py-2 min-w-[180px] z-50 animate-fade-in">
            {LOCALES.map((l) => (
              <button
                key={l}
                onClick={() => { setLocale(l); setOpen(false); }}
                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                  l === locale
                    ? "text-primary bg-primary/10"
                    : "text-text-secondary hover:bg-surface-light"
                }`}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>

          {/* Desktop: relative dropdown */}
          <div className="hidden sm:block absolute bottom-full mb-2 left-1/2 -translate-x-1/2 surface border border-border rounded-md shadow-lg py-1 min-w-[140px] z-50 animate-fade-in">
            {LOCALES.map((l) => (
              <button
                key={l}
                onClick={() => { setLocale(l); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                  l === locale
                    ? "text-primary bg-primary/10"
                    : "text-text-secondary hover:bg-surface-light"
                }`}
              >
                {LOCALE_NAMES[l]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
