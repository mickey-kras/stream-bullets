# Stream reports

StreamBullets records each stream of a page as a stream session.
After a session ends, the owner gets a report of that session.
The report has the chat, the people, the poll votes, the topics, and the support of the session.

This document gives the rules of a session, the metrics, the estimate, and the CSV format.
These parts are pure modules. The recorder, the storage, and the **Reports** section come in later changes.

| Part | File |
| --- | --- |
| Live signal and the event contract | `app/lib/activity.ts` |
| Session rules and their constants | `app/lib/stream-session.ts` |
| Summary, timeline, metrics, and estimate | `app/lib/stream-report.ts` |
| CSV format | `app/lib/session-csv.ts` |

## Current values

The owner did not decide these values yet. One constant holds each value.
Thus a decision changes one line. The table gives the current values.

| Constant | Current value | Meaning |
| --- | --- | --- |
| `STREAM_REPORT_RETENTION_DAYS` | 365 | A report stays for 365 days after the end of its session. |
| `ESTIMATE_METHOD` | `page_hmac_keys` | The estimate uses one HMAC key for each person of each page. |
| `PEOPLE_LOOKBACK_DAYS` | Twitch 90, YouTube 30, Kick 90 | The estimate looks back this number of days. |
| `REPORT_FORMATS` | `csv` | A report downloads as CSV only. PDF is for a later change. |
| `SCHEDULE_ONLY_REPORTS` | `with_activity` | A scheduled stream without a session gets a report only with activity. |
| `DIRECT_TIPS_READY` | `false` | Direct tips are not in a report until payments are ready. |

For `SCHEDULE_ONLY_REPORTS`, activity is one poll vote, one featured topic, or one event at a minimum.

## Live signals

A live signal tells that a channel is live or that it stopped. Its kind is `stream`.

| Field | Meaning |
| --- | --- |
| `platform` | The channel: `twitch`, `youtube`, or `kick` |
| `live` | `true` when the stream is live, `false` when it stopped |
| `startedAt` | Optional. The start time that the provider gives |
| `title` | Optional. The stream title, a maximum of 140 characters. Treat it as text from a stranger. |
| `receivedAt` | The time when the server received the signal |

A live signal is for the server only. It is not an `ActivityEvent`.
The type `IngestEvent` holds the feed events and the live signals.
`feedEvents` removes the live signals before the store and the sockets.
Thus no socket, no snapshot, and no store of chat or support gets a live signal.

A consumer refuses an event message of the `stream` kind. In a snapshot, it ignores the event.

## Session rules

`sessionStep(state, signal, now)` applies the rules. It gives the next state and the effects.
The server stores the state. `sessionStateSchema` validates it.

The reducer reads these signals:

| Signal | Meaning |
| --- | --- |
| `online` | A channel is live. It can have the start time and the title of the provider. |
| `offline` | A channel stopped. |
| `activity` | The page accepted chat or support from a channel. |
| `status` | The connection of a channel has an interruption, or the interruption ended. |
| `scheduleLive` | The live stream of the schedule, or none. |
| `checked` | The answer to a `check` effect: live, offline, or unknown. |
| `tick` | The alarm of the server. |

The reducer gives these effects:

| Effect | The server must |
| --- | --- |
| `open` | Record the start of a session. |
| `close` | Record the end of a session, with its live intervals. |
| `gapStart` | Record the start of a gap of one channel. |
| `gapEnd` | Record the end of that gap. Each `gapStart` gets one `gapEnd`. |
| `check` | Ask the provider if the channel is still live. Send the answer as `checked`. |

The rules use these constants:

| Constant | Value |
| --- | --- |
| `GRACE_MS` | 10 minutes |
| `SILENCE_GAP_MS` | 10 minutes |
| `SILENCE_CHECK_MS` | 30 minutes |
| `MAX_SILENCE_MS` | 3 hours |
| `MAX_SESSION_MS` | 24 hours |
| `BUCKET_MS` | 5 minutes |
| `PROVIDER_START_WINDOW_MS` | 15 minutes |

These are the rules:

1. R1: An `online` signal opens a session. If the start time of the provider is a maximum of 15 minutes old, the session starts at that time.
   Else the session starts at the signal.
2. R2: In a simulcast, each live channel adds a live interval to the same session.
3. R3: An `offline` signal starts the grace time of 10 minutes. Chat and support in the grace time do not count.
4. R4: If the channel is live again in the grace time, the session continues. The channel gets an `offline` gap.
5. R5: After the grace time, the session ends at the last offline time. The end reason is `provider`.
6. R6: If no channel is live, chat or support during a live stream of the schedule opens a session.
   The session starts at the start of the scheduled stream. The start reason is `schedule`.
7. R7: The schedule holds that session open until the end of the scheduled stream.
   After the grace time, the session ends at that end. The end reason is `schedule`.
   If the owner ends the stream early, the session ends at that time.
8. R8: A scheduled stream without a session can get a report from D1 only. The hourly job makes it.
9. R9: A live channel without a word from the provider for 30 minutes gets a `check`.
   If the provider says offline, the channel ends at its last activity.
   If the provider says live, the channel stays live. The silence count starts again.
   After 3 hours without a word, the channel ends at its last activity. The end reason is `silence`.
   An hourly job closes a session that nothing closed. Its end reason is `lost`.
10. R10: A session ends after 24 hours. The end reason is `limit`.
    A channel that is still live continues in a new session that starts at the limit. Its open gap continues too.
11. R11: A gap records a time without data. The table below gives the reasons.

| Gap reason | Cause |
| --- | --- |
| `offline` | The channel stopped and was live again in the grace time. |
| `outage` | The connection had an error, needed a new authorization, or disconnected. |
| `silence` | A live channel had no chat or support for 10 minutes. |
| `unwatched` | No consumer read the channel. The server reads YouTube only while a page listens. |

During an outage or an unwatched time, the channel gets no silence gap.
The 3 hours of silence do not end the channel during that time. The checks continue.
Thus a provider error does not end a session. The end of the interruption starts the silence count again.

A channel keeps a maximum of 48 live intervals in one session. A further interval joins the newest interval.

`sessionCounts(state, now)` tells if chat and support count now.
`nextWakeAt(state, now)` gives the next time that an alarm can change the state.
After a `tick` at a time, this next time is later than that time.
In the grace time before the limit of 24 hours, it is the end of the grace time, not the limit.

## Metrics

Each platform of a session has these metrics:

| Metric | Unit | Count |
| --- | --- | --- |
| `chat_messages` | messages | The chat messages of the session. Messages in the grace time do not count. |
| `removed_messages` | messages | The messages that a moderator removed. Kick does not give this metric. |
| `people_in_chat` | people | The different people in chat. The maximum count is 100,000. |
| `first_time` | people | An estimate. See [Estimate](#estimate). |
| `returning` | people | An estimate. See [Estimate](#estimate). |
| `follows` | events | Follows |
| `subscriptions` | events | Subscriptions. A subscription counts as one event, and the months do not count. |
| `memberships` | events | Memberships. A membership counts as one event. |
| `gifts` | gifts | The gifts in each gift bundle |
| `raids` | events | Raids |
| `bits` | bits | Bits |
| `super_chats` | events | Super Chats. The amounts are on `money` rows. |
| `super_stickers` | events | Super Stickers. The amounts are on `money` rows. |
| `kicks` | kicks | KICKs |

The page itself has `poll_votes`, `topics_featured`, and `authors_credited`.

Support counts as the platform reported it. Each unit stays native: StreamBullets does not convert units.
Money has one sum for each currency. A replay never counts. A topic credit is not support.

`REPORT_CAPABILITIES` tells which metric each platform gives:

| Metric | Twitch | YouTube | Kick |
| --- | --- | --- | --- |
| `removed_messages` | Yes | Yes | No |
| `follows` | Yes | No | Yes |
| `subscriptions` | Yes | No | Yes |
| `memberships` | No | Yes | No |
| `gifts` | Yes | Yes | Yes |
| `raids` | Yes | No | No |
| `bits` | Yes | No | No |
| `super_chats` | No | Yes | No |
| `super_stickers` | No | Yes | No |
| `kicks` | No | No | Yes |

`removed_messages` comes from `PLATFORM_CAPABILITIES.delete`. The support metrics come from `PLATFORM_SUPPORT`.
Each platform gives the other metrics.

`metricCell(platform, metric, summary)` gives a value or a "Not available" cell.
A "Not available" cell has the platform and one of these reasons:

| Reason | Cause |
| --- | --- |
| `not_offered` | The API of the platform does not give the metric. |
| `not_in_session` | The channel was not live in the session. |
| `support_not_read` | The connection does not read support events. Reconnect the channel to give the permissions. |
| `no_history` | The page has no history of people for the channel, for example after a disconnect. |

A value can be lower than the true count. Causes are a limit, an admission limit, and a gap.
Then the report says "At least this many".

## Estimate

The report shows first-time and returning contributors as an estimate.

1. A contributor chatted, or supported with a sender, in the session.
2. Each person has one key for each page: HMAC-SHA256 of the page secret and `platform:userId`.
3. A returning contributor has a key that the page saw in a session that ended in the look-back time.
4. Each other contributor is first-time.

The look-back time is 90 days for Twitch and Kick, and 30 days for YouTube.
Before the history covers the full look-back time, the report says "History starts" and the date.
A person with two accounts counts as two people. Voters on the page and topic authors are not contributors.

## CSV

`sessionCsv(report)` makes the CSV file. It validates the report with `sessionReportSchema` first.

- The file is UTF-8. It starts with a byte order mark.
- The fields follow RFC 4180. Lines end with CRLF.
- A field with a comma, a quote, or a line break is in quotes. Each quote in it becomes two quotes.
- Each time is UTC in ISO 8601, for example `2026-11-28T18:00:00.000Z`.
- A field that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return gets a leading apostrophe.
  Thus a spreadsheet does not run the field as a formula.

The CSV has the long format: one value on each row. It has these columns:

| Column | Content |
| --- | --- |
| `section` | `session`, `totals`, `contributors`, `support`, `timeline`, `live`, `gaps`, or `markers` |
| `platform` | `twitch`, `youtube`, `kick`, `page` for the page, or `all` for the session |
| `metric` | The stable English key of the metric, or the gap reason |
| `start` | The start of the time span |
| `end` | The end of the time span. It is empty while the session is live. |
| `value` | The value. It is empty when the value is not available. |
| `unit` | The unit, or the ISO 4217 code for money |
| `note` | "Not available" with the platform name, "At least this many", "Estimate", or "As reported by" the platform |

A money amount is a decimal of the native currency, for example `12.50`.
The `timeline` rows have 5-minute buckets of chat, support, and poll votes.

## Privacy

A report has counts only. It has no names, no platform user IDs, and no person keys.
Anonymous support is one count for each platform. No row names a supporter.
The input types of the CSV have no names and no IDs of people. Thus the CSV cannot have them.
