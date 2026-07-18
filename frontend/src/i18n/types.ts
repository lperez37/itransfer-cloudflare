export const LOCALES = ["en", "es", "fr", "pt", "nl", "it", "ca", "pl", "da", "sv"] as const;
export type Locale = (typeof LOCALES)[number];

export type Translations = Record<string, string>;
