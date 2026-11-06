import en from "./en.json";

/**
 * UI strings. Every new or touched string goes through t("id") so P7 only adds catalogs.
 * Ids are dotted (area.name). Variables use {name}. Plurals use two ids, `id.one` and `id.other`, through tn().
 * User content (names, titles, comments) is never translated.
 */
export type MessageId = keyof typeof en;
export type Locale = "en";
export type MessageVars = Readonly<Record<string, string | number>>;

const catalogs: Readonly<Record<Locale, Readonly<Record<MessageId, string>>>> = { en };

/** The active locale. P7 resolves it per request (user.locale, cookie, Accept-Language, then "en"). */
export const locale: Locale = "en";

function format(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match: string, key: string): string =>
    key in vars ? String(vars[key]) : match,
  );
}

export function t(id: MessageId, vars?: MessageVars): string {
  return format(catalogs[locale][id] ?? en[id] ?? id, vars);
}

type PluralBase = MessageId extends infer Id ? (Id extends `${infer Base}.other` ? Base : never) : never;

/** Plural message: picks `id.one` or `id.other` with the locale's plural rules and passes {count}. */
export function tn(id: PluralBase, count: number, vars?: MessageVars): string {
  const rule: Intl.LDMLPluralRule = new Intl.PluralRules(locale).select(count);
  const key = `${id}.${rule}` as MessageId;
  const template: string = catalogs[locale][key] ?? catalogs[locale][`${id}.other` as MessageId];
  return format(template, { count: new Intl.NumberFormat(locale).format(count), ...vars });
}
