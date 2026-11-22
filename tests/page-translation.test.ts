import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LOCALES } from "../db/enums";
import type { AppEnv } from "../app/env";
import {
  attachAboutTranslations,
  attachPageTranslations,
  translatePage,
  translatePendingPages,
} from "../app/server/page-translation.server";
import type { CommunityCard, StreamEvent, Streamer } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));
// These tests are about the job. Without the detector, text in Latin letters has no known language.
vi.mock("../app/lib/text-language", async (original) => ({
  ...(await original<typeof import("../app/lib/text-language")>()),
  loadLanguageDetector: vi.fn().mockResolvedValue(undefined),
}));

const NOW = 1_800_000_000_000;
const ABOUT = "Ich streame Rollenspiele.";

interface Input {
  messages: { role: string; content: string }[];
}

let database: TestDatabase;
let env: AppEnv;
let run: Mock<(model: string, input: Input) => Promise<{ response: unknown }>>;

function targetOf(input: Input): string {
  return input.messages[0].content.split(" into ")[1]?.split(".")[0] ?? "";
}

// A translation that has the name of the target language. It keeps the number of answer options.
function answer(_model: string, input: Input): Promise<{ response: unknown }> {
  const language: string = targetOf(input);
  if (!input.messages[0].content.includes("topics and polls"))
    return Promise.resolve({ response: `ORIGINAL=de\n---\nAbout in ${language}` });
  const source = JSON.parse(input.messages[1].content) as { options: string[]; body: string };
  return Promise.resolve({
    response: {
      title: `Title in ${language}`,
      options: source.options.map((): string => `Button in ${language}`),
      body: source.body ? `Body in ${language}` : "",
    },
  });
}

async function count(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM page_translations").first<{ n: number }>();
  return row?.n ?? -1;
}

function addEvent(title: string, startsAt: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO stream_events (id,streamer_id,title,notes,starts_at,duration_min,platform,url,tz,created_at,updated_at)
      VALUES (?,'page',?,'',?,60,'twitch','https://twitch.tv/host','UTC',1,1)`,
  ).bind(crypto.randomUUID(), title, startsAt);
}

function page(about: string = ABOUT): Streamer {
  return { id: "page", about } as Streamer;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  run = vi.fn(answer);
  env = { DB: database.db, AI: { run } as unknown as Ai } as unknown as AppEnv;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM translation_attempts"),
    env.DB.prepare(
      "INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('host','host','host@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name,about) VALUES ('page','host','host','Host',?)").bind(
      ABOUT,
    ),
    env.DB.prepare(
      `INSERT INTO community_cards (id,streamer_id,position,title,body,button_label,button_target)
        VALUES ('card','page',0,'Regeln','Seid nett.','Mehr lesen','tab:about')`,
    ),
    // Two streams of one series have the same text.
    addEvent("Montagsrunde", NOW),
    addEvent("Montagsrunde", NOW + 604_800_000),
  ]);
});

describe("translation of the text of a page", (): void => {
  it("stores a result for each text and site language, and one result for equal streams", async (): Promise<void> => {
    expect(await translatePage(env, "page", NOW, 8)).toEqual({ starts: 3 * LOCALES.length, failed: 0 });
    expect(await count()).toBe(3 * LOCALES.length);
    expect(run).toHaveBeenCalledTimes(3 * LOCALES.length);
    expect(await translatePage(env, "page", NOW + 1, 8)).toEqual({ starts: 0, failed: 0 });
  });

  it("gives the reader the About text, the cards and the streams in the site language", async (): Promise<void> => {
    await translatePage(env, "page", NOW, 8);
    const streamer: Streamer = page();
    const card = { id: "card", title: "Regeln", body: "Seid nett.", buttonLabel: "Mehr lesen" } as CommunityCard;
    const event = { id: "e", title: "Montagsrunde", notes: "" } as StreamEvent;
    const other = { id: "o", title: "Kein Ergebnis", notes: "" } as StreamEvent;
    await attachPageTranslations(env, streamer, "fr", [card], [event, other, null]);
    expect(streamer.aboutTranslation).toBe("About in French");
    expect(card.translation).toEqual({
      title: "Title in French",
      body: "Body in French",
      buttonLabel: "Button in French",
    });
    expect(event.translation).toEqual({ title: "Title in French", notes: "" });
    expect(other.translation).toBeUndefined();
    const listed: Streamer = page();
    await attachAboutTranslations(env, [listed, page("")], "de");
    expect(listed.aboutTranslation).toBe("About in German");
  });

  it("deletes the results of text that the page no longer has, and translates the new text", async (): Promise<void> => {
    await translatePage(env, "page", NOW, 8);
    run.mockClear();
    await env.DB.batch([
      env.DB.prepare("UPDATE streamers SET about='Neuer Text' WHERE id='page'"),
      env.DB.prepare("DELETE FROM community_cards"),
    ]);
    expect(await translatePage(env, "page", NOW + 1, 8)).toEqual({ starts: LOCALES.length, failed: 0 });
    expect(await count()).toBe(2 * LOCALES.length);
    const streamer: Streamer = page();
    await attachPageTranslations(env, streamer, "fr", null, []);
    expect(streamer.aboutTranslation).toBeUndefined();
  });

  it("stores no translation when the text did not change, and starts no model for text without letters", async (): Promise<void> => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM community_cards"),
      env.DB.prepare("DELETE FROM stream_events"),
      addEvent("24/7 !!!", NOW),
    ]);
    run.mockImplementation((_model: string, input: Input) =>
      Promise.resolve({ response: `ORIGINAL=de\n---\n${input.messages[1].content.split("\n").slice(2).join("\n")}` }),
    );
    await translatePage(env, "page", NOW, 8);
    expect(run).toHaveBeenCalledTimes(LOCALES.length);
    const streamer: Streamer = page();
    const event = { id: "e", title: "24/7 !!!", notes: "" } as StreamEvent;
    await attachPageTranslations(env, streamer, "en", null, [event]);
    expect(streamer.aboutTranslation).toBeNull();
    expect(event.translation).toBeNull();
  });

  it("translates a limited number of texts in one run of the job", async (): Promise<void> => {
    for (const run of [0, 1, 2])
      expect(await translatePendingPages(env, NOW + run)).toEqual({ starts: LOCALES.length, failed: 0 });
    expect(await translatePendingPages(env, NOW + 3)).toEqual({ starts: 0, failed: 0 });
  });

  it("leaves a text for the next run when the model fails for one language", async (): Promise<void> => {
    run.mockImplementation((model: string, input: Input) =>
      targetOf(input) === "French" ? Promise.reject(new Error("model down")) : answer(model, input),
    );
    expect(await translatePage(env, "page", NOW, 8)).toEqual({ starts: 3 * LOCALES.length, failed: 3 });
    run.mockImplementation(answer);
    expect(await translatePendingPages(env, NOW + 120_000)).toEqual({ starts: 1, failed: 0 });
  });

  it("gives the original text to a reader of the language of the text, and starts no model", async (): Promise<void> => {
    await env.DB.batch([
      env.DB.prepare("UPDATE streamers SET about='Я стримлю ролевые игры по вечерам.' WHERE id='page'"),
      env.DB.prepare("DELETE FROM community_cards"),
      env.DB.prepare("DELETE FROM stream_events"),
      addEvent("Вечерний стрим: отвечаю на вопросы", NOW),
    ]);
    await translatePage(env, "page", NOW, 8);
    // 2 texts, and no start for the Russian reader.
    expect(run).toHaveBeenCalledTimes(2 * (LOCALES.length - 1));
    const streamer: Streamer = page("Я стримлю ролевые игры по вечерам.");
    const event = { id: "e", title: "Вечерний стрим: отвечаю на вопросы", notes: "" } as StreamEvent;
    await attachPageTranslations(env, streamer, "ru", null, [event]);
    expect(streamer.aboutTranslation).toBeNull();
    expect(event.translation).toBeNull();
  });

  it("finds a new text when the results of a deleted stream make the count complete", async (): Promise<void> => {
    await translatePage(env, "page", NOW, 8);
    // A job deleted the streams, and the owner added a stream. The page has the same number of texts.
    await env.DB.batch([env.DB.prepare("DELETE FROM stream_events"), addEvent("Neuer Stream", NOW)]);
    expect(await translatePendingPages(env, NOW + 1)).toEqual({ starts: LOCALES.length, failed: 0 });
    expect(await count()).toBe(3 * LOCALES.length);
  });

  it("only deletes old results without the Workers AI binding", async (): Promise<void> => {
    await translatePage(env, "page", NOW, 8);
    await env.DB.prepare("UPDATE streamers SET about='' WHERE id='page'").run();
    expect(await translatePage({ ...env, AI: undefined }, "page", NOW + 1, 8)).toEqual({ starts: 0, failed: 0 });
    expect(await count()).toBe(2 * LOCALES.length);
  });
});
