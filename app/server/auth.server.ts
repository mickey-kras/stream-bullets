import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, betterAuth, type BetterAuthOptions, type User } from 'better-auth';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../db/auth-schema';
import type { AppContext, AppEnv } from '../env';
import type { Viewer } from '../types';
import { getOrigin, HttpError } from './http.server';
import { displayNameSchema } from './validation';

type Provider = 'google' | 'twitch';

export function configuredProviders(env: AppEnv): Provider[] {
  const providers: Provider[] = [];
  for (const [provider, id, secret] of [
    ['google', env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
    ['twitch', env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET],
  ] as const) {
    if (Boolean(id) !== Boolean(secret)) {
      throw new HttpError(503, `Both ${provider} OAuth credentials must be configured.`);
    }
    if (id && secret) providers.push(provider);
  }
  return providers;
}

export function createAuth(env: AppEnv): ReturnType<typeof betterAuth> {
  const origin: string = getOrigin(env);
  if (typeof env.BETTER_AUTH_SECRET !== 'string' || env.BETTER_AUTH_SECRET.length < 32) {
    throw new HttpError(503, 'Authentication secret is not configured.');
  }
  configuredProviders(env);
  const options: BetterAuthOptions = {
    appName: 'StreamBullets',
    baseURL: origin,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite', schema, transaction: false }),
    databaseHooks: {
      user: {
        create: {
          async before(user: User & Record<string, unknown>): Promise<{ data: User & Record<string, unknown> }> {
            const name = displayNameSchema.safeParse(user.name);
            if (!name.success) {
              throw new APIError('BAD_REQUEST', {
                code: 'INVALID_DISPLAY_NAME',
                message: 'Set your provider display name to 1 to 40 characters on one line, then sign in again.',
              });
            }
            return { data: { ...user, name: name.data } };
          },
        },
      },
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
        google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      } : {}),
      ...(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET ? {
        twitch: { clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET },
      } : {}),
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    disabledPaths: ['/link-social', '/unlink-account', '/update-user'],
    session: {
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: origin.startsWith('https:'),
      cookiePrefix: 'stream-bullets',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    logger: {
      level: 'warn',
      log(level: 'debug' | 'info' | 'warn' | 'error'): void {
        if (level === 'error') console.error('authentication_error');
        else if (level === 'warn') console.warn('authentication_warning');
      },
    },
  };
  return betterAuth(options);
}

export async function getViewer(request: Request, context: AppContext): Promise<Viewer | null> {
  const { response, headers } = await createAuth(context.env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) {
    context.responseHeaders.append('Set-Cookie', cookie);
  }
  if (!response) return null;
  const avatar: string = `/images/avatar/${encodeURIComponent(response.user.id)}`;
  return {
    id: response.user.id,
    name: response.user.name,
    avatar: response.user.image === avatar ? avatar : null,
  };
}
