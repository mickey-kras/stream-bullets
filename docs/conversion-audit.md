# Conversion and mobile audit

Issue: #585. Baseline: `0641d22`. Audit date: 2026-11-10.

## Existing analytics

The Cloudflare API shows Web Analytics enabled with automatic installation for `streambullets.com`.
Zaraz has no configured tools. The application has no conversion events or analytics SDK.
Workers observability is enabled. The privacy page incorrectly said that the site used no analytics.

Keep Web Analytics for visits and performance. Do not add another browser analytics SDK.
The privacy page now describes the existing analytics and the new conversion counts.
See [Cloudflare analytics](https://developers.cloudflare.com/analytics/types-of-analytics/).
No Cloudflare settings were changed during this audit.

## Conversion definitions

| Event | Counted when | Repeat handling |
| --- | --- | --- |
| `cta_browse` | Landing browse link is clicked | One random receipt per click |
| `cta_suggest`, `cta_vote`, `cta_discuss` | Landing link or 3D sign is activated | One random receipt per activation |
| `cta_sign_in` | Landing sign-in button is clicked | One random receipt per click |
| `cta_your_page` | Landing own-page link is clicked | One random receipt per click |
| `sign_in_completed` | A new authentication session is stored | Session updates do not count |
| `streamer_application` | An application is first stored | Application edits do not count |
| `first_vote` | An account first stores a poll vote | Account flag prevents repeats |
| `first_topic` | An account first stores a topic | Account flag prevents repeats |

Database triggers update completion totals in the same transaction as the source write.
Failed writes and rolled-back transactions do not count. Refreshes and reads do not count.
Topic deletion and vote changes do not reset account milestones.
Existing votes and topics set the flags at migration without adding conversion totals.
Deleted activity before this migration cannot be recovered; those accounts can count on their next action.
A newly created account after deletion can count again.

Totals contain only a UTC date, a fixed event name, and a count.
They contain no account IDs, IP addresses, URLs, provider details, or user content.
The two account flags appear in account exports and disappear with account deletion.
Aggregate totals remain after deletion because they cannot identify an account.

The click endpoint accepts only fixed CTA names and a random UUID.
It rejects completion events and extra fields. The client sends no cookies or referrer.
Repeated receipts do not count again during their retention period.
The existing Worker rate limit applies. These public click counts are not fraud-resistant.
Blocked or failed click requests are not retried and can undercount. Navigation still works.

Hourly cleanup removes click receipts older than one day and totals older than 90 days.
Receipt cleanup uses batches of 5,000, so a large backlog can extend retention.
A replay after receipt deletion can count again. No visitor identifier is stored in the browser.

## Read totals

Use the existing D1 console or Wrangler access. There is no public totals endpoint.

```sql
SELECT day, event, count
FROM conversion_daily
ORDER BY day DESC, event;
```

These counts show daily activity, not a joined visitor funnel.
Compare trends with Web Analytics visits; do not infer exact visitor conversion rates.

## Mobile evidence

The production build at the baseline reports the following compressed sizes.
These are build estimates, not measured network transfers.

| Asset | Uncompressed | Gzip |
| --- | ---: | ---: |
| Home JavaScript | 6.20 kB | 2.36 kB |
| Station scene JavaScript | 748.80 kB | 197.65 kB |
| Home CSS | 9.21 kB | 2.54 kB |

The scene already loads dynamically, batches static geometry, and pauses hidden rendering.
It also caps mobile resolution and supports reduced motion. These are source findings, not timing results.

Run the repeatable browser check after building:

```sh
pnpm build
pnpm exec playwright test tests/e2e/conversions.spec.ts
```

It checks 320 x 568, 390 x 844, and 844 x 390 viewports.
It checks horizontal overflow and whether each landing CTA can receive a click.
The Playwright report includes screenshots and `mobile-hero-cost.json` attachments.
Each attachment records asset sizes, observed readiness, and two-second still and animated samples.
Task time and frame cadence are lab indicators, not GPU timings or field Core Web Vitals.
CI uses software rendering, so its results do not predict physical phone frame rates.

Local Chromium could not start because the execution environment denied its socket operation.
The browser preview also timed out. Runtime mobile measurements remain unverified locally.
No visual or rendering change was selected without measured evidence.
