# StreamBullets

A community app for streamers. Viewers suggest topics, discuss them, and vote. Streamers control live polls and can use a public OBS overlay.

| Layer | Implementation |
| --- | --- |
| Application | React, React Router framework mode, TypeScript |
| UI | Tailwind CSS, Radix UI, the existing StreamBullets design |
| Runtime | Cloudflare Workers |
| Data | D1 and Drizzle |
| Images | Private R2 bucket, served through the Worker |
| Sign-in | Better Auth with Google and Twitch |
| Live updates | Durable Objects and read-only WebSockets |
| Checks | Vitest, Playwright, GitHub Actions |

## Behavior

- Accounts start as viewers. A viewer must create a streamer profile to claim `/@handle`.
- Display names use 1 to 40 characters on one line. If your provider name does not meet this limit, change it before you sign in.
- Topics, comments, replies, likes, dislikes, and profile changes persist in D1.
- Each account has one reaction per topic or poll, one like per comment, and one vote per poll. A poll vote can change until voting closes.
- Only the page owner can create, end, or reveal its polls. Polls can have a time limit or stay open until the owner ends them.
- Binary poll counts and percentages stay private until reveal. Multiple-choice results update live.
- Authors and page owners can remove content. Replies remain when a parent comment is removed.
- Newest uses stable cursor pagination. Top uses likes minus dislikes. New votes can move items between Top pages; refresh to see the new order.
- `/@handle/overlay` shows the latest active poll. Add `?poll=<id>` to select one poll. The overlay is public and cannot submit votes.
- Schedule shows an empty state until scheduling is implemented. It does not imply an event exists.

## Local use

Use Node.js 24 and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
python - <<'PY'
from pathlib import Path
import secrets
with Path('.dev.vars').open('x') as file:
    file.write('BETTER_AUTH_SECRET=' + secrets.token_hex(32) + '\n')
Path('.dev.vars').chmod(0o600)
PY
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173`. The checked-in D1 ID is an explicit local placeholder. Local D1, R2, and Durable Object state stays under `.wrangler/`.

Add Google or Twitch credentials to `.dev.vars` to test sign-in. A provider needs both its client ID and secret. An incomplete pair fails closed. With no providers configured, public pages work but sign-in is unavailable. Do not commit `.dev.vars` or database exports.

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact application origin. HTTPS is required except on localhost. Set it in Wrangler configuration. |
| `BETTER_AUTH_SECRET` | Random secret of at least 32 characters. Keep it stable across deployments. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth application credentials. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Twitch OAuth application credentials. |

Register these exact callback URLs with each enabled provider:

- `<APP_ORIGIN>/api/auth/callback/google`
- `<APP_ORIGIN>/api/auth/callback/twitch`

Use a separate provider application for local testing where supported. Twitch accounts must provide an email address. Provider accounts are not automatically linked by matching email addresses.

## Verify a change

```sh
pnpm check
pnpm lint
pnpm test:coverage
pnpm audit --audit-level high
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The browser suite runs the production build in local Workers with real D1, R2, and Durable Objects. It creates isolated state in `.wrangler/e2e/`. It seeds real session records and signed test cookies; the application has no test sign-in endpoint or identity-header bypass. The suite does not change your local development database or secrets.

Checks cover authorization, data constraints, vote changes and closure, uploads, public overlays, and critical browser flows. OAuth provider redirects and consent require a separate check with the real provider applications. Local tests do not establish production capacity or global Cloudflare behavior.

Vitest requires 90% line, statement, function, and branch coverage for server modules. The Durable Object runs in a separate Workerd process, outside V8 coverage collection; its behavior has a separate runtime test suite.

## Deploy to Cloudflare

Use a Cloudflare account with Workers, D1, R2, and SQLite Durable Objects enabled. Authenticate Wrangler on your deployment machine. CI does not receive production credentials or deploy pull requests.

1. Create a D1 database and R2 bucket:

   ```sh
   pnpm exec wrangler d1 create stream-bullets
   pnpm exec wrangler r2 bucket create stream-bullets-images
   ```

2. Put the returned D1 ID in `wrangler.jsonc`. Set `APP_ORIGIN` to the exact HTTPS production origin. Configure that hostname as a Worker route or custom domain. Keep the binding names `DB`, `IMAGES`, `POLL_ROOMS`, and `REQUEST_LIMITER`.
3. Register the production OAuth callback URLs. Store `BETTER_AUTH_SECRET` and provider credentials as Worker secrets, through the Cloudflare dashboard or `wrangler secret put <NAME>`. Never put secrets in `vars`, the repository, or a browser bundle. A new Worker returns an error until its authentication secret is configured.
4. Back up an existing D1 database before applying migrations:

   ```sh
   mkdir -p .wrangler/backups
   pnpm exec wrangler d1 export DB --remote --output .wrangler/backups/pre-deploy.sql
   pnpm exec wrangler d1 migrations apply DB --remote
   ```

5. Run the checks, build with the production configuration, then deploy:

   ```sh
   pnpm build
   pnpm deploy
   ```

6. Verify Google and Twitch sign-in, sign-out, two-account authorization, image upload, poll voting, and an OBS browser source on the production origin. Confirm failed requests do not expose secrets or account data.

The Durable Object `v1` migration runs with the Worker deployment. Back up D1 before later schema changes. Roll back Worker code only to a version that supports the current schema. Do not remove migration records or apply old schema files over live data.

## Prototype data

Migrations `0000`–`0002` and their legacy poll tables remain intact. The platform adds separate tables in migration `0003`. It does not assign old Sites identities to OAuth accounts or publish legacy polls under a guessed owner. Use an explicit, reviewed ownership mapping before any future data import. Browser-only prototype topics and profiles were never stored on the server.

## Security and operating limits

- All changes require a database session and an exact same-origin request. Forwarded Sites identity headers grant no access. Production cookies use HTTPS, HTTP-only access, and host scope.
- Owner checks and tenant constraints run on the server. Vote uniqueness and the poll deadline are enforced in atomic database writes. D1 is the source of truth.
- WebSockets expose public poll data only. They do not accept application mutations. Each room accepts at most 200 connections, with at most 10 per trusted client IP, and returns at most 50 polls, including the newest active poll. Connections have a fixed one-hour lease. Active rooms resync every 15 seconds to recover a missed notification; reconnect also loads current state. Disconnected views refresh over HTTP every 30 seconds and keep retrying WebSockets automatically.
- The edge request limiter is approximate and local to a Cloudflare location. D1 mutation limits apply across targets for each account. These limits do not prevent coordinated abuse by many accounts.
- A page can contain up to 1,000 topics and polls. A discussion can contain up to 10,000 comments. Request bodies and page sizes are bounded.
- Uploads accept PNG, JPEG, and WebP only, up to 5 MB, 16 million pixels, and 8,192 pixels per side. Each account has one avatar and each streamer has one background. Uploaded images are public through their application URLs. Image metadata is not stripped.
- Public responses omit email, tokens, provider credentials, and session details. The app does not log request bodies or identities. Cloudflare observability is off by default; review platform retention and redaction before enabling it.
- An hourly task removes expired sessions, OAuth state, and old rate-limit records in bounded batches.
- Content moderation is limited to author and streamer deletion. There is no report queue, account ban workflow, provider linking, or self-service account deletion in this version. Operators must handle deletion and abuse requests directly.

Require the `Verify application` check in the repository ruleset. Keep squash-only merges and branch deletion in the repository settings. The workflow cannot enforce those settings itself.

Dependency versions and the lockfile are pinned. Installation retains the seven-day release-age check. The exact `minimatch@11.0.1` and `@isaacs/nonrecursive-glob-match@1.0.1` exceptions admit the fix for glob expansion denial of service. Scoped overrides patch Miniflare's HTTP/image dependencies and Drizzle Kit's old esbuild dependency. CI checks the resolved dependency tree.
