import type { ActivityChat, ActivitySupport } from "../lib/activity";
import type { PendingAlert } from "../lib/alerts";
import { SEEN_TTL_MS, SNAPSHOT_MAX_AGE_MS } from "./channel-ingest-limits";

/** The id tables of the ingest object. */
export type IdTable = "seen" | "deleted";

/** The fixed statements of each id table. Table names are never built from input. */
export const ID_SQL: Readonly<
  Record<
    IdTable,
    { create: string; index: string; count: string; expire: string; trim: string; find: string; add: string }
  >
> = {
  seen: {
    create: "CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    index: "CREATE INDEX IF NOT EXISTS seen_at ON seen (at)",
    count: "SELECT count(*) AS n FROM seen",
    expire: "DELETE FROM seen WHERE at < ? RETURNING 1",
    trim: "DELETE FROM seen WHERE key IN (SELECT key FROM seen ORDER BY at LIMIT ?) RETURNING 1",
    find: "SELECT 1 FROM seen WHERE key=?",
    add: "INSERT INTO seen (key, at) VALUES (?, ?)",
  },
  deleted: {
    create: "CREATE TABLE IF NOT EXISTS deleted (key TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    index: "CREATE INDEX IF NOT EXISTS deleted_at ON deleted (at)",
    count: "SELECT count(*) AS n FROM deleted",
    expire: "DELETE FROM deleted WHERE at < ? RETURNING 1",
    trim: "DELETE FROM deleted WHERE key IN (SELECT key FROM deleted ORDER BY at LIMIT ?) RETURNING 1",
    find: "SELECT 1 FROM deleted WHERE key=?",
    add: "INSERT INTO deleted (key, at) VALUES (?, ?)",
  },
};

// The fixed statements of the cut. Each one raises the cut to the newest receive time of the messages that go.
const CUT_ABOVE_SIZE = `INSERT INTO cut (id, at) SELECT 1, at FROM (SELECT max(received_at) AS at FROM events
  WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)) WHERE at IS NOT NULL
  ON CONFLICT (id) DO UPDATE SET at = max(at, excluded.at)`;
const CUT_PLATFORM = `INSERT INTO cut (id, at) SELECT 1, at FROM (SELECT max(received_at) AS at FROM events
  WHERE platform=?) WHERE at IS NOT NULL ON CONFLICT (id) DO UPDATE SET at = max(at, excluded.at)`;

/**
 * The chat messages that the object keeps for a reconnect snapshot, and the cut: the newest receive time of a
 * message that left the table without moderation. The table has each kept message that is newer than the cut, so
 * a consumer can tell a moderated message from one that the size limit or a disconnect removed.
 */
export const EVENTS = {
  create(sql: SqlStorage): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL, message_id TEXT NOT NULL, user_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      body TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS cut (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)");
  },
  /** Removes the oldest messages above `size`. */
  trim(sql: SqlStorage, size: number): void {
    sql.exec(CUT_ABOVE_SIZE, size);
    sql.exec("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)", size);
  },
  /** Removes the messages of a platform that the owner disconnected. */
  dropPlatform(sql: SqlStorage, platform: string): void {
    sql.exec(CUT_PLATFORM, platform);
    sql.exec("DELETE FROM events WHERE platform=?", platform);
  },
  /** The cut, or 0 when no message left the table without moderation. */
  cut(sql: SqlStorage): number {
    return sql.exec<{ at: number }>("SELECT at FROM cut").toArray()[0]?.at ?? 0;
  },
  /** The kept messages, the oldest first. None is live: a command in a snapshot never runs again. */
  snapshot(sql: SqlStorage): ActivityChat[] {
    const rows: { body: string }[] = sql.exec<{ body: string }>("SELECT body FROM events ORDER BY seq").toArray();
    return rows.map((row): ActivityChat => ({ ...(JSON.parse(row.body) as ActivityChat), live: false }));
  },
};

/**
 * The support events that the object keeps for a reconnect snapshot. The id is unique, so an event is stored one
 * time. No moderation removes a support event, so this table needs no cut.
 */
export const SUPPORT = {
  create(sql: SqlStorage): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS support (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL)`);
  },
  add(sql: SqlStorage, event: ActivitySupport): void {
    sql.exec(
      "INSERT OR IGNORE INTO support (id, platform, received_at, body) VALUES (?, ?, ?, ?)",
      event.id,
      event.platform,
      event.receivedAt,
      JSON.stringify(event),
    );
  },
  /** Removes the events received before `before`, and the oldest ones above `size`. */
  prune(sql: SqlStorage, before: number, size: number): void {
    sql.exec("DELETE FROM support WHERE received_at < ?", before);
    sql.exec("DELETE FROM support WHERE seq NOT IN (SELECT seq FROM support ORDER BY seq DESC LIMIT ?)", size);
  },
  /** Removes the events of a platform that the owner disconnected. */
  dropPlatform(sql: SqlStorage, platform: string): void {
    sql.exec("DELETE FROM support WHERE platform=?", platform);
  },
  /** The kept events, the oldest first. Each one is a replay: a consumer shows it and never counts it again. */
  snapshot(sql: SqlStorage): ActivitySupport[] {
    const rows: { body: string }[] = sql.exec<{ body: string }>("SELECT body FROM support ORDER BY seq").toArray();
    return rows.map((row): ActivitySupport => ({ ...(JSON.parse(row.body) as ActivitySupport), replay: true }));
  },
  /** The kept event with this ID that the object received at or after `since`, or null. */
  find(sql: SqlStorage, id: string, since: number): ActivitySupport | null {
    const rows: { body: string }[] = sql
      .exec<{ body: string }>("SELECT body FROM support WHERE id=? AND received_at >= ?", id, since)
      .toArray();
    return rows.length > 0 ? (JSON.parse(rows[0].body) as ActivitySupport) : null;
  },
};

/**
 * The rows of `alert_state`: the muted flag with the alert on stream, the copy of the layer settings, and the count
 * of the goal.
 */
export type AlertStateKey = "state" | "config" | "goal";

/** A stored JSON text as a value. Null: the text is not JSON. The reader checks the shape of the value. */
function storedJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * What the alert host keeps (app/server/alert-host.ts): one row for each part of its state, and one row for each
 * alert that waits in the line. An alert that waits has the display name and the user ID of the supporter. The row
 * goes when the alert starts, when the owner mutes the alerts, and when the owner disconnects the platform.
 *
 * For the goal, the host also keeps the IDs of the newest support events, so an event counts one time, and one key
 * for each person that a goal for chatters counted. A key is a hash: it has no user ID.
 */
export const ALERTS = {
  create(sql: SqlStorage): void {
    sql.exec("CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS alert_line (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS alert_counted (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE)`);
    sql.exec("CREATE TABLE IF NOT EXISTS goal_people (key TEXT PRIMARY KEY)");
  },
  /** The stored value of `key`. Undefined: the row does not exist. Null: its text is not JSON. */
  read(sql: SqlStorage, key: AlertStateKey): unknown {
    const rows: { body: string }[] = sql
      .exec<{ body: string }>("SELECT body FROM alert_state WHERE key=?", key)
      .toArray();
    return rows.length > 0 ? storedJson(rows[0].body) : undefined;
  },
  write(sql: SqlStorage, key: AlertStateKey, value: unknown): void {
    sql.exec(
      "INSERT INTO alert_state (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body",
      key,
      JSON.stringify(value),
    );
  },
  /** The alerts that wait, the oldest first. */
  line(sql: SqlStorage): unknown[] {
    const rows: { body: string }[] = sql.exec<{ body: string }>("SELECT body FROM alert_line ORDER BY seq").toArray();
    return rows.map((row): unknown => storedJson(row.body));
  },
  /** Adds an alert at the end of the line. */
  wait(sql: SqlStorage, alert: PendingAlert): void {
    sql.exec("INSERT OR IGNORE INTO alert_line (id, body) VALUES (?, ?)", alert.view.id, JSON.stringify(alert));
  },
  /** Removes the alert with this ID from the line. */
  drop(sql: SqlStorage, id: string): void {
    sql.exec("DELETE FROM alert_line WHERE id=?", id);
  },
  /** Removes each alert from the line. */
  clear(sql: SqlStorage): void {
    sql.exec("DELETE FROM alert_line");
  },
  /**
   * Remembers the ID of a support event. False: the table has the ID, so the event came before. The table keeps the
   * newest `kept` IDs.
   */
  first(sql: SqlStorage, id: string, kept: number): boolean {
    const added: { seq: number }[] = sql
      .exec<{ seq: number }>("INSERT OR IGNORE INTO alert_counted (id) VALUES (?) RETURNING seq", id)
      .toArray();
    if (added.length === 0) return false;
    sql.exec("DELETE FROM alert_counted WHERE seq <= ?", added[0].seq - kept);
    return true;
  },
  /** Adds a person to the people of the goal. False: the goal has the person. */
  person(sql: SqlStorage, key: string): boolean {
    return sql.exec("INSERT OR IGNORE INTO goal_people (key) VALUES (?) RETURNING 1", key).toArray().length > 0;
  },
  /** Removes the people of the goal: a new count starts. */
  forgetPeople(sql: SqlStorage): void {
    sql.exec("DELETE FROM goal_people");
  },
};

const OLDEST = `SELECT (SELECT min(received_at) FROM events) AS events,
  (SELECT min(received_at) FROM support) AS support, (SELECT min(at) FROM seen) AS seen,
  (SELECT min(at) FROM deleted) AS deleted`;

/** When the oldest stored message, support event or id expires, or null when nothing is stored. */
export function nextExpiry(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ events: number | null; support: number | null; seen: number | null; deleted: number | null }>(OLDEST)
    .toArray()[0];
  const times: number[] = [];
  for (const at of [row.events, row.support]) if (at !== null) times.push(at + SNAPSHOT_MAX_AGE_MS + 1);
  for (const at of [row.seen, row.deleted]) if (at !== null) times.push(at + SEEN_TTL_MS + 1);
  return times.length > 0 ? Math.min(...times) : null;
}
