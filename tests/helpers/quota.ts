// D1 uses the real Miniflare clock; fake timers cannot advance quotas.
// Wait for the next minute when fewer than `marginSeconds` remain to avoid a quota reset mid-test.
export async function startOfQuotaWindow(db: D1Database, marginSeconds = 5): Promise<void> {
  const row = await db
    .prepare("SELECT CAST(strftime('%s','now') AS INTEGER) % 60 AS second")
    .first<{ second: number }>();
  if (!row) throw new Error("The database returned no clock reading.");
  const left = 60 - row.second;
  if (left < marginSeconds) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 100));
}
