# Live room capacity

Per streamer: 200 connections, including 100 anonymous connections.
Each client address permits ten viewer connections. Owners, valid-key overlays, and the OBS dock share ten priority seats.
An open OBS dock uses one priority seat. See [OBS dock](streamer-tools.md#obs-dock).
These are application limits, not measured Cloudflare limits.

## Load model

One load model serves the live room and the activity feed.
The model starts from one million registered streamers.
It counts registered streamers, live channels, connected clients, and website voters in separate rows.

Each assumption has its own row, and the row shows "Assumption" as its source.
An assumption has no measurement behind it. The owner can change each assumption.
The rows that use it then change with it.

| Row | Quantity | Value | Source |
| --- | --- | ---: | --- |
| 1 | Registered streamers | 1,000,000 | Start of the model |
| A1 | Share of registered streamers that are live at the peak | 1% | Assumption |
| 2 | Live channels at the peak | 10,000 | `row 1 × A1` |
| A2 | Share of registered streamers that go live on one day | 5% | Assumption |
| A3 | Mean length of one stream | 3 hours | Assumption |
| 3 | Live channel-hours each day | 150,000 | `row 1 × A2 × A3` |
| A4 | Owner clients of one live channel: web tools tab, OBS dock, horizontal OBS source, vertical OBS source | 4 | Assumption |
| A5 | Public page viewers that stay connected to one quiet live channel | 10 | Assumption |
| 4 | Connected clients at the peak | 140,000 | `row 2 × (A4 + A5)` |
| 5 | Activity sockets at the peak | 40,000 | `row 2 × A4` |
| A6 | Share of connected viewers that vote in one poll | 30% | Assumption |
| 6 | Website voters at the peak | 30,000 | `row 2 × A5 × A6` |

The model gives each owner client one activity socket and one live-room connection. A public page viewer holds one live-room connection.
A website voter is a signed-in viewer who votes on the public page.

The model has two types of live channel. A quiet channel is the usual case. A viral channel is at the application limits.

| Quantity for one live channel | Quiet channel | Viral channel | Source |
| --- | ---: | ---: | --- |
| Activity sockets | 4 | 20 | A4. The limit is `MAX_SOCKETS` |
| Live-room connections | 14 | 200 | `A4 + A5`. The limit is the room limit |
| Website voters in one poll | 3 | 59 | `A5 × A6`. For the viral channel: `(200 − A4) × A6` |
| A7 and A8: chat messages that the provider sends each second | 0.2 (A7) | 500 (A8) | Assumption |
| Chat messages that the feed admits each second | 0.2 | 50, after a burst of 200 | `ADMISSION_RATE`, `ADMISSION_BURST` |
| Moderation events that the feed admits each second | All | 20, after a burst of 200 | `MODERATION_RATE`, `MODERATION_BURST` |

The limits come from `app/server/channel-ingest-limits.ts`. A YouTube chat has one more limit.
One poll admits a maximum of 200 chat messages, and the shortest poll interval is 10 seconds.
Thus the feed admits a maximum of 20 YouTube chat messages each second.

Twitch and Kick push each event to a webhook. The feed does not poll them. Only YouTube uses a provider quota.

| Provider calls for one live channel-hour | Calls | Quota units | Source |
| --- | ---: | ---: | --- |
| Twitch chat | 0 polls | 0 | Push |
| Twitch subscription checks | 12 | 0 | One check each 10 minutes (`RECONCILE_INTERVAL_MS`). The unit test counts 2 calls for each check |
| Kick chat | 0 polls | 0 | Push |
| Kick subscription checks | 6 | 0 | One check each 10 minutes. The unit test counts 1 call for each check |
| YouTube chat with messages | 360 polls | 1,800 | `3,600,000 ÷ YOUTUBE_MIN_POLL_MS × 5` |
| YouTube chat without messages, or after 80% of a budget | 180 polls | 900 | `3,600,000 ÷ YOUTUBE_QUIET_POLL_MS × 5` |
| YouTube channel that is not live, one open consumer | 6 checks | 6 | `3,600,000 ÷ YOUTUBE_IDLE_POLL_MS × 1` |

The YouTube quota does not fit the model. This table shows the difference.

| Row | Quantity | Value | Source |
| --- | --- | ---: | --- |
| A9 | Share of live channel-hours that have a YouTube channel | 20% | Assumption |
| 7 | YouTube live channel-hours each day | 30,000 | `row 3 × A9` |
| 8 | Quota units that the model needs each day | 54,000,000 | `row 7 × 1,800` |
| 9 | Quota units that all pages can spend each day | 9,000 | `YOUTUBE_DAILY_BUDGET` |
| 10 | YouTube live channel-hours that the budget supplies each day | 5 | `row 9 ÷ 1,800` |

The model needs 6,000 times the shared budget. One page can also spend the full shared budget alone.
`YOUTUBE_PAGE_DAILY_BUDGET` is equal to `YOUTUBE_DAILY_BUDGET`.
The feed uses the 20-second interval after a page spends 80% of its budget.
Thus one YouTube stream spends its page budget in 6 hours: 4 hours at 1,800 units and 2 hours at 900 units.
See [YouTube quota](channel-connections.md#youtube-quota) for the procedure to get a higher quota.

The public page gets its live data from the live room (`PollRoom`). The model uses the live-room measurements of this document for it.
On November 26, 2026, a full room of 200 clients connected in 277.42 ms at `p95`.
A burst of 20 votes reached each of the 200 sockets in 402.01 ms at `p95`.

### Cost for one live channel-hour

This document gives no price. The harness counts the cost drivers of one live channel for one hour.
The owner applies the current Cloudflare price list to these counts.
The counts are from the stream of several hours in [Activity results and limits](#activity-results-and-limits).
That channel has a YouTube chat with 2 messages each second, a Twitch channel, and four consumers.

| Cost driver for one live channel-hour | Count | Depends on |
| --- | ---: | --- |
| Alarm runs of the ingest object | 360 | The YouTube poll interval |
| Deliveries to the ingest object | 120 | The event rate that Twitch and Kick send |
| D1 statements of the object and the Worker | 1,567 | The YouTube poll interval, the 30-second caches, and the 30-second health write |
| WebSocket messages that the object sends | 29,280 | Admitted events × open activity sockets |
| Provider calls | 373 | The YouTube poll interval and the subscription checks |
| YouTube quota units | 1,800 | The YouTube poll interval |

The first hour has one more alarm run, 5 more D1 statements, 2 more provider calls, and 2 more quota units.
The harness does not measure the duration that Cloudflare bills for an object, or the CPU time.

The admission rate does not limit the deliveries. The Worker sends each signed delivery to the object, and the object admits the events after that.
Thus a viral channel that gets 500 chat messages each second also causes 500 deliveries each second.
The object then admits 50 of them each second and sends only those to the sockets.

## Proposed targets

The owner sets the targets. The owner did not set them yet.
Each number in this table is a proposal. A proposed target becomes a target only when the owner confirms it.

The load tests assert each proposed target. The constants are in `tests/helpers/load-targets.ts`.
To change a target, change its constant and this table.

The baseline is the recorded run of November 26, 2026. Latency is in milliseconds at `p95`.
The harness measures event-to-screen latency from the webhook call of the provider to the event on an activity socket.

| Measurement | Constant | Baseline | Proposed target | Reason | Set by the owner |
| --- | --- | ---: | ---: | --- | --- |
| Event-to-screen latency, channel below the admission rate | `EVENT_LATENCY_P95_MS` | 11.83 for chat, 8.55 for moderation | 100 | The server part must stay small, because the provider network and OBS add time that the harness does not measure. | No |
| Event-to-screen latency, admitted chat at 10 times the admission rate | `FLOOD_EVENT_LATENCY_P95_MS` | 724.15 | 1,500 | A burst of 200 admitted messages goes to 20 sockets at one time, and a viewer cannot read a flood faster. | No |
| Event-to-screen latency, moderation during that flood | `MODERATION_LATENCY_P95_MS` | 224.02 | 1,000 | A deleted message must leave the overlay in about one second, also during a flood. | No |
| Dropped chat events below the admission rate | `DROPPED_EVENTS_BELOW_ADMISSION.chat` | 0 of 29,240 | 0 | The feed must drop chat only above the admission rate. | No |
| Dropped moderation events below the admission rate | `DROPPED_EVENTS_BELOW_ADMISSION.moderation` | 0 of 440 | 0 | A lost deletion keeps a removed message on the stream. | No |
| Admitted events that do not get to an open socket | `LOST_ADMITTED_EVENTS` | 0 | 0 | Each consumer must show the same feed. | No |
| Memory growth for each live hour, storage rows | `STORAGE_ROW_GROWTH_PER_LIVE_HOUR` | 0 rows | 0 rows | Retention limits each table, so a longer stream must not add rows. | No |
| Memory growth for each live hour, storage bytes | `STORAGE_BYTE_GROWTH_PER_LIVE_HOUR` | 4,096 bytes | 65,536 bytes | SQLite frees and takes full pages, so the target is 16 pages. | No |
| Public-page responsiveness, 20 votes to 200 sockets | `PUBLIC_UPDATE_P95_MS` | 402.01 | 1,000 | A viewer must see a poll result change in about one second. | No |
| Reconnect burst of one channel, time to the snapshot | `RECONNECT_SNAPSHOT_P95_MS` | 97.19 | 500 | An overlay must show chat again quickly after a network fault. | No |
| Reconnect burst of 100 channels, time to the snapshot | `FLEET_RECONNECT_SNAPSHOT_P95_MS` | 1,257.77 | 5,000 | A deployment closes each socket at one time, and each overlay must recover without help. | No |
| Provider calls for each reconnect | `PROVIDER_REQUESTS_PER_RECONNECT` | 0 | 0 | A reconnect storm must not spend provider quota. | No |
| Provider quota for one live channel, YouTube units each hour | `YOUTUBE_UNITS_PER_LIVE_HOUR` | 1,802 | 1,810 | The 10-second interval gives 1,800 units, and 10 more are for the start checks. | No |
| Cost for one live channel-hour, D1 statements | `COST_DRIVERS_PER_LIVE_HOUR.d1Statements` | 1,572 | 2,000 | D1 work must follow the poll rate and the 30-second caches, not the chat rate. | No |
| Cost for one live channel-hour, alarm runs | `COST_DRIVERS_PER_LIVE_HOUR.alarmRuns` | 361 | 400 | One alarm for each YouTube poll is the design. | No |
| Cost for one live channel-hour, provider calls | `COST_DRIVERS_PER_LIVE_HOUR.providerRequests` | 375 | 400 | One call for each YouTube poll, plus the subscription checks and token refresh. | No |

The memory rows are a storage proxy. They count rows and bytes of the SQLite storage of the object, not heap bytes.
The harness cannot read the heap of an object.

## Reproduce locally

Install the pinned dependencies. Then run from the repository root:

```sh
pnpm install --frozen-lockfile
LIVE_CAPACITY=1 LIVE_CAPACITY_OUTPUT=/tmp/live-capacity-results.json pnpm exec vitest run tests/live-capacity.test.ts
```

The isolated Miniflare harness uses real `PollRoom`, workerd WebSockets, temporary D1, and object SQLite storage.
It cannot target production. Direct internal identities bypass public authentication, session lookup, and rate limits.
Latency measurements use real sockets.

`LIVE_CAPACITY_RESULTS` prints JSON. Optional `LIVE_CAPACITY_OUTPUT` saves it.
Handshake timing includes the first snapshot. Update timing covers the vote burst through final-revision delivery to every client.
Mash timing covers individual acknowledgements and final tick delivery.

D1 counters include each room statement, including batches, with fixture writes separate.
They exclude scanned rows, query CPU, billing, and production cost.

## Workload

| Scenario | Tries | Expected behavior |
| --- | ---: | --- |
| Anonymous boundary | 99, 100, 101 | Accept 99, 100, 100. Refuse the excess with HTTP 503 |
| Member boundary | 199, 200, 201 | Accept 199, 200, 200. Refuse the excess with HTTP 503 |
| Mixed full room | 200 | Accept 100 anonymous viewers, 98 members, one owner, and one overlay |
| Reconnect storm | 250 | Refuse anonymous tries against the full room. Keep owner and overlay connected |
| Priority admission | 2 | Accept a new owner and overlay. Evict two viewers. Keep 200 open connections |
| Vote burst | 20 | Commit balanced votes, coalesce refresh work, deliver revision 20 to 200 sockets |
| Mash burst | 60 | Twenty members send three batches of three taps. Acknowledge all 180 taps |
| Object recovery | 1 reset | Abort the object, recover 180 taps, reconnect a member, and count one further tap |

Each try uses a distinct client key. Boundary scenarios use separate rooms.
The storm models one try per disconnected client. Browser tests cover retry budgets.
Overload refusals must execute zero room D1 statements.
Priority clients must stay connected and reconnect at full capacity.

## Results and limits

Recorded pass: November 10, 2026, with Node `v24.22.1` on Linux x64.
Host: AMD EPYC 9V45, nine logical CPUs, 9.7 GiB memory.
Vitest duration: 34.34 seconds, including runtime lifecycle work.

| Scenario | Accepted / refused | Latency in ms: `p50`, `p95`, maximum |
| --- | --- | --- |
| Anonymous 99 | 99 / 0 | 123.50 / 142.17 / 142.22 |
| Anonymous 100 | 100 / 0 | 48.12 / 66.67 / 67.74 |
| Anonymous 101 | 100 / 1 | 56.78 / 84.89 / 95.46 |
| Member 199 | 199 / 0 | 94.30 / 166.75 / 166.95 |
| Member 200 | 200 / 0 | 105.67 / 162.28 / 167.36 |
| Member 201 | 200 / 1 | 70.79 / 149.53 / 158.25 |
| Mixed full room | 200 / 0 | 92.22 / 177.62 / 186.25 |
| Saturated reconnect storm | 0 / 250 | 117.46 / 191.21 / 195.81 |
| Owner and overlay admission after storm | 2 / 0 | 3.97 / 6.45 / 6.45 |
| Twenty votes, final update to 200 sockets | All 200 received revision 20 | 226.48 / 239.91 / 240.36 |
| Sixty mash batches, acknowledgement | All 180 taps accepted | 2.41 / 9.09 / 9.25 |
| Final mash tick to 200 sockets | All 200 received total 180 | 210.87 / 213.77 / 213.88 |

Admission timings include accepted and refused tries.
The run produced 252 expected HTTP 503 responses, no unexpected admission statuses, and no message timeouts.
Storm refusals executed zero room D1 statements.

Votes executed 12 room statements plus 40 fixture statements. Mash executed 22 room statements and journaled 180 taps.
After reset, D1 recovered 180 taps. A reconnected member saw ten cumulative taps. The next tap raised the journal total to 181.

This mixed-room burst verified 200 local sockets.
Owner and overlay stayed connected during the storm. Two new priority connections displaced two viewers without exceeding 200 sockets.

These observations do not guarantee production capacity or measure infrastructure ceilings.
The runner shares CPU and memory without reserved resources.
JSON records OS, Node version, CPU model and count, and visible memory.
`pnpm-lock.yaml` pins dependencies, including Miniflare. Test compatibility date: `2026-05-15`.

The short, single-room burst excludes sustained load, multi-region latency, slow consumers, large histories, fifty large polls, concurrent battles, and deployment contention.
Before raising limits, agree on concurrency targets and measure staging. Do not run disruptive production load tests.

## Activity load tests

The activity path has its own load tests in the same isolated harness. Run them from the repository root:

```sh
LIVE_CAPACITY=1 LIVE_CAPACITY_OUTPUT=/tmp/activity-capacity-results.json pnpm exec vitest run tests/activity-capacity.test.ts
```

Give each test file its own output file. Without `LIVE_CAPACITY=1`, Vitest skips the tests of the two files.

The harness uses real `ChannelIngest`, the real Twitch webhook handler, workerd WebSockets, and object SQLite storage.
Temporary D1 has the real migrations. It cannot target production.

Each chat message and deletion is a signed Twitch EventSub call to `/hooks/twitch`.
A fake provider on the test machine answers each provider call. No call goes to Twitch, YouTube, or Kick.
Direct internal identities open the activity sockets. They bypass public authentication and rate limits.

`ACTIVITY_CAPACITY_RESULTS` prints JSON. Optional `LIVE_CAPACITY_OUTPUT` saves it.
Latency covers the webhook call through the event on each activity socket.
Snapshot timing covers the socket connection through the first snapshot.

The test bundle (`tests/helpers/activity-worker.ts`) adds counters, a storage report, and a clock that the test sets.
They exist only in the test bundle. The stream of several hours uses the set clock: four hours of traffic run in some seconds.

| Scenario | Load | Expected behavior |
| --- | --- | --- |
| Many quiet channels | 100 channels, 400 sockets, 200 chat messages and 100 deletions in 6 seconds | Each socket gets each event. Consumers add no provider subscription |
| One viral channel | 20 sockets, 500 chat messages each second for 5 seconds, 100 deletions during the flood | Admit the burst and the rate. Drop the other chat. Admit and send each deletion |
| Reconnect burst, one channel | 20 sockets close and connect again at one time | One snapshot of 100 messages for each socket. No provider call |
| Reconnect burst, 100 channels | 400 sockets close and connect again at one time | One snapshot for each socket. No provider call |
| Stream of several hours | 4 hours, 28,800 YouTube messages, 240 Twitch messages, 240 deletions, four consumers | No dropped event. Rows and quota units stay the same each hour |

`tests/channel-ingest-sharing.test.ts` runs with the unit tests. It shows one provider ingestion for each connected channel.
The web tools, the dock, and the two outputs share it.
Four consumers cause the same YouTube calls and quota units as one consumer. Polls stop when the last consumer leaves.
Four consumers also keep the Twitch and Kick subscriptions as they are.

## Activity results and limits

Recorded pass: November 26, 2026, with Node `v24.22.3` on Linux x64.
Host: Intel Xeon Processor at 2.10 GHz, four logical CPUs, 15.7 GiB memory.
Vitest duration: 55.40 seconds for the activity tests and 36.82 seconds for the live-room test.

| Scenario | Result | Latency in ms: `p50`, `p95`, maximum |
| --- | --- | --- |
| Quiet channels, chat | 200 sent, 0 dropped | 6.53 / 11.83 / 20.24 |
| Quiet channels, deletions | 100 sent, 0 dropped | 5.68 / 8.55 / 13.94 |
| Viral channel, chat | 2,500 sent, 451 admitted, 2,049 dropped by admission, 0 lost after admission | 87.83 / 724.15 / 797.20 |
| Viral channel, deletions | 100 sent, 100 admitted, 0 dropped | 12.41 / 224.02 / 366.36 |
| Reconnect burst, one channel | 20 snapshots of 100 messages, 0 provider calls | 82.98 / 97.19 / 97.43 |
| Reconnect burst, 100 channels | 400 snapshots, 0 provider calls | 801.36 / 1,257.77 / 1,288.23 |
| Stream of four hours | 29,040 chat messages and 240 deletions sent, 0 dropped | Not measured |

The viral flood took 5.03 seconds. The limit for that time is 452 admitted chat messages: the burst of 200 and 50 each second.
The object admitted 451. The webhook answered HTTP 204 to each delivery, also to a dropped one.
The moderation bucket is separate from the chat bucket. Thus the object admitted each deletion while it dropped chat.

The first consumers of the 100 quiet channels caused 200 provider calls: one subscription check of 2 calls for each channel.
The provider kept 500 subscriptions before and after the run. Each reconnect executed 2 D1 statements in the object.

The stream of four hours gave these numbers for each hour:

| Hour | Snapshot rows | Seen ID rows | Deleted ID rows | Storage bytes | YouTube units | D1 statements | Alarm runs | Provider calls |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 1,865 | 15 | 307,200 | 1,802 | 1,572 | 361 | 375 |
| 2 | 100 | 1,865 | 15 | 303,104 | 1,800 | 1,567 | 360 | 373 |
| 3 | 100 | 1,865 | 15 | 307,200 | 1,800 | 1,567 | 360 | 373 |
| 4 | 100 | 1,865 | 15 | 311,296 | 1,800 | 1,567 | 360 | 373 |

The row count did not grow after the first hour. The storage bytes changed by one SQLite page of 4,096 bytes.
The YouTube connection stayed `active`.

The run also read the resident memory of the workerd process after each hour: 500.2, 525.1, 550.9, and 572.5 MiB.
This number has no target. The process holds each object of the run, D1, and the runtime.
The harness cannot assign the growth to the ingest object, to the runtime, or to the harness.
Measure the memory of one object on staging before you use this number.

These observations do not guarantee production capacity.
One machine ran the Worker, the objects, D1, the fake provider, the load generator, and each socket.
They shared four CPUs, so the latency of the viral channel and of the reconnect bursts includes the queue of the test machine.
The run has no real provider, no provider network, no multi-region path, and no browser or OBS.
Latency stops at the socket. It does not include the time to draw the event on the screen.

With the set clock, the run shows retention and quota for four hours. It does not show effects of real time.
Examples are object eviction, hibernation, and the duration that Cloudflare bills.
The harness sends Twitch events and YouTube polls. The unit test covers the Kick subscriptions.

The 100 quiet channels are 1% of the live channels at the peak of the load model.
Do not run production load tests.
Measure the staging deployment before the owner confirms a target that depends on the network.

## Bounded reliability change

Before the fix, offline clients retried indefinitely. Brief snapshots reset the count and caused repeated owner-seat displacement.
Interactive clients allow eight automatic retries after initial connection.
Backoff uses 50 to 100 percent of exponential delay, capped at 30 seconds.
A valid snapshot after 60 healthy seconds restores the budget.

After exhaustion, viewers and owners can select Reconnect.
OBS sources retry indefinitely because they can run unattended.
Admission returns HTTP 429 or 503. Eviction closes WebSockets with code 1013.

## Remaining bottlenecks

One object per streamer handles admission, broadcasts, and battle ordering.
The 200-connection cap prevents measuring a higher object ceiling.
Each battle broadcasts to all sockets. D1 handles votes and bounded battle-total flushes. Statement counters prove no cost limit.

No measured compute limit yet justifies sharding. Set a business concurrency target first.
If staging supports sharding, scope a separate eight-point investigation and prototype.
Keep one authoritative battle coordinator and subscriber objects for fanout.
Measure the inter-object delivery, sequence recovery, duplicate delivery, overload admission, and deployment recovery before choosing that design.
Production sharding remains outside this issue.

## Recovery API

The test-only [abort method](https://developers.cloudflare.com/durable-objects/api/state/#abort) resets the object instance.
Recovery checks use real journal and D1 persistence. Reset endpoints and counters exist only in the test bundle.
