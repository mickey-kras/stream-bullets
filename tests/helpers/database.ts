import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

export interface TestDatabase {
  db: D1Database;
  bucket: R2Bucket;
  dispose: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    r2Buckets: ['IMAGES'],
  });
  const db = await runtime.getD1Database('DB') as unknown as D1Database;
  try {
    const files = (await readdir(new URL('../../drizzle/', import.meta.url))).filter((file: string): boolean => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').map((value: string): string => value.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
  } catch (error: unknown) {
    await runtime.dispose();
    throw error;
  }
  const bucket = await runtime.getR2Bucket('IMAGES') as unknown as R2Bucket;
  return { db, bucket, dispose: async (): Promise<void> => runtime.dispose() };
}
