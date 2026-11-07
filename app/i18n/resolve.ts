import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from "./index";

/** The language a signed-out visitor picked. Signed-in accounts also save it (`PATCH /api/me/locale`). */
export const LOCALE_COOKIE = "sb_locale";

/** Maps a BCP 47 tag to a supported language: `de-AT` to `de`, `pt` to `pt-BR`, `zh-Hans` to `zh-CN`. */
export function matchLocale(tag: string): Locale | null {
  const parts: string[] = tag.trim().toLowerCase().split(/[-_]/);
  const [language] = parts;
  if (!language) return null;
  if (language === "zh") {
    // Traditional Chinese readers are better served by English than by Simplified Chinese.
    const traditional: boolean = parts.some((part: string) => ["hant", "tw", "hk", "mo"].includes(part));
    return traditional ? null : "zh-CN";
  }
  if (language === "pt") return "pt-BR";
  return LOCALES.find((locale: Locale) => locale.toLowerCase() === language) ?? null;
}

/** The first supported language in an Accept-Language header, by quality, then by order. */
export function acceptedLocale(header: string | null): Locale | null {
  if (!header) return null;
  const ranges = header
    .split(",")
    .slice(0, 20)
    .map((part: string, index: number) => {
      const [tag = "", ...params] = part.split(";");
      const q: string | undefined = params.map((param: string) => param.trim()).find((p) => p.startsWith("q="));
      const quality: number = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((range) => range.tag && range.tag !== "*" && range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const range of ranges) {
    const locale: Locale | null = matchLocale(range.tag);
    if (locale) return locale;
  }
  return null;
}

/** One cookie's value from a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index: number = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The request's language: the account's saved language, then the cookie, then Accept-Language, then English. */
export function resolveLocale(input: {
  saved: Locale | null;
  cookie: string | null;
  acceptLanguage: string | null;
}): Locale {
  if (input.saved) return input.saved;
  if (isLocale(input.cookie)) return input.cookie;
  return acceptedLocale(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

export function requestLocale(request: Request, saved: Locale | null): Locale {
  return resolveLocale({
    saved,
    cookie: readCookie(request.headers.get("Cookie"), LOCALE_COOKIE),
    acceptLanguage: request.headers.get("Accept-Language"),
  });
}
