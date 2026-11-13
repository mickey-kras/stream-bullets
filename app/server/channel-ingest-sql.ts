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
