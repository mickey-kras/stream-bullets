import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { user } from '../../db/schema';
import { appContext, type AppContext } from '../env';
import { configuredProviders, getViewer } from '../server/auth.server';
import { consumeMutationQuota, getEntry, getOwnStreamer, getStreamer, listComments, listEntries, listStreamers, mutateComment, mutateEntry, saveStreamer } from '../server/data.server';
import { commentActionSchema, commentQuerySchema, entryActionSchema, entryQuerySchema, streamerSchema } from '../server/validation';
import { HttpError, errorResponse, json, queryParams, readJson, requireSameOrigin } from '../server/http.server';
import { uploadImage } from '../server/images.server';

const accountSchema = z.object({ name: z.string().trim().min(1).max(40).refine((name: string) => !Array.from(name).some((character: string) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'Use a single-line display name.') }).strict();

function parsedQuery<T>(request: Request, keys: string[], schema: z.ZodType<T>): T {
  const result = schema.safeParse(Object.fromEntries(queryParams(request, keys)));
  if (!result.success) throw new HttpError(400, 'Invalid query parameters.');
  return result.data;
}

async function notifyRoom(app: AppContext, streamerId: string): Promise<void> {
  try {
    const room = app.env.POLL_ROOMS.get(app.env.POLL_ROOMS.idFromName(streamerId));
    const result = await room.fetch(`https://poll-room.internal/refresh?streamerId=${encodeURIComponent(streamerId)}`, { method: 'POST' });
    if (!result.ok) console.error('live_refresh_failed');
  } catch { console.error('live_refresh_failed'); }
}

export async function loader({ request, context, params }: LoaderFunctionArgs): Promise<Response> {
  try {
    const app = context.get(appContext);
    const path = params['*'] ?? '';
    const viewer = await getViewer(request, app);
    if (path === 'me') {
      queryParams(request, []);
      return json({ viewer, streamer: viewer ? await getOwnStreamer(app.env, viewer.id) : null, providers: configuredProviders(app.env) });
    }
    if (path === 'streamers') { queryParams(request, []); return json({ streamers: await listStreamers(app.env) }); }
    const board = /^streamers\/([a-z0-9_]{3,30})$/.exec(path);
    if (board) {
      const input = parsedQuery(request, ['kind', 'sort', 'query', 'cursor'], entryQuerySchema);
      const streamer = await getStreamer(app.env, board[1]);
      if (!streamer) throw new HttpError(404, 'Streamer not found.');
      return json(await listEntries(app.env, streamer, viewer?.id ?? null, input));
    }
    const entry = /^entries\/([a-f0-9-]{36})(\/comments)?$/.exec(path);
    if (entry && z.string().uuid().safeParse(entry[1]).success) {
      const current = await getEntry(app.env, entry[1], viewer?.id ?? null);
      if (!current) throw new HttpError(404, 'Topic or poll not found.');
      if (entry[2]) {
        const input = parsedQuery(request, ['sort', 'cursor'], commentQuerySchema);
        return json(await listComments(app.env, current.id, viewer?.id ?? null, input));
      }
      queryParams(request, []);
      return json({ entry: current });
    }
    throw new HttpError(404, 'Endpoint not found.');
  } catch (error) { return errorResponse(error); }
}

export async function action({ request, context, params }: ActionFunctionArgs): Promise<Response> {
  try {
    const app = context.get(appContext);
    requireSameOrigin(request, app.env);
    queryParams(request, []);
    const viewer = await getViewer(request, app);
    if (!viewer) throw new HttpError(401, 'Sign in to continue.');
    const path = params['*'] ?? '';
    const upload = /^images\/(avatar|background)$/.exec(path);
    if (upload && request.method === 'PUT') {
      await consumeMutationQuota(app.env, viewer.id, true);
      return json({ url: await uploadImage(request, app.env, viewer.id, upload[1]) });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (path === 'profile') return json({ streamer: await saveStreamer(app.env, viewer.id, await readJson(request, streamerSchema)) });
    if (path === 'account') {
      const input = await readJson(request, accountSchema);
      await consumeMutationQuota(app.env, viewer.id);
      await drizzle(app.env.DB).update(user).set({ name: input.name, updatedAt: new Date() }).where(eq(user.id, viewer.id));
      return json({ viewer: { ...viewer, name: input.name } });
    }
    if (path === 'comments') return json(await mutateComment(app.env, viewer.id, await readJson(request, commentActionSchema)));
    const board = /^streamers\/([a-z0-9_]{3,30})$/.exec(path);
    if (board) {
      const input = await readJson(request, entryActionSchema);
      const streamer = await getStreamer(app.env, board[1]);
      if (!streamer) throw new HttpError(404, 'Streamer not found.');
      const result = await mutateEntry(app.env, viewer.id, streamer.id, input);
      await notifyRoom(app, streamer.id);
      return json(result);
    }
    throw new HttpError(404, 'Endpoint not found.');
  } catch (error) { return errorResponse(error); }
}
