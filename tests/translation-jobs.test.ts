import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LOCALES } from "../db/enums";
import type { AppEnv } from "../app/env";
import { translateItem, translatePending } from "../app/server/translation-jobs.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const NOW = 1_800_000_000_000;

interface Input {
  messages: { role: string; content: string }[];
}

let database: TestDatabase;
let env: AppEnv;
let run: Mock<(model: string, input: Input) => Promise<{ response: string }>>;
let entryId: string;

// A translation that has the name of the target language, so each language has a different text.
function answer(_model: string, input: Input): Promise<{ response: string }> {
  const [language] = input.messages[1].content.split("\n");
  const entry: boolean = input.messages[0].content.includes("topics and polls");
  return Promise.resolve({
    response: entry ? `ORIGINAL=de\n---\nTitle in ${language}\n---\n---\n---` : `ORIGINAL=de\n---\nText in ${language}`,
  });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

async function addComment(text: string): Promise<string> {
  const id: string = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'fan',?,1)")
    .bind(id, entryId, text)
    .run();
  return id;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  run = vi.fn(answer);
  entryId = crypto.randomUUID();
  env = {
    DB: database.db,
    AI: { run } as unknown as Ai,
    REQUEST_LIMITER: { limit: (): Promise<{ success: boolean }> => Promise.resolve({ success: false }) },
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
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES (?,'page','host','topic','Ein Thema',1)",
    ).bind(entryId),
  ]);
});

describe("translation of new and old content", (): void => {
  it("stores a result for each site language, with no account limit, and starts no model again", async (): Promise<void> => {
    await addComment("Hallo Welt");
    await addComment("Noch ein Kommentar");
    expect(await translatePending(env, NOW)).toBe(3);
    expect(await count("comment_translations")).toBe(2 * LOCALES.length);
    expect(await count("entry_translations")).toBe(LOCALES.length);
    expect(run).toHaveBeenCalledTimes(3 * LOCALES.length);
    const french = await env.DB.prepare("SELECT title FROM entry_translations WHERE entry_id=? AND locale='fr'")
      .bind(entryId)
      .first();
    expect(french).toEqual({ title: "Title in French" });
    expect(await translatePending(env, NOW + 1)).toBe(0);
    expect(run).toHaveBeenCalledTimes(3 * LOCALES.length);
  });

  it("translates an edited comment again", async (): Promise<void> => {
    const id: string = await addComment("Hallo Welt");
    await translatePending(env, NOW);
    run.mockClear();
    await env.DB.batch([
      env.DB.prepare("UPDATE entry_comments SET text='Neuer Text', edited_at=5 WHERE id=?").bind(id),
      env.DB.prepare("DELETE FROM comment_translations WHERE comment_id=?").bind(id),
    ]);
    expect(await translatePending(env, NOW + 120_000)).toBe(1);
    expect(run).toHaveBeenCalledTimes(LOCALES.length);
  });

  it("takes the newest items first, up to the limit", async (): Promise<void> => {
    await addComment("Alt");
    const newest: string = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'fan','Neu',9)",
    )
      .bind(newest, entryId)
      .run();
    await translatePending(env, NOW, 1);
    const rows = await env.DB.prepare("SELECT DISTINCT comment_id FROM comment_translations").all();
    expect(rows.results).toEqual([{ comment_id: newest }]);
  });

  it("leaves an item for the next run when the model fails for one language", async (): Promise<void> => {
    run.mockImplementation((model: string, input: Input) =>
      input.messages[1].content.startsWith("French\n") ? Promise.reject(new Error("model down")) : answer(model, input),
    );
    expect(await translatePending(env, NOW)).toBe(1);
    expect(await count("entry_translations")).toBe(LOCALES.length - 1);
    run.mockImplementation(answer);
    expect(await translatePending(env, NOW + 120_000)).toBe(1);
    expect(await count("entry_translations")).toBe(LOCALES.length);
  });

  it("translates one posted item to each site language", async (): Promise<void> => {
    const posted: string = await addComment("Hallo Welt");
    await addComment("Ein anderer Kommentar");
    await translateItem(env, "comment", posted, NOW);
    const rows = await env.DB.prepare("SELECT DISTINCT comment_id FROM comment_translations").all();
    expect(rows.results).toEqual([{ comment_id: posted }]);
    expect(await count("comment_translations")).toBe(LOCALES.length);
    await translateItem(env, "entry", entryId, NOW);
    expect(await count("entry_translations")).toBe(LOCALES.length);
  });

  it("fails the run when each start fails", async (): Promise<void> => {
    run.mockRejectedValue(new Error("model down"));
    await expect(translatePending(env, NOW)).rejects.toThrow("translation starts failed");
  });

  it("does nothing without the Workers AI binding", async (): Promise<void> => {
    await addComment("Hallo Welt");
    expect(await translatePending({ ...env, AI: undefined }, NOW)).toBe(0);
    expect(await count("comment_translations")).toBe(0);
  });
});
