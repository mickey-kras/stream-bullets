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

/**
 * `PUT /api/community-cards`: replaces the owner's whole ordered list (at most 8) in one atomic batch. Saving an
 * empty list brings the two default cards back, because no rows means defaults.
 */
export async function saveCards(env: AppEnv, viewerId: string, value: unknown): Promise<CommunityCard[] | null> {
  const result = communityCardsSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid cards.");
  const page = await env.DB.prepare("SELECT id FROM streamers WHERE owner_id=?").bind(viewerId).first<{ id: string }>();
  if (!page) throw new HttpError(403, "Only streamers can edit Community cards.");
  await assertStreamerWritable(env, page.id, viewerId);
  await consumeMutationQuota(env, viewerId, true);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM community_cards WHERE streamer_id=?").bind(page.id),
    ...result.data.cards.map((card: CommunityCardInput, position: number) =>
      env.DB.prepare(
        "INSERT INTO community_cards (id,streamer_id,position,icon,title,body,button_label,button_target) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        page.id,
        position,
        card.icon,
        card.title,
        card.body,
        card.buttonLabel,
        card.buttonTarget,
      ),
    ),
  ]);
  return listCards(env, page.id);
}
