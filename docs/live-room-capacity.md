# Live room capacity

The application permits 200 live connections per streamer. Anonymous viewers can use 100 of these connections.
One client address can use ten viewer connections. The owner and an overlay with a valid key share ten priority seats.
These are application admission limits, not measured Cloudflare infrastructure limits.

## Reproduce locally

Install the pinned dependencies with `pnpm install --frozen-lockfile`. Run this command from the repository root:

```sh
LIVE_CAPACITY=1 LIVE_CAPACITY_OUTPUT=/tmp/live-capacity-results.json pnpm exec vitest run tests/live-capacity.test.ts
```

The harness creates an isolated Miniflare runtime and temporary local databases. It cannot target a production URL.
It bundles the real `PollRoom` class and uses workerd WebSockets, D1, and SQLite Durable Object storage.
The test Worker provides internal identities directly. It does not test public authentication, session lookup, or rate limits.
It does not use simulated sockets for latency measurements.

The output contains a `LIVE_CAPACITY_RESULTS` JSON record. `LIVE_CAPACITY_OUTPUT` also saves that record as a file.
Omit `LIVE_CAPACITY_OUTPUT` when you need only console output. Handshake timing includes the first snapshot.
Update timing runs from the start of the vote burst through delivery of the final revision to each connected client.
Mash timing measures individual acknowledgement latency and final tick delivery to all connected clients.
The room D1 counter records executed statements, including statements inside batches. Fixture writes are separate.
It does not measure D1 rows scanned, query CPU, billed operations, or production cost.

## Workload

| Scenario | Attempts | Expected behavior |
| --- | ---: | --- |
| Anonymous boundary | 99, 100, 101 | Accept 99, 100, 100; refuse the excess with HTTP 503 |
| Member boundary | 199, 200, 201 | Accept 199, 200, 200; refuse the excess with HTTP 503 |
| Mixed full room | 200 | Accept 100 anonymous viewers, 98 members, one owner, and one overlay |
| Reconnect storm | 250 | Refuse anonymous attempts against the full room; keep owner and overlay connected |
| Priority admission | 2 | Accept a new owner and overlay; evict two viewers; retain 200 open connections |
| Vote burst | 20 | Commit balanced votes, coalesce refresh work, deliver revision 20 to 200 sockets |
| Mash burst | 60 | Twenty members send three batches of three taps; acknowledge all 180 taps |
| Object recovery | 1 reset | Abort the object, recover 180 taps, reconnect a member, and count one further tap |

Each attempt uses a distinct client key. The boundary scenarios use separate streamer rooms.
The storm emulates one attempt from each disconnected client. Browser retry bounds are tested separately.
An overload refusal must do no room D1 work. The test compares the counters before and after the storm.
The priority clients remain connected during the storm and can reconnect after it at full capacity.

## Results and limits

The recorded run passed on November 10, 2026, with Node `v24.22.1` on Linux x64.
The host exposed an AMD EPYC 9V45 processor, nine logical CPUs, and 9.7 GiB of memory.
Vitest reported 34.34 seconds for the run, including runtime lifecycle work.

| Scenario | Accepted / refused | Latency p50 / p95 / max (ms) |
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

Admission timings include successful and refused attempts in each row.
There were 252 expected HTTP 503 responses and no unexpected admission statuses or message timeouts.
The 250 refused storm attempts executed zero room D1 statements.
The vote burst executed 12 room D1 statements plus 40 fixture vote statements.
The mash burst executed 22 room D1 statements and stored 180 taps in the local durable journal.
After the object reset, D1 recovered all 180 taps. A reconnected member then received a cumulative count of ten.
The additional tap raised the durable journal total to 181.

The verified local capacity is 200 sockets for this mixed-room burst workload.
Owner and overlay sockets stayed connected during the refusal storm. Two new priority connections then displaced two viewers.
The room retained exactly 200 open connections.

Measurements are local observations. They are not production guarantees or an infrastructure capacity claim.
The runner shares CPU and memory with other tasks. It has no CPU reservation or isolated resource budget.
The JSON record includes the operating system, Node version, CPU model, logical CPU count, and visible memory.
Dependencies and the Miniflare version are pinned in `pnpm-lock.yaml`. The test compatibility date is `2026-05-15`.

The workload is a short burst against one room. It does not establish sustained throughput, multi-region latency, or slow-consumer behavior.
It does not model a large history, fifty large polls, many concurrent battles, or deployment-wide contention.
Use a separate staging environment with an agreed concurrency target before increasing the admission limits.
Do not run disruptive production load tests.

## Bounded reliability change

The browser previously retried indefinitely after it displayed an offline state. Brief successful snapshots also reset its retry count.
A saturated room could therefore cause repeated reconnects, including repeated owner-seat replacement.
The client now permits eight automatic retries after the initial connection.
Backoff uses 50 to 100 percent of the exponential delay, with a 30-second ceiling.
A valid snapshot after at least 60 seconds of a healthy connection restores the budget.
After the budget is exhausted, the viewer can use the Reconnect control. The owner control page has the same action.
In OBS, use the browser source interaction window to select Reconnect, or refresh the browser source.
HTTP 429 and 503 remain explicit admission responses. Capacity evictions use WebSocket close code 1013.

## Remaining bottlenecks

Each streamer still uses one object for admission, snapshot broadcast, and battle sequencing.
The fixed 200-connection limit prevents this harness from measuring a larger single-object ceiling.
Each active battle broadcasts to every live socket. D1 receives vote writes and bounded battle-total flushes.
The test counter does not establish a database cost limit.

No measured compute limit currently justifies sharding. Keep the present architecture and first establish a business concurrency target.
If staging measurements justify sharding, estimate a separate eight-point investigation and prototype.
Keep one authoritative coordinator for battle totals and ordering, and use subscriber objects for fanout.
Measure cross-object delivery, sequence recovery, duplicate delivery, overload admission, and deployment recovery before selecting that design.
Sharded production implementation is outside this issue.

## Recovery API

The test-only reset uses the documented [Durable Object State abort method](https://developers.cloudflare.com/durable-objects/api/state/#abort).
This resets the object instance. The recovery checks read the real persistent journal and D1 totals.
The reset endpoint and measurement counters exist only in the test bundle.
