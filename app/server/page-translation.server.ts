import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { LOCALES } from "../../db/enums";
import type { AppEnv } from "../env";
import type { Locale } from "../i18n";
import type { CommunityCard, EntryText, StreamEvent, Streamer } from "../types";
import { entryNeedsTranslation, translateParts } from "./entry-translation.server";
import { needsTranslation, reserveStart, sha256, translateText } from "./translation.server";

// The texts of one page that one cron run translates. One text starts the model for each site language. The
// batch is small: the work for comments, entries and pages in one day must stay below the daily limit of starts.
export const PAGE_TEXT_BATCH = 1;
// The pages that one cron run examines.
export const PAGE_BATCH = 2;
// The texts that the server translates after one save. A save of the cards can change 8 texts.
const SAVE_BATCH = 8;

type Kind = "about" | "card" | "event";

const storedText = z.object({ title: z.string(), body: z.string(), options: z.array(z.string()) });

function cardText(card: { title: string; body: string; buttonLabel: string | null }): EntryText {
  return { title: card.title, body: card.body, options: card.buttonLabel ? [card.buttonLabel] : [] };
}

function eventText(event: { title: string; notes: string }): EntryText {
  return { title: event.title, body: event.notes, options: [] };
}

function aboutText(about: string): EntryText {
  return { title: "", body: about, options: [] };
}

function textHash(kind: Kind, text: EntryText): Promise<string> {
  return sha256(JSON.stringify([kind, text.title, text.body, text.options]));
}

// The texts that the page has now, by their hash. Equal cards are one text. Streams of one series are one text.
async function pageTexts(env: AppEnv, streamerId: string): Promise<Map<string, { kind: Kind; text: EntryText }>> {
  const [page, cards, events] = await env.DB.batch<Record<string, string | null>>([
    env.DB.prepare("SELECT about FROM streamers WHERE id=?").bind(streamerId),
    env.DB.prepare(
      'SELECT DISTINCT title, body, button_label AS "buttonLabel" FROM community_cards WHERE streamer_id=?',
    ).bind(streamerId),
    env.DB.prepare("SELECT DISTINCT title, notes FROM stream_events WHERE streamer_id=?").bind(streamerId),
  ]);
  const about: string = page.results[0]?.about ?? "";
  const all: { kind: Kind; text: EntryText }[] = [
    ...(about ? [{ kind: "about" as const, text: aboutText(about) }] : []),
    ...cards.results.map((row) => ({
      kind: "card" as const,
      text: cardText({ title: row.title ?? "", body: row.body ?? "", buttonLabel: row.buttonLabel }),
    })),
    ...events.results.map((row) => ({
      kind: "event" as const,
      text: eventText({ title: row.title ?? "", notes: row.notes ?? "" }),
    })),
  ];
  const texts = new Map<string, { kind: Kind; text: EntryText }>();
  for (const item of all) texts.set(await textHash(item.kind, item.text), item);
  return texts;
}

// Starts the model one time for a text and a locale, and stores the result, also "no translation".
async function translateOne(
  env: AppEnv,
  ai: Ai,
  streamerId: string,
  item: { hash: string; kind: Kind; text: EntryText },
  locale: Locale,
  now: number,
): Promise<void> {
  const { hash, kind, text } = item;
  let value: EntryText | null = null;
  // Text without letters, and text in the language of the reader, has no translation and starts no model.
  if (kind === "about" ? needsTranslation(text.body, locale) : entryNeedsTranslation(text, locale)) {
    await reserveStart(env, null, streamerId, locale, hash, now);
    if (kind === "about") {
      const about: string | null = await translateText(ai, locale, text.body);
      value = about === null ? null : aboutText(about);
    } else value = await translateParts(ai, locale, text);
  }
  await env.DB.prepare(
    `INSERT INTO page_translations (streamer_id, source_hash, locale, value, created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(streamer_id, source_hash, locale) DO NOTHING`,
  )
    .bind(streamerId, hash, locale, value && JSON.stringify(value), now)
    .run();
}

/**
 * Translates the About text, the Community cards and the scheduled streams of one page to each site language.
 * It first deletes the stored results of text that the page no longer has. It then translates `limit` texts at
 * most. A stored result starts no model. Gives the number of starts and the number of failed starts.
 */
export async function translatePage(
  env: AppEnv,
  streamerId: string,
  now: number,
  limit: number,
): Promise<{ starts: number; failed: number }> {
  const texts = await pageTexts(env, streamerId);
  await env.DB.prepare(
    "DELETE FROM page_translations WHERE streamer_id=? AND source_hash NOT IN (SELECT value FROM json_each(?))",
  )
    .bind(streamerId, JSON.stringify([...texts.keys()]))
    .run();
  const ai: Ai | undefined = env.AI;
  if (!ai) return { starts: 0, failed: 0 };
  const { results } = await env.DB.prepare("SELECT source_hash, locale FROM page_translations WHERE streamer_id=?")
    .bind(streamerId)
    .all<{ source_hash: string; locale: string }>();
  const done = new Set<string>(results.map((row): string => `${row.source_hash}:${row.locale}`));
  const work: Promise<void>[] = [...texts]
    .map(([hash, item]) => ({
      hash,
      ...item,
      locales: LOCALES.filter((locale: Locale): boolean => !done.has(`${hash}:${locale}`)),
    }))
    .filter((item): boolean => item.locales.length > 0)
    .slice(0, limit)
    .flatMap((item) => item.locales.map((locale: Locale) => translateOne(env, ai, streamerId, item, locale, now)));
  const settled = await Promise.allSettled(work);
  return { starts: work.length, failed: settled.filter((result): boolean => result.status === "rejected").length };
}

/**
 * Translates pages that do not have a stored result for each text and site language. The pages are in random
 * order, so a text that fails each time does not stop the other pages. Each run also examines one more page
 * that has stored results. The hourly job deletes old streams, and their results can make the count of a page
 * complete while a text has no result. The examination deletes these results.
 */
export async function translatePendingPages(env: AppEnv, now: number): Promise<{ starts: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM (SELECT s.id FROM streamers s
      WHERE (SELECT COUNT(*) FROM page_translations t WHERE t.streamer_id=s.id) < ?1 * (
        (s.about != '')
        + (SELECT COUNT(*) FROM (SELECT DISTINCT title, body, button_label FROM community_cards WHERE streamer_id=s.id))
        + (SELECT COUNT(*) FROM (SELECT DISTINCT title, notes FROM stream_events WHERE streamer_id=s.id)))
      ORDER BY random() LIMIT ?2)
      UNION
      SELECT id FROM (SELECT DISTINCT streamer_id AS id FROM page_translations ORDER BY random() LIMIT 1)`,
  )
    .bind(LOCALES.length, PAGE_BATCH)
    .all<{ id: string }>();
  const total = { starts: 0, failed: 0 };
  for (const page of results) {
    const result = await translatePage(env, page.id, now, PAGE_TEXT_BATCH);
    total.starts += result.starts;
    total.failed += result.failed;
  }
  return total;
}

/** Starts the translation of the text of a page after its owner saved it, after the response. */
export function translatePageAfterSave(env: AppEnv, streamerId: string): void {
  waitUntil(translatePage(env, streamerId, Date.now(), SAVE_BATCH));
}

async function storedFor(
  env: AppEnv,
  streamerIds: readonly string[],
  locale: Locale,
): Promise<Map<string, EntryText | null>> {
  const { results } = await env.DB.prepare(
    `SELECT streamer_id, source_hash, value FROM page_translations
      WHERE locale=? AND streamer_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(locale, JSON.stringify(streamerIds))
    .all<{ streamer_id: string; source_hash: string; value: string | null }>();
  return new Map<string, EntryText | null>(
    results.map((row): [string, EntryText | null] => [
      `${row.streamer_id}:${row.source_hash}`,
      row.value === null ? null : storedText.parse(JSON.parse(row.value)),
    ]),
  );
}

/** Puts the stored translation of the About text for `locale` on each page. */
export async function attachAboutTranslations(
  env: AppEnv,
  streamers: readonly Streamer[],
  locale: Locale,
  stored?: Map<string, EntryText | null>,
): Promise<void> {
  const pages: Streamer[] = streamers.filter((streamer: Streamer): boolean => streamer.about !== "");
  if (pages.length === 0) return;
  const rows =
    stored ??
    (await storedFor(
      env,
      pages.map((page: Streamer): string => page.id),
      locale,
    ));
  for (const page of pages) {
    const text = rows.get(`${page.id}:${await textHash("about", aboutText(page.about))}`);
    if (text !== undefined) page.aboutTranslation = text && text.body;
  }
}

/**
 * Puts the stored translations for `locale` on the About text, the cards and the streams of one page. An item
 * without a stored result stays as it is.
 */
export async function attachPageTranslations(
  env: AppEnv,
  streamer: Streamer,
  locale: Locale,
  cards: readonly CommunityCard[] | null,
  events: readonly (StreamEvent | null)[],
): Promise<void> {
  const stored = await storedFor(env, [streamer.id], locale);
  if (stored.size === 0) return;
  await attachAboutTranslations(env, [streamer], locale, stored);
  for (const card of cards ?? []) {
    const text = stored.get(`${streamer.id}:${await textHash("card", cardText(card))}`);
    if (text !== undefined)
      card.translation = text && { title: text.title, body: text.body, buttonLabel: text.options[0] ?? null };
  }
  // Streams of one series have the same text, so the page computes each hash one time.
  const hashes = new Map<string, Promise<string>>();
  for (const event of events) {
    if (!event) continue;
    const key: string = JSON.stringify([event.title, event.notes]);
    const hash: Promise<string> = hashes.get(key) ?? textHash("event", eventText(event));
    hashes.set(key, hash);
    const text = stored.get(`${streamer.id}:${await hash}`);
    if (text !== undefined) event.translation = text && { title: text.title, notes: text.body };
  }
}
