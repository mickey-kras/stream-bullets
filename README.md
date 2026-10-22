# Stream Bullets

Existing topic UI plus persistent live polls, hosted by Sites with a D1 database.

- `app/shell.ts`: page markup; `public/`: styles, browser modules, and assets.
- `app/api/polls/route.ts`: poll API. Sites supplies authenticated identity headers.
- `POLL_HOST_EMAIL`: secret runtime setting that permits the host to create/reveal polls.
- One vote per authenticated visitor per poll. Votes can change until the server deadline or reveal.
- Polls refresh every two seconds. Unlimited polls use no deadline and stay open until host reveal. Likes/dislikes rank Top by net score; Newest uses creation time. Each poll has a persistent discussion and a `#poll=<id>` reference link. Yes/No percentages appear only after host reveal.
- Topic suggestions, topic votes, comments, and avatar choices remain browser-session mockup data.
- Schedule has no announced date. About and Community are basic navigation pages.

Validation: `node tests/polls.mjs`, `node node_modules/typescript/bin/tsc --noEmit`.
The route tests run against SQLite with production authentication logic; browser QA uses separate local D1 data. Development-only preview identity is stripped from production builds.

This repository is a source snapshot of the current Sites prototype, including its Vinext/Cloudflare tooling. It is not yet the planned React Router application.

The public hosting manifest retains the D1 binding but omits the private deployment identity. No runtime secrets, database contents, or Sites Git history are included. Configure `POLL_HOST_EMAIL` as a runtime secret, never in source.

Authentication currently depends on trusted identity headers supplied by Sites. A different hosting environment must implement authentication before exposing the poll API.

Use the Sites skill for installation, local D1 migrations, previews, builds, and publication to a separately configured Site.
