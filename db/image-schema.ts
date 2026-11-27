import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

// The current version of each uploaded image of an account.
export const imageVersions = sqliteTable(
  "image_versions",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    version: text("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.kind] }),
    check("image_versions_kind_check", sql`${table.kind} IN ('avatar', 'background', 'logo')`),
  ],
);

// The image prefixes of a deleted account that R2 may still hold. Account deletion writes them in its batch; a row
// goes when its objects are gone, so the hourly job retries a delete that failed. No foreign key: the user is gone.
export const imageCleanup = sqliteTable(
  "image_cleanup",
  {
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.kind] }),
    index("image_cleanup_created_idx").on(table.createdAt),
    check("image_cleanup_kind_check", sql`${table.kind} IN ('avatar', 'background', 'logo')`),
  ],
);
