import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';
import { z } from 'zod';

const origin = 'http://localhost:5173';
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

async function seedHistory(userId: string): Promise<string> {
  const entryId: string = randomUUID();
  const parentId: string = randomUUID();
  const now: number = Date.now() - 200_000;
  const statements: string[] = [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${userId}','topic','Historical discussion','A discussion with more than one page.','Just chatting',${now} FROM streamers WHERE handle='test_host';`,
  ];
  for (let index = 1; index <= 102; index += 1) {
    const id: string = index === 1 ? parentId : randomUUID();
    const parent: string = index === 2 ? `'${parentId}'` : 'NULL';
    statements.push(`INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${id}','${entryId}','${userId}','History comment ${String(index).padStart(3, '0')}',${now + index},${parent});`);
  }
  const seedPath: string = resolve('.wrangler/e2e/discussion-history.sql');
  await writeFile(seedPath, statements.join('\n'));
  execFileSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--local',
    '--config', resolve('.wrangler/e2e/wrangler.json'), '--env-file', resolve('.wrangler/e2e/.env'),
    '--persist-to', resolve('.wrangler/e2e/state'), '--file', seedPath], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  return entryId;
}

test('historical comment mutations stay visible and accurate after refresh', async ({ browser }) => {
  const sessions = sessionSchema.parse(JSON.parse(await readFile('.wrangler/e2e/sessions.json', 'utf8')));
  const viewer = sessions.viewer;
  if (!viewer) throw new Error('Missing viewer test account.');
  const entryId: string = await seedHistory(viewer.id);
  const context: BrowserContext = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.75' } });
  await context.addCookies([{ name: 'stream-bullets.session_token', value: viewer.cookie, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  try {
    const page = await context.newPage();
    await page.goto(`/@test_host?entry=${entryId}`);
    await page.getByRole('button', { name: 'Load more comments' }).click();
    const oldest = page.locator('article.comment').filter({ has: page.getByText('History comment 001', { exact: true }) });
    const reply = page.locator('article.comment').filter({ has: page.getByText('History comment 002', { exact: true }) });
    await expect(oldest).toBeVisible();
    await expect(reply.locator('.replying')).toHaveCount(1);
    const like = oldest.getByRole('button', { name: 'Like comment by viewer' });
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveText('Like 1');
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await expect(like).toHaveText('Like 0');
    await page.getByRole('textbox', { name: 'Write a comment' }).fill('Keep this unsent draft.');
    await oldest.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete comment', exact: true }).click();
    await expect(oldest).toHaveCount(0);
    await expect(reply).toBeVisible();
    await expect(reply.locator('.replying')).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Loading comments…', { exact: true })).toHaveCount(0);
    await expect(oldest).toHaveCount(0);
    await expect(reply).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Keep this unsent draft.');
    const added = await context.request.post('/api/streamers/test_host', {
      headers: { Origin: origin }, data: { action: 'comment', id: entryId, text: 'A newer comment arrives.' },
    });
    expect(added.ok()).toBe(true);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('A newer comment arrives.', { exact: true })).toBeVisible();
    await expect(reply).toHaveCount(1);
    await expect(oldest).toHaveCount(0);
  } finally { await context.close(); }
});
