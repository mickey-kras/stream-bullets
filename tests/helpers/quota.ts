/**
 * Mutation quotas count per minute of the database's own clock (`strftime('%s','now')` in D1), which runs in
 * the Miniflare process, so fake timers in the test cannot move it. A test that fills a quota and then expects
 * a 429 would pass the reset if a minute ended in between. This waits for the next minute to start when fewer
 * than `marginSeconds` are left in the current one, so the whole test runs inside one quota window.
 */
export async function startOfQuotaWindow(db: D1Database, marginSeconds = 5): Promise<void> {
  const row = await db
    .prepare("SELECT CAST(strftime('%s','now') AS INTEGER) % 60 AS second")
    .first<{ second: number }>();
  if (!row) throw new Error("The database returned no clock reading.");
  const left = 60 - row.second;
  if (left < marginSeconds) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 100));
}
