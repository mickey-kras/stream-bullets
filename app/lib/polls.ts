import type { Locale } from "../i18n";

/** The options that the database stores for each Yes/No poll. Custom labels go to `binary_labels`. */
export const BINARY_OPTIONS: readonly [string, string] = ["Yes", "No"];

export const BINARY_LABEL_MAX_LENGTH: number = 80;

const labels: Readonly<Record<Locale, readonly [string, string]>> = {
  en: ["Yes", "No"],
  es: ["Sí", "No"],
  "pt-BR": ["Sim", "Não"],
  de: ["Ja", "Nein"],
  pl: ["Tak", "Nie"],
  uk: ["Так", "Ні"],
  ru: ["Да", "Нет"],
  ja: ["はい", "いいえ"],
  "zh-CN": ["是", "否"],
  fr: ["Oui", "Non"],
  hi: ["हाँ", "नहीं"],
};

/** The default Yes and No labels in the language of the reader. */
export function binaryOptions(locale: Locale): readonly [string, string] {
  return labels[locale];
}

/** True when the labels are a pair of two different texts. The comparison ignores letter case. */
export function isBinaryLabelPair(options: readonly string[]): boolean {
  return options.length === 2 && options[0].toLowerCase() !== options[1].toLowerCase();
}

/** The labels to send for a Yes/No poll. No value means that the poll keeps the default labels. */
export function binaryLabelInput(first: string, second: string): string[] | undefined {
  const given: string[] = [first.trim(), second.trim()].filter(Boolean);
  return given.length > 0 ? given : undefined;
}
