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
};
