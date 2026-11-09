import { LOCALES } from "../../db/enums";
import en from "./en.json";

/**
 * UI strings. Every UI string goes through t("id"). Ids are dotted (area.name). Variables use {name}.
 * Plurals use one id per CLDR category (`id.one`, `id.few`, `id.many`, `id.other`) through tn().
 * User content (names, titles, comments) is never translated, and the legal pages stay in English (R6).
 *
 * English is bundled. The other catalogs load on demand: the server loads the request's catalog before it
 * renders, and the client loads the same one before it hydrates (see entry.client.tsx). A key a catalog does
 * not have falls back to English.
 */
export type MessageId = keyof typeof en;
export type Locale = (typeof LOCALES)[number];
export type MessageVars = Readonly<Record<string, string | number>>;
export type Catalog = Readonly<Partial<Record<string, string>>>;

export { LOCALES } from "../../db/enums";
export const DEFAULT_LOCALE: Locale = "en";

/** Each language's own name, for the language switcher. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  es: "Español",
  "pt-BR": "Português",
  de: "Deutsch",
  pl: "Polski",
  uk: "Українська",
  ru: "Русский",
  ja: "日本語",
  "zh-CN": "中文",
  fr: "Français",
  hi: "हिन्दी",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

const loaders = import.meta.glob<{ default: Catalog }>("./*.json");
const catalogs = new Map<Locale, Catalog>([["en", en]]);

/** Loads a language's catalog once. English is always loaded. */
export async function loadCatalog(locale: Locale): Promise<void> {
  if (catalogs.has(locale)) return;
  const load = loaders[`./${locale}.json`];
  catalogs.set(locale, load ? (await load()).default : {});
}

function documentLocale(): Locale {
  const lang: string | undefined = globalThis.document?.documentElement.lang;
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

/**
 * Where the active language comes from. In the browser it is the page's `<html lang>`, which the server set.
 * The server swaps in its per-request source (app/i18n/server.ts), so parallel requests never share a language.
 */
let localeSource: () => Locale = documentLocale;

export function setLocaleSource(source: () => Locale): void {
  localeSource = source;
}

/** The active language. */
export function getLocale(): Locale {
  return localeSource();
}

/** The tag for Intl formatting. Hindi and English name a region so dates and numbers follow India and the US. */
export function intlLocale(locale: Locale = getLocale()): string {
  if (locale === "hi") return "hi-IN";
  if (locale === "en") return "en-US";
  return locale;
}

function format(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match: string, key: string): string =>
    key in vars ? String(vars[key]) : match,
  );
}

function lookup(id: string): string | undefined {
  return catalogs.get(getLocale())?.[id];
}

export function t(id: MessageId, vars?: MessageVars): string {
  return format(lookup(id) ?? en[id] ?? id, vars);
}

type PluralBase = MessageId extends infer Id ? (Id extends `${infer Base}.other` ? Base : never) : never;

const english: Readonly<Record<string, string>> = en;

/**
 * Plural message: picks the form for `count` with the language's plural rules and passes {count}, formatted.
 * A language without that form uses its `other` form; a language without the message uses English.
 */
export function tn(id: PluralBase, count: number, vars?: MessageVars): string {
  const locale: Locale = getLocale();
  const rule: Intl.LDMLPluralRule = new Intl.PluralRules(intlLocale(locale)).select(count);
  const englishRule: Intl.LDMLPluralRule = new Intl.PluralRules("en").select(count);
  const template: string =
    lookup(`${id}.${rule}`) ?? lookup(`${id}.other`) ?? english[`${id}.${englishRule}`] ?? english[`${id}.other`];
  return format(template, { count: new Intl.NumberFormat(intlLocale(locale)).format(count), ...vars });
}
