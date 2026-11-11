# Conversion and mobile audit

Issue: #585. Baseline: `0641d22`. Audit date: 2026-11-10.

## Existing analytics

Cloudflare enables Web Analytics with automatic installation for `streambullets.com`.
Zaraz has no configured tools. The application has no analytics SDK or conversion events.
Workers observability captures errors. The privacy page incorrectly said that the site used no analytics.

The live HTML response contained no beacon script during this audit.
Its CSP permits only scripts from the same origin or scripts with a nonce.
Thus, the account setting alone does not prove that browsers send performance data.
Check the beacon delivery before using Web Analytics visits as a denominator.
See [Cloudflare setup and CSP guidance](https://developers.cloudflare.com/web-analytics/faq/).
This PR does not change Cloudflare settings or the CSP.

## Conversion definitions

| Event | Count trigger | Repeat handling |
| --- | --- | --- |
| `cta_browse` | Visitor clicks Browse | One receipt per click |
| `cta_suggest`, `cta_vote`, `cta_discuss` | Visitor activates a link or 3D sign | One receipt per action |
| `cta_sign_in` | Visitor clicks Sign in | One receipt per click |
| `cta_your_page` | Visitor clicks Your page | One receipt per click |
| `sign_in_completed` | Database stores a new session | Excludes session updates |
| `streamer_application` | Database stores an application | Excludes application edits |
| `first_vote` | Account stores its first poll vote | Once per account |
| `first_topic` | Account stores its first topic | Once per account |

Database triggers update totals in the same transaction as the source write.
Failed writes and transactions that roll back do not count. Refreshes and reads do not count.
Topic deletion and vote changes do not reset account milestones.

The migration sets flags for existing votes and topics without adding totals.
It cannot recover activity that users deleted before this migration.
Those accounts can count on their next action. A new account after deletion can count again.

Totals contain only a UTC date, a fixed event name, and a count.
They contain no account IDs, IP addresses, URLs, provider details, or user content.
The two account flags appear in account exports and disappear with account deletion.
Totals remain after deletion because they cannot identify an account.

The click endpoint accepts only fixed CTA names and a random UUID.
It rejects completion events and extra fields. The client sends no cookies or referrer.
Repeated receipts do not count again during their retention period.

The Worker limits requests. Public click counts do not prevent fraud.
The client does not retry failed requests, so counts can be too low. Navigation still works.

Hourly cleanup removes receipts older than one day and totals older than 90 days.
Cleanup uses batches of 5,000 receipts, so a large backlog can extend retention.
A replay after receipt deletion can count again. The browser stores no visitor identifier.

## Read totals

Use the D1 console or Wrangler. There is no public endpoint for totals.

```sql
SELECT day, event, count
FROM conversion_daily
ORDER BY day DESC, event;
```

These counts show daily activity. They do not link clicks to later actions.
Do not infer exact conversion rates for visitors.

## Mobile evidence

The production build at the baseline reports these sizes.
These are build estimates, not measured network transfers.

| Asset | Uncompressed | Gzip |
| --- | ---: | ---: |
| Home JavaScript | 6.20 kB | 2.36 kB |
| Station scene JavaScript | 748.80 kB | 197.65 kB |
| Home CSS | 9.21 kB | 2.54 kB |

The scene loads dynamically, batches static geometry, and pauses rendering when hidden.
It also caps resolution on mobile and supports reduced motion.
These findings come from source code, not timing measurements.

Run the browser check after building:

```sh
pnpm build
pnpm exec playwright test tests/e2e/conversions.spec.ts
```

It checks 320 x 568, 390 x 844, and 844 x 390 viewports.
It checks horizontal overflow and whether each landing CTA can receive a click.
The Playwright report includes screenshots and `mobile-hero-cost.json` attachments.
CI saves that report only on failure. Successful runs also print measurements with the `mobile-hero-cost` label.

Each attachment contains sizes of assets, readiness, and two-second samples with and without animation.
Task time and frame cadence are lab indicators, not GPU timings or Core Web Vitals from visitors.
CI uses software rendering. Its results do not predict performance on physical phones.

Local Chromium failed to start because the environment denied its socket operation.
The preview in the browser also timed out. Mobile timing measurements remain unverified locally.

Cloudflare screenshots at the audit baseline confirmed visible controls at 320 x 568 and 390 x 844.
At 844 x 390, the fixed-height page clipped the primary CTA and hid the action links.

The new benefits text also clipped action links at 320 x 568.
The hero area now scrolls on short screens in either orientation.
Typography and artwork stay the same.
No rendering change follows from timing assumptions.
