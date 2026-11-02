import { createRequestHandler, RouterContextProvider } from 'react-router';
import { appContext, type AppEnv } from '../app/env';
import { getStreamer } from '../app/server/data.server';
import { HttpError, errorResponse, getOrigin, queryParams, requireSameOrigin, securityHeaders } from '../app/server/http.server';
import { serveImage } from '../app/server/images.server';
import { cleanExpiredData } from '../app/server/cleanup.server';

export { PollRoom } from '../app/server/poll-room';

const handler = createRequestHandler(() => import('virtual:react-router/server-build'), import.meta.env.MODE);

export default {
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    await cleanExpiredData(env, controller.scheduledTime);
  },
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    const responseHeaders = new Headers();
    let response: Response;
    let origin: string;
    try {
      origin = getOrigin(env);
      if (new URL(request.url).origin !== origin) throw new HttpError(421, 'Use the configured application URL.');
      const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') ?? 'local'));
      const key = Array.from(new Uint8Array(keyBytes), (byte: number) => byte.toString(16).padStart(2, '0')).join('');
      if (!(await env.REQUEST_LIMITER.limit({ key })).success) throw new HttpError(429, 'Too many requests. Please try again in a minute.');
      const path = new URL(request.url).pathname;
      const live = /^\/api\/live\/([a-z0-9_]{3,30})$/.exec(path);
      if (live) {
        requireSameOrigin(request, env);
        queryParams(request, []);
        if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'Use a WebSocket connection.');
        const streamer = await getStreamer(env, live[1]);
        if (!streamer) throw new HttpError(404, 'Streamer not found.');
        const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(streamer.id));
        response = await room.fetch(`https://poll-room.internal/subscribe?streamerId=${encodeURIComponent(streamer.id)}`, { headers: { Upgrade: 'websocket', 'X-Stream-Bullets-Client': key } });
      } else if (path.startsWith('/images/')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
        response = await serveImage(env, path.slice('/images/'.length), request.method);
      } else {
        const context = new RouterContextProvider();
        context.set(appContext, { env, nonce, responseHeaders });
        response = await handler(request, context);
      }
    } catch (error) {
      response = errorResponse(error);
      origin = 'https://invalid.invalid';
    }
    const secured = securityHeaders(response, request, nonce, origin, import.meta.env.DEV);
    for (const value of responseHeaders.getSetCookie()) secured.headers.append('Set-Cookie', value);
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
