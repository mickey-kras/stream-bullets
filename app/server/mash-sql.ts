import { z } from "zod";
import { MASH_PHASES } from "../../db/enums";
import type { MashState } from "../types";

// Exclude finished Mash Battles from Auto: entries retain NULL `ends_at` and `revealed=0`, so inspect
// `entry_mash`. Setup/countdown/live count as open; `now` is SQL milliseconds.
export function notFinishedBattle(now: string): string {
  return `NOT EXISTS (SELECT 1 FROM entry_mash m WHERE m.entry_id=entries.id
    AND (m.phase='finished' OR (m.ends_at IS NOT NULL AND m.ends_at <= ${now})))`;
}

// JSON `mash` column for entry alias `e`, or NULL. Battles keep entry kind `choice`; totals come from
// `mash_taps`, with unflushed live totals overlaid.
export const MASH_COLUMN = `(SELECT json_object('durationS',m.duration_s,'phase',m.phase,'startsAt',m.starts_at,
    'endsAt',m.ends_at,'winner',m.winner,
    'totals',json((SELECT json_group_array(json_object('side',t.side,'taps',t.taps)) FROM
      (SELECT side,sum(taps) AS taps FROM mash_taps x WHERE x.entry_id=e.id GROUP BY side) t)),
    'players',(SELECT count(*) FROM mash_taps x WHERE x.entry_id=e.id AND x.taps>0),
    'assisted',(SELECT count(*) FROM mash_taps x WHERE x.entry_id=e.id AND x.assisted_taps>0))
  FROM entry_mash m WHERE m.entry_id=e.id) AS mash`;

const count = z.number().int().nonnegative();
const time = z.number().int().nullable();
const mashSchema = z.object({
  durationS: z.number().int().min(10).max(120),
  phase: z.enum(MASH_PHASES),
  startsAt: time,
  endsAt: time,
  winner: z.number().int().min(-1).max(3).nullable(),
  totals: z.array(z.object({ side: z.number().int().min(0).max(3), taps: count })).max(4),
  players: count,
  assisted: count,
});

// Reject malformed stored Mash data before sending it to clients.
export function mashValue(raw: string | null | undefined, sides: number): MashState | null {
  if (raw === null || raw === undefined) return null;
  const parsed = mashSchema.parse(JSON.parse(raw));
  const totals: number[] = Array.from(
    { length: sides },
    (_: unknown, side: number): number => parsed.totals.find((row) => row.side === side)?.taps ?? 0,
  );
  return { ...parsed, totals };
}
