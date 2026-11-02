import { readFile } from 'node:fs/promises';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { z } from 'zod';

const origin: string = 'http://localhost:5173';
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const png: Buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

async function signedIn(browser: Browser, role: string): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile('.wrangler/e2e/sessions.json', 'utf8')));
  const session = sessions[role];
  if (!session) throw new Error('Unknown test account.');
  const roleIndex: number = ['owner', 'viewer', 'newcomer', 'otherowner'].indexOf(role);
  const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { 'CF-Connecting-IP': `192.0.2.${roleIndex + 10}` } });
  await context.addCookies([{ name: 'stream-bullets.session_token', value: session.cookie, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  return context;
}

async function assertNoScriptErrors(page: Page, action: () => Promise<void>): Promise<void> {
  const errors: string[] = [];
  const record = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', record);
  await action();
  page.off('pageerror', record);
  expect(errors).toEqual([]);
}

test('public access rejects forged identities and unsafe mutations', async ({ browser, request, page }) => {
  await page.goto('/@test_host');
  await expect(page.getByRole('heading', { name: 'Pick the next conversation' })).toBeVisible();
  const forged = await request.post('/api/streamers/test_host', {
    headers: { Origin: origin, 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.test' },
    data: { action: 'create', kind: 'choice', title: 'Forged poll', options: ['A', 'B'], duration: 0 },
  });
  expect(forged.status()).toBe(401);
  const owner = await signedIn(browser, 'owner');
  const crossSite = await owner.request.post('/api/streamers/test_host', {
    headers: { Origin: 'https://example.test' },
    data: { action: 'create', kind: 'choice', title: 'Cross-site poll', options: ['A', 'B'], duration: 0 },
  });
  expect(crossSite.status()).toBe(403);
  const viewer = await signedIn(browser, 'viewer');
  const unauthorized = await viewer.request.post('/api/streamers/test_host', {
    headers: { Origin: origin },
    data: { action: 'create', kind: 'binary', title: 'Viewer poll', duration: 0 },
  });
  expect(unauthorized.status()).toBe(403);
  const me = await owner.request.get('/api/me');
  const identity = await me.json() as { viewer: Record<string, unknown> };
  expect(Object.keys(identity.viewer).sort()).toEqual(['avatar', 'id', 'name']);
  expect(me.headers()['cache-control']).toBe('no-store');
  expect(me.headers()['x-content-type-options']).toBe('nosniff');
  await owner.close();
  await viewer.close();
});

test('viewer topics, reactions, replies, and comment likes survive reload', async ({ browser }, testInfo) => {
  const context = await signedIn(browser, 'viewer');
  const page = await context.newPage();
  await assertNoScriptErrors(page, async () => {
    await page.goto('/@test_host');
    await page.getByRole('button', { name: 'Suggest a topic', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Title', { exact: true }).fill('How should we build a quiet PC?');
    await dialog.getByLabel('Details').fill('Compare cooling and fan speeds. <img src=x onerror=alert(1)>');
    await dialog.getByRole('button', { name: 'Submit topic' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'How should we build a quiet PC?' })).toBeVisible();
    await page.getByRole('button', { name: /^Like 0$/ }).click();
    await expect(page.getByRole('button', { name: /^Like 1$/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('textbox', { name: 'Write a comment' }).fill('Large fans make a difference.');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    const comment = page.locator('article.comment').filter({ hasText: 'Large fans make a difference.' });
    await expect(comment).toBeVisible();
    await comment.getByRole('button', { name: 'Like comment by viewer' }).click();
    await expect(comment.getByRole('button', { name: 'Like comment by viewer' })).toHaveAttribute('aria-pressed', 'true');
    await comment.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('textbox', { name: 'Write a comment' }).fill('A larger case can also help.');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('A larger case can also help.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'How should we build a quiet PC?' })).toBeVisible();
    await expect(page.getByText('A larger case can also help.', { exact: true })).toBeVisible();
    await expect(comment.getByRole('button', { name: 'Like comment by viewer' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.getByText('Compare cooling and fan speeds. <img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  });
  await page.screenshot({ path: testInfo.outputPath('community-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('community-mobile.png') });
  await context.close();
});

test('streamer controls a binary poll and the public OBS overlay updates live', async ({ browser }, testInfo) => {
  const ownerContext = await signedIn(browser, 'owner');
  const viewerContext = await signedIn(browser, 'viewer');
  const owner = await ownerContext.newPage();
  await owner.goto('/@test_host?view=polls');
  await owner.getByRole('button', { name: '+ Create poll', exact: true }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Question', { exact: true }).fill('Should we stream on Friday?');
  await dialog.getByRole('radio', { name: 'Yes / No' }).check();
  await dialog.getByLabel('Voting time').selectOption('0');
  await dialog.getByRole('button', { name: 'Start poll' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(owner).toHaveURL(/entry=/);
  const pollId: string | null = new URL(owner.url()).searchParams.get('entry');
  if (!pollId) throw new Error('Created poll link is missing.');
  const viewer = await viewerContext.newPage();
  await viewer.goto(`/@test_host?view=polls&entry=${pollId}`);
  await expect(viewer.getByRole('button', { name: '+ Create poll', exact: true })).toHaveCount(0);
  const overlayContext = await browser.newContext({ baseURL: origin });
  const overlay = await overlayContext.newPage();
  await overlay.goto(`/@test_host/overlay?poll=${pollId}`);
  await expect(overlay.getByRole('heading', { name: 'Should we stream on Friday?' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(overlay.locator('.overlay-total')).toContainText('1 vote');
  await expect(overlay.locator('.option-score')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'No', exact: true }).click();
  await expect(viewer.getByRole('button', { name: '✓ No', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const snapshot = await viewerContext.request.get(`/api/entries/${pollId}`);
  const before = await snapshot.json() as { entry: { counts: number[] | null; total: number } };
  expect(before.entry.counts).toBeNull();
  expect(before.entry.total).toBe(1);
  const otherOwner = await signedIn(browser, 'otherowner');
  const scopeAttack = await otherOwner.request.post('/api/streamers/other_host', { headers: { Origin: origin }, data: { action: 'reveal', id: pollId } });
  expect(scopeAttack.status()).toBe(404);
  await owner.getByRole('button', { name: 'End & reveal', exact: true }).click();
  await expect(overlay.getByText('Results revealed', { exact: true })).toBeVisible();
  await expect(overlay.locator('.option-score')).toHaveText(['0 votes0%', '1 vote100%']);
  const closedVote = await viewerContext.request.post('/api/streamers/test_host', { headers: { Origin: origin }, data: { action: 'vote', id: pollId, choice: 0 } });
  expect(closedVote.status()).toBe(409);
  await overlay.reload();
  await expect(overlay.getByText('Results revealed', { exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: /^(Yes|No)$/ })).toHaveCount(0);
  await overlay.screenshot({ path: testInfo.outputPath('poll-overlay.png') });
  await otherOwner.close();
  await ownerContext.close();
  await viewerContext.close();
  await overlayContext.close();
});

test('a viewer opts into a public streamer page and uploads a bounded image', async ({ browser }) => {
  const context = await signedIn(browser, 'newcomer');
  const page = await context.newPage();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Host a community' })).toBeVisible();
  await page.getByLabel('Handle', { exact: true }).fill('new_host');
  await page.getByLabel('Streamer name', { exact: true }).fill('New community');
  await page.getByLabel('About your stream').fill('Games and technology.');
  await page.getByRole('button', { name: 'Create public streamer profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your streamer page' })).toBeVisible();
  await page.getByLabel('Profile picture').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('status')).toHaveText('Your avatar is saved.');
  await page.getByLabel('Page background').setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('status')).toHaveText('Your background is saved.');
  await page.getByRole('link', { name: 'Open /@new_host' }).click();
  await expect(page.getByText('New community · Suggest topics. Vote. Chat.')).toBeVisible();
  const profile = await context.request.get('/api/me');
  const identity = await profile.json() as { viewer: { avatar: string }; streamer: { background: string } };
  const image = await context.request.get(identity.viewer.avatar);
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toBe('image/png');
  expect(await image.body()).toEqual(png);
  const rejected = await context.request.put('/api/images/avatar', { headers: { Origin: origin, 'Content-Type': 'image/svg+xml' }, data: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>' });
  expect(rejected.status()).toBe(415);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Suggest a topic', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Suggest a topic', exact: true })).toBeFocused();
  await context.close();
});
