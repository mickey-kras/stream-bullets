import type { Locale } from "../i18n";

// The detector of the language of text in Latin letters. Its data is large, so the module loads at the first
// use and not at the start of the Worker.
interface Detector {
  detect: (text: string) => { language: string; isReliable: () => boolean };
}
const LATIN: Readonly<Record<string, Locale>> = { de: "de", en: "en", es: "es", fr: "fr", pl: "pl", pt: "pt-BR" };
let detector: Detector | null = null;

/** Loads the language detector. Call it one time before `writtenIn` and `inLanguageOf`. */
export async function loadLanguageDetector(): Promise<void> {
  if (detector) return;
  const { eld } = await import("eld/extrasmall");
  eld.setLanguageSubset(Object.keys(LATIN));
  detector = eld;
}

// The site language of text in Latin letters. Null when the detector is not sure: short text, names, slang.
function latinLanguage(plain: string): Locale | null {
  const result = detector?.detect(plain);
  return result?.isReliable() ? (LATIN[result.language] ?? null) : null;
}

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

// Links, email addresses of mailto links, and code are not text of a language. A code span can have more than one backtick on each side.
function prose(text: string): string {
  return text.replaceAll(/https?:\/\/\S+|mailto:[^\s)]+|```[\s\S]*?```|~~~[\s\S]*?~~~|(`+)[^\n]*?\1/gu, " ");
}

// The script of most letters of the text. Null without letters.
function mainScript(plain: string): Script | null {
  const count = (script: Script): number => [...plain.matchAll(SCRIPTS[script])].length;
  // Japanese text has kana between its Han characters.
  if (count("kana") > 0 && count("kana") + count("han") > Math.max(count("latin"), count("cyrillic"))) return "kana";
  let main: Script | null = null;
  for (const script of ["cyrillic", "latin", "devanagari", "han"] as const)
    if (count(script) > (main ? count(main) : 0)) main = script;
  return main;
}

/**
 * The site languages that the text is written in, found without a model. Almost all Ukrainian text has one of
 * the letters і, ї, є and ґ, and Russian text has none. Cyrillic text with these letters and with letters of
 * only Russian can be the two. A statistical detector finds the language of text in Latin letters. The result
 * is empty when the language is not sure.
 */
export function writtenIn(text: string): readonly Locale[] {
  const plain: string = prose(text);
  const script: Script | null = mainScript(plain);
  if (script === "devanagari") return ["hi"];
  if (script === "kana") return ["ja"];
  if (script === "han") return ["zh-CN"];
  if (script === "latin") {
    const language: Locale | null = latinLanguage(plain);
    return language ? [language] : [];
  }
  if (script !== "cyrillic") return [];
  const russian: boolean = /[ыэъё]/iu.test(plain);
  const ukrainian: boolean = /[іїєґ]/iu.test(plain);
  if (!ukrainian) return ["ru"];
  return russian ? ["ru", "uk"] : ["uk"];
}

/**
 * Tells if a translation can be in the language of the reader. A model sometimes answers in a different
 * language. The text must have the script of the language. Text in Latin letters must not be in a different
 * site language, when the detector is sure. The `translated` part of the text, by default all of it, must have
 * no Cyrillic letters when the language has a different script. A part that the author already wrote in the
 * language of the reader stays as it is, also with a name in Cyrillic letters.
 */
export function inLanguageOf(locale: Locale, text: string, translated: string = text): boolean {
  const plain: string = prose(text);
  const script: Script | null = mainScript(plain);
  if (script === null) return true;
  if (!LOCALE_SCRIPTS[locale].includes(script)) return false;
  // The model sometimes keeps a name in Cyrillic letters, for example "Миша, ..." in a Polish translation.
  if (!LOCALE_SCRIPTS[locale].includes("cyrillic") && /\p{Script=Cyrillic}/u.test(prose(translated))) return false;
  if (script !== "latin") return true;
  const language: Locale | null = latinLanguage(plain);
  return language === null || language === locale;
}
