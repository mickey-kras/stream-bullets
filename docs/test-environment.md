# Test environment

The test URL is `https://test.streambullets.com`.
The production deployment and its quality gates run separately.
Test data is synthetic. Never copy production data or secrets here.

## Initial setup

Use the same setup as production: GitHub holds the deployment token.
Cloudflare holds the application secrets.

Create the GitHub environment `test` with `CLOUDFLARE_API_TOKEN`.
A repository secret with that name also works.
The token needs access to the test Worker, D1, R2, and custom domain.

Set these secrets on the Cloudflare Worker `stream-bullets-test`:

| Secret | Value |
| --- | --- |
| `BETTER_AUTH_SECRET` | A new random value with at least 32 characters. |
| `TEST_ACCESS_SECRET` | A different random value with at least 32 characters. |

Use the Worker's **Settings > Variables and secrets**, or Wrangler:

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env test
pnpm exec wrangler secret put TEST_ACCESS_SECRET --env test
```

Wrangler can create the Worker before its first application deployment.
Keep both values separate from production secrets.
Deployments preserve the secrets already stored in Cloudflare.

Restrict deployment access to the owner and approved maintainers.
Store the access secret in approved secret storage.
Share it with authorized assistants through a private session.
Never put it in URLs, issues, logs, or screenshots.

The test deployment uses these resources:

| Resource | Test value |
| --- | --- |
| Worker | `stream-bullets-test` |
| D1 | `stream-bullets-test`, ID `e475eb5b-db31-43bd-8692-5926711e8faa` |
| R2 | `stream-bullets-test-images` |
| Durable Objects | `PollRoom` in the test Worker namespace. |
| Rate limits | Namespace `1003`. |
| Custom domain | `test.streambullets.com`, attached on deployment. |

The test database contains `test_environment_identity` with its database ID.
This marker is configuration. Reset does not remove it.
The application cannot create the marker.
Do not add it to production migrations or the production database.
Check the marker only in the test database:

```sh
pnpm exec wrangler d1 execute e475eb5b-db31-43bd-8692-5926711e8faa --env test --remote --command 'SELECT id FROM test_environment_identity'
```

If the marker is missing, restore it only in that test database:

```sh
pnpm exec wrangler d1 execute e475eb5b-db31-43bd-8692-5926711e8faa --env test --remote --command "CREATE TABLE IF NOT EXISTS test_environment_identity(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO test_environment_identity VALUES ('e475eb5b-db31-43bd-8692-5926711e8faa');"
```

If the database ID changes, update the bindings and checks before use.

## Deploy a revision

1. Open **Actions > Deploy to test > Run workflow**.
2. Select the branch to deploy. Leave the commit SHA blank to use that branch.
3. To deploy a specific commit, enter its full 40-character SHA.
   The selected revision must contain both the runtime and deployment changes.
4. Check the deployment summary for the URL and commit.

The workflow runs type checks, lint, coverage, and a test build.
It checks the compiled bindings before it applies test migrations.
Deployment keeps the secrets in Cloudflare and records the selected commit.
A response check verifies the deployed commit.
Use `pnpm build:test` and `node scripts/check-test-deployment.ts` to check bindings locally.

## Sign in and reset

Open `/__test` and enter the test access secret.
Seed the fixtures before the first login.
Choose a fixture account to create a normal application session.

| Account | State |
| --- | --- |
| `signedout` | Guest access after the secret check. |
| `viewer`, `other_viewer` | Ordinary users in separate browser sessions. |
| `owner`, `other_owner` | Owners of `test_host` and `other_host`. |
| `admin` | Verified synthetic email in the test admin list. |
| `pending`, `approved`, `rejected` | Streamer applications in each supported state. |
| `frozen_owner`, `suspended_owner` | Owners of restricted pages. |

### Discussion fixtures

Each fixture community has three topics, one open poll, and one closed poll with results.
One topic has a thread of three comments.
One topic has a comment with formatted text and a reply with a long link.
The seed adds mention comments and notifications to `test_host` and `other_host`.
The author of the comment causes the notification.

| Account | Community | Notification | From | State |
| --- | --- | --- | --- | --- |
| `viewer` | `test_host` | Mention | `other_viewer` | Unread |
| `viewer` | `test_host` | Reply | `owner` | Read |
| `viewer` | `other_host` | Reply | `other_owner` | Unread |
| `other_viewer` | `other_host` | Mention | `viewer` | Read |
| `other_viewer` | `other_host` | Reply | `owner` | Unread |
| `owner` | `test_host` | Reply | `other_viewer` | Unread |
| `other_owner` | `other_host` | Reply | `other_viewer` | Read |
| `other_owner` | `other_host` | Mention | `owner` | Unread |

One comment from `owner` in `other_host` replies to `other_viewer` and mentions `other_owner`.
The other accounts start with an empty inbox.
A second seed keeps the read state that a tester changed.
It does not restore the notifications of a comment that a tester edited or removed.
Reset restores each fixture and clears the notification rate limits of the fixture accounts.

The secret does not change an account's permissions.
Use separate browser contexts to test separate accounts.
Choose `signedout` to clear the application session and keep test access.

Reset removes synthetic fixture data and recreates it.
It invalidates fixture sessions. Sign in again after reset.
Revision watermarks keep replacement data newer than the data in open overlays.
Configuration and resource bindings remain separate from resettable data.
Do not reset while another tester uses the environment.

### Sample chat

**Send sample chat to test_host** on `/__test` sends one batch of sample chat to the activity feed of `test_host`.
The batch has messages from each platform, with Unicode text, an emote, a badge, and a command.
The messages are live, like messages from a connected channel.
Each batch has new message identifiers, so you can send it again.
The feed keeps a message for 10 minutes. A reset does not remove the batch.

The action reads no provider and needs no channel connection.
It works only when the test deployment has the `CHANNEL_INGEST` binding. Without the binding, the answer is `503`.
In all other deployments, the feed object answers `404`.

To see the chat, sign in as `owner`, put the chat layer on stream in **Overlay control**, and create the overlay link.
Open the link in the same browser, because the test deployment needs the test access cookie.

## Authorization checks

The authorization model has viewers, page owners, and administrators.
Applications use the pending, approved, and rejected states.
Page states include active, frozen, and suspended.
There is no separate moderator role.

Check both independent communities with separate owner and viewer sessions.
Check the topics, replies, votes, polls, suggestions, and overlays.

A viewer can create a poll on an owner's page.

A viewer must not edit an owner's page, end an owner's poll, or reveal its results.
One owner must not control the other owner's page or overlay.
A non-admin must not review applications or do admin actions.
Frozen pages stay public and read-only. Public views hide suspended pages.
Test security keys for admins through the normal enrollment and step-up flows.

## Isolation and limits

Test login requires the exact test environment, origin, secret, and database marker.
Missing or incorrect settings reject access.
Production rejects test secrets and test login requests.

OAuth credentials, email bindings, and heartbeat URLs must stay outside test.
Test deployments disable cron. Tests use synthetic channels, viewers, and email recipients.
Provider account linking, provider photos, and delivery need separate live-provider checks.

The test build does not inherit production D1, R2, or Durable Object state.
Never change test bindings to production resource IDs.
The compiled binding check rejects those changes before deployment.
