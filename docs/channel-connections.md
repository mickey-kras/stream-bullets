# Channel connections and activity

A streamer can connect one Twitch, one YouTube, and one Kick channel to a StreamBullets page.
The connected channels supply one activity feed with chat and moderation events.
Overlay consumers, such as merged chat and interactive characters, read this feed.
All consumers use the same connection and the same ingestion. Each page has its own feed.

Channel connections are separate from sign-in. They have their own redirect URI, state records, and tables.
They never read or change the `account` table of Better Auth or the linked login methods.

## Data flow

1. The owner selects **Connect** in **Overlay control**. The API makes a single-use state and a PKCE verifier.
2. The browser goes to the provider. The owner approves the permissions there.
3. The provider sends the browser to `/channels/callback/:platform`. The server checks the state and the session.
4. The server exchanges the code for tokens. It reads the channel identity from the provider.
5. The server stores the connection and the encrypted tokens in D1.
6. The `ChannelIngest` Durable Object of the page makes the provider subscriptions.
7. Twitch and Kick send events to `/hooks/twitch` and `/hooks/kick`. The Worker checks each signature.
8. The Worker changes the payload to the event contract. It sends the result to the `ChannelIngest` object of the page.
9. For YouTube, the `ChannelIngest` object reads the live chat with a poll while a consumer listens.
10. Consumers connect to `/api/activity/:handle` with a WebSocket. They get a snapshot first. Live events come next.

The code is in these files:

| Part | File |
| --- | --- |
| Event contract and consumer parser | `app/lib/activity.ts` |
| Connect, callback, list, disconnect | `app/server/channels.server.ts`, `app/server/api/channels.ts`, `app/routes/channels-callback.ts` |
| Provider calls | `app/server/channel-providers.server.ts` |
| Token encryption | `app/server/channel-tokens.server.ts` |
| Webhook checks | `app/server/channel-webhooks.server.ts` |
| Payload normalization | `app/server/channel-normalize.ts` |
| Ingestion, snapshot, YouTube poll | `app/server/channel-ingest.ts` |
| Streamer controls | `app/components/channels/channel-panel.tsx` |

## Event contract

The types are in `app/lib/activity.ts`. A consumer must parse each socket message with `parseActivityMessage`.
It must ignore a message that the parser refuses.

| Kind | Fields | Meaning |
| --- | --- | --- |
| `chat` | `id`, `platform`, `channelId`, `messageId`, `user`, `text`, `fragments`, `badges`, `sentAt`, `receivedAt`, `live` | One chat message |
| `delete` | `platform`, `messageId`, `receivedAt` | A moderator deleted one message |
| `ban` | `platform`, `userId`, `until`, `receivedAt`, optional `bannedAt` | A ban (`until` is null) or a timeout (`until` is the end time). `bannedAt` is the ban time from the provider. It is null when the provider does not give one. |
| `clear` | `platform`, `receivedAt` | A moderator cleared the chat |
| `clear_user` | `platform`, `userId`, `receivedAt` | A moderator removed all messages of one user |
| `status` | `platform`, `status`, `code` | The connection changed state |

The `id` of a chat message is `platform:messageId`. It is unique across platforms.
A participant is the pair of `platform` and `user.id`. A display name is not an identity.
The feed never merges participants across platforms.

The socket sends these messages:

- `{"type":"snapshot","events":[...],"replay":true}` once, when the socket opens.
- `{"type":"event","event":{...}}` for each live event.
- `{"type":"unavailable"}` before the server closes the socket. This occurs when the overlay key changes,
  when an administrator suspends the page, and when the owner deletes the account.

Each chat message in a snapshot has `live: false`. A consumer must not run a command from such a message.
Thus a reconnect never runs an old command again.

A live chat message also has `live: false` when the platform sent it more than 30 seconds before the server
received it (`LIVE_WINDOW_MS`). Thus a late provider retry never runs an old command.
A message without a source time is live. Twitch gives no source time in the chat event.
Thus the feed uses the time of the webhook message. We did not check that a Twitch retry keeps this time.

### Rules for consumers

- Show `text`, `user.displayName`, and badge labels as text. Never insert them as HTML.
- Load an emote image only from a URL that the parser accepted. The accepted hosts are in `EMOTE_HOSTS`.
- Use `user.color` only as a CSS color value. The parser accepts only `#rrggbb`.
- Remove a message from the screen when a `delete`, `ban`, `clear`, or `clear_user` event names it.
- When the socket closes, wait and connect again. Start with a wait of 1 second.
- Double the wait after each failed try, up to 60 seconds. Add a random part (jitter).
- Reset the wait after a successful connection.

## Capability matrix

| Capability | Twitch | YouTube | Kick |
| --- | --- | --- | --- |
| Chat messages | Yes | Yes, by poll | Yes |
| Message deletion | Yes | Yes (see note 1) | No |
| Chat clear | Yes | No | No |
| Clear the messages of one user | Yes | No | No |
| Ban and timeout | Yes | Yes | Yes |
| Unban | Not used | No | No |
| Emote images | Yes | No | No (name as text) |
| Badges | Badge set IDs | Owner, moderator, member, verified | Badge type and text |
| Source time | Message timestamp header | `publishedAt` | `created_at` |

The constant `PLATFORM_CAPABILITIES` in `app/lib/activity.ts` holds this matrix.
The controls show the gaps for each platform.

Note 1: the YouTube documentation lists the `tombstone` type but does not describe it in detail.
The feed treats a `tombstone` item as a deletion of the message with the same ID.
It also accepts a `messageDeletedDetails.deletedMessageId` field. We did not check this behavior with live traffic.

## Permissions

The feed asks only for read permissions. It never asks for permission to post chat or to moderate.

| Platform | Scopes | Notes |
| --- | --- | --- |
| Twitch | `user:read:chat`, `user:bot`, `channel:bot`, and the read-only `moderator:read:*` scopes for `channel.moderate` version 2 | EventSub webhooks need an app access token. The broadcaster grants all scopes. Thus the broadcaster is also the chat user and the moderator in each condition. |
| YouTube | `https://www.googleapis.com/auth/youtube.readonly` | Google lists this scope as sensitive. Google must check a public app before the app can use this scope. |
| Kick | `user:read`, `channel:read`, `events:subscribe` | Kick needs PKCE. |

The feed uses these provider subscriptions:

- Twitch: `channel.chat.message`, `channel.chat.message_delete`, `channel.chat.clear`, and `channel.chat.clear_user_messages` (version 1), and `channel.moderate` (version 2).
- Kick: `chat.message.sent` and `moderation.banned` (version 1).
- YouTube: no subscription. The object calls `liveBroadcasts.list` to find the live chat. Next, it calls `liveChatMessages.list`.

The callback refuses an authorization that gives fewer scopes than the list above.

## Limits and retention

| Item | Limit |
| --- | --- |
| Webhook body | 64 KiB |
| Webhook age | 10 minutes before or after the server time |
| Events in one delivery | 50, of any kind |
| Chat admission per page | 50 chat messages each second, burst of 200. Only new chat messages cost a token. |
| Moderation admission per page | 20 deletions, bans, timeouts, and clears each second, burst of 200, in a separate bucket. Thus a chat flood never holds moderation back. |
| Dropped events | The object drops what its buckets refuse. It counts the drops in the `channel_ingest_dropped` log (`chat`, `moderation`). |
| Snapshot | The last 100 chat messages, for at most 10 minutes |
| Delivery IDs, message IDs, and ban keys for deduplication | 15 minutes, at most 84,800 IDs |
| IDs of deleted messages | 15 minutes, at most 84,800 IDs, in a separate table |
| Kick message IDs that a Worker isolate forwarded | The last 10,000 |
| Connection data in the Worker and in the object | The cache keeps it for 30 seconds |
| Live window | A chat message is live only if the platform sent it at most 30 seconds before it arrived |
| Chat text | 500 characters, without control and format characters |
| Badges | 16 for each message |
| Fragments | 64 for each message |
| Activity sockets per page | 20 |
| Authorization state | 10 minutes, single use |
| YouTube poll interval | The larger of `pollingIntervalMillis` and 10 seconds |
| YouTube check for a live broadcast | Every 10 minutes while the channel is not live |
| YouTube backoff | 1 second up to 5 minutes, with jitter |
| YouTube quota | 9,000 units each quota day for all pages together, and 3,000 units for each page |
| `last_event_at` writes | One each 30 seconds for each channel |

The object keeps the snapshot and the IDs in its own SQLite storage. A snapshot never holds a message older than
10 minutes. An alarm also deletes expired messages and IDs from storage. To limit wakeups, the alarm runs at most
once each minute. Thus storage can keep an expired item for up to one more minute.
A deletion, ban, timeout, or clear removes the matching messages before the object sends the next event or snapshot.

The ID limit covers the webhook freshness window at the admission limits. In 10 minutes the object admits at
most C = 50 × 600 + 200 = 30,200 chat messages and M = 20 × 600 + 200 = 12,200 moderation events.
The object keeps the ID of every delivery with at least one admitted event. It also keeps the ID of every
admitted chat message, and a content key for every admitted ban. Thus the IDs of 10 minutes fit in
2C + 2M = 84,800. The object always finds a provider retry inside the 10-minute window.

The object also keeps the IDs of moderation deliveries. A repeated clear or ban is not harmless: it can remove
chat that arrived after the first one. Deleted message IDs have their own table with the same count limit. The
moderation bucket admits fewer deletions than that limit in 15 minutes. Thus a deleted ID stays for its full time.

Delivery IDs do not cover copies of one Kick delivery that reach other apps. Kick signs the webhooks of every app
with one key, and any app can subscribe to any broadcaster. Thus a copy that another app received can come back
with a valid signature. These checks limit this risk:

- Each Worker isolate keeps the last 10,000 Kick message IDs that it forwards now or forwarded before.
- A repeat gets 204 at once, without a call to the ingest object. This also applies to a copy that arrives while
  the Worker forwards the first. A repeat counts against the per-address limit.
- A failed forward releases the ID, so the retry from Kick gets through.
- For Kick, a stale or unparsable signed copy also counts against the per-address limit.
- The object deduplicates bans by content: platform, user, end of the ban, and the ban time from the provider.
- A new ban after an unban has a new ban time. Thus it removes the messages of the user again.
- Some YouTube and Kick items have no ban time. For them, the object ignores the same ban again within
  15 minutes.
- A timeout that already ended still removes the stored messages of the user. Consumers get a `clear_user` event
  for that user, not a `ban`.

The object deduplicates and admits a delivery before it reads D1. Thus a duplicate or an excess delivery costs
no database read. The Worker keeps the page of each known channel for 30 seconds. The object keeps each
connection for 30 seconds. A call that changes a connection clears the copy in the object at once.

A cached Worker route can point to an old page for up to 30 seconds. This occurs after a disconnect, or after
another page took the channel. Each delivery carries the channel ID that the Worker checked. The object drops a
delivery for any other channel than its own connection.

Deleted message IDs are in their own table, so a burst of new IDs cannot push them out early. They stay for
15 minutes, which is longer than the freshness window. Thus a late copy of a deleted message cannot return.

### YouTube quota

YouTube polls run only while a consumer listens. Thus a page that has no open overlay uses no quota.
The object also ingests the first page after a connect or a reconnect. The messages on it that YouTube got more
than 30 seconds before are not live, so no old command runs. A poll never runs before its stored time.
A new consumer, a cleanup alarm, or a reconnect cannot skip a backoff, the polling interval, or a quota wait.

The default Google quota is 10,000 units each day for the Google project. `liveChatMessages.list` costs 5 units.
`liveBroadcasts.list` costs 1 unit. Google resets the quota at midnight Pacific Time. The quota day of the feed
follows this reset, also across summer time.

| Case | Units |
| --- | --- |
| One live page at the 10-second floor | 1,800 each hour (6 polls each minute × 5 units × 60) |
| One open overlay, channel not live | 6 each hour (one check each 10 minutes) |
| Budget for one page | 3,000 each day: about 100 minutes of live chat at the floor |
| Budget for all pages | 9,000 each day: about 5 hours of live chat at the floor |

YouTube can ask for a longer interval with `pollingIntervalMillis`. Then a page uses fewer units.
The counters are in `app_rate_limits`, with the keys `youtube-quota:<day>` and `youtube-quota:<day>:<page>`.
When a page uses up a budget, the connection shows the `quota_exhausted` status until the next quota day.

The quota rows start at the reset time of their day. The hourly cleanup removes rows a day after they start.
Thus it cannot remove a row before its day ends, also on a 25-hour day.

`liveChatMessages.streamList` is a server-streaming alternative to the polls. It can cost less quota.
The feed does not use it now. Evaluate it in a later change.

For more streamers, ask Google for a higher quota:

1. Open **APIs & Services > YouTube Data API v3 > Quotas** in the Google Cloud project.
2. Send the quota extension form. Google can audit the app first.
3. After Google raises the quota, change `YOUTUBE_DAILY_BUDGET` and `YOUTUBE_PAGE_DAILY_BUDGET` in
   `app/server/channel-ingest.ts`.
4. Deploy the change.

## Token encryption and rotation

Only `app/server/channel-tokens.server.ts` reads or writes the `channel_tokens` table.
It encrypts each token with AES-256-GCM from WebCrypto and a new 96-bit IV.
The associated data is `connectionId|platform|field`. Thus a value that someone copies to another row does not
decrypt.

`CHANNEL_TOKEN_KEYS` holds the keys as `id:base64key`, separated by commas. Each key is 32 random bytes.
The first key encrypts. All listed keys decrypt. Keep these keys separate from `BETTER_AUTH_SECRET`.

Without valid keys, channel connections are off and the API answers 503.
The server never stores a plaintext token.

To make a key:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

To rotate the key:

1. Make a new key with a new ID.
2. Put the new key first in `CHANNEL_TOKEN_KEYS` and keep the old key after it.
3. Deploy the secret. New tokens and refreshed tokens use the new key.
4. Wait until no row in `channel_tokens` has the old `key_id`.
5. If some rows still have the old `key_id`, ask the owners of those channels to reconnect.
6. Remove the old key from the secret.

A row gets the new key only when the server writes its tokens again: at a refresh or a reconnect.
YouTube tokens refresh about each hour while an overlay is open. Twitch and Kick tokens refresh only when a
connect or a disconnect needs them. Thus their rows can keep the old key for a long time.

Before you remove an old key, ask the owners of those channels to reconnect.
A row whose key is no longer in the secret does not decrypt. Its connection changes to `needs_reauth`.

If a key leaks, remove it at once. Ask the owners of the affected channels to reconnect.

`TWITCH_EVENTSUB_SECRET` is part of each Twitch subscription. Twitch signs every delivery with the secret that
was current when the object made the subscription. To change the secret, store the new value and deploy. Then
every Twitch channel must reconnect, because the old subscriptions fail the signature check from that moment.

### Refresh

Only the `ChannelIngest` object of the page refreshes tokens. A Durable Object can start a second call while
the first one waits for a fetch. Thus the object keeps one refresh promise for each connection in memory.
A second call that needs fresh tokens waits for that refresh. It does not start another one.

The object also replaces the stored row only if `updated_at` did not change since it read the row.
If another writer, such as a reconnect, stored newer tokens, the object uses those tokens.
Twitch and Kick can return a new refresh token on each refresh. The object always stores the newest one.
A refused refresh changes the connection to `needs_reauth`. The owner must then reconnect.

## Disconnect

A disconnect needs a recent sign-in. The server then does these steps:

1. The API marks the connection as disconnecting. From now on, the object drops deliveries for it.
2. The `ChannelIngest` object reads the list of subscriptions for the channel from the provider.
   It deletes them and the subscriptions that it stored.
3. The object asks the provider to revoke the authorization. This step is best effort.
4. The object removes the messages of that platform from the snapshot. It stops the YouTube poll.
5. The API deletes the connection row and its tokens. It writes an audit record.

The object keeps the subscription IDs that the provider did not delete. A later connect deletes them first.
A callback refuses a channel while its disconnect runs (`disconnect_first`). Both checks are part of the
database writes, so neither can overwrite the other:

- If the disconnect marked the row first, the callback writes neither the row nor the tokens. It revokes its new
  token and answers `disconnect_first`. Its cleanup after a failed object call also leaves the marked row alone.
- If the callback wrote first, the disconnect keeps the new connection and answers 409 (`channel_conflict`).
  The same answer comes when another disconnect or the expiry job removed the row meanwhile.

The API deletes the connection also when the provider or the object fails. The audit record shows if the
provider confirmed the revoke and the unsubscribe. The unsubscribe counts as confirmed only when the object read
the list of the provider and every delete succeeded.
The controls then tell the owner to remove the app in the provider settings too.
After a disconnect, the Worker drops webhooks for the channel because no connection matches them.

### Provider subscriptions

On each connect and reconnect, the object first deletes the old subscriptions. It uses the IDs that it stored
and the list of the provider. Twitch lists by user with the app token. The object keeps only webhook
subscriptions for this broadcaster and for the callback URL of this deployment. Kick lists by broadcaster with
the token of the broadcaster.

The object stores each new subscription ID as soon as the provider returns it. An ID that it cannot delete
also stays in storage. Thus a failure part way through leaves no unknown subscription.
If Twitch answers that a subscription exists (409), the object adopts the IDs of that type from the list.
If a type stays without a subscription for this callback, the connect fails with `subscribe_failed`. This occurs
when another deployment holds the subscription, or when the object cannot read the list.

### Account deletion

Before the database deletes an account, the server runs the disconnect steps for each connected channel.
It then closes every activity socket of the page and clears the stored activity.
Each call is best effort and stops waiting after 5 seconds. Thus a provider outage never blocks the deletion.
The object then deletes all its storage: messages, IDs, subscription IDs, and the YouTube state.
The database cascade then deletes the connections and the tokens.

### Callback failures

The callback stores a new connection as not yet subscribed. It becomes active when the object confirms the
subscriptions. If the write fails, the callback revokes the new token. If a parallel callback took the channel
or the platform first, the callback answers `channel_taken` or `disconnect_first`.

A refused YouTube token is an exception. Google revokes the full grant of the user for the app, not only one
token. If a stored connection uses the same channel, the callback does not revoke the new token.

If the call to the object fails, the callback revokes the new token. It deletes a new connection.
For a reconnect, it deletes the tokens and marks the connection `needs_reauth`.
The cleanup changes the row only while it holds the tokens of this callback. A newer reconnect keeps its tokens.
If that cleanup fails too, the callback logs it and still answers `failed`.

## Logs and alerts

The logs hold only fixed codes, platforms, and counts. They never hold an ID, a name, a token, or message text.

| Event | Meaning | Suggested alert |
| --- | --- | --- |
| `channel_quota_exhausted` | The pages used up the YouTube budget for today | Page the operator. Think about a quota increase. |
| `channel_poll_failed` | A YouTube poll failed. The object tries again with backoff. | Alert when it repeats for 15 minutes |
| `channel_webhook_rejected` | A webhook failed its checks (`reason`). Or the server cannot check it (`unavailable`). Or the ingest object or its D1 reads failed (`ingest`). The Worker writes this log at most once a minute for each platform and reason. | Alert on `reason: signature` that repeats: a forger, or a changed secret. Page on `unavailable`: a missing secret or the Kick key. Page on `ingest` that repeats for 5 minutes. The providers try again, and then Twitch stops the subscriptions. |
| `channel_youtube_expired` | The hourly job removed connections (`count`, `reason`) | Alert on `reason: stale` or `stale_backstop`: title refreshes fail or do not run. Alert on `reason: stuck`: disconnects stop before they end. |
| `channel_youtube_refresh_failed` | Title reads of the hourly job failed (`count`) | Alert when it repeats for a day |
| `channel_refresh_failed` | The hourly job cannot ask an object for a title read. The log holds the error class. | Alert when it repeats |
| `channel_youtube_overdue` | After a run, D1 still holds YouTube data older than 30 days (`count`) | Alert when it repeats for 2 hours. The job cannot keep up, and the 32-day backstop removes those rows. |
| `channel_name_refresh_failed` | A YouTube title read failed. This read is the daily read for an open overlay, or a read for the hourly job. | Alert when it repeats for a day |
| `channel_webhook_unknown_channel` | A signed Twitch notification named no connected channel (sampled) | Alert when it continues, mainly after a D1 restore |
| `channel_status_changed` with `code: delivery_failed` | Twitch stopped a subscription after failed deliveries | Page when it occurs. The owner must reconnect. |
| `channel_status_changed` | A connection is not active, with its code | Look at the `authorization_revoked` counts each day |
| `channel_connect_failed` | The object cannot make the subscriptions | Alert when it repeats |
| `channel_ingest_dropped` | The object dropped chat over the admission limit | Information only |
| `channel_callback_failed`, `channel_connect_cleanup_failed`, `channel_disconnect_failed`, `channel_cleanup_failed` | A step failed. The log holds the error class. | Alert when it repeats |
| `activity_notify_failed` | A key or suspension notice did not reach the object | Alert when it repeats |

## Overlay key

The activity socket accepts only the current overlay key of the page or the signed-in owner.
The key gives read access to the live room and the activity feed. It gives no access to the account,
to channel management, or to provider tokens. A new overlay key closes the sockets that used the old key.
The overlay page sends no `Referer`, and the server stores only the SHA-256 of the key.

## Setup

Use these Worker secrets together with the sign-in secrets:

| Secret | Use |
| --- | --- |
| `CHANNEL_TOKEN_KEYS` | Token encryption keys |
| `TWITCH_EVENTSUB_SECRET` | Twitch webhook secret, 32 to 100 printable ASCII characters |
| `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | Kick app credentials |

The Twitch and YouTube connections use the sign-in clients (`TWITCH_CLIENT_*`, `GOOGLE_CLIENT_*`).
A platform without its credentials shows as not available in the controls.

1. In the Twitch app, add `https://streambullets.com/channels/callback/twitch` as a redirect URL.
2. In the Google client, add `https://streambullets.com/channels/callback/youtube` as a redirect URI.
3. Enable version 3 of the YouTube Data API for the Google project. Add the `youtube.readonly` scope to the consent screen.
4. Complete Google verification for the sensitive scope before you open the feature to all streamers.
5. Make a Kick app. Set the redirect URL to `https://streambullets.com/channels/callback/kick`.
6. Set the Kick webhook URL to `https://streambullets.com/hooks/kick` and enable webhooks.
7. Store the secrets. Deploy the Worker. The deploy adds the `ChannelIngest` class (migration `v2`).

Twitch gets the webhook URL `https://streambullets.com/hooks/twitch` in each subscription call.
Twitch accepts only HTTPS on port 443, so local development cannot receive Twitch webhooks.

8. The terms and the privacy policy changed with this feature. At merge time, set `termsVersion` and
   `privacyVersion` in `app/signup-policy.ts` to the merge date.
9. Before you deploy, set `policyEffectiveDate` in the `LEGAL_DETAILS` Worker secret to the deploy date.

## Runbook

- `channel_status_changed` with `delivery_failed`: Twitch revoked a subscription after failed deliveries.
  Look for outages of `/hooks/twitch` in that time. Look for Worker errors, and for `channel_webhook_rejected`
  with `reason: ingest` (failures of the ingest object or D1). Ask the owner to reconnect the channel.
- D1 restore: before the restore, set `CHANNELS_OFF`. The hourly `youtube_expiry` job skips while this secret
  exists. Otherwise the job can remove YouTube connections whose restored data looks old.
- After the restore, expect a wave of `needs_reauth`. Restored rows can hold tokens that the providers already
  replaced. Next, `channel_webhook_unknown_channel` can show: the restore can bring back a state without some
  connections. Twitch gets 410 for those channels. It revokes their subscriptions after repeated failures. Ask
  the owners of those channels to reconnect.
- `channel_youtube_expired`: the hourly job removed connections. The `reason` is `reauth`, `stale`,
  `stale_backstop`, or `stuck`. Each removal has an audit row (`channel_expired`).
- A `stale` wave means that the title refreshes failed. Look at the quota and the Google API status.
- A `stale_backstop` row had data older than 32 days that no refresh reached.
- A `stuck` row is a disconnect of any platform that stopped more than an hour ago.
- `channel_quota_exhausted`: the pages used up the YouTube budget. See [YouTube quota](#youtube-quota).

## Turn the feature off

Store `CHANNELS_OFF` as a Worker secret. Do not set it as a plain variable in the dashboard. The next
`wrangler deploy` replaces plain variables with the ones in `wrangler.jsonc`.

To turn ingestion off:

```sh
printf 1 | pnpm exec wrangler secret put CHANNELS_OFF --env production
```

To check it, open a WebSocket to `/api/activity/<handle>` with the overlay URL. The server answers 503.

While it is off, these things occur:

- The Worker answers Kick webhooks with 204 and drops them, so Kick does not try again.
- The Worker still checks Twitch webhooks. It records revocations, so the controls show when access ended.
  It drops other Twitch events and refuses new subscription checks.
- The activity socket answers 503. The objects close open activity sockets with `unavailable` on their next
  alarm or call.
- The objects stop the YouTube polls.
- The hourly `youtube_expiry` job only finishes disconnects that stopped more than an hour ago. It deletes those
  rows and writes their audit rows. It does not call the ingest object or the providers.
- When the feature is on again, the job removes YouTube connections that the YouTube rules do not let it keep.
  These are connections without authorization for 7 days, and connections with data older than 30 days that a
  new read cannot refresh. Data older than 32 days goes too.
- The controls show every platform as not available. Connect and callbacks do nothing.

To turn ingestion on again:

```sh
pnpm exec wrangler secret delete CHANNELS_OFF --env production
```

Overlays then connect again with their backoff (see [Rules for consumers](#rules-for-consumers)).
The connections, tokens, and provider subscriptions stay while the feature is off. To remove all access, ask
the owners to disconnect. Or remove the rows and revoke the apps at the providers.

## Rollback

The deploy adds the Durable Object migration `v2` with the `ChannelIngest` class. Do not remove this migration.

A Worker version without the `ChannelIngest` class cannot deploy over it.
You cannot use `wrangler rollback` to go to a version from before migration `v2`.
To roll back, first turn the feature off with `CHANNELS_OFF`. Then deploy a fix forward.
Or keep the class and its binding in the older code.

The D1 migrations `0027` and `0028` only add tables and a column. An older Worker ignores them.

## Threat model

### Assets

- Provider access and refresh tokens.
- The overlay key and the activity feed of each page.
- The link between a page and its channels.
- Chat text and identities of viewers, who are often not StreamBullets users.
- The shared YouTube quota and the Worker resources.

### Actors

- A signed-in user who wants to control the channel or feed of another streamer.
- A person who has a stolen session cookie or a leaked overlay URL.
- An attacker on the internet who sends forged or replayed webhooks.
- A chat participant who sends hostile text, names, or bursts of messages.
- A compromised provider response.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| CSRF on connect | Connect is a same-origin POST. The state is random and bound to the account and page. The server stores only its SHA-256 hash. |
| Callback in another session | The callback compares the account of the state with the session. A mismatch connects nothing and uses up the state. |
| Replayed or old state | The server deletes the state on first use. The state expires after 10 minutes. |
| Stolen authorization code | PKCE S256 for YouTube and Kick. Twitch does not document PKCE for this flow. Thus the Twitch flow relies on the state and the client secret. |
| Account substitution | A channel can belong to only one page (`UNIQUE(platform, external_id)`). The callback refuses a channel of another page and revokes the new token, except for a YouTube token (see Callback failures). |
| Different channel on reconnect | The callback refuses it. The owner must disconnect first. |
| Redirect abuse | The callback goes only to the fixed path `/overlay-control` with a short result code. It sends no code, state, or token in the URL. |
| Stolen session cookie | Connect, reconnect, and disconnect need a sign-in from the last 10 minutes (`reauth_required`). |
| Cross-streamer access | Every operation uses the own page of the viewer. Each page has its own `ChannelIngest` object. Webhooks go to the page that owns the channel. |
| Forged webhook | Twitch: HMAC-SHA256 with a constant-time comparison. Kick: RSA PKCS#1 v1.5 SHA-256 with the public key of Kick. The check runs on the raw body before parsing. |
| Replayed webhook | A timestamp window of 10 minutes, and deduplication of delivery IDs and message IDs for 15 minutes. |
| Oversized webhook | A 64 KiB body limit. The Worker checks it while the body streams. |
| Burst or denial of service | Each page has two token buckets, one for chat and one for moderation. They drop the excess before any database read. Each delivery holds at most 50 events. Each queue, snapshot, and socket list has a limit. Signed webhooks skip the per-address limit, because providers send from shared addresses. Only failures from a sender without the provider key count against that limit. These failures are a bad signature, size, method, query, or a missing body. A stale or unparsable signed delivery never counts. A forged call still costs a body read and a signature check. |
| Replayed moderation | Kick signs the webhooks of all apps with one key. Thus a captured signed ban can come again. The object keeps every accepted delivery ID and limits moderation with its own bucket. |
| Orphaned Twitch subscription | A signed notification for an unknown channel gets a non-2xx answer (410). Twitch counts it as a failed delivery. It revokes the subscription after repeated failures (`notification_failures_exceeded`). Revocations always get 204. The Worker keeps an unknown channel for 10 seconds. |
| Sign-in token with channel scopes | Google sign-in does not ask for incremental authorization (`include_granted_scopes`). The YouTube connection does not ask for it too. Thus a sign-in token never carries the YouTube scope. |
| XSS by chat | The contract keeps text as text. The server removes control characters and limits lengths. Emote URLs come from emote IDs on allowed hosts only. Consumers must show text without HTML. |
| Token leakage | D1 holds the tokens only in encrypted form. They are never in a response, a URL, browser storage, or a log. Logs hold only error classes and status codes. |
| Revoked access | A refused token or a Twitch revocation changes the status to `needs_reauth`. Ingestion for that channel stops. |
| Quota exhaustion | A shared daily budget and a budget for each page. Polls run only while a consumer listens. A stored next poll time, and backoff on errors. |
| Replay of old commands | The live window: a message that the platform sent more than 30 seconds before it arrived is not live. Snapshot messages are never live. |
| Suspended page | The object drops deliveries, stops polling, and closes the activity sockets. |
| Leaked overlay key | The owner makes a new key. The old key stops at once for the live room and the activity feed. |

### Residual risks

- The overlay key is a bearer secret in the OBS URL. A person who has the URL can read the feed until the owner makes a new key.
- A forged webhook costs a body read and a signature check before the per-address limit applies. The Worker logs refused webhooks at most once a minute for each platform (`channel_webhook_rejected`).
- All pages share the YouTube quota. The budget for each page limits one page. But three busy pages can still use up the shared budget.
- Account deletion waits at most 5 seconds for each provider. If a provider is down, its subscription or grant can stay. The Worker drops the later webhooks because no connection matches them.
- We did not check that a revoked Twitch user token also ends the EventSub access of the app. The disconnect also deletes the subscriptions.
- Some moderation events are not in the provider feeds, such as a Kick message deletion. After such an event, the snapshot can hold the message for up to 10 minutes.
- Display names and chat text can still hold offensive content. The feed does not filter content.
- This design reduces risk. It does not make the feature fully secure.

## Stored YouTube data

The connection keeps the YouTube channel ID and the channel title. The developer policies of the YouTube API Services
ask an app to refresh or delete the API data that it stores within 30 days. Thus:

- Each connect and reconnect reads the title again from YouTube.
- While an overlay is open, the object reads the title again once a day. This costs 1 quota unit.
  The object spends it only when the read succeeds and finds this channel.
- After a failed read, the object tries again after an hour. After a read that finds another channel, it tries
  again after a day. Neither stops the chat poll.
- The hourly `youtube_expiry` job asks the object to read the title of a connection whose data is older than
  25 days. It takes the oldest data first, and makes at most 20 reads in each run.
- The job skips a connection whose read it tried in the last 50 minutes. Thus failing connections cannot block
  the others.
- The job removes a connection when that read finds the access revoked. It also removes a connection when that
  read failed and the data is older than 30 days.
- Before the job removes the row, it checks the data age again. A slow read that succeeded after the job stopped
  waiting keeps the row. A read that finds another channel counts as failed.
- Until 32 days, the job never removes data that it did not try to read in this run. Past 32 days, it removes
  the connection without a read (`stale_backstop`).
- The job also removes a connection that needs a new authorization for more than 7 days.
- For each removal, the job first runs the disconnect steps, best effort and limited to 5 seconds. The tokens go
  with the row. The job writes an audit row (`channel_expired`, no actor) and a `channel_youtube_expired` log.
- The job also finishes a disconnect, on any platform, that stopped more than an hour ago (`reason: stuck`).

The connection has two times. `data_read_at` is when the server last read the channel data from YouTube. The
30-day rule uses it. `updated_at` is when the status or its code last changed, or when a disconnect marked the
row. The 7-day rule uses it.

A disconnect that marks a row now sets `updated_at`. Thus the job cannot take that
row at the same time.

The terms of service and the controls tell owners that a YouTube connection binds them to the YouTube Terms of
Service. The privacy policy links the Google Privacy Policy and the Google security settings.

## Facts not checked

The provider documentation does not give these details, or we did not test them with live traffic:

- The format of the Kick `Kick-Event-Message-Timestamp` header. The Worker accepts RFC 3339 and Unix seconds.
- A host for Kick emote images. The feed shows Kick emotes as their names.
- The place in the Kick developer settings where you set the webhook URL.
- The exact meaning of the YouTube `tombstone` type (see note 1).
- The guide from Google for web server apps does not list PKCE. Google accepts it in the current sign-in flow.
- If revoking a Twitch user token also ends the EventSub authorizations for the app token.
- If a Twitch webhook retry keeps the original `Twitch-Eventsub-Message-Timestamp`.
- If a Kick `POST /events/subscriptions` for an existing event makes a second subscription.
- The URL pattern for Twitch emote images: `https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/1.0`.
