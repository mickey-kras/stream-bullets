# Production recovery

This runbook tells you how to roll back the production Worker and restore the D1 database.
Use it only for the `production` environment in `wrangler.jsonc`.
Run all commands from the repository root on a machine where Wrangler has production access.

Each command in this runbook changes production. Read each step before you run it.

## Select the procedure

- The new code is bad, and the data is correct: roll back the Worker only. Refer to [Roll back the Worker](#roll-back-the-worker).
- The data is bad, for example after a bad migration: restore D1. Refer to [Restore D1](#restore-d1).
- The code and the data are bad: roll back the Worker first. Restore D1 after the rollback.

A Worker rollback does not change D1, R2, or Durable Object storage. A D1 restore does not change the Worker, R2, or Durable Object storage.

## Roll back the Worker

The deployment job applies migrations before it deploys the Worker. Thus, the schema can be newer than an old Worker version.

1. List the recent versions:

   ```sh
   pnpm exec wrangler versions list --env production
   ```

   The list shows the 10 most recent versions. The CI deployment sets the message of each version to `commit <SHA>`. Only deployments after PR #652 have this message.

2. Find the commit of the target version. Find the migrations that CI applied later than this commit:

   ```sh
   git fetch origin main
   git diff --stat <TARGET_SHA> origin/main -- drizzle/
   ```

3. Make sure that the target version can use the current schema. Look at each new migration file. The target code must not read or write a table or column that a migration removed or renamed. The target code must not insert rows without a value for a new `NOT NULL` column that has no default. If a migration is not compatible, do not roll back. Revert the change through a PR. You can also restore D1. Refer to [Restore D1](#restore-d1).
4. Make sure that `migrations` in `wrangler.jsonc` did not change after the target commit. Cloudflare refuses a rollback across a Durable Object class migration.
5. Roll back:

   ```sh
   pnpm exec wrangler rollback <VERSION_ID> --env production --message "Rollback to commit <TARGET_SHA>"
   ```

   Without `<VERSION_ID>`, Wrangler selects the version before the latest version. Give the ID to prevent a wrong selection.

6. Do the [checks after recovery](#checks-after-recovery).

You can also deploy one version with `versions deploy`:

```sh
pnpm exec wrangler versions deploy <VERSION_ID>@100 --env production --message "Rollback to commit <TARGET_SHA>"
```

A rollback is temporary. The next push to `main` deploys the code of `main` again. Revert the bad change through a PR before the next merge.

## Restore D1

A restore overwrites the database in place. It discards all writes after the bookmark. This includes sign-ups, poll votes, profile changes, and image updates. Cloudflare cancels the queries that are in progress.

### Find the bookmark

1. Open the GitHub Actions run that deployed the bad change.
2. Open the **Deploy production** job. Its summary shows the commit SHA and the output of `wrangler d1 time-travel info`. The bookmark in that output is the state before the migrations of that run. Only deployments after PR #652 write this summary.
3. If the summary is not available, open the log of the **Migrate and deploy** step. The step writes the same output to the log.

If you need a different time, get a bookmark for a timestamp:

```sh
pnpm exec wrangler d1 time-travel info DB --env production --timestamp=<RFC3339_OR_UNIX_TIMESTAMP>
```

Time Travel keeps 7 days on Workers Free and 30 days on Workers Paid. You cannot restore to an older bookmark.

### Prepare

1. Tell users about the outage. A restore discards their recent changes.
2. Stop all new deployments. Do not merge to `main` until recovery is complete.
3. Make sure that the deployed Worker can use the schema of the bookmark. A bookmark from before a migration has the old schema. Roll back the Worker to a version from before that migration first. Refer to [Roll back the Worker](#roll-back-the-worker).
4. Make an export of the current database. You can use it to recover rows that the restore discards. Refer to the backup step in `README.md`.

The application has no maintenance mode. Writes continue until the restore starts. Do the restore immediately after the preparation to keep the loss of writes small.

### Restore

```sh
pnpm exec wrangler d1 time-travel restore DB --env production --bookmark=<BOOKMARK>
```

Wrangler asks for confirmation. After the restore, Wrangler shows a bookmark to undo the restore. Record that bookmark in the incident notes. To undo the restore, run the same command with that bookmark.

### After the restore

- If the schema is now older than `drizzle/` on `main`, some migrations are not in D1. Make sure that the deployed Worker uses the restored schema. Fix or revert the bad migration through a PR before the next deployment applies it again.
- Do the R2 and Durable Object checks below.
- Do the [checks after recovery](#checks-after-recovery).

## R2 images after a D1 restore

R2 is not part of the restore. The `image_versions` table in D1 points to the current object of each image. The key of the object is `<kind>/<owner_id>/<version>`. An upload writes a new object, updates `image_versions`, and then deletes the previous object.

After a restore to an earlier bookmark:

- An `image_versions` row can point to an object that an upload after the bookmark deleted. That image then does not load. The owner must upload the image again.
- An object from an upload after the bookmark has no `image_versions` row. Nothing uses these objects. They do not cause errors.

To find the rows, export the table:

```sh
pnpm exec wrangler d1 execute DB --env production --remote --json --command "SELECT owner_id, kind, version FROM image_versions"
```

To look at one object, download it:

```sh
pnpm exec wrangler r2 object get "stream-bullets-images/<kind>/<owner_id>/<version>" --remote --file /tmp/image-check
```

If the object does not exist, tell the owner to upload the image again.

## Durable Object PollRoom state after a D1 restore

Durable Object storage is not part of the restore. Each `PollRoom` keeps a `tap_journal` table in its own SQLite storage. The journal holds the acknowledged tap totals per player of each running battle. A room keeps active battles in memory and writes their totals to D1 each second.

After a restore:

- A room that is active keeps its battles in memory. It can write totals that are newer than the restored D1 data.
- A room reads its journal again when it restarts. It writes journal totals to D1 only for an active battle in D1. The battle must have the same start time.
- On restart, a room deletes journal rows of battles that D1 does not show as active.

To make the rooms read the restored data, restart them. A deployment of a different Worker version restarts the Durable Objects. Live connections then reconnect. After the restart, look at the active battles in D1:

```sh
pnpm exec wrangler d1 execute DB --env production --remote --command "SELECT entry_id, phase FROM entry_mash WHERE phase IN ('countdown','live')"
```

## Checks after recovery

1. Open `https://streambullets.com/`. Make sure that the homepage loads.
2. Sign in with Google and with Twitch.
3. Open a streamer page. Make sure that polls and images load.
4. Watch the Worker logs and errors in the Cloudflare dashboard for 30 minutes.
5. Write the incident notes. Include the version IDs, the bookmarks, and the time of each step.
