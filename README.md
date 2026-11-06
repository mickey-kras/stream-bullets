# StreamBullets

A community app for streamers. Viewers suggest topics, discuss them, and vote. Streamers control live polls and can use a public OBS overlay.

| Layer | Implementation |
| --- | --- |
| Application | React, React Router in framework mode, TypeScript |
| UI | Tailwind CSS, Radix UI, the existing StreamBullets design |
| Runtime | Cloudflare Workers |
| Data | D1 and Drizzle |
| Images | Private R2 bucket, served through the Worker |
| Sign-in | Better Auth with Google and Twitch |
| Live updates | Durable Objects and read-only WebSockets |
| Checks | Vitest, Playwright, GitHub Actions |

## Behavior

- Accounts start as viewers. In this version, a streamer profile needs approval.
- A viewer joins the waitlist in **Settings**. The application contains 1 to 5 HTTPS links to the channels of the viewer. It can also contain a note of up to 1,000 characters.
- The viewer can change a pending or rejected application. When the viewer sends a rejected application again, it becomes pending. An approved application cannot change.
- Administrators review applications at `/admin`. The page shows pending, approved, and rejected applications. Administrators can see the name and email address of each applicant.
- After approval, the account can create one streamer profile and claim `/@handle`. Administrators can create a streamer profile without an application.
- Existing streamer profiles continue to work. A rejection does not remove an existing profile.
- Display names use 1 to 40 characters on one line. If your provider name does not meet this limit, change it before you sign in.
- Topics, comments, replies, likes, dislikes, and profile changes persist in D1.
- Each account has one reaction per topic or poll, one like per comment, and one vote per poll. A poll vote can change until voting closes.
- Only the page owner can create, end, or reveal its polls. Polls can have a time limit or stay open until the owner ends them.
- Binary poll counts and percentages stay private until reveal. Multiple-choice results update live.
- Authors and page owners can remove content. Replies remain when an author or page owner removes a parent comment.
- Signed-in users can report a topic or comment with **Report**. Administrators review reports at `/admin`. The hourly task deletes resolved reports after one year.
- In **Settings > Your data**, a user can download a JSON copy of their data. The user can also delete the account. Deletion removes the account and all of its data. This includes content, votes, reactions, images, the streamer profile, the application, sessions, and reports.
- Sign-up and sign-in are one step. The home page shows one **Sign in** button. The sign-in dialog tells the user to be 16 or older and links the Terms and the Privacy Policy.
- `/privacy` and `/terms` show the Privacy Policy and the Terms of Service. A footer on each page links to them, the contact address, and the reporting rules. The overlay has no footer.
- Newest uses stable cursor pagination. Top uses likes minus dislikes. New votes can move items between Top pages. Refresh to see the new order.
- `/@handle/overlay` shows the latest active poll. Add `?poll=<id>` to select one poll. The overlay is public and cannot submit votes.
- The page owner schedules streams on the **Schedule** tab, as one-off or weekly streams. Each stream has a platform, a link, and optional linked topics. The owner can edit, cancel, or delete a stream and add a replay link. Viewers see a feed of upcoming and past streams, plus day, week, and month views on desktop, in their local time zone.
- `/@handle/schedule.ics` serves the schedule as a calendar feed. Calendar apps can subscribe to it.
- The owner edits up to 8 cards on the **Community** tab and up to 4 support links in **Edit your page**. Support links open the provider site. StreamBullets takes no payments.
- The official `@streambullets` page is the Ideas board. Signed-in users suggest improvements and report bugs there, and everyone can vote. **Suggest an improvement** in the footer and the account menu opens it.

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

Add Google, TikTok, Twitch or Instagram credentials to `.dev.vars` to test sign-in. A provider needs both values of its credential pair. An incomplete pair fails closed. With no providers configured, public pages work but sign-in is unavailable. Do not commit `.dev.vars` or database exports.

The production site shows no sign-in buttons until you set at least one credential pair as Worker secrets. The sign-in dialog shows a button for each provider with a complete pair.

| Setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact application origin. Use HTTPS except on localhost. Set it in Wrangler configuration. |
| `BETTER_AUTH_SECRET` | Random secret of at least 32 characters. Keep it stable across deployments. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credentials for the Google OAuth application. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Credentials for the Twitch OAuth application. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Credentials for the TikTok Login Kit application. TikTok gives no email address. |
| `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | Credentials for an Instagram API with Instagram Login application. Only creator and business accounts can sign in. Meta must review the application first. Instagram gives no email address. |
| `ADMIN_EMAILS` | Email addresses of administrators. Use commas or spaces between the addresses. Letter case is not important. |

An administrator is an account with a verified email address in `ADMIN_EMAILS`. TikTok and Instagram accounts get a placeholder address that is not verified, so they cannot be administrators. If `ADMIN_EMAILS` is empty, nobody can approve applications or create new streamer profiles.

For local testing, add `ADMIN_EMAILS` to `.dev.vars`. For production, store it as a Worker secret. Use `pnpm exec wrangler secret put ADMIN_EMAILS --env production` or the Cloudflare dashboard. Do not use a plain variable in the dashboard. Each deployment replaces plain variables with the `vars` in `wrangler.jsonc`.

Register these exact callback URLs with each enabled provider:

- `<APP_ORIGIN>/api/auth/callback/google`
- `<APP_ORIGIN>/api/auth/callback/tiktok`
- `<APP_ORIGIN>/api/auth/callback/instagram`
- `<APP_ORIGIN>/api/auth/callback/twitch`

Use a separate provider application for local testing where supported. Twitch accounts must have an email address. The app does not automatically link provider accounts with matching email addresses.

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

The browser suite runs the production build in local Workers with real D1, R2, and Durable Objects. It creates isolated state in `.wrangler/e2e/`. It seeds real session records and signed test cookies. The application has no test sign-in endpoint or identity-header bypass. The suite does not change your local development database or secrets.

Checks cover authorization, data constraints, vote changes and closure, uploads, public overlays, and critical browser flows. OAuth provider redirects and consent need a separate check with the real provider applications. Local tests do not prove production capacity or global Cloudflare behavior.

Vitest requires 90% line, statement, function, and branch coverage for server modules. The Durable Object runs in a separate Workerd process, outside V8 coverage collection. Its behavior has a separate runtime test suite.

## Deploy to Cloudflare

Production uses `https://streambullets.com`. The `production` environment in `wrangler.jsonc` contains its account, database, bucket, and custom domain. Local development retains its separate configuration. Cloudflare redirects `streambullets.app` and `streambullets.live` to the primary domain with the path and query string preserved.

Each push to `main` triggers GitHub Actions. Deployment starts after `Verify application` passes, unless a newer commit reaches `main`. Superseded runs skip migration and deployment. A PR runs verification and a production build dry run without production credentials. Runs queue without interrupting an active deployment.

One-time setup:

- Create the GitHub `production` environment. Restrict its deployment branches to `main`. Omit required reviewers for automatic deployment.
- Add `CLOUDFLARE_API_TOKEN` as an environment secret. Restrict the Cloudflare token to this account and the `streambullets.com` zone. Give it these permissions: **Workers Scripts Edit**, **D1 Edit**, **Workers R2 Storage Edit**, **Workers Routes Edit**, and **Zone Read**. Do not put the token in a file or workflow.
- Configure `BETTER_AUTH_SECRET`, Google credentials, and Twitch credentials as Worker secrets, as described below. Wrangler preserves existing secrets during deployment. The production smoke check fails if `BETTER_AUTH_SECRET` is missing or invalid. It does not check OAuth sign-in. Test both providers after setup.
- Store `ADMIN_EMAILS` as a Worker secret, as described above. Without it, nobody can approve streamer applications.
- Make `Verify application` mandatory before merging to `main` and prevent direct pushes in the repository ruleset.

The deployment records the current bookmark for D1 Time Travel before applying pending migrations. It uploads the production Worker and assets, then checks the homepage and stylesheet. A migration failure stops deployment. A failed smoke check marks the run as failed. It does not automatically roll back the schema. Keep migrations compatible with the currently deployed Worker until the new version is live.

Time Travel retention is 7 days on Workers Free and 30 days on Workers Paid.

After changing a missing secret, rerun the failed deployment job. For a code rollback, revert the change through a PR. Check the schema compatibility first. Do not rerun an old successful deployment after newer code is live.

For a manual deployment, authenticate Wrangler on your deployment machine:

1. The production configuration has an existing D1 database and private R2 bucket. For a new account, create replacements:

   ```sh
   pnpm exec wrangler d1 create stream-bullets
   pnpm exec wrangler r2 bucket create stream-bullets-images
   ```

2. For a replacement account, update `env.production` with its account and D1 IDs, bucket, HTTPS `APP_ORIGIN`, and custom domain. Keep the binding names `DB`, `IMAGES`, `POLL_ROOMS`, and `REQUEST_LIMITER`.
3. Register the OAuth callback URLs for production. Store `BETTER_AUTH_SECRET`, `ADMIN_EMAILS`, and provider credentials as Worker secrets through the Cloudflare dashboard or `pnpm exec wrangler secret put <NAME> --env production`. Never put secrets in `vars`, the repository, or a browser bundle. A new Worker returns an error until you configure its authentication secret.
4. Make a backup of an existing D1 database before applying migrations:

   ```sh
   mkdir -p .wrangler/backups
   pnpm exec wrangler d1 export DB --env production --remote --output .wrangler/backups/pre-deploy.sql
   pnpm exec wrangler d1 migrations apply DB --env production --remote
   ```

5. Run the checks. Deploy after they pass. This command builds with `CLOUDFLARE_ENV=production` before uploading the generated Worker:

   ```sh
   pnpm deploy
   ```

6. Check Google and Twitch sign-in, sign-out, two-account authorization, image upload, and poll voting on the production origin. Check an OBS browser source. Confirm failed requests do not expose secrets or account data.
7. Send a waitlist application from a test account. Approve it at `/admin` with an administrator account. Make sure that the test account can then create a streamer profile.

The Durable Object `v1` migration runs with the Worker deployment. Make a backup of D1 before later schema changes. Roll back Worker code only to a version that supports the current schema. Do not remove migration records or apply old schema files over live data.

## Prototype data

Migrations `0000`–`0002` and their legacy poll tables remain intact. The platform adds separate tables in migration `0003`. It does not assign old Sites identities to OAuth accounts or publish legacy polls under a guessed owner. Use an explicit, reviewed ownership mapping before any future data import. The server never stored browser-only prototype topics and profiles.

## Security and operating limits

- All changes need a database session and an HTTP call from the exact same origin. Forwarded Sites identity headers grant no access. Production cookies use HTTPS, HTTP-only access, and host scope.
- Owner checks and tenant constraints run on the server. Atomic database writes enforce vote uniqueness and the poll deadline. D1 is the source of truth.
- WebSockets expose public poll data only. They do not accept application mutations. Each room accepts at most 200 connections, with at most 10 per trusted client IP. It returns at most 50 polls, including the newest active poll. Connections have a fixed one-hour lease. Active rooms resync every 15 seconds to recover a missed notification. Reconnect also loads current state. Disconnected views refresh over HTTP every 30 seconds and keep retrying WebSockets automatically.
- The limiter for HTTP requests is approximate and local to a Cloudflare location. D1 mutation limits apply across targets for each account. These limits do not prevent coordinated abuse by many accounts.
- A page can contain up to 1,000 topics and polls. A discussion can contain up to 10,000 comments. The app limits the bodies of HTTP requests and page sizes.
- Uploads accept PNG, JPEG, and WebP only, up to 5 MB, 16 million pixels, and 8,192 pixels per side. Each account has one avatar and each streamer has one background. Uploaded images are public through their application URLs. The app keeps image metadata.
- Public responses omit email, tokens, provider credentials, and session details. The app does not log the bodies of HTTP requests or identities. Cloudflare observability is off by default. Review platform retention and redaction before enabling it.
- Administrators can see the email address of each applicant. Give administrator access only to trusted accounts.
- The app does not send email about review decisions in this version. Applicants see the status of their application in **Settings**.
- Migration `0004` adds the `streamer_applications` table. When you delete a user, the database also deletes the application of that user.
- An hourly task removes expired sessions, OAuth state, and old rate-limit records in bounded batches.
- Authors and streamers can delete content. Users can report content, and administrators review the reports at `/admin`. There is no account ban workflow or provider linking in this version.
- Users can export or delete their own data in **Settings > Your data**. Account deletion is permanent. Deleted rows stay in D1 Time Travel for up to 30 days. Do not restore a deleted account from Time Travel.
- The app sets only necessary cookies: the session cookie and the OAuth state cookie, with the `stream-bullets` prefix. It has no analytics, advertisements, or trackers. Thus, it shows no cookie banner. Get consent before you add a cookie that is not necessary, and update the Privacy Policy.
- The general rate limiter uses a SHA-256 hash of the client IP address as its key. Better Auth keeps the IP address and user agent on each session. Its database rate limit also uses the IP address.

## Legal pages

The Privacy Policy and the Terms of Service get the details of the operator from `app/legal.ts`. Replace each value in square brackets before launch:

- `operatorName`: the legal name of the operator.
- `operatorCountry`: the country of residence of the operator. The Terms also use it as the governing law.
- `policyEffectiveDate`: the date that the policy starts.

`contactEmail` and `minimumAge` have production values. Make sure that the contact mailbox receives email. While a placeholder remains, both pages show a draft notice at the top. Get a legal review of the text before launch. Update the pages when you add a data processor, a cookie, or a new use of data.

Make the `Verify application` check mandatory in the repository ruleset. Keep squash-only merges and branch deletion in the repository settings. The workflow cannot enforce those settings itself.

The repository pins dependency versions and the lockfile. Installation retains the seven-day release-age check. The exact `minimatch@11.0.1` and `@isaacs/nonrecursive-glob-match@1.0.1` exceptions admit the fix for glob expansion denial of service. Scoped overrides patch Miniflare's HTTP and image dependencies and Drizzle Kit's old esbuild dependency. CI checks the resolved dependency tree.

## Quality gates

Each PR must pass `Required quality gates` and `Trusted CI policy`. This check requires application verification, security scans, policy checks, and documentation checks. Production also requires the SonarQube quality gate on `main`.

| Check | Failure condition |
| --- | --- |
| Application | Type, lint, test, build, browser, or deployment dry-run failure |
| Coverage | Less than 90% for any configured server coverage metric |
| Dependency review and audit | A high or critical vulnerability |
| Gitleaks | A secret in Git history |
| Semgrep | A finding in the local security rules |
| Trivy | A high or critical vulnerability with a fix |
| Aislop | A score below 100 or a finding outside dependency auditing |
| Documentation | A ste-cli or Vale warning |
| CodeQL | Analysis failure. Configure a code scanning rule to block findings |
| Policy | An unpinned action, ignored failure, missing gate, or mixed CI and application change |

Scanner tools use the immutable `PINNED` revision in the quality workflow. Candidate configuration cannot select scanner tools. Change the tools and the pin in a separate CI PR. Keep application changes separate from CI policy changes.

The independent `policy` workflow uses `pull_request_target` and owner comment events. It executes trusted code from `github.workflow_sha` and reads candidate Git blobs as data. It compares protected files against that exact trusted revision. This guard activates after the workflow merges into the default branch.

Application dependency changes can accompany application code. They must use exact registry versions and preserve install settings. Type packages can change with their matching application dependency. Packages with commands, build and test tools, their dependency graphs, scripts, and CI controls still need policy approval.

A PR with policy changes needs approval for its file tree, current base, and trusted workflow revision. Get the tree SHA with `git rev-parse HEAD^{tree}`. The repository owner can post this exact comment:

```text
Approve CI policy: tree=<TREE_SHA> base=<CURRENT_PR_BASE_SHA> trusted=<GITHUB_WORKFLOW_SHA>
```

Owner comments trigger a fresh check of `Trusted CI policy`. Comment edits and deletions also trigger the check. A rejection removes approval. Changed files, base, or trusted policy need new approval.

A metadata-only commit rewrite preserves tree approval. The previous `head=<HEAD_SHA>` format remains valid only for that exact commit. Owner comments identify the account. They do not prove that a human posted them.

The configuration for Aislop preserves globals in Cloudflare Workers and the virtual module through narrow compatibility settings. The application uses valid nickname autofill, focusable scroll panels, and a native slider to resize the topic panels. The required `pnpm audit` check owns dependency auditing. Aislop does not repeat that check.

Configure these repository settings before production use:

- Make `Required quality gates` and `Trusted CI policy` mandatory on `main`. Keep branches up to date before merge. Block direct pushes and make review by code owners mandatory for policy changes.
- Enable the dependency graph and code scanning in the repository security settings. Configure CodeQL findings as a merge rule.
- Create the `stream-bullets` project in SonarQube. Use the same quality profile and gate as the other public repositories.
- Add `SONAR_TOKEN`, `SONAR_HOST_URL`, `TAILSCALE_OAUTH_CLIENT_ID`, and `TAILSCALE_AUDIENCE` as GitHub secrets. Let `tag:github-sonar` reach SonarQube.

Dependency review needs an active dependency graph. An administrator can enable it in **Settings > Advanced Security** ([repository security settings](https://github.com/mickey-kras/stream-bullets/settings/security_analysis)). The connector for GitHub cannot change this setting. Keep the dependency review mandatory.

SonarQube uses coverage from the successful verification job for the same commit. The workflow uses these secrets only on `main`. Missing SonarQube configuration fails the job and blocks deployment. CODEOWNERS does not activate repository protection by itself. Writers can publish commit statuses. Make review by code owners mandatory for workflow changes to protect status provenance.

The Tailscale trust credential must allow the GitHub subject for this repository:

```text
repo:mickey-kras/stream-bullets:ref:refs/heads/main
```

Use the audience from that credential for `TAILSCALE_AUDIENCE`. Copying secrets from another repository does not extend its trust scope. A 403 response during token exchange blocks SonarQube. Deployment waits for SonarQube.

The documentation tools check writing rules. They do not prove full ASD-STE100 Issue 9 compliance or validate dictionary meanings.
