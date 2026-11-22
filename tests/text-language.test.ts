import { describe, expect, it } from "vitest";
import { hasScriptOf, writtenIn } from "../app/lib/text-language";

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
    ["Hallo Welt", []],
    ["lol 👍 123", []],
    ["👍 123", []],
  ])("finds the site languages of %j", (text: string, locales: string[]): void => {
    expect(writtenIn(text)).toEqual(locales);
  });

  it("tells if a translation has the script of the language of the reader", (): void => {
    expect(hasScriptOf("uk", "Misha, it is impossible to read the messages")).toBe(false);
    expect(hasScriptOf("uk", "Миша, повідомлення неможливо читати")).toBe(true);
    expect(hasScriptOf("en", "Привет")).toBe(false);
    expect(hasScriptOf("ja", "今日の配信")).toBe(true);
    expect(hasScriptOf("ja", "東京")).toBe(true);
    expect(hasScriptOf("zh-CN", "今日の配信は楽しい")).toBe(false);
    expect(hasScriptOf("hi", "Hello")).toBe(false);
    // A code block is not text of the language.
    expect(hasScriptOf("uk", 'Привіт!\n~~~js\nconst message = "hello world";\n~~~')).toBe(true);
    // Text without letters has no script.
    expect(hasScriptOf("ru", "👍 2024")).toBe(true);
  });
});
