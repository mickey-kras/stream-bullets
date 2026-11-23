import type { ReactNode } from "react";
import { intlLocale, t, type Locale } from "../i18n";

/** The label of a translated item: "Translated from <language>", or "Translated" when the language is not sure. */
export function TranslatedFrom({ from }: Readonly<{ from?: Locale }>): ReactNode {
  const language: string | undefined = from && new Intl.DisplayNames([intlLocale()], { type: "language" }).of(from);
  return <span>{language ? t("discussion.translatedFrom", { language }) : t("discussion.translated")}</span>;
}
