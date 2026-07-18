import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  createElement,
  type ReactNode,
} from "react";
import { LOCALES, type Locale, type Translations } from "./types";
import en from "./locales/en.json";

const STORAGE_KEY = "lang";

const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Translations }>> = {
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  pt: () => import("./locales/pt.json"),
  nl: () => import("./locales/nl.json"),
  it: () => import("./locales/it.json"),
  ca: () => import("./locales/ca.json"),
  pl: () => import("./locales/pl.json"),
  da: () => import("./locales/da.json"),
  sv: () => import("./locales/sv.json"),
};

function detectLanguage(): Locale {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode, disabled cookies) - ignore.
  }
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;

  const nav = navigator.language || "";
  const base = nav.split("-")[0].toLowerCase();
  if ((LOCALES as readonly string[]).includes(base)) return base as Locale;

  return "en";
}

function resolvePluralSuffix(locale: Locale, count: number): string {
  const rules = new Intl.PluralRules(locale);
  const category = rules.select(count);
  // Map CLDR categories to our suffix convention
  switch (category) {
    case "one":
      return "_one";
    case "few":
      return "_few";
    case "many":
      return "_many";
    default:
      return "_other";
  }
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLanguage);
  const [messages, setMessages] = useState<Translations>(en);

  useEffect(() => {
    if (locale === "en") {
      setMessages(en);
      return;
    }
    let cancelled = false;
    loaders[locale]()
      .then((mod) => {
        // Discard a stale response if the locale changed (or unmounted) before
        // this dynamic import resolved - prevents out-of-order overwrites.
        if (cancelled) return;
        setMessages({ ...en, ...mod.default });
      })
      .catch(() => {
        // Chunk failed to load (network/offline) - fall back to English.
        if (cancelled) return;
        setMessages(en);
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // localStorage may be unavailable - persistence is best-effort.
    }
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let resolved = key;

      // Plural resolution: if params has `count`, try suffixed key
      if (params && "count" in params) {
        const suffix = resolvePluralSuffix(locale, params.count as number);
        const pluralKey = key + suffix;
        if (pluralKey in messages) {
          resolved = pluralKey;
        } else if (key + "_other" in messages) {
          resolved = key + "_other";
        }
      }

      let text = messages[resolved] ?? en[resolved as keyof typeof en] ?? key;

      // Interpolate {{var}}
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        }
      }

      return text;
    },
    [messages, locale]
  );

  return createElement(I18nContext.Provider, { value: { locale, setLocale, t } }, children);
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within LanguageProvider");
  return ctx;
}

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  pt: "Português",
  nl: "Nederlands",
  it: "Italiano",
  ca: "Català",
  pl: "Polski",
  da: "Dansk",
  sv: "Svenska",
};

export { LOCALES, type Locale };
