import { notFinishedBattle } from "./mash-sql";

// SQL rules for polls that the list order, the overlay and the live room share. `entry` is the entries alias.

/** The current time in SQL milliseconds. */
export const SQL_NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

/**
 * True for an active poll: results not revealed, voting time not over, and not a finished Mash Battle.
 * `now` is SQL milliseconds and occurs two times: a `?` placeholder needs two bound values.
 */
export function openPoll(now: string, entry = "entries"): string {
  return `${entry}.revealed=0 AND (${entry}.ends_at IS NULL OR ${entry}.ends_at>${now})
    AND ${notFinishedBattle(now, entry)}`;
}

/** True for an entry that the page owner wrote. */
export function byOwner(entry = "entries"): string {
  return `${entry}.author_id=(SELECT o.owner_id FROM streamers o WHERE o.id=${entry}.streamer_id)`;
}

/** False while moderation holds an entry (under review) or after moderation declined it. The overlay never shows these. */
export function notHeld(entry = "entries"): string {
  return `(${entry}.status IS NULL OR ${entry}.status NOT IN ('review','declined'))`;
}

/** A poll that automatic overlay selection may show: the page owner wrote it and moderation does not hold it. */
export function autoPoll(entry = "entries"): string {
  return `${byOwner(entry)} AND ${notHeld(entry)}`;
}

// Polls list groups, in list order.
export const POLL_GROUP_OWNER = 0;
export const POLL_GROUP_OTHERS = 1;
export const POLL_GROUP_CLOSED = 2;

/**
 * The rows of `rows` (an entries SELECT) with `poll_group`: active polls of the page owner, active polls of other
 * people, then all polls that are not active. Bind the list time two times and the owner ID before the values of
 * `rows`. The cursor keeps the list time, so a poll whose voting time ends between two pages stays in its group.
 */
export function groupedPolls(rows: string): string {
  return `(SELECT x.*, CASE WHEN NOT (${openPoll("?", "x")}) THEN ${POLL_GROUP_CLOSED}
      WHEN x.author_id=? THEN ${POLL_GROUP_OWNER} ELSE ${POLL_GROUP_OTHERS} END AS poll_group
    FROM (${rows}) x)`;
}

export const POLL_GROUP_ORDER = "poll_group ASC,created_at DESC,id DESC";
/** Rows after the cursor row. Bind group, group, time, id. */
export const POLL_GROUP_AFTER = "WHERE poll_group > ? OR (poll_group = ? AND (created_at,id) < (?,?))";
