import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";

export interface TestDatabase {
  db: D1Database;
  bucket: R2Bucket;
  dispose: () => Promise<void>;
}

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(new URL("../../drizzle/", import.meta.url)))
    .filter((file: string): boolean => file.endsWith(".sql"))
    .sort();
}

// Apply migrations statement by statement, as Wrangler does.
export async function applyMigrations(db: D1Database, files: string[]): Promise<void> {
  for (const file of files) {
    const sql = await readFile(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((value: string): string => value.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

// Isolated D1 and R2; migrate:false keeps D1 empty.
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: "2026-07-01",
    d1Databases: ["DB"],
    r2Buckets: ["IMAGES"],
  });
  const db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  try {
    if (options.migrate !== false) await applyMigrations(db, await migrationFiles());
  } catch (error: unknown) {
    await runtime.dispose();
    throw error;
  }
  const bucket = (await runtime.getR2Bucket("IMAGES")) as unknown as R2Bucket;
  return { db, bucket, dispose: async (): Promise<void> => runtime.dispose() };
}
