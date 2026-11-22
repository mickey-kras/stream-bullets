import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AppEnv } from "../app/env";
import { getEntry } from "../app/server/data.server";
import {
  attachEntryTranslations,
  entryTranslationSchema,
  readEntryAnswer,
  translateEntry,
} from "../app/server/entry-translation.server";
import type { Entry, EntryText } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const NOW = 1_800_000_000_000;
const POLL: EntryText = {
  title: "Welches Spiel?",
  body: "Stimmt ab!\nEnde ist Freitag.",
  options: ["Elden Ring", "Gemütlich"],
};
// The answer of the model: JSON with the three parts. The runtime gives an object.
function answer(title: string, options: string[], body: string): { title: string; options: string[]; body: string } {
  return { title, options, body };
}
const GOOD = answer("Which game?", ["Elden Ring", "Cozy"], "Vote!\nEnds on Friday.");

let database: TestDatabase;
let env: AppEnv;
let run: Mock<
  (model: string, input: { messages: { role: string; content: string }[] }) => Promise<{ response: unknown }>
>;
let pollId: string;
let topicId: string;

async function entry(id: string): Promise<Entry> {
  const value: Entry | null = await getEntry(env, id, "fan");
  if (!value) throw new Error("no entry");
  return value;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  run = vi.fn();
  pollId = crypto.randomUUID();
  topicId = crypto.randomUUID();
  env = {
    DB: database.db,
    AI: { run } as unknown as Ai,
    REQUEST_LIMITER: { limit: (): Promise<{ success: boolean }> => Promise.resolve({ success: true }) },
  } as unknown as AppEnv;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM translation_attempts"),
    ...["host", "fan"].map(
      (id: string): D1PreparedStatement =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,1,1)").bind(
          id,
          id,
          `${id}@example.test`,
        ),
    ),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host','Host')"),
    env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,options,created_at) VALUES (?,'page','host','choice',?,?,?,1)",
    ).bind(pollId, POLL.title, POLL.body, JSON.stringify(POLL.options)),
    env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES (?,'page','host','topic','Thema ohne Text',1)",
    ).bind(topicId),
  ]);
});

describe("the answer of the model for an entry", (): void => {
  it("reads the title, the options and the description", (): void => {
    expect(readEntryAnswer(GOOD)).toEqual({
      title: "Which game?",
      options: ["Elden Ring", "Cozy"],
      body: "Vote!\nEnds on Friday.",
    });
  });
  it("reads JSON text, and removes spaces at the ends", (): void => {
    expect(readEntryAnswer(JSON.stringify(answer(" Title ", [" A "], " Hello\n\nWorld ")))).toEqual({
      title: "Title",
      options: ["A"],
      body: "Hello\n\nWorld",
    });
  });
  it.each(["Here is the translation", { title: "Which game?" }, { title: "A", options: "B", body: "" }, null])(
    "refuses a wrong form: %j",
    (wrong: unknown): void => {
      expect(readEntryAnswer(wrong)).toBeNull();
    },
  );
});

describe("entry translation", (): void => {
  it("accepts only a locale of the site and the text that the reader sees", (): void => {
    expect(entryTranslationSchema.safeParse({ locale: "en", ...POLL }).success).toBe(true);
    expect(entryTranslationSchema.safeParse({ locale: "xx", ...POLL }).success).toBe(false);
    expect(entryTranslationSchema.safeParse({ locale: "en", title: "A" }).success).toBe(false);
  });

  it("translates the title, the options and the description one time", async (): Promise<void> => {
    run.mockResolvedValue({ response: GOOD });
    const expected: EntryText = {
      title: "Which game?",
      options: ["Elden Ring", "Cozy"],
      body: "Vote!\nEnds on Friday.",
    };
    expect(await translateEntry(env, pollId, "fan", "en", NOW, POLL)).toEqual(expected);
    expect(await translateEntry(env, pollId, "host", "en", NOW + 1, POLL)).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(1);
    const [, input] = run.mock.calls[0];
    // The target language comes before the JSON. With the JSON only, the model often gave back the source.
    const [instruction, json] = input.messages[1].content.split(/\n(.*)/su);
    expect(instruction).toBe("Translate into English:");
    expect(JSON.parse(json)).toEqual(POLL);
    expect(input.messages[0].content).toContain("into English");
    const value: Entry = await entry(pollId);
    await attachEntryTranslations(env, [value], "en");
    expect(value.translation).toEqual(expected);
    const french: Entry = await entry(pollId);
    await attachEntryTranslations(env, [french], "fr");
    expect(french.translation).toBeUndefined();
  });

  it.each([
    ["a different number of options", answer("Which game?", ["Elden Ring"], "Vote!\nEnds on Friday.")],
    ["two options with the same name", answer("Which game?", ["Cozy", "Cozy"], "Vote!\nEnds on Friday.")],
    ["a lost line break", answer("Which game?", ["Elden Ring", "Cozy"], "Vote! Ends on Friday.")],
    ["a lost description", answer("Which game?", ["Elden Ring", "Cozy"], "")],
    ["the same text", answer(POLL.title, POLL.options, POLL.body)],
    [
      "an answer in a different language",
      answer("¿Qué juego?", ["Elden Ring", "Acogedor"], "¡Voten ahora!\nTermina el viernes por la noche."),
    ],
    ["a wrong form", "Which game?"],
  ])("gives no translation for %s, and does not ask again", async (_name: string, response: unknown): Promise<void> => {
    run.mockResolvedValue({ response });
    expect(await translateEntry(env, pollId, "fan", "en", NOW, POLL)).toBeNull();
    expect(await translateEntry(env, pollId, "fan", "en", NOW + 1, POLL)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    const value: Entry = await entry(pollId);
    await attachEntryTranslations(env, [value], "en");
    expect(value.translation).toBeNull();
  });

  it("translates a topic that has only a title", async (): Promise<void> => {
    run.mockResolvedValue({ response: answer("Topic without text", [], "") });
    const shown: EntryText = { title: "Thema ohne Text", body: "", options: [] };
    expect(await translateEntry(env, topicId, "fan", "en", NOW, shown)).toEqual({
      title: "Topic without text",
      body: "",
      options: [],
    });
  });

  it("refuses an unknown entry, an old text, and a deployment without the binding", async (): Promise<void> => {
    await expect(translateEntry(env, crypto.randomUUID(), "fan", "en", NOW, POLL)).rejects.toMatchObject({
      status: 404,
    });
    await expect(translateEntry(env, pollId, "fan", "en", NOW, { ...POLL, title: "Old" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(translateEntry({ ...env, AI: undefined }, pollId, "fan", "en", NOW, POLL)).rejects.toMatchObject({
      status: 503,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("gives the original text to a reader of the language of the entry, and hides an answer in English", async (): Promise<void> => {
    const id: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,created_at) VALUES (?,'page','host','topic','Какую игру стримить?','Голосуйте, это важно!',1)",
    )
      .bind(id)
      .run();
    expect(await translateEntry(env, id, "fan", "ru", NOW)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue({ response: answer("Which game to stream?", [], "Vote, it is important!") });
    expect(await translateEntry(env, id, "fan", "uk", NOW)).toBeNull();
    expect(run.mock.calls[0][1].messages[0].content).toContain("into Ukrainian");
    run.mockResolvedValue({ response: answer("Which game to stream?", [], "Vote, it is important!") });
    expect(await translateEntry(env, id, "fan", "en", NOW)).toEqual({
      title: "Which game to stream?",
      body: "Vote, it is important!",
      options: [],
    });
  });

  it("keeps a part in the language of the reader as the author wrote it", async (): Promise<void> => {
    const id: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES (?,'page','host','choice','Which game do we play?',?,1)",
    )
      .bind(id, JSON.stringify(["Ведьмак", "Hades"]))
      .run();
    // The model changes the Russian answer option. A Russian reader gets it unchanged, with the other parts in Russian.
    run.mockResolvedValue({ response: answer("В какую игру играем?", ["Ведьмак 3", "Аид"], "") });
    expect(await translateEntry(env, id, "fan", "ru", NOW)).toEqual({
      title: "В какую игру играем?",
      body: "",
      options: ["Ведьмак", "Аид"],
    });
    // A Russian poll with names in Latin letters has no translation for a Russian reader.
    const russian: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES (?,'page','host','choice','Во что играем сегодня вечером?',?,1)",
    )
      .bind(russian, JSON.stringify(["Hades", "Elden Ring"]))
      .run();
    run.mockClear();
    expect(await translateEntry(env, russian, "fan", "ru", NOW)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    // A kept part with a name in Cyrillic letters does not make the translated parts fail the language check.
    const mixed: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,created_at) VALUES (?,'page','host','topic','Обсуждаем следующую трансляцию и планы на неделю',?,1)",
    )
      .bind(mixed, "Ask Миша about the next stream and the plans for this week.")
      .run();
    run.mockResolvedValue({ response: answer("We discuss the next stream and the plans for the week", [], "Ask Misha.") });
    expect(await translateEntry(env, mixed, "fan", "en", NOW)).toEqual({
      title: "We discuss the next stream and the plans for the week",
      body: "Ask Миша about the next stream and the plans for this week.",
      options: [],
    });
    // Game names in Latin letters stay as they are. The Japanese parts decide the script of a Japanese answer.
    const games: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,options,created_at) VALUES (?,'page','host','choice','Во что играем дальше?','次の配信で遊ぶゲームを選んでください。',?,1)",
    )
      .bind(games, JSON.stringify(["Elden Ring", "Cyberpunk 2077"]))
      .run();
    run.mockResolvedValue({ response: answer("次のゲーム", ["Elden Ring", "Cyberpunk 2077"], "Ignored") });
    expect(await translateEntry(env, games, "fan", "ja", NOW)).toEqual({
      title: "次のゲーム",
      body: "次の配信で遊ぶゲームを選んでください。",
      options: ["Elden Ring", "Cyberpunk 2077"],
    });
  });

  it("uses the same daily count as the comments", async (): Promise<void> => {
    run.mockResolvedValue({ response: GOOD });
    await translateEntry(env, pollId, "fan", "en", NOW, POLL);
    const row = await env.DB.prepare("SELECT COALESCE(SUM(starts),0) AS n FROM translation_attempts").first();
    expect(row).toEqual({ n: 1 });
  });
});
