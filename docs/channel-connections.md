# Channel connections and activity

A streamer can connect one Twitch, one YouTube, and one Kick channel to a StreamBullets page.
The connected channels supply one activity feed with chat and moderation events.
The feed also has the support events of each connected channel, such as follows and subscriptions.
Overlay consumers, such as merged chat and interactive characters, read this feed.
All consumers use the same connection and the same ingestion. Each page has its own feed.

Channel connections are separate from sign-in. They have their own redirect URI, state records, and tables.
They never read or change the `account` table of Better Auth or the linked login methods.

## Data flow

1. The owner selects **Connect** in the **Channels** section of **Streamer tools**. The API makes a single-use state and a PKCE verifier.
2. The browser goes to the provider. The owner approves the permissions there.
3. The provider sends the browser to `/channels/callback/:platform`. The server checks the state and the session.
4. The server exchanges the code for tokens. It reads the channel identity from the provider.
5. The server stores the connection and the encrypted tokens in D1.
6. The `ChannelIngest` Durable Object of the page makes the provider subscriptions.
7. Twitch and Kick send events to `/hooks/twitch` and `/hooks/kick`. The Worker checks each signature.
8. The Worker changes the payload to the event contract. It sends the result to the `ChannelIngest` object of the page.
9. For YouTube, the `ChannelIngest` object reads the live chat with a poll while a consumer listens.
10. Consumers connect to `/api/activity/:handle` with a WebSocket. They get a snapshot first. Live events come next.

Connect, reconnect, and disconnect need a sign-in from the last 10 minutes.
With an older session, the card of the platform shows a prompt. It names the platform and the sign-in provider of the account.
The sign-in sends no age confirmation and no display name. The server reads them only when it creates an account.

Before the browser goes to the sign-in provider, the page stores the platform and the action in the session storage of the tab.
After the sign-in, the page reads this value once and removes it. A value older than 10 minutes does nothing.

The value also holds the handle of the page. A value for a different page does nothing.
A connect then continues to the platform without a second click. For a disconnect, its button gets focus.

The address never carries this value. Thus a link from another site cannot start a connect.

The code is in these files:

| Part | File |
| --- | --- |
| Event contract and consumer parser | `app/lib/activity.ts` |
| Connect, callback, list, disconnect | `app/server/channels.server.ts`, `app/server/api/channels.ts`, `app/routes/channels-callback.ts` |
| Provider calls | `app/server/channel-providers.server.ts` |
| Token encryption | `app/server/channel-tokens.server.ts` |
| Webhook checks | `app/server/channel-webhooks.server.ts` |
| Payload normalization | `app/server/channel-normalize.ts`, `app/server/channel-support.ts` |
| Ingestion, snapshot, YouTube poll | `app/server/channel-ingest.ts` |
| Provider subscriptions and their repair | `app/server/channel-ingest-subscriptions.ts`, `app/server/channel-repair.server.ts` |
| Streamer controls | `app/components/channels/channel-panel.tsx`, `app/components/channels/channels-step.tsx` |
| Channel health and its refresh | `app/lib/channel-health.ts`, `app/components/channels/use-live-channels.ts` |

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
| A support kind | `id`, `platform`, `deliveryId`, `sender`, `anonymous`, `amount`, `currency`, optional `text`, optional `sentAt`, `receivedAt`, `replay` | One support event. See [Support events](#support-events). |

The `id` of a chat message is `platform:messageId`. It is unique across platforms.
A participant is the pair of `platform` and `user.id`. A display name is not an identity.
The feed never merges participants across platforms.

The socket sends these messages:

- `{"type":"snapshot","events":[...],"replay":true,"since":0}` once, when the socket opens.
- `{"type":"event","event":{...}}` for each live event.
- `{"type":"unavailable"}` before the server closes the socket. This occurs when the overlay key changes,
  when an administrator suspends the page, and when the owner deletes the account.
- `{"type":"alerts",...}` and `{"type":"alert",...}` for the alerts and the goal. See [Alerts and the goal](#alerts-and-the-goal).
  The server sends `alerts` once after the snapshot, and again after each change of the state. See [Alert host](#alert-host).

A browser cannot read the HTTP status of a failed WebSocket upgrade.
Thus the server accepts a connection with a wrong or revoked key and closes it at once with the code `4403`.

Each chat message in a snapshot has `live: false`. A consumer must not run a command from such a message.
Thus a reconnect never runs an old command again.

`since` is a receive time. The snapshot has each message that the server keeps and that is newer than `since`.
A consumer that has a newer message, which is not in the snapshot, knows that a moderator removed it.
The snapshot tells nothing about a message that is not newer than `since`.
The server keeps the newest 100 messages for 10 minutes. `since` is the newest of these times:

- The time 10 minutes before the snapshot.
- The receive time of the newest message that the limit of 100 removed.
- The receive time of the newest message of a platform that the owner disconnected.
- The receive time of the newest message that the size limit of the snapshot left out.

A snapshot also has the support events that the server keeps: the newest 50, for 10 minutes.
Each of them has `replay: true`. The events of a snapshot are in the order of their receive times.
A support event never changes `since`: no moderation removes a support event.

A live chat message also has `live: false` when the platform sent it more than 30 seconds before the server
received it (`LIVE_WINDOW_MS`). Thus a late provider retry never runs an old command.
A message without a source time is live. Twitch gives no source time in the chat event.
Thus the feed uses the time of the webhook message. We did not check that a Twitch retry keeps this time.

### Support events

The feed has one format for support from each platform, for direct tips, and for topic credits. These are the kinds:

| Kind | Meaning | `amount` | `currency` |
| --- | --- | --- | --- |
| `follow` | A new follower | `null` | `null` |
| `subscription` | A subscription | Months | `null` |
| `membership` | A channel membership | Months | `null` |
| `gift` | A gift bundle: one event for the bundle | Gifts in the bundle | `null` |
| `raid` | A raid | Viewers | `null` |
| `bits` | Bits | Bits | `null` |
| `super_chat` | A Super Chat | Micros of the currency | The ISO 4217 code |
| `super_sticker` | A Super Sticker | Micros of the currency | The ISO 4217 code |
| `kicks` | KICKs | KICKs | `null` |
| `tip` | A direct tip through StreamBullets | Micros of the currency | The ISO 4217 code |
| `reactions` | A group of reactions: one event for the group | Reactions | `null` |
| `topic` | The credit for the author of a topic that the owner shows on stream | `null` | `null` |

Each support event has these fields:

- `platform`: `twitch`, `youtube`, or `kick`. Only a `tip` and a `topic` have `direct`.
- `deliveryId`: the ID that the provider gave the delivery. `id` is `platform:deliveryId`.
- `sender`: `{id, displayName}` of the supporter on that platform, or `null`.
- `anonymous`: `true` when the supporter asked for no name. An anonymous event always has `sender: null`.
- `amount`: the amount in the native unit of the kind. Money is in micros: 1 000 000 is one unit of the currency.
  The feed never converts an amount to a different unit or currency.
- `text`: the text that the supporter sent, with at most 500 characters. Show it as text, never as HTML, as for chat text.
  For a `topic`, the text is the title of the topic.
- `sentAt`: the time when the platform says that the event occurred. The field is absent when the platform gives no time.
  Only YouTube events have it in this version.
  A consumer that counts or plays events must compare this time, not only `receivedAt`. A provider can send an old event again a long time after it occurred.
- `replay`: `true` for an event that the server sends again: a replay of the owner, a test, or the snapshot of a reconnect.

The parser refuses a support event that does not agree with its kind.
Examples are a follow with an amount, money without a currency, and a tip that is not direct.

No part of the server makes a `topic` event in this version. `tip` and `reactions` also have no source.

A consumer ignores the kinds that it does not know.
An `event` message of an unknown kind is not valid for the parser, and the consumer ignores it.
A snapshot keeps its other events. Thus a newer server never empties the chat of an older page.

These rules make each support event count one time:

- A provider sends a delivery again after a timeout or an error. The second delivery has the same `deliveryId`.
  `acceptDelivery` refuses it, so it makes no second event.
- The `ChannelIngest` object keeps the `id` of each support event for 15 minutes. It does not send an event with a known `id` again.
  This also applies to a YouTube page that comes again.
- A live support event has `replay: false`. The same event in the snapshot of a reconnect has `replay: true`.
- A consumer can show a replay. `supportTotals` never counts a replay, and it never counts the same `id` again.
  Thus a replayed alert does not change a goal or a revenue record.

This section is the format only. See [Support events of each provider](#support-events-of-each-provider) for the provider events.

### Alerts and the goal

`app/lib/alerts.ts` and `app/lib/goals.ts` have the rules for alerts on stream and for the goal.
They are pure functions. The alert host of the page uses them. See [Alert host](#alert-host).

The overlay shows the alerts and the goal. The editor has their settings. See [Alerts settings](overlay-composition.md#alerts-settings).

A rule tells what a support event does. The alerts layer holds the rules. See [Overlay layers](api.md#overlay-layers).

| Rule | Support kinds | Starts at | Banner | Character action |
| --- | --- | --- | --- | --- |
| `follow` | `follow` | Each event | Off | `wave` |
| `subscription` | `subscription`, `membership` | Each event | On | `jump` |
| `gift` | `gift` | A bundle of 1 gift | On | `jump` |
| `bits` | `bits`, `kicks` | 100 Bits or 100 KICKs | On | `jump` |
| `paid` | `super_chat`, `super_sticker` | Each event | On | `jump` |
| `raid` | `raid` | 5 viewers | On | `crowd` |
| `topic` | `topic` | Each event | On | `wave` |

- The table gives the defaults. Each rule has three switches: `banner`, `chat`, and `character`. The defaults of `chat` and `character` are on.
- `gift`, `bits`, and `raid` have the amount `min`. A live event below `min` makes no alert. Bits and KICKs use one amount.
- A rule with the three switches off makes no alert.
- `tip` and `reactions` have no rule. They make no alert.
- `crowd` makes each character on screen cheer. An alert without a known participant also gets `crowd`.
- One alert shows at a time, for 6 seconds (`ALERT_SHOW_MS`). The next alerts wait in a line.
  `ALERT_QUEUE_MAX` sets no limit for the line. The alert host holds at most 100 alerts that wait.
- An alert without a banner does not wait in the line. It plays immediately.

`alertFor` makes the alert of one support event. Its result has the view for the clients and two server values:

- `view`: what a client shows. See the fields below.
- `subject`: the `platform` and the `userId` of the participant whose character moves. The server never sends it.
- `action`: the character action, or `null` when the rule has `character` off.

A view (`AlertView`) has these fields:

- `id`: the ID of one play. For a live alert and a test, it is the ID of the event. A replay adds `~r` and the number of the replay.
- `origin`: `live`, `replay`, or `test`.
- `kind`, `platform`, `amount`, `currency`: as in the support event. Only a `topic` has the platform `direct`.
- `name`: the display name of the supporter, or `null`.
- `anonymous`: `true` when the supporter asked for no name. The parser refuses an anonymous view with a name.
- `text`: for a `topic`, the title of the topic, with at most 200 characters (`ALERT_TEXT_LENGTH`). No other view has it.
  The server never puts the message of a supporter in a view. That message stays in the support event.
- `banner` and `chat`: the switches of the rule.
- `startsAt` and `endsAt`: the server times of the banner. They are equal for an alert without a banner.

A view never has a user ID. The parser drops each field that is not in this list.

A test and a replay are alerts that the owner starts:

- They ignore `min`. They use the three switches of the rule.
- `testSupport` makes the sample event of a test. The server must not send or store that event. The event has `replay: true`.
- They never count for a goal, a report, or revenue.

The socket messages are:

- `{"type":"alerts","at","muted","current","waiting","goal"}`: the whole state at the server time `at`.
  `current` is the view on stream or `null`. `waiting` is the number of alerts in the line.
  `goal` is `{counts, value, startedAt}` or `null`.
- `{"type":"alert","alert"}`: one view without a banner.

`alertShownOn` tells whether an output for one platform shows a view.
Such an output shows the alerts of its platform and each topic credit. See [Twitch chat only](overlay-composition.md#twitch-chat-only).
`messageForPlatform` does not remove an alert message.

A goal counts one thing (`counts`):

| `counts` | What adds to the value |
| --- | --- |
| `subs` | 1 for each `subscription` and each `membership`, and the gifts of each `gift` bundle |
| `follows` | 1 for each `follow` |
| `bits` | The Bits of each `bits` event |
| `kicks` | The KICKs of each `kicks` event |
| `chatters` | No support event. The value is the number of people who chat. |
| `votes` | No support event. The value is the number of poll votes and new topics. |

- `goalAmount` gives the amount of one support event for a goal. It gives 0 for an event with `replay: true`.
- `countSupport` adds the amount to the progress. It adds nothing for an event from before `startedAt`.
  It compares `sentAt`, or `receivedAt` when the event has no `sentAt`.
- The alert host refuses a known event ID, as `acceptDelivery` does. Thus an event counts one time.
- The server counts nothing for `votes` in this version. The value of such a goal stays 0.
- A goal never converts Bits, KICKs, or a currency.

### Alert host

`app/server/alert-host.ts` is the alert host. It is a part of the `ChannelIngest` object of the page.
It makes the alerts, keeps the line, and runs the controls of the owner.
See [Alert controls](api.md#alert-controls) for the API.

The object gives the host each support event that it stored and sent to the sockets. The host first does these two steps:

1. If the host knows the `id` of the event, it stops. The event counts for nothing and plays nothing.
   The host keeps the `id` of the newest 2,000 support events (`DELIVERIES_KEPT`).
   The object refuses a known `id` for 15 minutes only. A provider can send an event again later.
2. The goal counts the event. See [Goal count](overlay-composition.md#goal-count).
   The steps for the alert do not change the count.

The object also gives the host each chat message that it stored. A goal that counts chatters counts its sender.

The host then does these steps for the alert:

1. If the event is not live, the host stops. A live event has no `sentAt`, or its `sentAt` is at most 30 seconds before `receivedAt`.
   Thus an old event that a provider sends again plays no alert.
2. If no alert can play, the host stops. See the list below.
3. `alertFor` makes the alert with the rules of the alerts layer. The host removes the message of the supporter first.
4. An alert without a banner plays immediately. If the rule has `chat` on, the sockets get an `alert` message.
5. If no alert is on stream, an alert with a banner starts. If one is on stream, the new alert waits in the line.
   The sockets get the new state in an `alerts` message.
6. If the rule has `character` on, the characters react when the alert starts. See [Characters](characters.md).

No alert plays in these conditions, and no such alert plays later:

- The alerts layer is not on stream in an output.
- The mute is on.
- No activity socket is open: no overlay page, no **Streamer tools** page, and no dock.
- 100 alerts wait in the line. The host drops the new alert.

One state applies to each socket of the page. Thus the two outputs, **Streamer tools**, and the dock show the same alert.

- Each alert with a banner shows for 6 seconds. The host sets the alarm of the object to the end time.
  The alarm ends the alert and starts the next one.
- A socket that opens gets the `alerts` state after the snapshot. `current.endsAt` tells the page how long the banner stays.
  A page must also hide the banner at `endsAt` with its own clock, because an alarm can be late.
  The state never has an alert after its `endsAt`.
- When the alarm runs and no activity socket is open, the host removes the alert on stream and the line.
- When the alerts layer goes off stream, the host removes the alert on stream and the line.
- When the owner disconnects a platform, the host removes the alerts of that platform.

The controls of the owner do these things:

- **Mute** stops the alert on stream immediately and removes the line. While the mute is on, the host makes no alert.
  Thus nothing from the muted time plays after the mute ends. The muted state survives a restart of the object.
- **Skip** ends the alert on stream. The next alert of the line starts.
- **Test** plays a sample alert. **Replay** plays the alert of a support event again.
  The host finds the event of a replay in the support snapshot: the newest 50 events of the last 10 minutes.
- A test and a replay use the three switches of the rule and not its `min`.
  They add no support event and no row, and the sockets get no `event` message for them.
- The host refuses a test or a replay that cannot play, with a code. It never drops one without an answer.

The characters react as follows:

- The character of the supporter does the action of the rule. The host gives the playground the `platform` and the user ID of the supporter.
- The crowd cheers for a raid, for an anonymous event, for a test, and for a supporter without a character on screen.
- One playground serves the two outputs. When an output shows only Twitch and the alert is not from Twitch, the crowd has no Twitch characters.
  Thus the Twitch output shows no reaction to an event of a different platform. A topic credit shows in each output, so each character can react.

The host has a copy of what it needs from the saved layers. The copy has the rules, and it tells whether the alerts layer is on stream.
It also tells whether an output shows only Twitch, and what the goal counts.
Thus an event that wakes the object reads no database. The host reads the saved layers again at these times:

- When the API tells the object that the layers changed. This is one more database read for each change of the layers.
- Before the object takes in events, when the host has no copy. Thus the first events count for the goal.
  A goal that this read starts counts from the earliest live event of these events.
  If this read fails, the object refuses the delivery with 503, and the provider sends it again. A YouTube poll stops before it moves to the next page.
- Before each test, each replay, and each `goalReset`.
- When a socket opens and the copy is older than 60 seconds.
- When the alarm runs and the copy is older than 60 seconds, while a page listens or the goal counts.
- 60 seconds after the last read, when an event used the copy since the read. The host sets the alarm for this read.
  Thus a change notice that did not arrive changes the alerts and the goal for at most 60 seconds.

A message to a socket never has a platform user ID. A view has the display name, and `null` for an anonymous supporter.
The user ID of a supporter is only in the line, for the reaction of the character.

### Support events of each provider

`app/server/channel-support.ts` turns the provider events below into support events.
Each connected channel reads its support events. Alerts and goals use them.
The owner cannot turn the support events on or off. There is no switch and no API route for them.

The `support_events` field of a connection tells whether the connection reads support events.
Each connect and each reconnect set the field:

- The server asks the provider for the scopes of chat and for the scopes of the support events.
- The provider gives the scopes of the authorization. The server stores them in the `scopes` field of the connection.
- The field is on when the authorization has each scope that the support events need.
- Twitch needs three scopes: `moderator:read:followers`, `channel:read:subscriptions`, and `bits:read`.
- YouTube and Kick need no scope for the support events. Thus each new YouTube and Kick connection has the field on.

The closed notes of each card in **Streamer tools** list the support events of the platform.
For Twitch, the notes also name the three permissions in plain words.

**Live** and the dock show the support events in the chat list. See [Chat](streamer-tools.md#chat).
The overlay chat shows no support event. An alert with the mark in chat makes one row in the overlay chat.
See [Alerts layer](overlay-composition.md#alerts-layer).

A connection with the field on does these things:

- The `ChannelIngest` object makes the Twitch and Kick subscriptions of the support events. It makes the chat subscriptions first.
- For YouTube, the object reads the support events from each chat page that it reads for chat.

A connection with the field off reads chat only. The object drops each support event of that connection.
It does not store the event, and it does not keep the ID. The chat events of the same delivery continue.

A refusal of the provider never stops chat:

- Twitch does not give the three scopes: the callback connects the channel for chat and answers `support_denied`. The field is off.
- Twitch answers 403 for a subscription of a support event: the object sets the field to off.
- Kick answers 401 or 403 for the support events, or makes no subscription for one of them: the object sets the field to off.
- In each case the connection stays `active`, and the chat subscriptions stay.
- For a refused subscription, the object writes the `channel_support_refused` log. The callback then answers `support_denied`.
- The next subscription check deletes a subscription of a support event that stays at the provider.
- The next reconnect asks for the scopes and makes the subscriptions again.

Migration `0051_channel_support_always` sets the field for each connection from before this change:

- A YouTube or Kick connection gets the field on. The next subscription check makes the Kick subscriptions of the support events.
- A Twitch connection gets the field on only when its stored scopes have the three scopes.
  The next subscription check then makes its subscriptions of the support events.
- A Twitch connection without the three scopes keeps the field off. Its chat continues, and no check asks Twitch for the support events.

The `ChannelIngest` object keeps a connection in memory for 30 seconds. Thus it uses the new value of the field 30 seconds after the migration, at the latest.

The card of a connection with the field off shows the `rejected` status icon.
For Twitch, the tooltip tells the owner to reconnect one time. Alerts and goals can then read follows, subscriptions, and Bits.
This state is not a health problem. It causes no toast and no announcement, and **Live** shows the channel as connected.
See [Channel health in Streamer tools](#channel-health-in-streamer-tools).

The tables give, for each provider event: the kind, the amount, the person that the event names, and the permission.
The facts are from the provider documentation of 2026-11-26.

Twitch sends each event as an EventSub notification:

| EventSub type | Kind | `amount` | `sender` | Scope |
| --- | --- | --- | --- | --- |
| `channel.follow` (version 2) | `follow` | `null` | The follower | `moderator:read:followers` |
| `channel.subscribe` | `subscription` | 1 | The subscriber | `channel:read:subscriptions` |
| `channel.subscription.message` | `subscription` | All months so far (`cumulative_months`) | The subscriber | `channel:read:subscriptions` |
| `channel.subscription.gift` | `gift` | Gifts in the bundle (`total`) | The person who gives | `channel:read:subscriptions` |
| `channel.cheer` | `bits` | Bits | The person who cheers | `bits:read` |
| `channel.raid` | `raid` | Viewers | The channel that raids | None |

- Anonymity: only `channel.cheer` and `channel.subscription.gift` have `is_anonymous`. Twitch then sends no user, and the event has `anonymous: true` and `sender: null`.
- A gift bundle also sends `channel.subscribe` with `is_gift: true` for each person who got a gift. Those give no event, so the bundle counts one time.
- A cheer also sends `channel.bits.use`. The server reads `channel.cheer` only, so Bits count one time.
- Twitch does not send `channel.subscribe` for a renewal. A renewal shows only when the subscriber sends a message with it.
- The delivery ID is the header `Twitch-Eventsub-Message-Id`. Twitch sends a notification again with the same ID.
- The scopes are optional: a connection without them reads chat only. The server asks for them at each connect and reconnect. `channel.raid` needs no scope.
- The condition of `channel.raid` names the channel in `to_broadcaster_user_id`. Each other type names it in `broadcaster_user_id`.
- The server makes the chat subscriptions first. Thus a refused support subscription leaves chat as it is.

Kick sends each event as a webhook:

| Webhook event | Kind | `amount` | `sender` |
| --- | --- | --- | --- |
| `channel.followed` | `follow` | `null` | `follower` |
| `channel.subscription.new` | `subscription` | Months (`duration`) | `subscriber` |
| `channel.subscription.renewal` | `subscription` | Months (`duration`) | `subscriber` |
| `channel.subscription.gifts` | `gift` | The number of `giftees` | `gifter` |
| `kicks.gifted` | `kicks` | KICKs (`gift.amount`) | `sender` |

- Anonymity: only `channel.subscription.gifts` has an anonymous `gifter`. Kick then sends null for each field of the gifter, and the event has `anonymous: true` and `sender: null`.
- A gift bundle is one webhook. The event does not name the people who got a gift.
- The ID of an event is from its content: the event type, the person, and the time `created_at`. A gift bundle adds its size and the first person who got a gift. KICKs add the amount.
- A follow has no time. Its ID is the event type and the person, so a second follow of the same person is the same event.
- An event without `created_at` has the header `Kick-Event-Message-Id` as its ID. Kick calls it the idempotent key.
- Kick signs the webhooks of all apps with one key. A copy that a different app got has a different message ID and the same content. Thus the copy makes the same event ID and counts one time.
- Permission: the Kick documentation names only `events:subscribe` for webhook events. Each connection has this scope.
- The server asks Kick for the chat events first, and for the support events in a second call.

YouTube sends each event as a message of the live chat, in the same page as the chat:

| `snippet.type` | Kind | `amount` | `currency` |
| --- | --- | --- | --- |
| `superChatEvent` | `super_chat` | `amountMicros` | The ISO 4217 code |
| `superStickerEvent` | `super_sticker` | `amountMicros` | The ISO 4217 code |
| `newSponsorEvent` | `membership` | 1 | `null` |
| `memberMilestoneChatEvent` | `membership` | Months (`memberMonth`) | `null` |
| `membershipGiftingEvent` | `gift` | `giftMembershipsCount` | `null` |

- The `sender` is the author of the message (`authorDetails`). YouTube has no anonymous support in chat.
- A gift bundle is one `membershipGiftingEvent`. Each person who got a gift also makes a `giftMembershipReceivedEvent`, which gives no event.
- The delivery ID is the ID of the message. A page that comes again has the same IDs.
- `sentAt` is the `publishedAt` time of the message. An event without a correct `publishedAt` has no `sentAt`.
- Permission: these messages come with the chat that the server reads. They need no new scope and no more calls of the API, so they use no more quota.
- YouTube has no chat message for a new channel subscriber, so the feed has no `follow` from YouTube.
- `giftEvent` (Jewels) has no kind in the feed. The server does not read it.

### Native polls, predictions, and rewards

StreamBullets has its own polls. It does not read the native polls, predictions, or rewards of a provider, and it asks for no permission for them.

| Provider | Feature | How the provider offers it | StreamBullets reads it |
| --- | --- | --- | --- |
| Twitch | Polls | EventSub `channel.poll.begin`, `.progress`, `.end` with `channel:read:polls` | No |
| Twitch | Predictions | EventSub `channel.prediction.begin`, `.progress`, `.lock`, `.end` with `channel:read:predictions` | No |
| Twitch | Channel Points rewards | EventSub `channel.channel_points_custom_reward_redemption.add` and `.update` with `channel:read:redemptions` | No |
| Twitch | Hype Train | EventSub `channel.hype_train.begin`, `.progress`, `.end` with `channel:read:hype_train` | No |
| YouTube | Live polls | Live chat message of the type `pollEvent` | No |
| YouTube | Predictions and rewards | The documentation of the API names none | No |
| Kick | Polls and predictions | The Kick documentation names no event | No |
| Kick | Channel rewards | Webhook `channel.reward.redemption.updated` | No |

### Rules for consumers

- Show `text`, `user.displayName`, and badge labels as text. Never insert them as HTML.
- Load an emote image only from a URL that the parser accepted. The accepted hosts are in `EMOTE_HOSTS`.
- Use `user.color` only as a CSS color value. The parser accepts only `#rrggbb`.
- Remove a message from the screen when a `delete`, `ban`, `clear`, or `clear_user` event names it.
- When the socket closes, wait and connect again. Start with a wait of 1 second.
- Double the wait after each failed try, up to 60 seconds. Add a random part (jitter).
- Reset the wait after a successful connection.
- When the socket closes with the code `4403`, do not connect again. The key never works again.

### Overlay chat

The merged chat on the overlay is a consumer of this feed. It follows the rules above.
It opens an activity socket only while an enabled chat layer shows on the page.
See [Overlay composition and merged chat](overlay-composition.md) for its limits and its quota effect.

### Interactive characters

The character playground is also a consumer of this feed. Its sockets ask for frames with `characters=1`.
The `ChannelIngest` object tags these sockets `characters`. Each one counts as a consumer, like a chat socket.
Thus an open characters source keeps the YouTube poll alive, and each poll costs YouTube quota.

The playground runs only while at least one characters socket is open. See [Interactive characters](characters.md).

## Channel health in Streamer tools

The **Channels** section of **Streamer tools** shows the health of each platform while the page is open.
The page says a change of health in each of its sections.
The page gets the first list from its loader. It then reads `GET /api/channels` every 20 seconds.
It reads only while the tab is visible.
It reads at once when the tab shows again or when the browser is online again.

The read uses no account quota and no address limit. A failed read keeps the last list.
After 3 failed reads in a row, the panel shows a short line. The next successful read removes the line.
A failed read causes no toast.

The cards of the platforms always show. The section has no disclosure around them.
The heading of the section has the ID `channels-title`. The links with the text **Connect channels** in the **Overlay** section go to it.

The cards are in one row and have the same height. On a narrow screen the row wraps. A phone shows one column.

A connected card has three lines:

1. The platform pill is at the left. The status icon and the account name are at the right.
2. **Reconnect** and **Disconnect** fill the line in two equal columns. They look the same on each card.
   The accessible name of each button also has the name of the platform: **Reconnect Twitch**, for example.
3. A closed `details` element at the bottom of the card gives the data that the feed reads and the limits.

A card without a connection has the platform pill and the **Connect** button on one line. The closed `details` element is below them.
The `details` element of a YouTube card without a connection also has the sentence about the YouTube Terms of Service.
A card of a platform that the site does not offer says so. It has no **Connect** button and no `details` element.

The status of a connected card is an icon. The card shows no line of text for it.
The icon has a tooltip (`title`). Text that only a screen reader reads gives the same words.

The quality gate refuses `role="img"` on an element that is not an `img` element. Thus the icon does not use that role.
The table gives the icons and their words:

| Icon | Condition | Words |
| --- | --- | --- |
| `success` | The status is `active`, and the connection reads support events. | "Healthy" and the age of the last chat event |
| `sync` | The connection has the `error` status with the code `quota_exhausted` or `webhooks_rejected`. This problem ends without the owner. | The problem |
| `rejected` | The connection has a different problem. The owner must reconnect. | The problem and the fix |
| `rejected` | The status is `active`, and the connection reads no support events. | The words that ask the owner to reconnect one time |

The `sync` icon turns. It does not turn when the system or the display settings of the site ask for reduced motion.
A card without a connection has no icon. A connection of a platform that the site does not offer has no icon.

The tooltip of a healthy card gives the age of the last chat event, for example "Healthy. Last chat event 2 minutes ago."
The age changes at most one time in 15 seconds. It shows after the page has the clock of the browser.

`channelCardState` in `app/lib/channel-health.ts` gives the icon of a card.
`channelHealth` in the same file gives the health for the messages of the page and for **Live**.
A connection that reads no support events is healthy for `channelHealth`. Only its card shows that state.

When the list shows a change of health, the page tells the owner one time:

- A healthy platform gets a problem: a toast and the live region name the platform and the problem.
- A platform works again: a toast and the live region say that its chat is back.

The first list causes no message. An unchanged state causes no message.
The `quota_exhausted` status causes one message, at its start. The card shows this status until the next quota day.

The overlay page never shows the channel health, because viewers see that page.

The chat layer settings use the same list for their warning.
See [Settings of the selected layer](overlay-composition.md#settings-of-the-selected-layer).

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
A closed `details` element at the bottom of each card tells when chat starts for that platform.
It also lists the data that the feed reads for chat and for alerts and goals, the limits, and the gaps.

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

Support events have optional scopes. The server asks for them at each connect and each reconnect:

| Platform | Optional scopes | Notes |
| --- | --- | --- |
| Twitch | `moderator:read:followers`, `channel:read:subscriptions`, `bits:read` | Read-only scopes for follows, subscriptions, gifts, and Bits. A raid needs no scope. |
| YouTube | None | The support events are messages of the chat that `youtube.readonly` reads. |
| Kick | None | The Kick documentation names only `events:subscribe` for webhook events. |

The rule of the callback does not change for the optional scopes. An authorization without them connects the channel for chat.
The result is then `support_denied`, and the connection reads no support events.

The server stores the scopes of each authorization in the `scopes` field of the connection.
The callback compares them with the optional scopes and sets the `support_events` field.
`GET /api/channels` gives only the `support` value. It never names the scopes that a connection has.

For a connection that reads support events, the feed also uses these provider subscriptions:

- Twitch: `channel.follow` (version 2), and `channel.subscribe`, `channel.subscription.gift`, `channel.subscription.message`, `channel.cheer`, and `channel.raid` (version 1).
- Kick: `channel.followed`, `channel.subscription.new`, `channel.subscription.renewal`, `channel.subscription.gifts`, and `kicks.gifted` (version 1).
- YouTube: no subscription and no more calls.

## Scheduled streams

The schedule of a page shows the scheduled streams of its connected Twitch and YouTube channels.
The code is in `app/server/schedule-import.server.ts`.

| Platform | Source | Access |
| --- | --- | --- |
| Twitch | `GET https://api.twitch.tv/helix/schedule` | The app token. The endpoint needs no scope. |
| YouTube | `liveBroadcasts.list` with `broadcastStatus=upcoming` | The token of the channel, with the `youtube.readonly` scope. 1 quota unit for each page. |
| Kick | The public API has no schedule endpoint | Kick streams stay manual. |

The `ChannelIngest` object of the page reads the platform (`POST /upcoming`).
Thus only the object refreshes tokens, and a YouTube read spends the quota of the page.

These rules apply to a read:

- The read covers 4 weeks. Twitch gives at most 4 pages of 25 segments. YouTube gives at most 4 pages of 50 broadcasts.
- A read with more pages, or a YouTube read without quota for a page, is not complete. It changes nothing.
- The import ignores a canceled Twitch segment and a segment that starts in the vacation of the channel. It also ignores a private YouTube broadcast and a YouTube broadcast without a start time.
  It reads an unlisted YouTube broadcast: the streamer planned it, but keeps it off the channel page.
- An empty title takes the Twitch category. Without a category, it takes the channel name.
- A stream without an end gets 120 minutes. The length stays between 15 minutes and 24 hours.
- Each read stream has a row in `stream_event_sources`, with the platform and its ID.
  Thus a new read updates the entry. It does not make a second entry.
- The row also keeps the Twitch category and the address of a picture.
  For Twitch, the picture is the category cover from Get Games, 360 × 480 pixels.
  For YouTube, it is the `maxres` thumbnail, else the `medium` thumbnail.
  A custom thumbnail comes from `i9.ytimg.com`, with a signed query.
  When Get Games fails, the covers stay empty. The read continues.
- After each read, the server loads each new picture one time and keeps a copy in R2.
  The key is `schedule/<page>/<hash of the picture address>`, so streams with the same cover use one copy.
  A Twitch cover stays at its size. The Images binding makes two WebP copies of a YouTube thumbnail:
  960 × 540 for the "Up next" card, and 320 × 180 for a schedule row.
  The binding is only in the production Worker. Without it, the server does not load YouTube thumbnails.
- A failed picture does not stop the read. The server does not follow a redirect.
- The hourly job deletes a copy when no source links to its address.
  Thus a YouTube copy goes, at the latest, with its source after 30 days.
- The schedule shows the YouTube thumbnail of a stream first, else the Twitch cover.
  The category chip shows the Twitch category with its cover.
- `GET /images/stream/<event>/<platform>` serves the large copy, and `.../small` the small one.
  The device of a viewer does not contact Twitch or YouTube.
- Two streams are the same stream when their starts are at most 15 minutes apart. The titles can be different.
  A streamer runs one stream at a time. The schedule then shows one entry with the link of each platform.
- The import makes entries with `imported = 1`. An edit by the owner, or a replay link, sets `imported = 0`.
  The import changes only entries with `imported = 1`, and only from the platform that made them.
- A manual entry of the owner keeps its text. A read stream with the same start adds only a link.
- When the owner deletes an entry, its source row stays without an entry. Thus a new read does not add it again.
- When a platform no longer lists a stream, the read removes its link. This occurs only for a stream that starts
  in more than one hour, inside the 4 weeks. An entry with `imported = 1` and no other link goes too.
- A failed read changes nothing. A refused YouTube token sets `needs_reauth`.
- A full schedule takes no new entry. The next read tries again.

The import reads a page at these times:

- When the owner opens the schedule, after the response. At most one read each 10 minutes for each page.
- In the hourly `schedule_import` job. The job reads at most 25 pages in each run.
  It reads a page again after 6 hours, and takes the oldest reads first.

`schedule_imports` keeps the time of the last read of each page.

The hourly job also deletes YouTube source rows that no read found for 30 days.
It deletes the imported entries that only these rows held. Twitch rows stay with their entry.
An entry with a YouTube link and a Twitch row takes the Twitch link.
A row without an entry goes after the same 30 days.

The test deployment reads no platform. It uses the synthetic streams of `testStreams`.

## Limits and retention

| Item | Limit |
| --- | --- |
| Webhook body | 64 KiB |
| Webhook age | 10 minutes before or after the server time |
| Events in one delivery | 50, of any kind |
| Chat admission per page | 50 chat messages each second, burst of 200. Only new chat messages cost a token. |
| Moderation admission per page | 20 deletions, bans, timeouts, and clears each second, burst of 200, in a separate bucket. Thus a chat flood never holds moderation back. |
| Support admission per page | 10 support events each second, burst of 100, in a separate bucket. Only new support events cost a token. Thus a flood of follows never holds moderation back. |
| Dropped events | The object drops what its buckets refuse. It counts the drops in the `channel_ingest_dropped` log (`chat`, `moderation`, `support`). |
| Snapshot | The last 100 chat messages, for at most 10 minutes |
| Support snapshot | The last 50 support events, for at most 10 minutes |
| Support events | One event for each delivery ID. The object refuses a known ID for 15 minutes. |
| Alert on stream | One alert at a time, for 6 seconds |
| Line of alerts | At most 100 alerts that wait: the alerts of 10 minutes. The object drops a new alert while the line is full. |
| Replay of an alert | Only for a support event in the support snapshot: the newest 50, for at most 10 minutes |
| Saved layers in the alert host | The host reads them again at the first alarm or new socket after 60 seconds, while a page listens or the goal counts. It also reads them 60 seconds after a read that an event used |
| Support event IDs for the goal and the alerts | The newest 2,000, with no time limit |
| People of a goal for chatters | At most 100,000. The count stops there. |
| Delivery IDs, message IDs, ban keys, and support event IDs for deduplication | 15 minutes, at most 97,000 IDs |
| IDs of deleted messages | 15 minutes, at most 97,000 IDs, in a separate table |
| Kick message IDs that a Worker isolate forwarded | The last 10,000 |
| Connection data in the Worker and in the object | The cache keeps it for 30 seconds |
| Live window | A chat message is live only if the platform sent it at most 30 seconds before it arrived |
| Chat text | 500 characters, without control and format characters |
| Badges | 16 for each message |
| Fragments | 64 for each message |
| Activity sockets per page | 20 |
| Authorization state | 10 minutes, single use |
| YouTube poll interval | The larger of `pollingIntervalMillis` and the floor: 10 seconds, or 20 seconds after an empty page or with a low budget |
| YouTube check for a live broadcast | Every minute for 30 minutes after the first consumer connects, then every 10 minutes, while the channel is not live |
| YouTube backoff | 1 second up to 5 minutes, with jitter |
| YouTube quota | 9,000 units each quota day for all pages together, and 9,000 units for each page |
| `last_event_at` writes | One each 30 seconds for each channel |
| Subscription check while a consumer listens | At most one each 10 minutes for each channel |
| Subscription checks of the hourly job | 25 channels in one run |
| Repair backoff | 1 second up to 5 minutes, with jitter |
| Webhook health writes | One each minute for each key and Worker isolate |
| Watchdog report | At most one each hour for each channel |

The object keeps the snapshot and the IDs in its own SQLite storage. A snapshot never holds a message or a support
event older than 10 minutes. An alarm also deletes expired messages, support events, and IDs from storage. To limit wakeups, the alarm runs at most
once each minute. Thus storage can keep an expired item for up to one more minute.
A deletion, ban, timeout, or clear removes the matching messages before the object sends the next event or snapshot.

The ID limit covers the webhook freshness window at the admission limits. In 10 minutes the object admits at
most C = 50 × 600 + 200 = 30,200 chat messages and M = 20 × 600 + 200 = 12,200 moderation events.
It also admits at most S = 10 × 600 + 100 = 6,100 support events.

The object keeps the ID of every delivery with at least one admitted event. It also keeps the ID of every
admitted chat message, a content key for every admitted ban, and the ID of every admitted support event.
Thus the IDs of 10 minutes fit in 2C + 2M + 2S = 97,000.
The object always finds a provider retry inside the 10-minute window.

The alert host keeps these items in the same storage:

- The muted state, the alert on stream, and the number of tests and replays. They stay until the owner deletes the account.
- The line: one row for each alert that waits. A row has the view and the user ID of the supporter.
  The row goes when the alert starts. An alert waits for 10 minutes at most, because the line holds 100 alerts of 6 seconds each.
  The mute, a disconnect of the platform, and an alarm without an open socket also remove the rows.
- The copy of the layer settings. It has no personal data.
- The `id` of the newest 2,000 support events. An `id` is the platform and the delivery ID. It has no user ID.
- The count of the goal: `counts`, `value`, `startedAt`, and a random salt.
- For a goal that counts chatters: one key for each person that the goal counted, at most 100,000.
  A key is a part of the SHA-256 hash of the salt, the platform, and the user ID. The storage has no user ID of a chatter.
  A new count has a new salt, and the host removes the keys of the count before.

A support event has no moderation. Thus the support snapshot needs no boundary such as `since`.
A disconnect removes the support events of its platform from the snapshot.
The object keeps no ID of a support event that it dropped for a connection that reads no support events.

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

YouTube polls run only while a consumer listens. A consumer is an open activity socket of the page.
Chat sources, characters sources, and composition sources open one. The editor preview opens one with the characters layer on.
Thus a page that has no open overlay uses no quota.

The object also ingests the first page after a connect or a reconnect. The messages on it that YouTube got more
than 30 seconds before are not live, so no old command runs. A poll never runs before its stored time.
A new consumer, a cleanup alarm, or a reconnect cannot skip a backoff, the polling interval, or a quota wait.

The default Google quota is 10,000 units each day for the Google project. `liveChatMessages.list` costs 5 units.
`liveBroadcasts.list` costs 1 unit. Google resets the quota at midnight Pacific Time. The quota day of the feed
follows this reset, also across summer time.

| Case | Units |
| --- | --- |
| One live page at the 10-second floor | 1,800 each hour (6 polls each minute × 5 units × 60) |
| One live page at the 20-second floor | 900 each hour |
| One open overlay, channel not live | 6 each hour, and a maximum of 30 in the first 30 minutes |
| Schedule reads of one page | 1 for each read: at most 4 each day from the hourly job, and 1 for each 10 minutes of owner visits |
| Budget for one page | 9,000 each day: about 5 hours of live chat at the floor |
| Budget for all pages | 9,000 each day: about 5 hours of live chat at the floor |

YouTube can ask for a longer interval with `pollingIntervalMillis`. Then a page uses fewer units.
The [load model](live-room-capacity.md#load-model) compares this quota with one million registered streamers.

Support events use no quota. The object reads them from each chat page that it reads for chat.
It makes the same calls for a connection that reads support events and for a connection that does not.
For a connection that reads them, the first page after a connect can hold support events from before the consumer connected.
The object sends each of them one time, as a live event with `replay: false`.

Each of them has its publish time in `sentAt`. Thus a consumer can refuse an old event.

The floor is 20 seconds after a page without items. It is 10 seconds again after a page with items.
The floor is also 20 seconds after the feed spends 80% of the page budget or of the shared budget.
The 20-second floor is below the 30-second live window. Thus a message that waits one interval is still live.

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
The encrypted overlay key of a page has the same rule: it gets the new key when the owner regenerates the link.
After you remove the old key, an overlay link from before the rotation still works, but the owner cannot see it again.
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
4. The object removes the messages and the support events of that platform from the snapshot. It stops the YouTube poll.
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

For a connection that reads support events, a connect also makes the subscriptions of the support events, after the chat subscriptions.
A Twitch `channel.raid` subscription names the channel in `to_broadcaster_user_id`. The list filter and the webhook accept this field.
If the provider refuses a subscription of a support event, the connect does not fail. The object sets `support_events` to off for the connection.
See [Support events of each provider](#support-events-of-each-provider).

### Subscription repair

The object repairs Twitch and Kick subscriptions without the owner. A check reads the list of the provider for
the channel. It deletes each subscription that the provider reports as ended. It creates each required type that
has no enabled or pending subscription. It never changes an enabled or pending subscription of a required type.
Thus a check of a healthy channel changes nothing.

The required types follow the `support_events` field of the connection. With the field on, a check also requires the types of the support events.
With the field off, a check deletes each subscription of a support event. It keeps the chat subscriptions.

Twitch reports a status for each subscription. `enabled` is healthy. `webhook_callback_verification_pending`
waits for the callback check. Every other status means that the subscription ended. The Twitch check uses only
the app token.

Kick reports no status. Kick removes a subscription when its webhook fails for more than a day. Thus a missing
event in the list is the only sign. The Kick check needs the token of the broadcaster. The object refreshes that
token first. The check creates only the missing events.

A check runs at these times:

- When a consumer starts to listen, and at most once each 10 minutes while one listens.
- Each hour from the `channel_repair` job, for at most 25 channels in one run. Each run starts at another
  channel. A failed channel does not stop the job.
- After a Twitch revocation that the app can repair.

A check never runs for a connection with `needs_reauth`, for a suspended page, or while `CHANNELS_OFF` exists.
It also never runs for a platform without provider credentials.
A connect makes every subscription. Thus the first check after a connect waits 10 minutes.

The check sets the status that its result proves. If the provider reports each required type as `enabled` or pending, the connection
becomes `active`. If the provider refuses a missing type, the connection gets `error` with `subscribe_failed`.
An `error` that already has a code keeps that code. A list that the object cannot read changes no status.

A refused Kick refresh sets `needs_reauth`. A Twitch 403 for a new chat subscription also sets `needs_reauth`.
A refusal for a subscription of a support event sets no status. The check sets `support_events` to off for the connection.

A failed check runs again with backoff, from 1 second up to 5 minutes, with jitter. Without a consumer, the
object stops at the longest backoff. The hourly job then tries the channel again.

A Twitch revocation with `notification_failures_exceeded` or `version_removed` sets `error`. The object also
schedules a check with the same backoff. A revocation with an unknown status gets the same repair. A revocation
with `authorization_revoked` or `user_removed` sets `needs_reauth`. Only the owner can give that access back.

The feed subscribes to current versions. Thus a new subscription can replace one with a removed version.

The Worker checks no header format before the signature of a Twitch message. A signed revocation needs no
message ID. Thus an unusual ID can never refuse a revocation. Only a notification needs a valid ID, because the
ID is the delivery ID.

An accepted, signed Twitch or Kick delivery proves that the channel works. It changes `error` back to `active`
and sends the new status to the consumers. It never changes `needs_reauth`.

### Refused webhooks

The Worker counts each webhook that it refuses for a bad signature or a bad payload. It writes the count to D1
at most once a minute for each key and isolate. A refusal before the signature check counts for the platform
only, because the sender is unknown. A signed Twitch delivery with a bad body or a bad message ID counts for its
channel. The Worker also records when a platform last accepted a delivery.

The object reads these counts during a check for a listening consumer. It reports a channel only when all of
these conditions are true:

- A consumer listened for 10 minutes, and the channel accepted no delivery in that time.
- At least 3 sampled refusals arrived, each less than 10 minutes after the one before.
- The refusals are for this channel. Or the platform accepted no delivery for any channel in the last
  10 minutes.
- The object did not report this channel in the last hour.

The object then writes one `channel_webhooks_all_rejected` warning. The warning holds only the platform. The
object sets `error` with `webhooks_rejected`. The usual check follows. While the provider list is healthy, later
checks keep this code and change no subscription. An accepted delivery ends the code.

A sender that does not have the key of the provider cannot name a channel in these counts. Forged deliveries cannot change a
channel that accepts deliveries. They cannot change any channel while the platform accepts deliveries for other
channels. They never cause a delete or a create at the provider. See the residual risks for the case that stays.

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

The callback revokes a YouTube token only if the row still holds the tokens of this callback.

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
| `channel_status_changed` with `code: delivery_failed` | Twitch stopped a subscription after failed deliveries. The object makes the subscription again. | Page when no `channel_subscriptions_repaired` follows in 10 minutes. |
| `channel_webhooks_all_rejected` | A channel with an open overlay accepted nothing for 10 minutes while the Worker refused webhooks (`platform`). The object writes it at most once an hour for each channel. | Page when it occurs. Look at `channel_webhook_rejected` for the reason. |
| `channel_subscriptions_repaired` | A check deleted or created a provider subscription (`platform`) | Information only. Alert when it repeats each 10 minutes: the callback fails its verification. |
| `channel_reconcile_failed` | A provider call of a subscription check failed (`platform`). The object tries again with backoff. | Alert when it repeats for 15 minutes |
| `channel_repair_run` | The hourly job counts its results (`ok`, `repaired`, `failed`, `reauth`, `recent`, `skipped`). It writes the log only when a count other than `ok`, `recent`, and `skipped` is not zero. | Alert on `failed` that repeats |
| `channel_repair_failed` | The hourly job cannot reach an object, or a check in the object failed before the provider call. The log holds the error class. | Alert when it repeats |
| `channel_webhook_health_failed` | The Worker cannot write a webhook health count to D1. The log holds the error class. | Alert when it repeats |
| `channel_status_changed` | A connection is not active, with its code | Look at the `authorization_revoked` counts each day |
| `channel_connect_failed` | The object cannot make the subscriptions | Alert when it repeats |
| `channel_ingest_dropped` | The object dropped chat, moderation, or support events over the admission limit (`chat`, `moderation`, `support`) | Information only |
| `channel_support_refused` | A provider refused a subscription of a support event (`platform`). The object set `support_events` to off for the connection. Chat continues, and the card asks the owner to reconnect. | Alert when it repeats for many channels: a changed permission of the provider. |
| `channel_callback_failed`, `channel_connect_cleanup_failed`, `channel_disconnect_failed`, `channel_cleanup_failed` | A step failed. The log holds the error class. | Alert when it repeats |
| `activity_notify_failed` | A key or suspension notice did not reach the object | Alert when it repeats |
| `schedule_read_failed` | A schedule read of a platform failed (`platform`). The read changes nothing. The log holds the error class. | Alert when it repeats for a day |
| `schedule_import_failed` | The schedule import of a page failed. The log holds the error class. | Alert when it repeats |

## Overlay key

The activity socket accepts only a current overlay key of the page or the signed-in owner.
Each output of the overlay has its own key. See [Outputs](overlay-composition.md#outputs).

The key gives read access to the live room and the activity feed. It gives no access to the account,
to channel management, or to provider tokens. A new overlay key closes the sockets that used the old key.
The overlay page sends no `Referer`.

The server compares a key with the stored SHA-256 of the key.
The server also keeps the key in encrypted form, so the owner can see the overlay link again.
The encryption uses the first key of `CHANNEL_TOKEN_KEYS` and applies only to the page of the key.
A deployment without `CHANNEL_TOKEN_KEYS` does not keep the key. The owner then sees the link only one time.
`POST /api/overlay/key/show` gives the link to the signed-in owner and writes an audit record.

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
  with `reason: ingest` (failures of the ingest object or D1). The object makes the subscription again. The
  owner does not need to reconnect.
- `channel_webhooks_all_rejected`: the Worker refuses the webhooks of a platform. Read the `reason` of
  `channel_webhook_rejected`. For `signature`, compare `TWITCH_EVENTSUB_SECRET` with the secret of the
  subscriptions. For `payload`, look for a change in the provider payload. After a fix, the status clears with
  the next accepted delivery.
- A connection stays in `error` with `subscribe_failed`: the provider refuses the list or a new subscription.
  Look at `channel_reconcile_failed` and at the provider status. The hourly job tries again.
- D1 restore: before the restore, set `CHANNELS_OFF`. The hourly `youtube_expiry` job skips while this secret
  exists. Otherwise the job can remove YouTube connections whose restored data looks old.
- After the restore, expect a wave of `needs_reauth`. Restored rows can hold tokens that the providers already
  replaced. Next, `channel_webhook_unknown_channel` can show: the restore can bring back a state without some
  connections. Twitch gets 410 for those channels. It revokes their subscriptions after repeated failures. Ask
  the owners of those channels to reconnect. No check repairs a channel that has no connection.
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
| Redirect abuse | The callback goes only to the fixed path `/tools?view=channels` with a short result code. It sends no code, state, or token in the URL. |
| Stolen session cookie | Connect, reconnect, and disconnect need a sign-in from the last 10 minutes (`reauth_required`). |
| Cross-streamer access | Every operation uses the own page of the viewer. Each page has its own `ChannelIngest` object. Webhooks go to the page that owns the channel. |
| Forged webhook | Twitch: HMAC-SHA256 with a constant-time comparison. Kick: RSA PKCS#1 v1.5 SHA-256 with the public key of Kick. The check runs on the raw body before parsing. |
| Replayed webhook | A timestamp window of 10 minutes, and deduplication of delivery IDs and message IDs for 15 minutes. |
| Oversized webhook | A 64 KiB body limit. The Worker checks it while the body streams. |
| Burst or denial of service | Each page has three token buckets: one for chat, one for moderation, and one for support events. They drop the excess before any database read. Each delivery holds at most 50 events. Each queue, snapshot, and socket list has a limit. Signed webhooks skip the per-address limit, because providers send from shared addresses. Only failures from a sender without the provider key count against that limit. These failures are a bad signature, size, method, query, or a missing body. A stale or unparsable signed delivery never counts. A forged call still costs a body read and a signature check. |
| Replayed moderation | Kick signs the webhooks of all apps with one key. Thus a captured signed ban can come again. The object keeps every accepted delivery ID and limits moderation with its own bucket. |
| Orphaned Twitch subscription | A signed notification for an unknown channel gets a non-2xx answer (410). Twitch counts it as a failed delivery. It revokes the subscription after repeated failures (`notification_failures_exceeded`). Revocations always get 204. The Worker keeps an unknown channel for 10 seconds. |
| Sign-in token with channel scopes | Google sign-in does not ask for incremental authorization (`include_granted_scopes`). The YouTube connection does not ask for it too. Thus a sign-in token never carries the YouTube scope. |
| XSS by chat | The contract keeps text as text. The server removes control characters and limits lengths. Emote URLs come from emote IDs on allowed hosts only. Consumers must show text without HTML. |
| Token leakage | D1 holds the tokens only in encrypted form. They are never in a response, a URL, browser storage, or a log. Logs hold only error classes and status codes. |
| Revoked access | A refused token, or a Twitch revocation of the authorization, changes the status to `needs_reauth`. Ingestion for that channel stops. No check repairs it. |
| Forged webhooks against the repair | A refusal names a channel only after a valid signature. An accepted delivery in the last 10 minutes stops the watchdog for its channel. Accepted deliveries for other channels stop it for the platform. A check deletes only what the provider reports as ended. Each channel gets at most one check in 10 minutes and one report in an hour. |
| Quota exhaustion | A shared daily budget and a budget for each page. Polls run only while a consumer listens. A stored next poll time, and backoff on errors. |
| Replay of old commands | The live window: a message that the platform sent more than 30 seconds before it arrived is not live. Snapshot messages are never live. |
| Suspended page | The object drops deliveries, stops polling, and closes the activity sockets. |
| Leaked overlay key | The owner makes a new key for that output. The old key stops at once for the live room and the activity feed. |

### Residual risks

- The overlay key is a bearer secret in the OBS URL. A person who has the URL can read the feed until the owner makes a new key.
- A forged webhook costs a body read and a signature check before the per-address limit applies. The Worker logs refused webhooks at most once a minute for each platform (`channel_webhook_rejected`).
- A forged webhook also costs one D1 write a minute for each platform and isolate.
- Forged webhooks can set `webhooks_rejected` on a quiet channel with an open overlay. This needs 10 minutes in which the platform accepts no delivery for any channel. It changes no subscription. The next accepted delivery clears the status.
- The `Twitch-Eventsub-Message-Type` header is not part of the Twitch signature. Thus the Worker trusts it only together with a signed body.
- All pages share the YouTube quota. The budget for each page limits one page. But three busy pages can still use up the shared budget.
- Account deletion waits at most 5 seconds for each provider. If a provider is down, its subscription or grant can stay. The Worker drops the later webhooks because no connection matches them.
- We did not check that a revoked Twitch user token also ends the EventSub access of the app. The disconnect also deletes the subscriptions.
- Some moderation events are not in the provider feeds, such as a Kick message deletion. After such an event, the snapshot can hold the message for up to 10 minutes.
- Display names and chat text can still hold offensive content. The feed does not filter content.
- Kick signs the webhooks of all apps with one key. Thus a person with a different Kick app can send a signed copy of a real Kick support event.
  The ID of a Kick support event is from its content, so the copy makes the same event and counts one time.
  A Kick support event without `created_at` has only its message ID. A copy of such an event makes a second support event.
  The copy cannot change the content of the event, and it counts only for a connection that reads support events.
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
- A reconnect after the read sets a new data time. The job then keeps the row, also when the read found the
  access revoked.
- Until 32 days, the job never removes data that it did not try to read in this run. Past 32 days, it removes
  the connection without a read (`stale_backstop`).
- The job also removes a connection that needs a new authorization for more than 7 days.
- For each removal, the job first runs the disconnect steps, best effort and limited to 5 seconds. The tokens go
  with the row. The job writes an audit row (`channel_expired`, no actor) and a `channel_youtube_expired` log.
- The job also finishes a disconnect, on any platform, that stopped more than an hour ago (`reason: stuck`).

Scheduled streams read from YouTube follow the same 30-day rule. See [Scheduled streams](#scheduled-streams).

The connection has two times. `data_read_at` is when the server last read the channel data from YouTube. The
30-day rule uses it. `updated_at` is when the status or its code last changed, or when a disconnect marked the
row. The 7-day rule uses it.

A disconnect that marks a row now sets `updated_at`. Thus the job cannot take that
row at the same time.

The terms of service and the controls tell owners that a YouTube connection binds them to the YouTube Terms of
Service. The privacy policy links the Google Privacy Policy and the Google security settings.

## Research for Instagram, Facebook Live, and TikTok

This section records what the official documentation of each provider says about live comments.
It is the research step of #1038, #1039, and #1040. No code reads these providers.
We read the documentation on November 26, 2026.

Each row has one of these states:

- **Confirmed**: we read the full official page, and the page says it.
- **Excerpt**: we read only a search excerpt of the official page.
- **Not confirmed**: the official documentation does not say it, or the page did not open.

The feed uses official APIs only. It does not scrape a page, and it uses no unofficial connector.

### Instagram

Meta has an official API for the comments of a live broadcast. It serves professional accounts only.

| Subject | Result | State | Source |
| --- | --- | --- | --- |
| Push | The webhook field `live_comments` sends each comment of a live broadcast. | Confirmed | [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) |
| Pull | `GET /{ig-user-id}/live_media` with the field `comments`. It gives only a broadcast that is live at that time. | Confirmed | [IG User live media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/live_media) |
| Account types | Professional accounts (business or creator). The documentation has no path for a personal account. | Confirmed | [Overview](https://developers.facebook.com/documentation/instagram-platform/overview) |
| Account visibility | The account must be public. A private account gets no comment notification. | Confirmed | [Webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup) |
| Permissions for the webhook, Instagram Login | `instagram_business_basic` and `instagram_business_manage_comments` | Confirmed | [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) |
| Permissions for the webhook, Facebook Login | `instagram_basic`, `instagram_manage_comments`, `pages_manage_metadata`, `pages_read_engagement`, and `pages_show_list`. The account needs a linked Facebook Page. | Confirmed | [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) |
| Permissions for the pull | `instagram_basic` and `pages_read_engagement`, with Facebook Login. The page names no other login. | Confirmed | [IG User live media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/live_media) |
| App review | `live_comments` needs a published app and Advanced Access. Advanced Access needs App Review and Business Verification. | Confirmed | [Webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup) |
| What App Review needs | A working app that Meta can test, and a screen recording for each permission. A permission without a recording gets no approval. | Confirmed | [App Review](https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction) |
| Comment data | The Instagram-scoped ID and the username of the person, the comment ID, the text, and the media ID. | Confirmed | [Webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples) |
| End of the broadcast | The notifications stop when the broadcast ends. Meta sends no notification from before the subscription. | Confirmed | [Webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup) |
| Rate limit | 4,800 calls for each impression of the account in 24 hours, for each app and account. | Confirmed | [Overview](https://developers.facebook.com/documentation/instagram-platform/overview) |
| Limits of the pull | 50 comments for each query, and no filter by time. | Confirmed | [IG Media comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments) |
| Reactions, viewer count, and joins | No official page names them. | Not confirmed | None |
| Stream key for OBS | Live Producer gives a stream key on instagram.com. The page is from 2022 and says that Instagram limits the access. The key changes for each broadcast. | Confirmed | [Live Producer](https://about.instagram.com/blog/tips-and-tricks/instagram-live-producer) |

The documentation does not answer these questions:

- If the pull works with a token of Instagram Login. The page names only Facebook Login.
- If Standard Access is enough for the account of the app owner. The overview says yes, and the webhook setup says that Advanced Access is necessary.
- If `live_comments` covers a broadcast that starts in Live Producer.
- Who gets Live Producer today.

Result for #1038: the connection is possible with the webhook `live_comments`.
App Review comes after the code, not before it. Meta tests a working app and follows a screen recording for each permission.
The work has this sequence:

1. The owner makes the Meta app and starts Business Verification.
2. Development and test use an account that has a role on the app.
3. The owner sends the working app to App Review.
4. Meta approves the app. Only then can the connection release to other streamers.

### Facebook Live

Meta has an official API for the comments and the reactions of a live video.
Meta removed parts of its reference, so some facts have no current official source.

| Subject | Result | State | Source |
| --- | --- | --- | --- |
| Pull | `GET /{live-video-id}/comments` and `GET /{live-video-id}/reactions`. Meta says to poll them each few seconds. | Confirmed | [Interact with viewers](https://developers.facebook.com/documentation/live-video-api/interact-with-viewers) |
| Push | Server-Sent Events from `streaming-graph.facebook.com`: `/{live-video-id}/live_comments` and `/{live-video-id}/live_reactions`. | Confirmed | [Interact with viewers](https://developers.facebook.com/documentation/live-video-api/interact-with-viewers) |
| Reference of the push | The pages for the parameters and the limits of Server-Sent Events open the start page of the Live Video API. | Not confirmed | None |
| App review | The API needs App Review for its feature and for each permission. | Confirmed | [API for live video](https://developers.facebook.com/documentation/live-video-api) |
| Permissions that the page names | `publish_video` for a profile. `pages_manage_posts` and `pages_read_engagement` for a Page. The page lists them for publishing. | Confirmed | [Live Video API](https://developers.facebook.com/documentation/live-video-api) |
| Permissions to read comments | The same permissions as for the video. The reference of the live video gives a 404 error. | Not confirmed | [Comments](https://developers.facebook.com/docs/graph-api/reference/v27.0/object/comments) |
| Profiles | Meta holds back the identity and the comments of other people on the content of a profile, unless those people authorize the app. | Confirmed | [Comments](https://developers.facebook.com/docs/graph-api/reference/v27.0/object/comments) |
| Groups | In version 19.0, Meta removed the permissions for groups. No current page says that an app can read the comments of a live video in a group. | Not confirmed | None |
| Identity of the person | The examples show `from` with a name and an ID. The current field table of a comment does not list `from`. | Not confirmed | [Comment](https://developers.facebook.com/docs/graph-api/reference/comment/) |
| Quality filter | A live video filters low-quality comments by default (`live_filter`). | Confirmed | [Live video comments](https://developers.facebook.com/docs/graph-api/reference/live-video/comments) |
| Reactions | The reaction types, and a total count in `summary`. | Confirmed | [Live video reactions](https://developers.facebook.com/docs/graph-api/reference/live-video/reactions) |
| The ID of a live video that a different tool started | The reference index lists the edges `live_videos`. The pages of those edges say that an app cannot read them. | Not confirmed | [Reference](https://developers.facebook.com/documentation/live-video-api/reference) |
| Rate limit | 200 calls for each user in one hour for an app, and 4,800 calls for each engaged user in 24 hours for a Page. No page says which one applies to live comments. | Excerpt | [Rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) |
| Stream key for OBS | Each live video has a stream URL. The URL expires 24 hours after its creation, and a stream can use it for 8 hours. | Confirmed | [Overview](https://developers.facebook.com/documentation/live-video-api/overview) |
| Who can go live | The account is 60 days old or older. A Page or a profile in professional mode has 100 followers or more. | Confirmed | [Live Video API](https://developers.facebook.com/documentation/live-video-api) |

The documentation does not answer these questions:

- Which token and which permission read the comments of a Page live video and of a profile live video.
- If Meta sends `from`, and for which token.
- If Meta still maintains Server-Sent Events. The last entry of the changelog is from September 14, 2021.
- How an app finds the ID of a live video that OBS started with a stream key.
- If Business Verification is necessary for the Pages of other people.

Result for #1040: the connection is possible for a Page. The documentation does not confirm a profile or a group.
A test with a Page of the owner must answer the open questions first.
App Review comes after the code, as for Instagram. Meta must approve the app before the release to other streamers.
Only the owner can make the Meta app and start the App Review.

### TikTok

We found no official API that reads TikTok LIVE chat, gifts, or events.
The pages of `developers.tiktok.com` and `www.tiktok.com` did not open in the environment of this research.
Thus each row is from a search excerpt, and the research does not prove that no such API exists.

| Subject | Result | State | Source |
| --- | --- | --- | --- |
| Developer products | Share Kit, Login Kit, Content Posting API, Research API, Display API, Embed Videos, Data Portability API, Green Screen Kit, and Commercial Content API. None is for LIVE. | Excerpt | [TikTok for Developers](https://developers.tiktok.com/doc/oauth-user-access-token-management) |
| An API, a scope, or a partner program for LIVE chat | None found. | Not confirmed | [TikTok for Developers](https://developers.tiktok.com/) |
| Webhooks | The events that we saw are for the Content Posting API. None is for LIVE. | Excerpt | [Content Posting API](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status) |
| Data Portability API | It exports the LIVE history of a user, with the LIVE comments, as an archive. It is not a live feed. | Excerpt | [Data types](https://developers.tiktok.com/doc/data-portability-data-types) |
| Terms of Service, global | They forbid automated scripts that collect information from the service. | Excerpt | [Terms of Service](https://www.tiktok.com/legal/page/global/terms-of-service/en) |
| Terms of Service, United States | They forbid automated extraction of data without written approval. | Excerpt | [Terms of Service](https://www.tiktok.com/legal/page/us/terms-of-service/en) |
| Stream key for OBS | No official text about who gets a server URL and a stream key. | Not confirmed | None |

Result for #1039: no official connection is possible today.
An unofficial connector reads LIVE chat without an API, and the terms forbid that without written approval.
The feed has no such connector unless the owner decides it in writing.
Read the TikTok pages for developers again before that decision, from a network that can open them.

### Decisions for the owner

- **Instagram:** make the Meta app and start Business Verification, so that the development can start. Or keep #1038 open.
- **Facebook Live:** make the Meta app and give a Page for the test, so that the development can start. Or keep #1040 open.
- **App Review:** send each working connection to App Review before its release.
- **TikTok:** keep #1039 open until TikTok has an official API, or decide in writing to use an unofficial connector.
- Privacy and Terms must describe each new source of data before its release.

## Facts not checked

The provider documentation does not give these details, or we did not test them with live traffic:

- The format of the Kick `Kick-Event-Message-Timestamp` header. The Worker accepts RFC 3339 and Unix seconds.
- A host for Kick emote images. The feed shows Kick emotes as their names.
- The place in the Kick developer settings where you set the webhook URL.
- The exact meaning of the YouTube `tombstone` type (see note 1).
- The guide from Google for web server apps does not list PKCE. Google accepts it in the current sign-in flow.
- If revoking a Twitch user token also ends the EventSub authorizations for the app token.
- If a Twitch webhook retry keeps the original `Twitch-Eventsub-Message-Timestamp`.
- If a Kick `POST /events/subscriptions` for an existing event makes a second subscription. A repair creates
  only the missing events.
- How many failed deliveries Twitch counts before it revokes a subscription, and how long its list shows a
  revoked one.
- If Kick accepts an app access token for its event subscription endpoints. The endpoint reference names only
  the user token, so the feed uses that token.
- If Kick sends any message when it removes a subscription. The documentation names none.
- The repair with live Twitch and Kick traffic. Only tests with stand-in providers cover it.
- The support events with live Twitch, Kick, and YouTube traffic. Only tests with the documented payloads cover them.
- The answer of Kick when it refuses a support event. The feed reads 401, 403, and an event without a subscription ID
  as a refusal.
- If Twitch revokes only the subscriptions of the support events in some cases. A revocation with
  `authorization_revoked` sets `needs_reauth` for the connection, also for a subscription of a support event.
- The URL pattern for Twitch emote images: `https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/1.0`.
