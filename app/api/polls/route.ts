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
// 2000 UTF-16 code units need at most 12000 bytes as JSON unicode escapes.
// Leave room for the action, UUID, keys, and modest formatting overhead.
const MAX_BODY_BYTES = 16 * 1024;
const COMMENT_WINDOW_MS = 60_000;
const COMMENT_LIMIT = 5;
const cursorSchema = z.string().regex(/^\d{1,16}:[0-9a-f-]{36}$/i).refine(value => {
  const [time, id] = value.split(':');
  return Number.isSafeInteger(Number(time)) && z.string().uuid().safeParse(id).success;
});
const querySchema = z.object({ poll: z.string().uuid().optional(), sort: z.enum(['top', 'newest']).optional(), before: cursorSchema.optional() }).strict().refine(value => !value.before || !!value.poll);
export async function GET(request: Request): Promise<Response> {
  const db = env.DB;
  if (!db) return json({ error: 'Poll storage is unavailable.' }, 503);
  const user = identity(request);
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length !== 1)) return json({ error: 'Invalid poll, sort, or comment cursor.' }, 400);
  const { poll: selected, before } = parsed.data;
  const order = parsed.data.sort === 'top' ? 'COALESCE((SELECT SUM(value) FROM poll_reactions WHERE poll_id = polls.id), 0) DESC, created_at DESC, id DESC' : 'created_at DESC, id DESC';
  const rows = selected ? await db.prepare('SELECT * FROM polls WHERE id = ?').bind(selected).all<PollRow>() : await db.prepare(`SELECT * FROM polls ORDER BY ${order} LIMIT 50`).all<PollRow>();
  const ids = rows.results.map(poll => poll.id);
  const placeholders = ids.map(() => '?').join(',');
  // Three grouped reads for the whole page, independent of the number of polls.
  const votes = ids.length ? (await db.prepare(`SELECT poll_id, choice, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM poll_votes WHERE poll_id IN (${placeholders}) GROUP BY poll_id, choice`).bind(user.id, ...ids).all<{poll_id:string; choice:number; count:number; mine:number}>()).results : [];
  const reactions = ids.length ? (await db.prepare(`SELECT poll_id, value, COUNT(*) AS count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM poll_reactions WHERE poll_id IN (${placeholders}) GROUP BY poll_id, value`).bind(user.id, ...ids).all<{poll_id:string; value:number; count:number; mine:number}>()).results : [];
  const commentCounts = ids.length ? (await db.prepare(`SELECT poll_id, COUNT(*) AS count FROM poll_comments WHERE poll_id IN (${placeholders}) GROUP BY poll_id`).bind(...ids).all<{poll_id:string; count:number}>()).results : [];
  const polls = rows.results.map(poll => {
    const counts = votes.filter(row => row.poll_id === poll.id);
    const ratings = reactions.filter(row => row.poll_id === poll.id);
    const options: string[] = JSON.parse(poll.options);
    const totals = options.map((_, index) => counts.find(row => row.choice === index)?.count ?? 0);
    const total = totals.reduce((sum, count) => sum + count, 0);
    const score = total ? (totals[0] - totals[1]) / total * 100 : 0;
    return { likes: ratings.find(row => row.value === 1)?.count ?? 0, dislikes: ratings.find(row => row.value === -1)?.count ?? 0, reaction: ratings.find(row => row.mine)?.value ?? 0, comments: commentCounts.find(row => row.poll_id === poll.id)?.count ?? 0, id: poll.id, question: poll.question, kind: poll.kind, options, endsAt: poll.ends_at, revealed: !!poll.revealed, total, score, counts: poll.kind === 'choice' || poll.revealed ? totals : null, myVote: counts.find(row => row.mine)?.choice ?? null };
  });
  const cursor = before?.split(':');
  const discussion = selected ? await db.prepare(`SELECT id, user_id, text, created_at FROM poll_comments WHERE poll_id = ? ${cursor ? 'AND (created_at, id) < (?, ?)' : ''} ORDER BY created_at DESC, id DESC LIMIT 101`).bind(...(cursor ? [selected, Number(cursor[0]), cursor[1]] : [selected])).all<{id:string; user_id:string; text:string; created_at:number}>() : null;
  const page = discussion?.results.slice(0, 100) ?? [];
  const oldest = page.at(-1);
  const nextCommentsCursor = discussion && discussion.results.length > 100 && oldest ? `${oldest.created_at}:${oldest.id}` : null;
  const comments = page.reverse().map(comment => ({id:comment.id, mine:comment.user_id === user.id, text:comment.text, createdAt:comment.created_at}));
  return json({ polls, comments, nextCommentsCursor, canHost: user.host, signedIn: !!user.id, serverNow: Date.now() });
}
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) return json({ error: 'Invalid request origin.' }, 403);
  const db = env.DB;
  if (!db) return json({ error: 'Poll storage is unavailable.' }, 503);
  const user = identity(request);
  if (!user.id) return json({ error: 'Sign in to vote.' }, 401);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
      void reader?.cancel().catch(() => {});
      return json({ error: 'Request too large (maximum 16 KiB).' }, 413);
    }
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return json({ error: 'Request too large (maximum 16 KiB).' }, 413);
        }
        chunks.push(chunk.value);
      }
    }
  } catch { return json({ error: 'Unable to read request body.' }, 400); }
  finally { reader?.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { return json({ error: 'Invalid UTF-8 JSON.' }, 400); }
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
    // The limit check and insert are one SQLite statement, so concurrent requests
    // cannot both claim the final slot. The composite index bounds the lookup.
    const result = await db.prepare('INSERT INTO poll_comments (id, poll_id, user_id, text, created_at) SELECT ?, id, ?, ?, ? FROM polls WHERE id = ? AND (SELECT COUNT(*) FROM poll_comments WHERE poll_id = ? AND user_id = ? AND created_at > ?) < ?').bind(crypto.randomUUID(), user.id, data.text, now, data.id, data.id, user.id, now - COMMENT_WINDOW_MS, COMMENT_LIMIT).run();
    if (!result.meta.changes) {
      const poll = await db.prepare('SELECT id FROM polls WHERE id = ?').bind(data.id).first<{id:string}>();
      if (!poll) return json({ error: 'Poll not found.' }, 404);
      return Response.json({ error: 'You can post 5 comments per minute on a poll. Wait 60 seconds and try again.', retryAfterSeconds: 60 }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
    }
  } else {
    if (!user.host) return json({ error: 'Only the host can reveal results.' }, 403);
    const result = await db.prepare('UPDATE polls SET revealed = 1, ends_at = MIN(ends_at, ?) WHERE id = ?').bind(now, data.id).run();
    if (!result.meta.changes) return json({ error: 'Poll not found.' }, 404);
  }
  return json({ ok: true });
}
