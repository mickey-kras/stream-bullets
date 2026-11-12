import type { Locale } from "../i18n";

export const BUG_TEMPLATES: Readonly<Record<Locale, string>> = {
  en: "What happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n1. ",
  de: "Was ist passiert?\n\nWas hast du erwartet?\n\nSchritte zum Reproduzieren:\n1. ",
  es: "¿Qué ocurrió?\n\n¿Qué esperabas?\n\nPasos para reproducirlo:\n1. ",
  fr: "Que s’est-il passé ?\n\nQuel résultat attendiez-vous ?\n\nÉtapes pour reproduire le problème :\n1. ",
  pl: "Co się stało?\n\nJakiego wyniku oczekiwano?\n\nKroki odtworzenia problemu:\n1. ",
  "pt-BR": "O que aconteceu?\n\nO que você esperava?\n\nPassos para reproduzir:\n1. ",
  ru: "Что произошло?\n\nКакого результата вы ожидали?\n\nШаги для воспроизведения:\n1. ",
  uk: "Що сталося?\n\nЯкого результату ви очікували?\n\nКроки для відтворення:\n1. ",
  hi: "क्या हुआ?\n\nआपको क्या उम्मीद थी?\n\nसमस्या दोहराने के चरण:\n1. ",
  "zh-CN": "发生了什么？\n\n你期望的结果是什么？\n\n复现步骤：\n1. ",
  ja: "何が起きましたか？\n\n期待していた結果は何ですか？\n\n再現手順：\n1. ",
};
