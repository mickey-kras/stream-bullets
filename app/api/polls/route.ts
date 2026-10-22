import { env } from 'cloudflare:workers';
import { z } from 'zod';
export const dynamic = 'force-dynamic';
interface PollRow { id: string; question: string; kind: string; options: string; created_at: number; ends_at: number; revealed: number }
const createSchema = z.object({ action: z.literal('create'), question: z.string().trim().min(1).max(160), kind: z.enum(['choice', 'binary']), options: z.array(z.string().trim().min(1).max(80)).min(2).max(6), duration: z.union([z.literal(0), z.number().int().min(15).max(3600)]) }).strict();
const actionSchema = z.discriminatedUnion('action', [createSchema, z.object({ action: z.literal('react'), id: z.string().uuid(), value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).strict(), z.object({ action: z.literal('comment'), id: z.string().uuid(), text: z.string().trim().min(1).max(2000) }).strict(), z.object({ action: z.literal('vote'), id: z.string().uuid(), choice: z.number().int().min(0).max(5) }).strict(), z.object({ action: z.literal('reveal'), id: z.string().uuid() }).strict()]);
function identity(request: Request): { id: string | null; host: boolean } {
  // Only the local development bundle supplies a preview identity.
  if (import.meta.env.DEV) return { id: request.headers.get('oai-authenticated-user-id') ?? 'preview-host', host: request.headers.get('x-preview-viewer') !== 'true' };
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email');
  return { id, host: !!id && !!env.POLL_HOST_EMAIL && email?.toLowerCase() === env.POLL_HOST_EMAIL.toLowerCase() };
}
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
export async function GET(request: Request): Promise<Response> {
  const db = env.DB;
  if (!db) return json({ error: 'Poll storage is unavailable.' }, 503);
  const user = identity(request);
  const params = new URL(request.url).searchParams;
  const selected = params.get('poll');
  if (selected && !z.string().uuid().safeParse(selected).success) return json({ error: 'Invalid poll reference.' }, 400);
  const order = params.get('sort') === 'top' ? 'COALESCE((SELECT SUM(value) FROM poll_reactions WHERE poll_id = polls.id), 0) DESC, created_at DESC, id DESC' : 'created_at DESC, id DESC';
  const rows = selected ? await db.prepare('SELECT * FROM polls WHERE id = ?').bind(selected).all<PollRow>() : await db.prepare(`SELECT * FROM polls ORDER BY ${order} LIMIT 50`).all<PollRow>();
  const polls = await Promise.all(rows.results.map(async (poll) => {
    const counts = await db.prepare('SELECT choice, COUNT(*) AS count FROM poll_votes WHERE poll_id = ? GROUP BY choice').bind(poll.id).all<{ choice: number; count: number }>();
    const myVote = user.id ? await db.prepare('SELECT choice FROM poll_votes WHERE poll_id = ? AND user_id = ?').bind(poll.id, user.id).first<{ choice: number }>() : null;
    const reactions = await db.prepare('SELECT value, COUNT(*) AS count FROM poll_reactions WHERE poll_id = ? GROUP BY value').bind(poll.id).all<{value:number; count:number}>();
    const myReaction = user.id ? await db.prepare('SELECT value FROM poll_reactions WHERE poll_id = ? AND user_id = ?').bind(poll.id, user.id).first<{value:number}>() : null;
    const commentCount = await db.prepare('SELECT COUNT(*) AS count FROM poll_comments WHERE poll_id = ?').bind(poll.id).first<{count:number}>();
    const options: string[] = JSON.parse(poll.options);
    const totals = options.map((_, index) => counts.results.find((row) => row.choice === index)?.count ?? 0);
    const total = totals.reduce((sum, count) => sum + count, 0);
    const score = total ? (totals[0] - totals[1]) / total * 100 : 0;
    return { likes: reactions.results.find(row => row.value === 1)?.count ?? 0, dislikes: reactions.results.find(row => row.value === -1)?.count ?? 0, reaction: myReaction?.value ?? 0, comments: commentCount?.count ?? 0, id: poll.id, question: poll.question, kind: poll.kind, options, endsAt: poll.ends_at, revealed: !!poll.revealed, total, score, counts: poll.kind === 'choice' || poll.revealed ? totals : null, myVote: myVote?.choice ?? null };
  }));
  const discussion = selected ? await db.prepare('SELECT id, user_id, text, created_at FROM (SELECT * FROM poll_comments WHERE poll_id = ? ORDER BY created_at DESC, id DESC LIMIT 100) ORDER BY created_at ASC, id ASC').bind(selected).all<{id:string; user_id:string; text:string; created_at:number}>() : null;
  const comments = discussion?.results.map(comment => ({id:comment.id, mine:comment.user_id === user.id, text:comment.text, createdAt:comment.created_at})) ?? [];
  return json({ polls, comments, canHost: user.host, signedIn: !!user.id, serverNow: Date.now() });
}
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) return json({ error: 'Invalid request origin.' }, 403);
  const db = env.DB;
  if (!db) return json({ error: 'Poll storage is unavailable.' }, 503);
  const user = identity(request);
  if (!user.id) return json({ error: 'Sign in to vote.' }, 401);
  if (Number(request.headers.get('content-length')) > 4096) return json({ error: 'Request too large.' }, 413);
  const text = await request.text();
  if (text.length > 4096) return json({ error: 'Request too large.' }, 413);
  let input: unknown;
  try { input = JSON.parse(text); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return json({ error: 'Check the question, options, and duration (unlimited, or 15 seconds to 60 minutes).' }, 400);
  const data = parsed.data, now = Date.now();
  if (data.action === 'create') {
    if (!user.host) return json({ error: 'Only the host can start polls.' }, 403);
    const options = data.kind === 'binary' ? ['Yes', 'No'] : data.options;
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return json({ error: 'Each option must be different.' }, 400);
    const result = await db.prepare('INSERT INTO polls (id, question, kind, options, created_at, ends_at, revealed) SELECT ?, ?, ?, ?, ?, ?, 0 WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM polls WHERE ends_at > ? AND revealed = 0)').bind(crypto.randomUUID(), data.question, data.kind, JSON.stringify(options), now, data.duration === 0 ? 0 : now + data.duration * 1000, data.duration, now).run();
    if (!result.meta.changes) return json({ error: 'A poll is already live. End it before starting another.' }, 409);
  } else if (data.action === 'vote') {
    const result = await db.prepare('INSERT INTO poll_votes (poll_id, user_id, choice) SELECT id, ?, ? FROM polls WHERE id = ? AND (ends_at = 0 OR ends_at > ?) AND revealed = 0 AND ? < json_array_length(options) ON CONFLICT(poll_id, user_id) DO UPDATE SET choice = excluded.choice').bind(user.id, data.choice, data.id, now, data.choice).run();
    if (!result.meta.changes) return json({ error: 'Voting has closed or this poll is unavailable.' }, 409);
  } else if (data.action === 'react') {
    const result = await db.prepare('INSERT INTO poll_reactions (poll_id, user_id, value) SELECT id, ?, ? FROM polls WHERE id = ? ON CONFLICT(poll_id, user_id) DO UPDATE SET value = excluded.value').bind(user.id, data.value, data.id).run();
    if (!result.meta.changes) return json({ error: 'Poll not found.' }, 404);
  } else if (data.action === 'comment') {
    const result = await db.prepare('INSERT INTO poll_comments (id, poll_id, user_id, text, created_at) SELECT ?, id, ?, ?, ? FROM polls WHERE id = ?').bind(crypto.randomUUID(), user.id, data.text, now, data.id).run();
    if (!result.meta.changes) return json({ error: 'Poll not found.' }, 404);
  } else {
    if (!user.host) return json({ error: 'Only the host can reveal results.' }, 403);
    const result = await db.prepare('UPDATE polls SET revealed = 1, ends_at = MIN(ends_at, ?) WHERE id = ?').bind(now, data.id).run();
    if (!result.meta.changes) return json({ error: 'Poll not found.' }, 404);
  }
  return json({ ok: true });
}
