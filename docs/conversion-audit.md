# Conversion and mobile audit

Issue: #585. Baseline: `0641d22`. Audit date: 2026-11-10.

## Existing analytics

Cloudflare Web Analytics has automatic installation enabled for `streambullets.com`.
Zaraz has no tools. The baseline app had no analytics SDK or conversion events.
Workers observability captures errors. The baseline privacy page incorrectly denied analytics use.

Audit HTML contained no beacon. CSP permits same-origin or nonce-protected scripts only.
Check the beacon delivery before treating Web Analytics visits as a denominator.
See [Cloudflare setup and CSP guidance](https://developers.cloudflare.com/web-analytics/faq/).
This change leaves Cloudflare settings and CSP intact.

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

Database triggers update totals with source writes atomically.
Failed writes, rollbacks, reads, refreshes, topic deletion, and vote changes do not add or reset milestones.
Migration flags existing votes and topics without adding totals.
The migration cannot recover deleted activity. Those accounts can count next time. Re-created accounts can count again.

Totals store UTC day, fixed event name, and count only.
They contain no account IDs, IPs, URLs, provider details, or content and remain after account deletion.
Exports include both account flags. Account deletion removes them.

Click requests accept fixed CTA names and a random UUID only. The endpoint rejects completion events and extra fields.
Clients send no cookies or referrer. Retained receipts prevent repeat counts.

Worker limits do not prevent fraud. The client never retries failed calls, which can undercount. Navigation still works.

Hourly cleanup removes receipts after one day and totals after 90 days.
Receipt batches hold 5,000 rows. Backlogs can extend retention. Replays after deletion can count again.
Browsers store no visitor identifier.

## Read totals

Use D1 or Wrangler. Totals have no public endpoint:

```sql
SELECT day, event, count
FROM conversion_daily
ORDER BY day DESC, event;
```

Daily counts do not connect clicks to later actions. Do not infer exact visitor conversion rates.

## Mobile evidence

Sizes from the baseline production build, not measured transfers:

| Asset | Uncompressed | Gzip |
| --- | ---: | ---: |
| Home JavaScript | 6.20 kB | 2.36 kB |
| Station scene JavaScript | 748.80 kB | 197.65 kB |
| Home CSS | 9.21 kB | 2.54 kB |

Source inspection confirms dynamic scene loading, static geometry batching, hidden-render pausing, mobile resolution caps, and reduced motion.
This inspection measures no timing.

Run browser checks:

```sh
pnpm build
pnpm exec playwright test tests/e2e/conversions.spec.ts
```

The checks cover overflow and clickable CTAs at 320 x 568, 390 x 844, and 844 x 390.
Playwright reports attach screenshots and `mobile-hero-cost.json`.
CI saves reports on failure. Successful runs show the `mobile-hero-cost` measurements.
Attachments contain the asset sizes, readiness, and two-second animated and static samples.

Task time and frame cadence are lab indicators, not GPU timings or Core Web Vitals from visitors.
CI software rendering cannot predict physical-phone performance.

Local Chromium failed because the environment denied sockets. Browser preview timed out. Local mobile timings remain unverified.

Baseline Cloudflare screenshots showed controls at 320 x 568 and 390 x 844, but clipped CTAs at 844 x 390.
New benefits text also clipped links at 320 x 568.
The hero now scrolls on short screens in either orientation, keeping typography and artwork.
No rendering change relies on assumed timings.
