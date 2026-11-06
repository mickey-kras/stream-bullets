import { z } from "zod";
import type { AppEnv } from "../env";
import {
  MASH_COUNTDOWN_MS,
  MASH_DURATIONS,
  MASH_MAX_SIDES,
  MASH_MIN_SIDES,
  MASH_SIDE_LENGTH,
  mashPhaseAt,
} from "../lib/mash";
import type { MashPhase } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { line } from "./validation";

/** Mash Battle owner actions (item 31). Taps never come here: they go over the live WebSocket (R16). */

const MAX_ENTRIES = 1000;

/** The create action for a Mash Battle, sent to `POST /api/streamers/:handle` like any poll. */
export const mashCreateSchema = z
  .object({
    action: z.literal("create"),
    kind: z.literal("mash"),
    title: line(160),
    options: z.array(line(MASH_SIDE_LENGTH)).min(MASH_MIN_SIDES).max(MASH_MAX_SIDES),
    durationS: z
      .number()
      .int()
      .refine((value: number): boolean => (MASH_DURATIONS as readonly number[]).includes(value), "Pick a battle length."),
  })
  .strict()
  .refine(
    (value): boolean => new Set(value.options.map((option: string) => option.toLowerCase())).size === value.options.length,
    "Give each side a different name.",
  );
export type MashCreate = z.infer<typeof mashCreateSchema>;

/** `POST /api/mash/:id/start`. `countdown: true` starts with 3-2-1. */
export const mashStartSchema = z.object({ countdown: z.boolean().default(true) }).strict();
export const mashActions = ["start", "end", "restart"] as const;
export type MashAction = (typeof mashActions)[number];

interface BattleRow {
  phase: MashPhase;
  starts_at: number | null;
  ends_at: number | null;
  duration_s: number;
  streamer_id: string;
  owner_id: string;
}

/** Creates a Mash Battle: an entry of kind `choice` plus its `entry_mash` row (R1), in one batch. */
export async function createMash(
  env: AppEnv,
  userId: string,
  streamerId: string,
  input: MashCreate,
): Promise<{ id: string }> {
  await assertStreamerWritable(env, streamerId, userId);
  await consumeMutationQuota(env, userId);
  await consumeMutationQuota(env, userId, true);
  const id = crypto.randomUUID();
  const [created] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed)
      SELECT ?,s.id,?,'choice',?,'','',?,?,NULL,0 FROM streamers s WHERE s.id=? AND s.owner_id=?
        AND (SELECT count(*) FROM entries e WHERE e.streamer_id=s.id) < ?`).bind(
      id,
      userId,
      input.title,
      JSON.stringify(input.options),
      Date.now(),
      streamerId,
      userId,
      MAX_ENTRIES,
    ),
    env.DB.prepare("INSERT INTO entry_mash (entry_id,duration_s) SELECT id,? FROM entries WHERE id=?").bind(
      input.durationS,
      id,
    ),
    env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(streamerId),
  ]);
  if (created.meta.changes === 0)
    throw new HttpError(403, "Only the streamer can create polls. Each page can contain up to 1000 topics and polls.");
  return { id };
}

async function ownedBattle(env: AppEnv, userId: string, id: string): Promise<BattleRow> {
  const row = await env.DB.prepare(`SELECT m.phase,m.starts_at,m.ends_at,m.duration_s,e.streamer_id,s.owner_id
    FROM entry_mash m JOIN entries e ON e.id=m.entry_id JOIN streamers s ON s.id=e.streamer_id WHERE m.entry_id=?`)
    .bind(id)
    .first<BattleRow>();
  if (!row) throw new HttpError(404, "Mash Battle not found.");
  await assertStreamerWritable(env, row.streamer_id, userId);
  if (row.owner_id !== userId) throw new HttpError(403, "Only the streamer can run a Mash Battle.");
  return row;
}

function mashUpdate(env: AppEnv, sql: string, ...params: (string | number | null)[]): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...params);
}

/**
 * Start, end or restart a battle. Each writes D1 first; the caller then asks the live room to reload
 * it (`notifyMash`). Ending a battle in its countdown cancels it back to setup. Restart deletes the taps
 * and keeps the sides viewers picked.
 */
export async function runMashAction(
  env: AppEnv,
  userId: string,
  id: string,
  action: MashAction,
  input: z.infer<typeof mashStartSchema>,
): Promise<{ streamerId: string }> {
  const battle = await ownedBattle(env, userId, id);
  const now = Date.now();
  const phase = mashPhaseAt(
    { phase: battle.phase, startsAt: battle.starts_at, endsAt: battle.ends_at },
    now,
  );
  const statements: D1PreparedStatement[] = [];
  if (action === "start") {
    if (phase !== "setup") throw new HttpError(409, "This battle has already started.");
    const startsAt = input.countdown ? now + MASH_COUNTDOWN_MS : now;
    statements.push(
      mashUpdate(
        env,
        "UPDATE entry_mash SET phase=?,starts_at=?,ends_at=?,winner=NULL WHERE entry_id=? AND phase='setup'",
        input.countdown ? "countdown" : "live",
        startsAt,
        startsAt + battle.duration_s * 1_000,
        id,
      ),
    );
  } else if (action === "end") {
    if (phase === "setup" || phase === "finished") throw new HttpError(409, "This battle is not running.");
    statements.push(
      phase === "countdown"
        ? mashUpdate(
            env,
            "UPDATE entry_mash SET phase='setup',starts_at=NULL,ends_at=NULL WHERE entry_id=? AND phase='countdown'",
            id,
          )
        : mashUpdate(
            env,
            "UPDATE entry_mash SET ends_at=max(starts_at+1,?) WHERE entry_id=? AND phase IN ('countdown','live')",
            now,
            id,
          ),
    );
  } else {
    if (phase !== "finished") throw new HttpError(409, "Restart a battle once it has ended.");
    statements.push(
      mashUpdate(env, "DELETE FROM mash_taps WHERE entry_id=?", id),
      mashUpdate(
        env,
        "UPDATE entry_mash SET phase='setup',starts_at=NULL,ends_at=NULL,winner=NULL WHERE entry_id=?",
        id,
      ),
    );
  }
  statements.push(mashUpdate(env, "UPDATE streamers SET revision=revision+1 WHERE id=?", battle.streamer_id));
  const results = await env.DB.batch(statements);
  if (results.at(-2)?.meta.changes === 0) throw new HttpError(409, "The battle changed. Refresh and try again.");
  return { streamerId: battle.streamer_id };
}
