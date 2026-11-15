import type { LiveSnapshot } from "../types";
import { MASH_COLUMN, mashValue, notFinishedBattle } from "./mash-sql";

export type PollRow = {
  id: string;
  title: string;
  kind: "choice" | "binary";
  options: string;
  ends_at: number | null;
  revealed: number;
  total: number;
  count_0: number;
  count_1: number;
  count_2: number;
  count_3: number;
  count_4: number;
  count_5: number;
  mash: string | null;
};

// Read the 50 newest choice/binary polls plus any older open poll, with counts. Bind streamer ID twice.
export const LIVE_POLLS_SQL = `
  WITH recent AS (
    SELECT id, title, kind, options, ends_at, revealed, created_at
    FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
    ORDER BY created_at DESC, id DESC LIMIT 50
  ), active AS (
    SELECT id, title, kind, options, ends_at, revealed, created_at
    FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
      AND revealed = 0 AND (ends_at IS NULL OR ends_at > unixepoch('subsec') * 1000)
      AND ${notFinishedBattle("unixepoch('subsec') * 1000")}
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), selected AS (
    SELECT * FROM (SELECT * FROM recent UNION SELECT * FROM active)
    ORDER BY (id = (SELECT id FROM active)) DESC, created_at DESC, id DESC LIMIT 50
  )
  SELECT e.id, e.title, e.kind, e.options, e.ends_at, e.revealed,
    COALESCE(SUM(c.votes), 0) AS total,
    COALESCE(SUM(CASE WHEN c.choice = 0 THEN c.votes END), 0) AS count_0,
    COALESCE(SUM(CASE WHEN c.choice = 1 THEN c.votes END), 0) AS count_1,
    COALESCE(SUM(CASE WHEN c.choice = 2 THEN c.votes END), 0) AS count_2,
    COALESCE(SUM(CASE WHEN c.choice = 3 THEN c.votes END), 0) AS count_3,
    COALESCE(SUM(CASE WHEN c.choice = 4 THEN c.votes END), 0) AS count_4,
    COALESCE(SUM(CASE WHEN c.choice = 5 THEN c.votes END), 0) AS count_5,
    ${MASH_COLUMN}
  FROM selected e LEFT JOIN entry_vote_counts c ON c.entry_id = e.id
  GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC
`;

export function optionsFromJson(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    parsed.length > 6 ||
    !parsed.every(
      (option: unknown): option is string => typeof option === "string" && option.length > 0 && option.length <= 80,
    )
  ) {
    throw new Error("Invalid stored poll options");
  }
  return parsed;
}

export function livePolls(rows: readonly PollRow[]): LiveSnapshot["polls"] {
  return rows.map((poll: PollRow) => {
    const options = optionsFromJson(poll.options);
    const mash = mashValue(poll.mash, options.length);
    return {
      id: poll.id,
      title: poll.title,
      kind: mash ? "mash" : poll.kind,
      options,
      endsAt: poll.ends_at,
      revealed: poll.revealed === 1,
      counts:
        poll.kind === "binary" && poll.revealed !== 1
          ? null
          : [poll.count_0, poll.count_1, poll.count_2, poll.count_3, poll.count_4, poll.count_5].slice(
              0,
              options.length,
            ),
      total: poll.total,
      mash,
    };
  });
}
