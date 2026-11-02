import type { AppEnv } from '../env';

export async function cleanExpiredData(env: AppEnv, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expires_at <= ? LIMIT 5000)').bind(now),
    env.DB.prepare('DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expires_at <= ? LIMIT 5000)').bind(now),
    env.DB.prepare('DELETE FROM rate_limit WHERE id IN (SELECT id FROM rate_limit WHERE last_request < ? LIMIT 5000)').bind(now - 86_400_000),
    env.DB.prepare('DELETE FROM app_rate_limits WHERE key IN (SELECT key FROM app_rate_limits WHERE window_start < ? LIMIT 5000)').bind(now - 86_400_000),
  ]);
}
