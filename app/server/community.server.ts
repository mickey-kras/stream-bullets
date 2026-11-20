import type { AppEnv } from "../env";
import type { CardIcon, CommunityCard } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { placedLayerSql } from "./overlay-state";
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

// Return ordered cards, or null for the default cards.
export async function listCards(env: AppEnv, streamerId: string): Promise<CommunityCard[] | null> {
  const { results } = await env.DB.prepare("SELECT * FROM community_cards WHERE streamer_id=? ORDER BY position")
    .bind(streamerId)
    .all<CardRow>();
  return results.length === 0 ? null : results.map(cardValue);
}

// Replace up to eight cards atomically. Empty restores defaults; existing IDs preserve overlay references.
// Rewrite positions (unique, 0-7), bump overlay revision, and reload. An overlay with the card layer on the grid
// also reloads. A card layer that names a removed card shows nothing.
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
    env.DB.prepare(
      `UPDATE overlay_state SET revision=revision+1, updated_at=?2 WHERE streamer_id=?1 AND ${placedLayerSql("'card'")}`,
    ).bind(page.id, Date.now()),
  ]);
  return listCards(env, page.id);
}
