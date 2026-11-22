import type { Locale } from "../i18n";

type Script = "cyrillic" | "latin" | "devanagari" | "kana" | "han";

const SCRIPTS: Readonly<Record<Script, RegExp>> = {
  cyrillic: /\p{Script=Cyrillic}/gu,
  latin: /\p{Script=Latin}/gu,
  devanagari: /\p{Script=Devanagari}/gu,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  han: /\p{Script=Han}/gu,
};

// The scripts that a text in each site language can have. Japanese text can have only Han characters.
const LOCALE_SCRIPTS: Readonly<Record<Locale, readonly Script[]>> = {
  de: ["latin"],
  en: ["latin"],
  es: ["latin"],
  fr: ["latin"],
  hi: ["devanagari"],
  ja: ["kana", "han"],
  pl: ["latin"],
  "pt-BR": ["latin"],
  ru: ["cyrillic"],
  uk: ["cyrillic"],
  "zh-CN": ["han"],
};

// Links and code are not text of a language.
function prose(text: string): string {
  return text.replaceAll(/https?:\/\/\S+|```[\s\S]*?```|`[^`\n]*`/gu, " ");
}

// The script of most letters of the text. Null without letters.
function mainScript(plain: string): Script | null {
  const count = (script: Script): number => plain.match(SCRIPTS[script])?.length ?? 0;
  // Japanese text has kana between its Han characters.
  if (count("kana") > 0 && count("kana") + count("han") > Math.max(count("latin"), count("cyrillic"))) return "kana";
  let main: Script | null = null;
  for (const script of ["cyrillic", "latin", "devanagari", "han"] as const)
    if (count(script) > (main ? count(main) : 0)) main = script;
  return main;
}

/**
 * The site languages that the text is written in, found from its letters and not from a model. Almost all
 * Ukrainian text has one of the letters і, ї, є and ґ, and Russian text has none. Cyrillic text with these
 * letters and with letters of only Russian can be the two. The result is empty for Latin text: its letters do
 * not tell the language.
 */
export function writtenIn(text: string): readonly Locale[] {
  const plain: string = prose(text);
  const script: Script | null = mainScript(plain);
  if (script === "devanagari") return ["hi"];
  if (script === "kana") return ["ja"];
  if (script === "han") return ["zh-CN"];
  if (script !== "cyrillic") return [];
  const russian: boolean = /[ыэъё]/iu.test(plain);
  const ukrainian: boolean = /[іїєґ]/iu.test(plain);
  if (!ukrainian) return ["ru"];
  return russian ? ["ru", "uk"] : ["uk"];
}

/** Tells if the text has the script of the language. A model sometimes answers in a different language. */
export function hasScriptOf(locale: Locale, text: string): boolean {
  const script: Script | null = mainScript(prose(text));
  return script === null || LOCALE_SCRIPTS[locale].includes(script);
}
