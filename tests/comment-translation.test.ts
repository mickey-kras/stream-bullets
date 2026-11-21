import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AppEnv } from "../app/env";
import { deleteComment, mutateComment } from "../app/server/comments.server";
import {
  pruneTranslationAttempts,
  TRANSLATION_ATTEMPT_RETENTION_MS,
  TRANSLATION_DAILY_LIMIT,
  translateComment,
  translationSchema,
} from "../app/server/translation.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const NOW = 1_800_000_000_000;
const SOURCE = "**Hi** @Bob Lee, see `x`";

let database: TestDatabase;
let env: AppEnv;
let run: Mock<
  (model: string, input: { messages: { role: string; content: string }[] }) => Promise<{ response: string }>
>;
let allowed: boolean;
let entryId: string;

function answer(text: string): { response: string } {
  return { response: `ORIGINAL=en\n---\n${text}` };
}

async function seedComment(text: string = SOURCE): Promise<string> {
  const id: string = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'fan',?,1)").bind(
      id,
      entryId,
      text,
    ),
    env.DB.prepare('INSERT INTO comment_mentions (comment_id,user_id,start,"end") VALUES (?,?,7,15)').bind(id, "bob"),
  ]);
  return id;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  run = vi.fn();
  allowed = true;
  entryId = crypto.randomUUID();
  env = {
    DB: database.db,
    AI: { run } as unknown as Ai,
    REQUEST_LIMITER: { limit: (): Promise<{ success: boolean }> => Promise.resolve({ success: allowed }) },
  } as unknown as AppEnv;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM translation_attempts"),
    ...["host", "fan", "bob"].map(
      (id: string): D1PreparedStatement =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,1,1)").bind(
          id,
          id,
          `${id}@example.test`,
        ),
    ),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host','Host')"),
    env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES (?,'page','host','topic','Topic',1)",
    ).bind(entryId),
  ]);
});

describe("comment translation", (): void => {
  it("accepts only a locale of the site", (): void => {
    expect(translationSchema.safeParse({ locale: "de" }).success).toBe(true);
    expect(translationSchema.safeParse({ locale: "xx" }).success).toBe(false);
    expect(translationSchema.safeParse({ locale: "de", model: "other" }).success).toBe(false);
  });

  it("gives the translation with the mention at its new position", async (): Promise<void> => {
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    const id: string = await seedComment();
    expect(await translateComment(env, id, "fan", "de", NOW)).toEqual({
      text: "**Hallo** @Bob Lee, siehe `x`",
      mentions: [{ userId: "bob", start: 10, end: 18 }],
    });
    const [, input] = run.mock.calls[0];
    expect(input.messages[1].content).toBe(`German\n@Bob Lee\n${SOURCE}`);
  });

  it("runs the model one time for each comment text and locale", async (): Promise<void> => {
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    const id: string = await seedComment();
    const first = await translateComment(env, id, "fan", "de", NOW);
    expect(await translateComment(env, id, "host", "de", NOW + 1)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    await translateComment(env, id, "fan", "fr", NOW + 2);
    expect(run).toHaveBeenCalledTimes(2);
    await env.DB.prepare("UPDATE entry_comments SET text=? WHERE id=?").bind("**Yo** @Bob Lee, see `x`", id).run();
    await translateComment(env, id, "fan", "de", NOW + 3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["changed code", "**Hallo** @Bob Lee, siehe `y`"],
    ["lost Markdown", "Hallo @Bob Lee, siehe `x`"],
    ["lost mention", "**Hallo** @Robert, siehe `x`"],
    ["the same text", SOURCE],
  ])("gives no translation for %s, and does not ask again", async (_name: string, text: string): Promise<void> => {
    run.mockResolvedValue(answer(text));
    const id: string = await seedComment();
    expect(await translateComment(env, id, "fan", "de", NOW)).toBeNull();
    expect(await translateComment(env, id, "fan", "de", NOW + 1)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives no translation for an answer in the wrong form", async (): Promise<void> => {
    run.mockResolvedValue({ response: "Here is the translation: Hallo" });
    expect(await translateComment(env, await seedComment(), "fan", "de", NOW)).toBeNull();
  });

  it("refuses a removed or unknown comment and does not run the model", async (): Promise<void> => {
    const id: string = await seedComment();
    await env.DB.prepare("UPDATE entry_comments SET removed_at=1 WHERE id=?").bind(id).run();
    await expect(translateComment(env, id, "fan", "de", NOW)).rejects.toMatchObject({ status: 404 });
    await expect(translateComment(env, crypto.randomUUID(), "fan", "de", NOW)).rejects.toMatchObject({ status: 404 });
    expect(run).not.toHaveBeenCalled();
  });

  it("is off without the Workers AI binding", async (): Promise<void> => {
    const id: string = await seedComment();
    await expect(translateComment({ ...env, AI: undefined }, id, "fan", "de", NOW)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("stops at the request limit of the account, but still gives a stored translation", async (): Promise<void> => {
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    const stored: string = await seedComment();
    await translateComment(env, stored, "fan", "de", NOW);
    allowed = false;
    await expect(translateComment(env, await seedComment(), "fan", "de", NOW)).rejects.toMatchObject({ status: 429 });
    expect(await translateComment(env, stored, "fan", "de", NOW)).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops at the daily limit of model starts, also after edits and removals", async (): Promise<void> => {
    const id: string = await seedComment();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
        INSERT INTO translation_attempts (comment_id, locale, source_hash, created_at) SELECT 'gone', 'de', 'h'||i, ? FROM n`,
    )
      .bind(TRANSLATION_DAILY_LIMIT, NOW - 1000)
      .run();
    await expect(translateComment(env, id, "fan", "de", NOW)).rejects.toMatchObject({ status: 503 });
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    expect(await translateComment(env, id, "fan", "de", NOW + 86_400_000)).not.toBeNull();
  });

  it("starts the model one time for two requests at the same time", async (): Promise<void> => {
    let finish: (value: { response: string }) => void = (): void => undefined;
    run.mockReturnValue(
      new Promise<{ response: string }>((resolve) => {
        finish = resolve;
      }),
    );
    const id: string = await seedComment();
    const first = translateComment(env, id, "fan", "de", NOW);
    await vi.waitFor((): void => expect(run).toHaveBeenCalledTimes(1));
    await expect(translateComment(env, id, "host", "de", NOW + 1)).rejects.toMatchObject({ status: 409 });
    finish(answer("**Hallo** @Bob Lee, siehe `x`"));
    expect(await first).not.toBeNull();
    expect(await translateComment(env, id, "host", "de", NOW + 2)).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a later request try again after the model failed", async (): Promise<void> => {
    run.mockRejectedValueOnce(new Error("model down"));
    const id: string = await seedComment();
    await expect(translateComment(env, id, "fan", "de", NOW)).rejects.toThrow("model down");
    await expect(translateComment(env, id, "fan", "de", NOW + 1)).rejects.toMatchObject({ status: 409 });
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    expect(await translateComment(env, id, "fan", "de", NOW + 60_001)).not.toBeNull();
    // The failed start stays in the daily count.
    const row = await env.DB.prepare("SELECT starts FROM translation_attempts WHERE comment_id=?").bind(id).first();
    expect(row).toEqual({ starts: 2 });
  });

  it("deletes the stored translations when the comment is removed or edited", async (): Promise<void> => {
    run.mockResolvedValue(answer("**Hallo** @Bob Lee, siehe `x`"));
    const stored = async (id: string): Promise<number> => {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_translations WHERE comment_id=?")
        .bind(id)
        .first<{ n: number }>();
      return row?.n ?? -1;
    };
    // A removed comment with a reply stays as a placeholder row.
    const parent: string = await seedComment();
    await env.DB.prepare(
      "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,'host','Reply',2,?)",
    )
      .bind(crypto.randomUUID(), entryId, parent)
      .run();
    await translateComment(env, parent, "host", "de", NOW);
    expect(await stored(parent)).toBe(1);
    await deleteComment(env, "fan", parent);
    expect(await stored(parent)).toBe(0);

    const edited: string = await seedComment();
    await translateComment(env, edited, "host", "de", NOW);
    await mutateComment(env, "fan", { action: "edit", id: edited, text: "New text", mentions: [] });
    expect(await stored(edited)).toBe(0);
  });

  it("does not store the translation of a text that changed while the model ran", async (): Promise<void> => {
    const id: string = await seedComment();
    run.mockImplementation(async (): Promise<{ response: string }> => {
      await env.DB.prepare("UPDATE entry_comments SET text='Other text' WHERE id=?").bind(id).run();
      return answer("**Hallo** @Bob Lee, siehe `x`");
    });
    await translateComment(env, id, "host", "de", NOW);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comment_translations WHERE comment_id=?")
      .bind(id)
      .first();
    expect(row).toEqual({ n: 0 });
  });

  it("removes the old rows of the daily count", async (): Promise<void> => {
    await env.DB.prepare(
      "INSERT INTO translation_attempts (comment_id, locale, source_hash, created_at) VALUES ('a','de','old',?),('a','de','new',?)",
    )
      .bind(NOW - TRANSLATION_ATTEMPT_RETENTION_MS - 1, NOW - 1000)
      .run();
    await pruneTranslationAttempts(env, NOW).run();
    const { results } = await env.DB.prepare("SELECT source_hash FROM translation_attempts WHERE comment_id='a'").all();
    expect(results).toEqual([{ source_hash: "new" }]);
  });
});
