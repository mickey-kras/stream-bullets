import { LOCALES } from "../../db/enums";
import en from "./en.json";

// Use t for dotted message IDs, {name} placeholders and tn for CLDR plurals. Never translate user content;
// legal text stays English. Bundle English and lazy-load other catalogs before SSR/hydration. Missing keys
// use English.
export type MessageId = keyof typeof en;
export type Locale = (typeof LOCALES)[number];
export type MessageVars = Readonly<Record<string, string | number>>;
export type Catalog = Readonly<Partial<Record<string, string>>>;

export { LOCALES } from "../../db/enums";
export const DEFAULT_LOCALE: Locale = "en";

// Native language names.
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

// Load each catalog once; English is bundled.
export async function loadCatalog(locale: Locale): Promise<void> {
  if (catalogs.has(locale)) return;
  const load = loaders[`./${locale}.json`];
  catalogs.set(locale, load ? (await load()).default : {});
}

function documentLocale(): Locale {
  const lang: string | undefined = globalThis.document?.documentElement.lang;
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

// Browser locale comes from html lang. Server uses per-request storage to isolate concurrent renders.
let localeSource: () => Locale = documentLocale;

export function setLocaleSource(source: () => Locale): void {
  localeSource = source;
}

export function getLocale(): Locale {
  return localeSource();
}

// Use regional Intl tags for Indian Hindi and US English.
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

// Select the locale's plural form and format count. Fall back to other, then English for missing messages.
export function tn(id: PluralBase, count: number, vars?: MessageVars): string {
  const locale: Locale = getLocale();
  const rule: Intl.LDMLPluralRule = new Intl.PluralRules(intlLocale(locale)).select(count);
  const englishRule: Intl.LDMLPluralRule = new Intl.PluralRules("en").select(count);
  const template: string =
    lookup(`${id}.${rule}`) ?? lookup(`${id}.other`) ?? english[`${id}.${englishRule}`] ?? english[`${id}.other`];
  return format(template, { count: new Intl.NumberFormat(intlLocale(locale)).format(count), ...vars });
}
