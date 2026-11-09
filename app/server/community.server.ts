import type { AppEnv } from "../env";
import type { CardIcon, CommunityCard } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { communityCardsSchema, type CommunityCardInput } from "./validation";

interface CardRow {
  id: string;
  icon: CardIcon | null;
  title: string;
  body: string;
  button_label: string | null;
  button_target: string | null;
}

function cardValue(row: CardRow): CommunityCard {
  return {
    id: row.id,
    icon: row.icon,
    title: row.title,
    body: row.body,
    buttonLabel: row.button_label,
    buttonTarget: row.button_target,
  };
}

/** The page's cards in order, or null when the owner never saved any (the page then shows the defaults, R18). */
export async function listCards(env: AppEnv, streamerId: string): Promise<CommunityCard[] | null> {
  const { results } = await env.DB.prepare("SELECT * FROM community_cards WHERE streamer_id=? ORDER BY position")
    .bind(streamerId)
    .all<CardRow>();
  return results.length === 0 ? null : results.map(cardValue);
}

/** An overlay source that names a card no longer on the page goes to Hidden, never to another card. */
function clearedCard(column: "air" | "preview"): string {
  return `CASE WHEN json_extract(${column},'$.type')='card' AND json_extract(${column},'$.ref') IS NOT NULL
    AND json_extract(${column},'$.ref') NOT IN (SELECT id FROM community_cards WHERE streamer_id=?1)
    THEN '{"type":"hidden","ref":null}' ELSE ${column} END`;
}

/**
 * `PUT /api/community-cards`: replaces the owner's whole ordered list (at most 8) in one atomic batch. Saving an
 * empty list brings the two default cards back, because no rows means defaults. A card sent with the id of one of
 * the page's cards keeps that id, so the overlay keeps showing it; the rows are rewritten because the position
 * index is unique and positions only go up to 7. An overlay that shows a card gets a new revision, so it reloads.
 */
export async function saveCards(env: AppEnv, viewerId: string, value: unknown): Promise<CommunityCard[] | null> {
  const result = communityCardsSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid cards.");
  const page = await env.DB.prepare("SELECT id FROM streamers WHERE owner_id=?").bind(viewerId).first<{ id: string }>();
  if (!page) throw new HttpError(403, "Only streamers can edit Community cards.");
  await assertStreamerWritable(env, page.id, viewerId);
  await consumeMutationQuota(env, viewerId, true);
  const { results } = await env.DB.prepare("SELECT id FROM community_cards WHERE streamer_id=?")
    .bind(page.id)
    .all<{ id: string }>();
  const owned = new Set<string>(results.map((row: { id: string }): string => row.id));
  const ids: string[] = result.data.cards.map((card: CommunityCardInput): string => {
    if (card.id === undefined || !owned.delete(card.id)) return crypto.randomUUID();
    return card.id;
  });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM community_cards WHERE streamer_id=?").bind(page.id),
    ...result.data.cards.map((card: CommunityCardInput, position: number) =>
      env.DB.prepare(
        "INSERT INTO community_cards (id,streamer_id,position,icon,title,body,button_label,button_target) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(ids[position], page.id, position, card.icon, card.title, card.body, card.buttonLabel, card.buttonTarget),
    ),
    env.DB.prepare(`UPDATE overlay_state SET air=${clearedCard("air")}, preview=${clearedCard("preview")},
      revision=revision+1, updated_at=?2
      WHERE streamer_id=?1 AND (json_extract(air,'$.type')='card' OR json_extract(preview,'$.type')='card')`).bind(
      page.id,
      Date.now(),
    ),
  ]);
  return listCards(env, page.id);
}
