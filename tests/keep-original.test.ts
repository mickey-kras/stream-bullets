import { beforeAll, describe, expect, it } from "vitest";
import type { Locale } from "../app/i18n";
import { loadLanguageDetector, readsOriginal, writtenIn } from "../app/lib/text-language";

// Short comments as viewers write them in a live-stream chat. The setting "languages you read" depends on the
// language that `writtenIn` finds, so these lists measure how often it gives the wrong one of the two.
const UKRAINIAN: readonly string[] = [
  "Дякую за стрім, було дуже цікаво!",
  "Привіт усім, я вперше на каналі",
  "Коли буде наступний стрім?",
  "Це найкраща гра цього року",
  "Можна грати разом з глядачами?",
  "Я з Києва, вітаю!",
  "Будь ласка, увімкніть звук",
  "Звук дуже тихий, нічого не чути",
  "Чому ти не взяв меч?",
  "Ця локація виглядає чудово",
  "Скільки годин ти вже граєш?",
  "Добрий вечір, як справи?",
  "Мені подобається твій голос",
  "Давай пройдемо цей рівень ще раз",
  "Я теж хочу таку клавіатуру",
  "Чекаю на нове відео",
  "Дуже смішно, дякую",
  "Підтримую, гарна ідея",
  "Цей бос дуже складний",
  "Купив гру після твого стріму",
  "Так, звісно",
  "Добре, чекаємо",
  "Супер гра",
  "Давай ще",
  "Хто зараз дивиться?",
  "Коли розіграш?",
  "Гарного вечора",
  "Що це за музика?",
  "Як називається ця гра?",
  "Дякую",
];

const RUSSIAN: readonly string[] = [
  "Спасибо за стрим, было очень интересно!",
  "Привет всем, я впервые на канале",
  "Когда будет следующий стрим?",
  "Это лучшая игра этого года",
  "Можно играть вместе со зрителями?",
  "Я из Москвы, всем привет!",
  "Пожалуйста, включите звук",
  "Звук очень тихий, ничего не слышно",
  "Почему ты не взял меч?",
  "Эта локация выглядит отлично",
  "Сколько часов ты уже играешь?",
  "Добрый вечер, как дела?",
  "Мне нравится твой голос",
  "Давай пройдем этот уровень еще раз",
  "Я тоже хочу такую клавиатуру",
  "Жду новое видео",
  "Очень смешно, спасибо",
  "Поддерживаю, хорошая идея",
  "Этот босс очень сложный",
  "Купил игру после твоего стрима",
  "Да, конечно",
  "Хорошо, ждем",
  "Супер игра",
  "Давай еще",
  "Кто сейчас смотрит?",
  "Когда розыгрыш?",
  "Хорошего вечера",
  "Что это за музыка?",
  "Как называется эта игра?",
  "Спасибо",
];

// The share of texts for which a reader of only `reads` sees the original although the text is in `other`.
function wronglyKept(texts: readonly string[], reads: Locale): number {
  return texts.filter((text: string): boolean => readsOriginal([reads], text)).length / texts.length;
}

// The share of texts for which a reader of `language` gets a translation of a text in that language.
function wronglyTranslated(texts: readonly string[], language: Locale): number {
  return texts.filter((text: string): boolean => !readsOriginal([language], text)).length / texts.length;
}

beforeAll(async (): Promise<void> => loadLanguageDetector());

describe("languages that the reader reads", (): void => {
  it("keeps the original text only when each language of the text is one that the reader reads", (): void => {
    expect(readsOriginal([], "Дякую за стрім, було дуже цікаво!")).toBe(false);
    expect(readsOriginal(["uk"], "Дякую за стрім, було дуже цікаво!")).toBe(true);
    expect(readsOriginal(["de"], "Ich streame jeden Abend Rollenspiele und spreche mit euch über neue Spiele.")).toBe(
      true,
    );
    expect(readsOriginal(["ja"], "今日は新しいゲームを遊びます")).toBe(true);
    // A text with letters of Ukrainian and of Russian can be either: only a reader of both keeps it.
    expect(writtenIn("Сьогодні ми граємо в ігри, это интересно")).toEqual(["ru", "uk"]);
    expect(readsOriginal(["uk"], "Сьогодні ми граємо в ігри, это интересно")).toBe(false);
    expect(readsOriginal(["ru", "uk"], "Сьогодні ми граємо в ігри, это интересно")).toBe(true);
    // A text without a sure language keeps its translation.
    expect(readsOriginal(["en"], "ok")).toBe(false);
    expect(readsOriginal(["en"], "", "https://example.com")).toBe(false);
  });

  it("keeps the translation when one part of an item is in a language that the reader does not read", (): void => {
    const title =
      "Яку гру ми будемо грати сьогодні ввечері разом з глядачами? Напишіть свою думку і проголосуйте, будь ласка, до кінця стріму!";
    const options = ["Something with exploration and building", "A story game with many choices"];
    expect(writtenIn([title, ...options].join("\n\n"))).toEqual(["uk"]);
    // The long Ukrainian title alone would decide the whole text; the English options need their translation.
    expect(readsOriginal(["uk"], title, ...options)).toBe(false);
    expect(readsOriginal(["uk", "en"], title, ...options)).toBe(true);
    // A part without a sure language, like a short option, does not decide.
    expect(readsOriginal(["uk"], title, "ok")).toBe(true);
  });

  it("measures how often Ukrainian and Russian comments get the wrong one of the two", (): void => {
    // `writtenIn` alone finds Russian in 10 of these 30 Ukrainian comments: they have none of і, ї, є and ґ.
    expect(UKRAINIAN.filter((text: string): boolean => writtenIn(text).join() === "ru")).toHaveLength(10);
    // The setting must not hide a translation that the reader needs: a reader of only one of the two languages
    // never sees a comment in the other one without a translation.
    expect(wronglyKept(UKRAINIAN, "ru")).toBe(0);
    expect(wronglyKept(RUSSIAN, "uk")).toBe(0);
    // The cost: a comment without a letter of only one of the two languages keeps its translation for a reader
    // of one of them. The reader can still select the original.
    expect(wronglyTranslated(UKRAINIAN, "uk")).toBeCloseTo(10 / 30);
    // 16 of the 30 Russian comments have none of ы, э, ъ and ё.
    expect(wronglyTranslated(RUSSIAN, "ru")).toBeCloseTo(16 / 30);
  });
});
