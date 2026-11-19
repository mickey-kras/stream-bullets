import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiError, errorMessage } from "../app/components/api";
import type { AppEnv } from "../app/env";
import { DEFAULT_LOCALE, LOCALES, loadCatalog, setLocaleSource, t, type Locale } from "../app/i18n";
import {
  BINARY_LABEL_MAX_LENGTH,
  BINARY_OPTIONS,
  binaryLabelInput,
  binaryOptions,
  isBinaryLabelPair,
} from "../app/lib/polls";
import { getEntry, getOverlaySnapshot, mutateEntry } from "../app/server/data.server";
import { readJson } from "../app/server/http.server";
import { mashCreateSchema } from "../app/server/mash.server";
import { entryActionSchema } from "../app/server/validation";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

interface LabelRow {
  author_id: string;
  options: string;
  binary_labels: string | null;
}

let database: TestDatabase;
let env: AppEnv;

function binaryPoll(options?: readonly unknown[]): Record<string, unknown> {
  return { action: "create", kind: "binary", title: "One more round?", ...(options ? { options } : {}) };
}

async function labelRow(id: string): Promise<LabelRow | null> {
  return env.DB.prepare("SELECT author_id,options,binary_labels FROM entries WHERE id=?").bind(id).first<LabelRow>();
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db, IMAGES: database.bucket, APP_ORIGIN: "https://stream.example.test" } as AppEnv;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
      ('host','Host','host@example.test',1,1,1),('fan','Fan','fan@example.test',1,1,1)`),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host_page','Host')"),
  ]);
});

afterAll(async (): Promise<void> => database.dispose());

afterEach((): void => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

describe("custom poll label helpers", (): void => {
  it("has two different default labels in each language", (): void => {
    for (const locale of LOCALES) expect(isBinaryLabelPair(binaryOptions(locale)), locale).toBe(true);
    expect(binaryOptions("en")).toEqual(BINARY_OPTIONS);
    expect(binaryOptions("de")).toEqual(["Ja", "Nein"]);
  });

  it("sends no labels for two empty inputs, and only the filled ones otherwise", (): void => {
    expect(binaryLabelInput("", "  ")).toBeUndefined();
    expect(binaryLabelInput(" Keep ", "Skip")).toEqual(["Keep", "Skip"]);
    expect(binaryLabelInput("Keep", " ")).toEqual(["Keep"]);
  });
});

describe("custom poll label validation", (): void => {
  it("accepts no labels or two trimmed labels that differ", (): void => {
    expect(entryActionSchema.parse(binaryPoll())).toMatchObject({ kind: "binary" });
    expect(entryActionSchema.parse(binaryPoll(["  Keep ", "Skip"]))).toMatchObject({ options: ["Keep", "Skip"] });
    const longest: string = "a".repeat(BINARY_LABEL_MAX_LENGTH);
    expect(entryActionSchema.parse(binaryPoll([longest, "b"]))).toMatchObject({ options: [longest, "b"] });
  });

  it.each([
    ["one label", ["Keep"]],
    ["three labels", ["Keep", "Skip", "Later"]],
    ["the same label twice", ["Keep", "Keep"]],
    ["labels that differ only in letter case", ["Keep", "KEEP"]],
    ["labels that differ only in outer spaces", ["Keep", " Keep "]],
  ])("refuses %s with the stable code", (_name: string, options: readonly string[]): void => {
    const result = entryActionSchema.safeParse(binaryPoll(options));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: "custom", params: { apiCode: "binary_options_invalid" } });
  });

  it.each([
    ["an empty label", ["", "Skip"]],
    ["a blank label", ["Keep", "   "]],
    ["a label over the limit", ["a".repeat(BINARY_LABEL_MAX_LENGTH + 1), "Skip"]],
    ["a label with a line break", ["Keep\nit", "Skip"]],
    ["a label that is not text", [1, "Skip"]],
    ["an empty list", []],
  ])("refuses %s", (_name: string, options: readonly unknown[]): void => {
    expect(entryActionSchema.safeParse(binaryPoll(options)).success).toBe(false);
  });

  it("keeps the rule of choice polls: 2 to 6 different options", (): void => {
    const choice = (options: readonly string[]): boolean =>
      entryActionSchema.safeParse({ action: "create", kind: "choice", title: "Which?", options }).success;
    expect(choice(["A", "B"])).toBe(true);
    expect(choice(["A"])).toBe(false);
    expect(choice(["A", "a"])).toBe(false);
    expect(choice(["A", "B", "C", "D", "E", "F", "G"])).toBe(false);
  });

  it("returns the code from the create endpoint schema and from the mutation", async (): Promise<void> => {
    const request = new Request("https://stream.example.test/api/streamers/host_page/entries", {
      method: "POST",
      body: JSON.stringify(binaryPoll(["Keep"])),
      headers: { "Content-Type": "application/json" },
    });
    const refusal = { status: 400, code: "binary_options_invalid" };
    await expect(readJson(request, mashCreateSchema.or(entryActionSchema))).rejects.toMatchObject(refusal);
    for (const author of ["host", "fan"])
      await expect(mutateEntry(env, author, "page", binaryPoll(["Same", "same"]))).rejects.toMatchObject(refusal);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM entries").first<{ count: number }>())?.count).toBe(0);
  });

  it.each(LOCALES)("%s has its own text for the code", async (locale: Locale): Promise<void> => {
    await loadCatalog(locale);
    setLocaleSource((): Locale => locale);
    const message: string = errorMessage(new ApiError("English server detail", 400, "binary_options_invalid"));
    expect(message).toBe(t("error.binaryOptions"));
    expect(message).not.toBe("English server detail");
  });
});

describe("custom poll label write", (): void => {
  it.each([
    ["the page owner", "host"],
    ["a viewer", "fan"],
  ])("stores the labels of %s and shows them to readers", async (_name: string, author: string): Promise<void> => {
    const created = await mutateEntry(env, author, "page", binaryPoll([" Keep going ", "Stop"]));
    expect(await labelRow(created.id)).toEqual({
      author_id: author,
      options: '["Yes","No"]',
      binary_labels: '["Keep going","Stop"]',
    });
    expect(await getEntry(env, created.id, "fan")).toMatchObject({
      kind: "binary",
      authorId: author,
      options: ["Keep going", "Stop"],
      counts: null,
    });
    await mutateEntry(env, "fan", "page", { action: "vote", id: created.id, choice: 1 });
    expect(await getEntry(env, created.id, "fan")).toMatchObject({ myVote: 1, total: 1 });
    const overlay = await getOverlaySnapshot(env, "page", created.id);
    expect(overlay.polls[0]).toMatchObject({ id: created.id, options: ["Keep going", "Stop"] });
  });

  it.each([
    ["the page owner", "host"],
    ["a viewer", "fan"],
  ])("stores no labels for %s without custom labels", async (_name: string, author: string): Promise<void> => {
    for (const options of [undefined, [...BINARY_OPTIONS]]) {
      const created = await mutateEntry(env, author, "page", binaryPoll(options));
      expect(await labelRow(created.id)).toEqual({ author_id: author, options: '["Yes","No"]', binary_labels: null });
      expect(await getEntry(env, created.id, null)).toMatchObject({ options: ["Yes", "No"] });
    }
  });

  it("stores the default words in another order as custom labels", async (): Promise<void> => {
    const created = await mutateEntry(env, "fan", "page", binaryPoll(["No", "Yes"]));
    expect(await labelRow(created.id)).toMatchObject({ binary_labels: '["No","Yes"]' });
  });
});
