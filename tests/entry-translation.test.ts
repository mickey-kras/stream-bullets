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
const GOOD = "ORIGINAL=de\n---\nWhich game?\n---\nElden Ring\nCozy\n---\nVote!\nEnds on Friday.";

let database: TestDatabase;
let env: AppEnv;
let run: Mock<
  (model: string, input: { messages: { role: string; content: string }[] }) => Promise<{ response: string }>
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
  it.each([
    [
      "no options and no description",
      "ORIGINAL=en\n---\nTitle\n---\n---\n---",
      { title: "Title", options: [], body: "" },
    ],
    [
      "no options",
      "ORIGINAL=ru\n---\nIdea\n---\n---\nIt is good.",
      { title: "Idea", options: [], body: "It is good." },
    ],
    [
      "a separator line in the description",
      "ORIGINAL=de\n---\nTitle\n---\nA\nB\n---\nHello\n\n---\n\nWorld",
      { title: "Title", options: ["A", "B"], body: "Hello\n\n---\n\nWorld" },
    ],
  ])("reads an answer with %s", (_name: string, answer: string, expected: EntryText): void => {
    expect(readEntryAnswer(answer)).toEqual(expected);
  });
  it.each(["Here is the translation", "ORIGINAL=de\nWhich game?", "ORIGINAL=de\n---\n\n---\nA\n---\n"])(
    "refuses a wrong form: %s",
    (answer: string): void => {
      expect(readEntryAnswer(answer)).toBeNull();
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
    expect(input.messages[1].content).toBe(`English\n${POLL.title}\n---\nElden Ring\nGemütlich\n---\n${POLL.body}`);
    const value: Entry = await entry(pollId);
    await attachEntryTranslations(env, [value], "en");
    expect(value.translation).toEqual(expected);
    const french: Entry = await entry(pollId);
    await attachEntryTranslations(env, [french], "fr");
    expect(french.translation).toBeUndefined();
  });

  it.each([
    ["a different number of options", "ORIGINAL=de\n---\nWhich game?\n---\nElden Ring\n---\nVote!\nEnds on Friday."],
    ["two options with the same name", "ORIGINAL=de\n---\nWhich game?\n---\nCozy\nCozy\n---\nVote!\nEnds on Friday."],
    ["a lost line break", "ORIGINAL=de\n---\nWhich game?\n---\nElden Ring\nCozy\n---\nVote! Ends on Friday."],
    ["a lost description", "ORIGINAL=de\n---\nWhich game?\n---\nElden Ring\nCozy\n---\n"],
    ["the same text", `ORIGINAL=de\n---\n${POLL.title}\n---\nElden Ring\nGemütlich\n---\n${POLL.body}`],
    ["a wrong form", "Which game?"],
  ])("gives no translation for %s, and does not ask again", async (_name: string, response: string): Promise<void> => {
    run.mockResolvedValue({ response });
    expect(await translateEntry(env, pollId, "fan", "en", NOW, POLL)).toBeNull();
    expect(await translateEntry(env, pollId, "fan", "en", NOW + 1, POLL)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    const value: Entry = await entry(pollId);
    await attachEntryTranslations(env, [value], "en");
    expect(value.translation).toBeNull();
  });

  it("translates a topic that has only a title", async (): Promise<void> => {
    run.mockResolvedValue({ response: "ORIGINAL=de\n---\nTopic without text\n---\n---\n---" });
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

  it("uses the same daily count as the comments", async (): Promise<void> => {
    run.mockResolvedValue({ response: GOOD });
    await translateEntry(env, pollId, "fan", "en", NOW, POLL);
    const row = await env.DB.prepare("SELECT COALESCE(SUM(starts),0) AS n FROM translation_attempts").first();
    expect(row).toEqual({ n: 1 });
  });
});
