# Live room capacity

Per streamer: 200 connections, including 100 anonymous connections.
Each client address permits ten viewer connections. Owners and valid-key overlays share ten priority seats.
These are application limits, not measured Cloudflare limits.

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
