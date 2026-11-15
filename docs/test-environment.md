# Test environment

The test URL is `https://test.streambullets.com`.
The production deployment and its quality gates run separately.
Test data is synthetic. Never copy production data or secrets here.

## Initial setup

Create the GitHub environment `test` with these secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token for the test Worker, D1, R2, and custom domain. |
| `BETTER_AUTH_SECRET` | A new random value with at least 32 characters. |
| `TEST_ACCESS_SECRET` | A different random value with at least 32 characters. |

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
2. Enter the full 40-character commit SHA from this repository.
3. Run the workflow from the approved workflow revision.
   Select a commit that contains both the runtime and deployment changes.
4. Check the deployment summary for the URL and commit.

The workflow runs type checks, lint, coverage, and a test build.
It checks the compiled bindings before it applies test migrations.
Deployment uploads only the test secrets and records the selected commit.
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

The secret does not change an account's permissions.
Use separate browser contexts to test separate accounts.
Choose `signedout` to clear the application session and keep test access.

Reset removes synthetic fixture data and recreates it.
It invalidates fixture sessions. Sign in again after reset.
Revision watermarks keep replacement data newer than the data in open overlays.
Configuration and resource bindings remain separate from resettable data.
Do not reset while another tester uses the environment.

## Authorization checks

The authorization model has viewers, page owners, and administrators.
Applications use the pending, approved, and rejected states.
Page states include active, frozen, and suspended.
There is no separate moderator role.

Check both independent communities with separate owner and viewer sessions.
Check the topics, replies, votes, polls, suggestions, and overlays.

A viewer must not edit an owner's page or create owner-only polls.
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
Mentions and notifications from #674 need fixtures when those features ship.

The test build does not inherit production D1, R2, or Durable Object state.
Never change test bindings to production resource IDs.
The compiled binding check rejects those changes before deployment.
