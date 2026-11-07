import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  getLocale,
  intlLocale,
  LOCALES,
  loadCatalog,
  setLocaleSource,
  t,
  tn,
  type Locale,
} from "../app/i18n";
import { acceptedLocale, matchLocale, readCookie, requestLocale, resolveLocale } from "../app/i18n/resolve";

type Catalog = Record<string, string>;

function catalog(locale: Locale): Catalog {
  return JSON.parse(readFileSync(new URL(`../app/i18n/${locale}.json`, import.meta.url), "utf8")) as Catalog;
}

const english: Catalog = catalog("en");
const PLURAL_FORMS = new Set(["one", "few", "many", "other"]);
/** Message ids with plural forms: the id without `.one` / `.other`. */
const pluralBases = new Set(
  Object.keys(english)
    .filter((id: string) => id.endsWith(".other") && `${id.slice(0, -6)}.one` in english)
    .map((id: string) => id.slice(0, -6)),
);
const variables = (text: string): string =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");

/**
 * The plural forms a language needs for whole numbers (CLDR), plus `other`, the fallback every language keeps.
 * The `many` form some languages use only for millions is left out.
 */
function requiredForms(locale: Locale): string[] {
  const forms = new Set<string>(["other"]);
  for (let count = 0; count <= 200; count += 1) forms.add(new Intl.PluralRules(intlLocale(locale)).select(count));
  return [...forms].filter((form: string) => PLURAL_FORMS.has(form)).sort();
}

afterEach(() => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

describe("catalogs", () => {
  it("keeps en.json sorted, so new ids land in one place", () => {
    const ids: string[] = Object.keys(english);
    expect(ids).toEqual([...ids].sort((a: string, b: string) => (a < b ? -1 : Number(a > b))));
  });

  it.each(LOCALES.filter((locale: Locale) => locale !== "en"))("%s has every English message", (locale: Locale) => {
    const messages: Catalog = catalog(locale);
    const forms: string[] = requiredForms(locale);
    const expected: string[] = Object.keys(english).filter((id: string) => {
      const dot: number = id.lastIndexOf(".");
      return !pluralBases.has(id.slice(0, dot));
    });
    for (const base of pluralBases) for (const form of forms) expected.push(`${base}.${form}`);
    expect(Object.keys(messages).sort()).toEqual(expected.sort());
  });

  it.each(LOCALES.filter((locale: Locale) => locale !== "en"))("%s keeps every {placeholder}", (locale: Locale) => {
    for (const [id, text] of Object.entries(catalog(locale))) {
      const dot: number = id.lastIndexOf(".");
      const source: string | undefined = pluralBases.has(id.slice(0, dot))
        ? english[`${id.slice(0, dot)}.other`]
        : english[id];
      expect(variables(text), `${locale} ${id}`).toBe(variables(source ?? ""));
      expect(text.trim(), `${locale} ${id}`).not.toBe("");
    }
  });
});

describe("t and tn", () => {
  it("formats variables and leaves unknown ones as they are", () => {
    expect(t("language.current", { name: "Deutsch" })).toBe("Language: Deutsch");
    expect(t("ai.can2")).toBe("Use {file} for a summary of the site.");
  });

  it("falls back to English for a language without the message", () => {
    setLocaleSource((): Locale => "xx" as Locale);
    expect(t("prefs.title")).toBe("Accessibility & display");
    expect(tn("entry.comments", 2)).toBe("2 comments");
  });

  it("uses the language's plural rules", async () => {
    expect(tn("entry.comments", 1)).toBe("1 comment");
    expect(tn("entry.comments", 1200)).toBe("1,200 comments");
    await Promise.all([loadCatalog("ru"), loadCatalog("ja"), loadCatalog("de"), loadCatalog("pl")]);
    setLocaleSource((): Locale => "ru");
    const russian: Catalog = catalog("ru");
    expect(tn("entry.comments", 1)).toBe(russian["entry.comments.one"].replace("{count}", "1"));
    expect(tn("entry.comments", 3)).toBe(russian["entry.comments.few"].replace("{count}", "3"));
    expect(tn("entry.comments", 5)).toBe(russian["entry.comments.many"].replace("{count}", "5"));
    expect(tn("entry.comments", 21)).toBe(russian["entry.comments.one"].replace("{count}", "21"));
    setLocaleSource((): Locale => "pl");
    expect(tn("entry.comments", 22)).toBe(catalog("pl")["entry.comments.few"].replace("{count}", "22"));
    setLocaleSource((): Locale => "ja");
    expect(tn("entry.comments", 1)).toBe(catalog("ja")["entry.comments.other"].replace("{count}", "1"));
    setLocaleSource((): Locale => "de");
    expect(tn("entry.comments", 1200)).toBe(catalog("de")["entry.comments.other"].replace("{count}", "1.200"));
  });

  it("names Hindi and English with a region for Intl", () => {
    expect(intlLocale("hi")).toBe("hi-IN");
    expect(intlLocale("en")).toBe("en-US");
    expect(intlLocale("pt-BR")).toBe("pt-BR");
    expect(getLocale()).toBe("en");
  });
});

describe("locale resolution", () => {
  it("prefers the account, then the cookie, then Accept-Language, then English", () => {
    const all = { saved: "de" as Locale, cookie: "fr", acceptLanguage: "ja" };
    expect(resolveLocale(all)).toBe("de");
    expect(resolveLocale({ ...all, saved: null })).toBe("fr");
    expect(resolveLocale({ ...all, saved: null, cookie: "xx" })).toBe("ja");
    expect(resolveLocale({ saved: null, cookie: null, acceptLanguage: "ko, sv;q=0.8" })).toBe("en");
    expect(resolveLocale({ saved: null, cookie: null, acceptLanguage: null })).toBe("en");
  });

  it("reads Accept-Language by quality, then order", () => {
    expect(acceptedLocale("ko;q=0.9, pl;q=0.5, uk;q=0.7")).toBe("uk");
    expect(acceptedLocale("es-MX, fr;q=0.9")).toBe("es");
    expect(acceptedLocale("ru;q=0, de;q=0.1")).toBe("de");
    expect(acceptedLocale("*")).toBeNull();
    expect(acceptedLocale("")).toBeNull();
  });

  it("maps regional tags to the supported languages", () => {
    expect(matchLocale("pt-PT")).toBe("pt-BR");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(matchLocale("zh-TW")).toBeNull();
    expect(matchLocale("zh-Hant")).toBeNull();
    expect(matchLocale("hi-IN")).toBe("hi");
    expect(matchLocale("EN_gb")).toBe("en");
    expect(matchLocale("")).toBeNull();
  });

  it("reads the language cookie from a request", () => {
    const request = new Request("https://streambullets.test/", {
      headers: { Cookie: "a=1; sb_locale=pl; b=%E0", "Accept-Language": "de" },
    });
    expect(readCookie(request.headers.get("Cookie"), "sb_locale")).toBe("pl");
    expect(readCookie(request.headers.get("Cookie"), "b")).toBeNull();
    expect(readCookie(null, "sb_locale")).toBeNull();
    expect(requestLocale(request, null)).toBe("pl");
    expect(requestLocale(request, "hi")).toBe("hi");
  });
});
