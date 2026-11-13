# StreamBullets

Viewers suggest topics, discuss, and vote. Streamers run polls and show them through an OBS overlay.

| Layer | Implementation |
| --- | --- |
| Application | React, React Router in framework mode, TypeScript |
| UI | Tailwind CSS, Radix UI, StreamBullets design |
| Runtime | Cloudflare Workers |
| Data | D1, Drizzle |
| Images | Private R2, served through the Worker |
| Sign-in | Better Auth, Google, Twitch |
| Live updates | Durable Objects, WebSockets |
| Checks | Vitest, Playwright, GitHub Actions |

See [Authentication setup](docs/auth-setup.md) for production sign-in and administrators.

## Behavior

- Accounts start as viewers. **Host a community** accepts 1 to 5 HTTPS channel links and an optional 1,000-character note.
- Viewers can edit pending or rejected applications. Resubmission changes rejected applications to pending. Approved applications cannot change.
- Administrators review all application states, applicant names, and emails at `/admin`.
- Approval permits one profile at `/@handle`. Administrators need no application. Rejection does not remove an existing profile.
- Display names need 1 to 40 characters on one line. Invalid provider names need correction before sign-in.
- D1 stores topics, comments, replies, reactions, and profile changes.
- Each account gets one reaction per topic or poll, one like per comment, and one changeable vote per open poll.
- Only owners create, end, and reveal their polls. Polls can end manually or at a deadline.
- Binary counts and percentages stay private until reveal. Multiple-choice results update live.
- Authors and owners can remove content. Removing a parent comment preserves replies.
- Signed-in users can **Report** topics and comments. Administrators review reports at `/admin`. Hourly cleanup deletes resolved reports after one year.
- **Your data** exports JSON or permanently deletes the account, content, votes, reactions, images, profile, application, sessions, and reports.
- **Sign in** also creates accounts. Registration needs acknowledgement of the minimum age, 16, and links to Terms and Privacy Policy.
- `/privacy` and `/terms` contain legal disclosures. Footers link legal pages, contact, and reporting rules. Overlays have no footer.
- Newest uses stable cursors. Top sorts by likes minus dislikes. Votes can move entries between pages. Refresh for current order.
- `/@handle/overlay` shows the latest active poll. `?poll=<id>` selects a poll. Public overlays cannot vote.
- **Overlay control** creates a private OBS URL with a secret `key`. It grants owner-priority admission, including full rooms.
- The full URL appears once. The server stores only its SHA-256 key hash. **Regenerate link** revokes the old key. Update OBS afterward.
- **Schedule** supports one-off and weekly streams, platform links, linked topics, edits, cancellation, deletion, and replay links.
- Viewers see upcoming and past streams in local time. Desktop adds day, week, and month views.
- `/@handle/schedule.ics` provides a subscribable calendar feed.
- Owners can save up to 8 cards on **Community** and 4 support links in **Edit your page**.
- Support links open external providers. StreamBullets processes no payments.
- Migration `0020` seeds the official `@streambullets` Ideas board. Its system principal has no email, credentials, or sessions.
- Administrators manage ideas. Signed-in users submit improvements and bugs. Everyone can vote. **Suggest an improvement** opens the board.
- The board uses no personal profile slot and survives administrator deletion.
- UI supports English, Spanish, Brazilian Portuguese, German, Polish, Ukrainian, Russian, Japanese, Simplified Chinese, French, and Hindi.
- Locale priority: account, `sb_locale` cookie, `Accept-Language`, English. The footer and account menu open language selection.
- Add message IDs to all 11 `app/i18n/` catalogs. `tests/i18n.test.ts` checks IDs, plural forms, and `{placeholder}` values.
- User content keeps its language. Legal text remains English with translated notices of its legal authority.
- **Accessibility & display** controls colour-vision palettes, contrast, text size, font, link underlines, and motion.
- It also controls score announcements for Mash Battle, shortcuts, and assisted tapping. Accounts and browser cookies keep preferences.
- Before first paint, an inline script with the response nonce applies the preferences.
- `/ai`, `/robots.txt`, and `/llms.txt` allow public agent reads and prohibit posting, voting, and registration.
- `POST /api/ai-interest` accepts one unverified like or dislike per visitor per day. Retention is 30 days.
- JSON-LD describes the site, streamers, upcoming streams, and open topics.

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

Open `http://localhost:5173`. The D1 ID is a local placeholder. Local state stays under `.wrangler/`.

Add provider credential pairs to `.dev.vars`. Incomplete pairs fail closed. No providers means public pages only.
Each complete pair enables its sign-in button. Do not commit secrets or database exports.

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact origin in Wrangler configuration. HTTPS needed except on localhost. |
| `BETTER_AUTH_SECRET` | Stable random secret, at least 32 characters. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth credentials. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Twitch OAuth credentials. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Credentials for TikTok Login Kit. No provider email. |
| `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | Instagram Login credentials. Requires Meta review and a creator or business account. No provider email. |
| `ADMIN_EMAILS` | Case-insensitive administrator emails, separated by commas or spaces. |
| `AI_INTEREST_SALT` | Worker secret, at least 16 random characters. Keys the daily IP hash. The counter never stores raw IPs. Absence disables the counter and buttons. |
| `ADMIN_STEP_UP` | `off`, `report` (default), or `enforce`. Unknown values enforce. See [Admin security keys](#admin-security-keys). |
| `LEGAL_DETAILS` | Worker secret: JSON with `operatorName`, `operatorCountry`, and `policyEffectiveDate` (`YYYY-MM-DD`). Values appear publicly. Missing values show a draft. Invalid values return 503. |
| `CRON_HEARTBEAT_URL` | Optional uptime-service URL. Successful hourly jobs send POST. Configure alerts for missed calls. |
| `CHANNEL_TOKEN_KEYS`, `TWITCH_EVENTSUB_SECRET`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | Worker secrets for channel connections. See [setup](docs/channel-connections.md#setup). |
| `CHANNELS_OFF` | Optional Worker secret. `1` turns channel ingestion off. Never a dashboard variable. See [Turn the feature off](docs/channel-connections.md#turn-the-feature-off). |
| `NOTIFY_EMAIL`, `NOTIFY_FROM` | Optional `send_email` binding and sender. Both enable selected owner notifications for page freezing, suspension, or restoration. In-app notices always appear. |

Administrators need a verified email in `ADMIN_EMAILS`.
TikTok and Instagram placeholder addresses cannot qualify. Without administrators, nobody can approve applications or create new profiles.
Set `ADMIN_EMAILS` locally in `.dev.vars`. Production needs a Worker secret:

```sh
pnpm exec wrangler secret put ADMIN_EMAILS --env production
```

Deployments replace dashboard plain variables with `wrangler.jsonc` values.
Keep real legal details out of Git, CI variables, fixtures, and build inputs. Configure them through Cloudflare before publishing policies.

### Admin security keys

Admin supports FIDO2 keys, such as YubiKeys. Checks last 15 minutes in the current session.
Freezing, suspension, and key changes need a check within 2 minutes.

| `ADMIN_STEP_UP` | Behavior |
| --- | --- |
| `report` | Allows access without keys. With two keys, prompts but permits skipping. Logs unchecked admin calls. |
| `enforce` | Requires two registered keys and a session check within 15 minutes. |
| `off` | Disables checks. Local development only. |

Configure enforcement:

1. Deploy with `report` or no value.
2. Sign out. Then sign in as administrator.
3. Within 5 minutes, open `/admin?view=keys` and register the first key. Register the backup key.
4. In a second session, confirm both keys pass the prompt.
5. Set `ADMIN_STEP_UP=enforce` in `env.production.vars` or a Worker secret. Then deploy.

Keys bind to the `APP_ORIGIN` host. Localhost keys cannot authenticate in production.
See [key recovery](SECURITY.md#recovery-when-the-administrator-loses-every-key).

Register exact provider callbacks:

- `<APP_ORIGIN>/api/auth/callback/google`
- `<APP_ORIGIN>/api/auth/callback/tiktok`
- `<APP_ORIGIN>/api/auth/callback/instagram`
- `<APP_ORIGIN>/api/auth/callback/twitch`

Use separate local provider applications where supported. Twitch needs an email.
See [account linking](docs/auth-setup.md#account-linking-and-registration) for verified-email matching and explicit links.

## Check a change

```sh
pnpm check
pnpm lint
pnpm test:coverage
pnpm audit --audit-level high
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Browser tests run production builds in local Workers with real D1, R2, and Durable Objects.
They use isolated `.wrangler/e2e/` state, real sessions, and signed cookies without test authentication bypasses.
Local development data and secrets remain separate.

Checks cover authorization, constraints, voting, uploads, overlays, and browser flows.
Test OAuth redirects and consent separately with real providers. Local tests cannot prove production capacity or global behavior.
Vitest needs 90% server line, statement, function, and branch coverage.
Separate runtime tests cover Durable Objects outside V8 coverage in Workerd.

## Deploy to Cloudflare

Production is `https://streambullets.com`. `env.production` in `wrangler.jsonc` holds its resources and domain.
Local configuration is separate. Cloudflare redirects `.app` and `.live`, preserving paths and query strings.

Pushes to `main` trigger deployment after verification and SonarQube pass.
Superseded runs skip migrations and deployment. Active deployments finish before queued runs.
PRs check and dry-run production builds without production credentials.

One-time setup:

- Create the GitHub `production` environment, restricted to `main`. Leave reviewer approval off for automatic deployment.
- Store `CLOUDFLARE_API_TOKEN` as an environment secret, restricted to the account and `streambullets.com` zone.
- Grant **Workers Scripts Edit**, **D1 Edit**, **Workers R2 Storage Edit**, **Workers Routes Edit**, and **Zone Read**. Never commit the token.
- Configure stable `BETTER_AUTH_SECRET`, provider credentials, and `ADMIN_EMAILS` as Worker secrets. Wrangler preserves them.
- Make the checks mandatory and block direct pushes. See [Quality gates](#quality-gates).

Deployment records a bookmark for D1 Time Travel, applies migrations, uploads Worker and assets, and checks the homepage and stylesheet.
Migration failure stops deployment. Smoke failure fails the run without automatic schema rollback.
Keep migrations compatible with the live Worker. Time Travel keeps 7 days on Free and 30 days on Paid.

After fixing a missing secret, rerun the failed job.
For code rollback, revert through a PR after checking schema compatibility. Never rerun an old successful deployment over newer code.

See [recovery](docs/recovery.md) for a fast code rollback with `wrangler rollback` and D1 restoration.
The deployment summary records the D1 bookmark and commit SHA. Check the schema compatibility before rollback.

For manual deployment, authenticate Wrangler:

1. Reuse production D1 and private R2. For a new account, create replacements:

   ```sh
   pnpm exec wrangler d1 create stream-bullets
   pnpm exec wrangler r2 bucket create stream-bullets-images
   ```

2. Update `env.production` account and D1 IDs, bucket, HTTPS `APP_ORIGIN`, and domain. Keep `DB`, `IMAGES`, `POLL_ROOMS`, and `REQUEST_LIMITER` bindings.
3. Register callbacks. Store secrets through Cloudflare or `pnpm exec wrangler secret put <NAME> --env production`. Never put secrets in `vars` or browser bundles.
4. Make a backup of existing D1. Then migrate:

   ```sh
   mkdir -p .wrangler/backups
   pnpm exec wrangler d1 export DB --env production --remote --output .wrangler/backups/pre-deploy.sql
   pnpm exec wrangler d1 migrations apply DB --env production --remote
   ```

5. Run checks. Then deploy:

   ```sh
   pnpm deploy
   ```

6. Check both providers, sign-out, two-account authorization, uploads, voting, and OBS. Confirm errors expose no secrets or account data.
7. Submit and approve a test application at `/admin`. Confirm profile creation afterward.

Smoke checks reject missing or invalid `BETTER_AUTH_SECRET`. They do not test OAuth. A new Worker fails until this secret exists.

`pnpm deploy` builds with `CLOUDFLARE_ENV=production`. Durable Object migrations `v1` (`PollRoom`) and `v2`
(`ChannelIngest`) run during upload. Never remove a class a migration added. See
[rollback](docs/channel-connections.md#rollback).

Make a backup of D1 before later schema changes. Roll back only to compatible Worker code.
Never remove migration records or apply old schema files to live data.

## Prototype data

Migrations `0000`-`0002` keep the legacy poll tables. Migration `0003` adds the platform tables.
Future imports need reviewed ownership mappings. Do not infer OAuth owners from Sites identities.
Browser-only prototype topics and profiles never reached the server.

## Security and operating limits

- Mutations need a database session and exact-origin HTTP calls. Sites identity headers grant no access.
- Production cookies use HTTPS, HTTP-only access, and host scope. Server checks enforce ownership and tenant constraints.
- Atomic D1 writes enforce vote uniqueness and deadlines. D1 is authoritative.
- Live rooms expose public data. Public overlays cannot mutate. Mash Battle taps use the authenticated live protocol.
- Rooms allow 200 connections, including 100 signed-out viewers and 10 per client network: IPv4 address or IPv6 /64.
- Owners and valid private overlays get priority. Key hashes use constant-time comparison. Invalid keys receive normal anonymous admission.
- Regeneration closes old-key connections. Frozen overlays remain read-only. Suspension refuses overlays and closes live connections.
- At capacity, signed-in viewers displace the oldest signed-out connection. Snapshots include at most 50 polls and the newest active poll.
- Leases last one hour. Clients ping every 20 seconds. 60 seconds without a ping closes the connection.
- Mash taps enter durable storage before acknowledgement. Totals flush to D1 each second and recover after restart.
- Rooms resync every 15 seconds. Reconnect loads current state. Disconnected views refresh HTTP every 30 seconds.
- See [live capacity](docs/live-room-capacity.md) for retry budgets and measured limits.
- HTTP limits are approximate per Cloudflare location. D1 mutation limits apply per account across targets. Neither stops coordinated multi-account abuse.
- Pages allow 1,000 topics and polls. Discussions allow 10,000 comments. The app caps the HTTP bodies and page sizes.
- Images accept PNG, JPEG, or WebP: at most 5 MB, 16 million pixels, and 8,192 pixels per side.
- Accounts have one avatar. Streamers have one background. Application image URLs are public.
- Uploads remove private metadata, including camera and location data, and keep orientation and color profiles.
- Public responses omit email, credentials, tokens, and sessions. Logs omit the HTTP bodies, identities, and error messages.
- Error logs contain type, stack frames, and call ID. Responses share that ID for report lookup. The site enables Workers logs and issue grouping.
- Limit administrator access to trusted accounts. Administrators can read applicant emails.
- Application decisions appear in the account dialog without email notifications. Deleting a user also deletes their `0004` application row.
- Hourly cleanup removes expired sessions, OAuth state, and rate-limit records in bounded batches.
- Authors and owners delete content. Administrators review reports. There is no account-ban workflow.
- **Your data** supports export and permanent deletion. Deleted D1 rows can remain in Time Travel for 30 days. Never restore deleted accounts.
- The Privacy Policy describes necessary cookies and consent behavior. Get consent before adding optional cookies and update that policy.
- The general limiter keys requests with an IP SHA-256 hash. Better Auth stores the IP and user agent for each session. It uses IP-based database limits.

## Legal pages

Set `LEGAL_DETAILS` with `operatorName`, `operatorCountry`, and `policyEffectiveDate` before launch.
The country also supplies governing law. `app/legal.ts` defines the schema and production contact and minimum age.
Confirm the contact mailbox receives mail. Missing details show a draft notice. Invalid details return 503.

Get legal review before launch. Update disclosures for new processors, cookies, or data uses.
Only English legal text has legal effect. Translated notices explain this.

Dependencies and lockfiles use exact versions with a seven-day release-age check.
Exceptions for `minimatch@11.0.1` and `@isaacs/nonrecursive-glob-match@1.0.1` admit glob denial-of-service fixes.
Overrides fix the HTTP and image dependencies in Miniflare and esbuild in Drizzle Kit. CI checks the resolved tree.

## Quality gates

PRs need `Required quality gates` and `Trusted CI policy`. Production also needs SonarQube on `main`.

| Check | Failure condition |
| --- | --- |
| Application | Type, lint, test, build, browser, or deployment dry-run failure |
| Coverage | Any configured server metric below 90% |
| Dependency review and audit | High or critical vulnerability |
| Gitleaks | Secret in Git history |
| Semgrep | Local security-rule finding |
| Trivy | Fixable high or critical vulnerability |
| Aislop | Score below 100 or finding outside dependency auditing |
| Documentation | ste-cli or Vale warning |
| CodeQL | Analysis failure. Code scanning rules must block findings |
| Policy | Unpinned action, ignored failure, missing gate, or mixed CI/application change |

Scanners use immutable `PINNED` tooling. Candidate configuration cannot select tools.
Promote tools and pins in a separate CI PR. Keep changes to CI policy separate from application changes.
Aislop compatibility settings keep Workers globals and virtual modules. `pnpm audit` owns dependency auditing.

The independent `policy` workflow uses `pull_request_target` and owner-comment events.
It executes `github.workflow_sha` code and inspects candidate Git blobs as data against that revision.
Graph updates and owner comments run it on `main` and report `guard` on the PR head.

Application dependencies can accompany code if exact registry versions and install settings remain intact.
Matching type packages can change together. Tool packages, tool dependency graphs, scripts, and CI controls need policy approval.

Approval binds the file tree, current base, and trusted workflow revision.
Get the tree with `git rev-parse HEAD^{tree}`. The owner can post:

```text
Approve CI policy: tree=<TREE_SHA> base=<CURRENT_PR_BASE_SHA> trusted=<GITHUB_WORKFLOW_SHA>
```

Comment creation, editing, or deletion rechecks policy. Rejection removes approval.
Changed files, base, or trusted revision need renewed approval. Metadata-only commit rewrites preserve tree approval.
Legacy `head=<HEAD_SHA>` approval binds only that commit. Owner comments prove account identity, not human authorship.

Configure repository protection:

- Need `Required quality gates`, `Trusted CI policy`, and up-to-date branches on `main`.
- Block direct pushes. Need code-owner review for policy changes. Enable squash-only merges and automatic branch deletion.
- Enable the dependency graph and code scanning. Make CodeQL findings a merge rule.
- Create the SonarQube `stream-bullets` project with the other public repositories' quality profile and gate.
- Store `SONAR_TOKEN`, `SONAR_HOST_URL`, `TAILSCALE_OAUTH_CLIENT_ID`, and `TAILSCALE_AUDIENCE` as GitHub secrets.
- Allow `tag:github-sonar` to reach SonarQube.

Enable the dependency graph under **Settings > Advanced Security** ([security settings](https://github.com/mickey-kras/stream-bullets/settings/security_analysis)).
The GitHub connector has no control for that setting. Keep the dependency review mandatory.
CODEOWNERS alone enables no protection. Writers can publish statuses. Required code-owner review protects workflow changes.

SonarQube consumes verification coverage from the same commit. The workflow uses secrets only on `main`. Missing configuration blocks deployment.
The Tailscale credential must trust:

```text
repo:mickey-kras/stream-bullets:ref:refs/heads/main
```

Set `TAILSCALE_AUDIENCE` to that credential's audience.
Copied secrets do not extend trust. Token-exchange HTTP 403 blocks SonarQube and deployment.
Documentation tools check writing rules, not full ASD-STE100 Issue 9 compliance or dictionary meanings.

### Board refreshes and public image cache

Votes and reactions disable only the affected entry. They refresh the board and selected entry through existing APIs.
Shell, support, and schedule stay loaded. New reads and navigation cancel older reads. Failed mutations show errors and release controls.

Workers cache image bodies for one hour per data center.
Every read checks the D1 reference and upload version before cache lookup. Cache hits skip R2.
Browsers receive `Cache-Control: no-store` to force access checks. Deleted references fail before cache lookup.

Migration `0021_image_versions.sql` adds versions. Old images bypass cache until re-uploaded.
Replacement stores an immutable R2 object, then publishes its reference and version atomically.

Old writes cannot populate new versions. Cache entries expire after one hour.
Uploads remove previous objects. Account deletion removes all versions, including failed uploads.

Cache errors log their class and fall back to R2. D1 and R2 failures block delivery. Failed access checks never serve stale bodies.
