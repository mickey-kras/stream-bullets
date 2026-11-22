import { beforeAll, describe, expect, it } from "vitest";
import { inLanguageOf, loadLanguageDetector, writtenIn } from "../app/lib/text-language";

beforeAll(loadLanguageDetector);

describe("the language of a text from its letters", (): void => {
  it.each([
    ["Миша, сообщения невозможно читать :((", ["ru"]],
    ["Привіт усім, як справи?", ["uk"]],
    ["Спасибо, поправлю!", ["ru"]],
    ["Смотри `npm run dev` тут https://example.com/a-long-latin-address", ["ru"]],
    // A letter in code or in a link is not text of the comment.
    ["Спасибо! `і` https://example.com/їжак", ["ru"]],
    // Letters of the two languages.
    ["Привіт! Это мой ответ", ["ru", "uk"]],
    ["नमस्ते दोस्तों", ["hi"]],
    ["今日の配信は楽しかった", ["ja"]],
    ["今天的直播很有趣", ["zh-CN"]],
    ["Hallo Welt, wie geht es euch heute?", ["de"]],
    ["What are your thoughts about the massive Microsoft outage yesterday?!", ["en"]],
    ["Nie wiem, co o tym myśleć", ["pl"]],
    ["O que vocês acham da transmissão de hoje à noite?", ["pt-BR"]],
    // The detector is not sure about names and short slang.
    ["Elden Ring", []],
    ["lol 👍 123", []],
    ["👍 123", []],
  ])("finds the site languages of %j", (text: string, locales: string[]): void => {
    expect(writtenIn(text)).toEqual(locales);
  });

  it("tells if a translation has the script of the language of the reader", (): void => {
    expect(inLanguageOf("uk", "Misha, it is impossible to read the messages")).toBe(false);
    expect(inLanguageOf("uk", "Миша, повідомлення неможливо читати")).toBe(true);
    expect(inLanguageOf("en", "Привет")).toBe(false);
    // A name kept in Cyrillic letters in a language with a different script.
    expect(inLanguageOf("pl", "Миша, nie myślałeś o przeprowadzce do innego stanu?")).toBe(false);
    expect(inLanguageOf("pl", "Misha, nie myślałeś o przeprowadzce do innego stanu?")).toBe(true);
    expect(inLanguageOf("ja", "ミシャ、Мишаの配信")).toBe(false);
    expect(inLanguageOf("ru", "Миша, привет от Kasia")).toBe(true);
    // Code is not text of the language, also in a code span with two backticks.
    expect(inLanguageOf("en", "Use `Привет` as the greeting string.")).toBe(true);
    expect(inLanguageOf("en", "Use ``Привет`` as the greeting string.")).toBe(true);
    expect(inLanguageOf("ja", "今日の配信")).toBe(true);
    expect(inLanguageOf("ja", "東京")).toBe(true);
    expect(inLanguageOf("zh-CN", "今日の配信は楽しい")).toBe(false);
    expect(inLanguageOf("hi", "Hello")).toBe(false);
    // A code block is not text of the language.
    expect(inLanguageOf("uk", 'Привіт!\n~~~js\nconst message = "hello world";\n~~~')).toBe(true);
    // A different site language in the same script.
    expect(inLanguageOf("en", "¿Qué opinan del gran corte de Microsoft de ayer?! Hay rumores de bots rebeldes.")).toBe(
      false,
    );
    expect(inLanguageOf("en", "What are your thoughts about the massive Microsoft outage yesterday?!")).toBe(true);
    expect(inLanguageOf("en", "lol gg")).toBe(true);
    // Text without letters has no script.
    expect(inLanguageOf("ru", "👍 2024")).toBe(true);
  });
});
