import type { Locale } from "../i18n";

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

export function binaryOptions(locale: Locale): readonly [string, string] {
  return labels[locale];
}
