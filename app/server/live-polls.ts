import { contentSources } from "../lib/overlay-layers";
import type { LiveSnapshot } from "../types";
import { MASH_COLUMN, mashValue } from "./mash-sql";
import { autoPoll, byOwner, notHeld, openPoll } from "./poll-sql";

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
  by_owner: number;
};

const POLL_COLUMNS = `id, title, kind, COALESCE(binary_labels, options) AS options, ends_at, revealed, created_at,
      (${byOwner()}) AS by_owner`;

// Read the 50 newest choice/binary polls plus any older open poll of the page owner, with counts. Leave out polls that
// moderation holds. Only a poll of the page owner can be the open poll: automatic selection never shows a viewer poll.
// Bind streamer ID twice.
export const LIVE_POLLS_SQL = `
  WITH recent AS (
    SELECT ${POLL_COLUMNS}
    FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary') AND ${notHeld()}
    ORDER BY created_at DESC, id DESC LIMIT 50
  ), active AS (
    SELECT ${POLL_COLUMNS}
    FROM entries WHERE streamer_id = ? AND kind IN ('choice', 'binary')
      AND ${openPoll("unixepoch('subsec') * 1000")} AND ${autoPoll()}
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), selected AS (
    SELECT * FROM (SELECT * FROM recent UNION SELECT * FROM active)
    ORDER BY (id = (SELECT id FROM active)) DESC, created_at DESC, id DESC LIMIT 50
  )
  SELECT e.id, e.title, e.kind, e.options, e.ends_at, e.revealed, e.by_owner,
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
      byOwner: poll.by_owner === 1,
    };
  });
}

/**
 * The snapshot for a socket of the OBS overlay: polls of the page owner, plus the polls that the owner picked. A
 * picked poll is the poll on air or the poll of a poll layer on stream.
 * An overlay page that runs older code then cannot show a viewer poll through automatic selection.
 */
export function overlaySnapshot(snapshot: LiveSnapshot): LiveSnapshot {
  const overlay = snapshot.overlay;
  const picked = new Set<string | null>();
  if (overlay?.air.type === "poll") picked.add(overlay.air.ref);
  for (const source of overlay ? contentSources(overlay.layers) : [])
    if (source.type === "poll") picked.add(source.ref);
  return {
    ...snapshot,
    polls: snapshot.polls.filter((poll: LiveSnapshot["polls"][number]): boolean => poll.byOwner || picked.has(poll.id)),
  };
}
