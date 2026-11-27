# API reference

Handlers: `app/server/api/*.ts`. Registry: `app/server/api/index.ts`. Types: `app/types.ts`.

Reads (`GET`/`HEAD`) allow signed-out access unless noted.
Writes need sign-in, exact origin, and no query string. Failures return `401`, `403`, or `400`.
Unknown paths return `404`. Unsupported methods on known paths return `405`.
The checks of a write come before `405`: another origin gets `403`, a query string `400`, and no sign-in `401`.

The Worker applies address quotas of 120 requests each minute. An address is one IPv4 address or one IPv6 `/64` network.
Each of these kinds of requests has its own quota: `/api/auth/*`, WebSocket connections, writes, and private reads.
Private reads are `/api/admin*` and `/api/account/export`. Other reads use no address quota.

Requests above the quota get `429` with `Retry-After: 60`.
A path with malformed percent-encoding returns `400`.

Errors return `{error, code?, details?}` with the HTTP status. `error` is an English message.
`code` is a stable reason. `details` is an optional `Record<string, string>` with values for that code.

The client translates a known code. A `423` or `429` without a known code gets a status message.
For other errors without a known code, English shows `error`. Other languages show a status message.
English also shows `error` for `step_up_required` and `other_key_required`.

## Changed response shapes

| Type or route | Contract |
| --- | --- |
| `Viewer` | `avatarPreset: number \| null` (0-17. Null defaults to 14), `locale: Locale \| null`, `displayPrefs: DisplayPrefs \| null`. |
| `Streamer` | `logo: string \| null`, `isOfficial: boolean`, `status: "active" \| "frozen" \| "suspended"`, `statusReason`, `handleChangedAt`. Only owners receive both last fields. Administrators also receive the reason. Others receive null. |
| `Entry` | Ideas `status`: `review`, `planned`, `progress`, `shipped`, `declined`, or null. `statusReason`. Comment counts exclude removed placeholders. |
| `Comment` | `removed: boolean`. Removed parents keep replies with empty `author`, `authorId`, and `text`, null `avatar`, and zero `likes`. Render "Comment removed" without like, report, or delete controls. |
| Moderated-page writes | `423` with the code `page_frozen` or `page_suspended`. Suspended pages return `404` to users other than owners and administrators. |
| `GET /api/streamers` | Official pages first. Suspended pages excluded. `query` matches name or handle, at most 60 characters. Send `nextCursor` back as `cursor`, including forms such as `1.handle`. |
| `GET /@handle`, `/api/streamers/:handle`, `/api/entries/:id` | Suspended pages return `404` except to owners and administrators. |
| `GET /@handle/overlay`, `/api/live/:handle` | Suspended pages return `404` to everyone. |

## New endpoints

| Endpoint | Body | Response |
| --- | --- | --- |
| `PATCH /api/profile` | `{name?, avatarPreset?: 0..17 \| null}`. At least one field | `{viewer}` |
| `PATCH /api/me/locale` | `{locale: Locale \| null}` | `{locale}` |
| `PATCH /api/me/keep-original` | `{locales: Locale[]}`. Replaces the saved list. Content in these languages shows in its original text. | `{locales}` |
| `PATCH /api/me/preferences` | Complete `DisplayPrefs`. Replaces saved preferences. Debounce by 1 s. | `{preferences}` |
| `PATCH /api/streamer` | `{name?, about?, handle?, logoMode?: "profile" \| "logo"}`. At least one field | `{streamer}` |
| `PUT /api/images/logo` | PNG, JPEG, or WebP body with `Content-Type`. At most 5 MB | `{url}` |
| `DELETE /api/images/logo` | None | `{logo: null}` |
| `GET /api/entries/:id/comments?view=thread` | `sort`, `cursor` query parameters | `{comments: CommentThread[], nextCursor}`. Paged parents, each with its 2 oldest replies of any depth, `replyCount` and `earlierReplies: 0`. A reply keeps `parentId` and has `parentAuthor`. The name is empty for a removed parent |

- Handle changes need 30 days. Early changes return `409` with the code `handle_cooldown`.
  `details.retryAt` is the ISO timestamp of the next allowed change.
- Old page and overlay links stop working without redirects. Warn before saving.
- `logoMode: "profile"` and logo deletion remove uploads. `logoMode: "logo"` needs an upload or returns `400`.
- Uploaded `avatar` takes precedence over a preset. Selecting a preset does not remove the upload. The profile dialog handles that choice.

## Phase 3 changes

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/streamer` | `{handle, name, about}` | `{streamer}` for approved accounts or administrators. Second profiles return `409` |
| `DELETE /api/images/avatar` | None | `{avatar: null}`. Shows preset or default afterward |
| `GET /api/me` | None | `signInProvider`: `"google"`, `"tiktok"`, `"twitch"`, `"instagram"`, or null. Owner `support: {links, visible, card}`, otherwise null |

- The API no longer supports `POST /api/profile` or `/api/account`. Use streamer creation and update and profile update routes.
- `Streamer.ownerAvatarPreset` is `number | null`. Picture priority: logo, uploaded owner avatar, owner preset, preset 14.
- `/settings` redirects `302` to `/streamers?dialog=profile`.
- Account dialogs use `?dialog=profile`, `host`, `data`, or `page` over the current page.
- Directory `?intent=suggest` opens topic creation or sign-in. `?intent=discuss` opens the top topic's discussion.
- Applications hide TikTok and Instagram placeholder emails: `{id}@tiktok.invalid` and `{id}@instagram.invalid`.

## Phase 4 changes

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/streamers/:handle/events?from&to` | No body. UTC-millisecond bounds, at most 200 days apart | `{events: StreamEvent[], serverNow}`. Overlapping streams, oldest first, at most 500 |
| `POST /api/events` | `{title, notes?, date, time, tz, durationMin, platform, url, repeatDays?, repeatUntil?, topicIds?}` | `{event}` for the first stream. Owner only |
| `PATCH /api/events/:id` | `{action: "edit", scope: "one" \| "following", ...}`, `{action: "cancel"}`, or `{action: "replay", vodUrl}` | `{event}` |
| `DELETE /api/events/:id` | Optional `{scope: "one" \| "following"}` | `{deleted: true}` |
| `GET /@handle/schedule.ics` | None | `text/calendar`, `Cache-Control: public, max-age=300`. Suspended pages return `404` |
| `PUT /api/community-cards` | `{cards: [{icon, title, body, buttonLabel, buttonTarget}]}`. At most 8 | `{cards}`. Replaces the list atomically |
| `PUT /api/support-links` | `{links: [{kind, label, url}], visible, card}`. At most 4 links | `{links, visible, card}` |

- `date`: `YYYY-MM-DD`. `time`: `HH:MM`. `tz`: IANA zone.
- Weekly `repeatDays` uses bit 0 for Sunday. The server includes `date`'s weekday. `repeatUntil` is optional.
- Each occurrence gets a row, generated 12 weeks ahead and extended hourly. Local times survive daylight-saving changes.
- `StreamEvent.status`: `scheduled`, `live`, `ended`, or `cancelled`. Cancellation keeps the stream and sets calendar `STATUS:CANCELLED`.
- `scope: "following"` replaces this and later series occurrences. `"one"` changes only this occurrence.
- Card targets: `tab:topics`, `tab:polls`, `tab:schedule`, `tab:about`, `tab:community`, or HTTPS.
- Unsaved pages show two default cards. First save stores the visible cards.
- Support URLs need HTTPS and the provider domain. Kind `other` accepts public hosts and needs `label`. Other kinds ignore it.
- Official-page ideas use `category`: `feature`, `bug`, `design`, `a11y`, or `lang`. Initial status is `review`.
- The server rejects untouched bug templates. Authors can delete ideas only during `review`.
- `GET /api/streamers/:handle` accepts an Ideas `status` filter.
- `Entry.reported` and `Comment.reported` show the viewer's open report. Show "Reported" without another Report button.

## Channel connections

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/channels` | none | `{channels: [{platform, available, connection, capabilities, support}]}` for the owner's page. `connection` is null or `{displayName, status, code, connectedAt, lastEventAt, updatedAt}`. `updatedAt` is when the status or its code last changed. `support` is true when the connection reads support events. It is false without a connection, without the scopes for the support events, and after the provider refused them. The answer never holds tokens or the scopes that a connection has. |
| `POST /api/channels/:platform/connect` | `{}` | `{authorizeUrl}`. The browser then goes to the provider. The address asks for the scopes of chat and of support events: for Twitch, three more scopes. |
| `POST /api/channels/:platform/reconnect` | `{}` | `{authorizeUrl}`. The connection row stays. The address asks for the same scopes as a connect. |
| `DELETE /api/channels/:platform` | none, or `{}` | `{revoked}`: true when the provider confirmed the revoke. `404` when the page has no connection for the platform. `409` (`channel_conflict`) when the row changed during the disconnect. A reconnect replaced it, or another disconnect or the expiry job removed it. |
| `GET /channels/callback/:platform` | provider query | A redirect to `/tools?view=channels&channel=<platform>&result=<code>`. |
| `GET /api/activity/:handle` | WebSocket upgrade, optional `key`, optional `characters=1` | The activity feed. Only the current overlay key or the signed-in owner can connect. With `characters=1` the socket also gets the character playground frames. `400` for another `characters` value or another parameter. `426` without a WebSocket upgrade, `403` without a key or owner session. A wrong or revoked key gets a socket that the server closes at once with the code `4403`. `404` for a missing or suspended page, `503` while the `CHANNELS_OFF` secret exists. |
| `POST /hooks/twitch`, `POST /hooks/kick` | signed provider webhook | `204`, or `200` with the challenge for a Twitch subscription check. `410` for a signed Twitch notification of an unknown channel. Twitch counts it as a failed delivery. It revokes the subscription after repeated failures. `403` for a bad signature or an old timestamp. `413` for a large body. `429` when an address with too many forged webhooks reaches the per-address limit. `503` when the server cannot check the webhook. |

- `:platform` is `twitch`, `youtube` or `kick`.
- The writes need a session from the last 10 minutes. Otherwise they answer `403` with the code
  `reauth_required`. They count against the content quota of 6 changes each minute.
- A connect and a reconnect answer `423` for a frozen or suspended page. A disconnect works on a frozen page too.
- A platform without credentials answers `503` with the code `platform_unavailable`.
- The callback result is `connected`, `denied`, `state_invalid`, `session_mismatch`, `channel_taken`,
  `disconnect_first`, `scope_missing`, `support_denied` or `failed`.
- `support_denied` means that the channel reads chat. The provider did not give the permissions for
  support events, or it refused their subscriptions. A reconnect tries again.
- No route turns support events on or off. Each connected channel reads them.
- See [Channel connections and activity](channel-connections.md) for the event contract and the limits.

## Overlay layers

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/overlay` | - | `{overlay, data, handle}`. The `OverlayState` of the page of the signed-in owner, and the polls, topics, and cards for the pickers |
| `POST /api/overlay` | `{action: "layers", write?, orientation?, chat?: {enabled?, hideCommands?, backgroundOpacity?}, characters?: {enabled?, timeout?, max?}, items?: {poll?, topic?, next?, message?, card?, support?}, camera?: {enabled?}, alerts?: {enabled?, rules?}, goal?: {enabled?, title?, counts?, target?}, cells?: {horizontal?, vertical?}, twitchOnly?: {horizontal?, vertical?}}` | `{overlay}`. The whole new `OverlayState`, with `layers` |
| `POST /api/overlay` | `{action: "showResults", on: boolean}` | `{overlay}`. The whole new `OverlayState`, with `showResults` |
| `POST /api/overlay` | `{action: "message", text, style: "info" \| "hype"}` | `{overlay}`. The whole new `OverlayState`, with `message` and `messageStyle` |
| `POST /api/overlay` | `{action: "chatTest", on: boolean}` | `{overlay}`. The whole new `OverlayState`, with `chatTestUntil` |
| `POST /api/overlay/key` | `{output?: "horizontal" \| "vertical"}` | `{url}`. A new private link for one output of the page of the signed-in owner. The old link of that output stops immediately. The link of the other output stays. Without `output`, the output is `horizontal`. |
| `POST /api/overlay/key/show` | `{output?: "horizontal" \| "vertical"}` | `{url}`. The current private link of one output, or `null` when the server kept no key for it. Only the owner can read it. |
| `POST /api/overlay/characters` | `{op: "status" \| "test" \| "stopTest" \| "pause" \| "resume" \| "reset" \| "clear"}` or `{op: "remove", id}` | `{paused, testEndsAt}`. The state of the character playground |
| `GET /@handle/overlay?key&layer&poll` | Optional `layer`: `content`, `chat`, or `characters`. Optional `poll`: a poll ID | The overlay page of one output. The key gives the output: horizontal or vertical. Without a valid key, the page shows the horizontal output. Without `layer`, it shows the composition. With `layer`, it shows that part alone. An unknown value shows an empty page. |

- The overlay shows only the layers on the grid: `chat`, `characters`, the content layers, and `camera`.
  The content layers are `poll`, `topic`, `next`, `message`, `card`, and `support`. Each content layer shows one content source.
  A layer is on stream in an output when it has a cell in the orientation of that output and its `enabled` value is `true`.
- The grid also has the `alerts` layer and the `goal` layer. The API saves their cells and their settings.
  The overlay does not show them in this version, and the editor does not offer them.
- `orientation` is `horizontal` (a grid of 32 × 18 cells) or `vertical` (18 × 32 cells). A cell is 60 pixels.
  It is the output that the editor shows. Each output has its own link, and OBS can show the two outputs together.
  See [Outputs](overlay-composition.md#outputs).
- Each orientation in `cells` holds `{chat?, characters?, poll?, topic?, next?, message?, card?, support?, camera?, alerts?, goal?}`.
  Each value is a cell rectangle `{c, r, w, h}` of whole cells, or `null`. With `null`, the layer is not on the grid.
  `c + w` is at most the number of columns, and `r + h` is at most the number of rows.
- Each value in `items` holds the settings of one content layer: `{enabled?, ref?, backgroundOpacity?, qr?}`.
  - `ref` is the ID of a poll, a topic, or a Community card of the page. An unknown ID returns `404`.
    A `poll` layer with `ref: null` shows the latest active poll. A `card` layer with `ref: null` shows the first card.
    `next`, `message`, and `support` accept only `ref: null`.
  - `backgroundOpacity` has the same values as `chat.backgroundOpacity`. It applies to the card background of the layer.
  - `qr` shows a QR code in the card of the layer. A viewer scans it to open the public page of the item.
    The `message` layer accepts the value and never shows a code.
    See [QR code](overlay-composition.md#qr-code).
- `twitchOnly` has one boolean for each output. With `true`, that output shows chat and characters from Twitch only.
  The default is `false`: the merged chat. See [Twitch chat only](overlay-composition.md#twitch-chat-only).
- `camera` is the camera frame: a frame with a clear window. It has only the `enabled` value.
  See [Camera frame](overlay-composition.md#camera-frame).
- `alerts.rules` holds the rules of the alerts: `{follow?, subscription?, gift?, bits?, paid?, raid?, topic?}`.
  - Each rule is `{min?, banner?, chat?, character?}`. The three switches are booleans.
  - `min` is the amount where the alert starts: a whole number from 1 to 1,000,000.
    Only `gift`, `bits`, and `raid` accept `min`. A `min` on a different rule returns `400`.
  - A body changes only the fields of the rules that it names.
  - See [Alerts and the goal](channel-connections.md#alerts-and-the-goal) for the rules and their defaults.
- `goal` holds the settings of the goal.
  - `title` is the title on stream: one line of at most 60 characters. It can be empty. The API keeps the spaces at its ends.
  - `counts` is `subs`, `follows`, `bits`, `kicks`, `chatters`, or `votes`.
  - `target` is a whole number from 1 to 10,000,000.
- `chat.backgroundOpacity` is the opacity of the message cards in percent: an integer from 0 to 100 that is a multiple of 5.
  Other values return `400`. See [Message background](overlay-composition.md#message-background).
- The minimum size is 6 × 4 cells for `chat`, 12 × 4 for `characters`, 8 × 4 for each content layer, and 6 × 4 for `camera`.
  It is 8 × 3 cells for `alerts` and 8 × 2 cells for `goal`.
- After the merge, no two layers can overlap in an orientation. A layer without a cell does not count.
  A layer with a cell counts also while its `enabled` value is `false`.
- The stored layers have a limit of 4000 characters. The server stores only the cells and the settings that are not the defaults.
  A change that goes above the limit returns `400`. The values that the API accepts stay below the limit.
- `write` is `{writer, seq}`. `writer` is a random ID of 8 to 64 letters, digits, `_` or `-`. `seq` is a positive integer.
  The server keeps the largest applied `seq` of each of the last 8 writers. It ignores a change with a `seq` that is not larger than the kept `seq` of its `writer`.
  The server then answers `200` with the current state and does not notify the overlay pages. A change without `write` always applies.
- The body changes only the fields that it names. The API merges each field into the saved layers.
  Thus send only the fields that you change. Unknown fields return `400`.
- The change goes live at once. Overlay pages get the new `layers` through the live room.
- `showResults` shows (`on: true`) or hides the results of the poll in the poll layer.
- `message` saves the text and the style of the message banner. The text has at most 120 characters on one line.
  The public overlay state has the text only while the `message` layer is on stream.
- `chatTest` with `on: true` sets `chatTestUntil` to the server time plus 60 seconds. With `on: false` it sets 0.
  `on: true` returns `400` when the chat layer is off stream. `on: false` always applies.
  A `layers` action that takes the chat layer off stream also sets `chatTestUntil` to 0.
  Overlay pages get the value through the live room. A time in the past means no test.
- `characters.timeout` is the time in seconds without chat before a character walks out. It is a whole number from 10 to 600. The default is 60.
- `characters.max` is the maximum number of characters on screen. It is a whole number from 5 to 40. The default is 40.
- Each `layers` action and each `chatTest` action with `on: true` counts against the write quota of 60 changes each minute.
- `POST /api/overlay/characters` controls the character playground of the page:
  - `status` changes nothing. It only returns the state.
  - `test` starts the characters test for 5 minutes, or starts it again. It also ends a pause.
    It returns `400` when the saved characters layer is off stream.
  - With the saved characters layer off stream, the playground keeps nothing. Then each operation returns `{paused: false, testEndsAt: null}`, and `remove` returns `404`.
  - `stopTest` stops the test. `pause` and `resume` stop and start the playground. `reset` removes all characters and all builds. `clear` removes all builds and keeps the characters.
  - `remove` removes the character with the frame `id`. It returns `404` when no character has that `id`.
  - `testEndsAt` is the server time at which the test ends, or `null` when no test runs.
  - `test`, `reset`, `clear`, and `remove` count against the write quota. The other operations do not.
  - It returns `503` while the `CHANNELS_OFF` secret exists, when the deployment has no `CHANNEL_INGEST` binding, or when the playground cannot answer.
- The action changes the streamer page of the signed-in user. A user who does not own a page gets `404`.
- Errors: `400` for an invalid body, a cell outside the grid, or overlapping layers, `401` without sign-in, and `403` for another origin.
  Also `404` without a streamer page, `409` when concurrent saves conflict, `423` for a frozen or suspended page, and `429` above the quota.
- `OverlayState` and `OverlayPublic` are `{showResults, message, messageStyle, layers, chatTestUntil, revision}`.
  `OverlayPublic` is what the overlay page and the live room get. Its `message` is empty unless the `message` layer is on stream.
- `layers` is `{orientation, chat: {enabled, hideCommands, backgroundOpacity}, characters: {enabled, timeout, max}, camera: {enabled}, alerts: {enabled, rules}, goal: {enabled, title, counts, target}, items, cells: {horizontal, vertical}, twitchOnly: {horizontal, vertical}}`.
  Each orientation in `cells` is `{chat, characters, poll, topic, next, message, card, support, camera, alerts, goal}`. Each value is a cell or `null`.
  `items` holds `{enabled, ref, backgroundOpacity, qr}` for each content layer.
  Missing, unknown, or incorrect stored fields take the defaults. Reads never fail because of a stored `layers` value.
  No layer has a cell by default. Chat and characters are off by default, `hideCommands` is on, and `backgroundOpacity` is 100.
  `hideCommands` applies to the chat layer and to the chat of the owner in **Live** and in the OBS dock.
  The defaults of a content layer are `enabled: true`, `ref: null`, and `backgroundOpacity: 100`. `poll` has `qr: true`. The other content layers have `qr: false`.
- `alerts` and `goal` are off by default. `alerts.rules` always has each of the seven rules, and each rule has its four fields.
  A rule that does not accept `min` has `min: 1`.
  The defaults of `goal` are an empty `title`, `counts: "subs"`, and `target: 25`.
  The live room sends `layers` to each viewer. Thus the title of a goal is public when the API saves it, also while the layer is off stream.
- With the `poll` parameter, the overlay page shows that poll in the poll layer, and no other content layer.
  A poll ID that the page does not have returns `404`.
- The API has no `preview`, `take`, or `layout` action now. Each of them returns `400`.
  The state has no `air`, `preview`, `position`, `size`, or `instant` value now.
  To show a source, put its layer on the grid with a `layers` action. To hide it, set `enabled` to `false` or its cell to `null`.
  The server converts saved state from before this change by itself.
  See [State from before the overlay studio](overlay-composition.md#state-from-before-the-overlay-studio).
- See [Overlay composition and merged chat](overlay-composition.md) for the layers, the URLs, the test, and the chat limits.

## Overlay layouts

Each output of the overlay has its own layouts, and one of them is on stream.
See [Layouts](overlay-composition.md#layouts).

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/overlay` | - | The response also has `layouts`: `{horizontal, vertical}`, each with `active` and `saved` |
| `POST /api/overlay/layouts` | `{action: "select", output, id, keep}` | `{overlay, layouts}`. The layout `id` is on stream |
| `POST /api/overlay/layouts` | `{action: "create", output, name, from: "empty" \| "current", keep}` | `{overlay, layouts}`. A new layout of the streamer is on stream |
| `POST /api/overlay/layouts` | `{action: "rename", output, id, name}` | `{overlay, layouts}` |
| `POST /api/overlay/layouts` | `{action: "delete", output, id}` | `{overlay, layouts}` |
| `POST /api/overlay/layouts` | `{action: "reset", output}` | `{overlay, layouts}`. The preset on stream has the cells that it comes with |

- `output` is `horizontal` or `vertical`.
- `id` is the ID of a layout of the streamer, or the ID of a preset: `preset:chatting`, `preset:gameplay`, or `preset:vertical`.
  A preset of the other output returns `404`.
- `active` is the ID of the layout on stream, or `null` when the layout on stream has no saved copy.
- `saved` holds `{id, name, cells}` for each layout of the streamer, and for each preset that the streamer used.
  The cells of the layout on stream are in `overlay.layers.cells`. Its `cells` in `saved` can be old.
- `name` and `keep` are one line of 1 to 40 characters.
  `keep` is the name for a layout on stream that has no saved copy: it then becomes a layout of the streamer.
- Each output can have 8 layouts of the streamer. One more returns `400` with the code `layout_limit`.
- The server refuses to delete the layout on stream (`400`), to rename a preset (`400`), and to reset when no preset is on stream (`400`).
- `select`, `create`, and `reset` change the layers. Overlay pages get the new `layers` through the live room, without a reload.
- Each action increases `overlay.revision`, and the live room sends the new revision. Another open tab of the owner then loads the layouts again.
- Only the owner of the page can use these endpoints. Unknown fields return `400`.

## Alert controls

The alert host of the page plays the alerts on stream. See [Alert host](channel-connections.md#alert-host).

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/overlay/alerts` | `{op: "status"}` | `{at, muted, current, waiting, goal}`. The state of the alerts. This control changes nothing. |
| `POST /api/overlay/alerts` | `{op: "test", kind?}` | The state. A sample alert plays. |
| `POST /api/overlay/alerts` | `{op: "mute", on: boolean}` | The state. With `on: true`, no alert plays. |
| `POST /api/overlay/alerts` | `{op: "skip"}` | The state. The alert on stream ends, and the next alert starts. |
| `POST /api/overlay/alerts` | `{op: "replay", id}` | The state. The alert of one support event plays again. |

- The state has the fields of the `alerts` message of the activity socket, without `type`:

| Field | Value |
| --- | --- |
| `at` | The server time of the state, in milliseconds |
| `muted` | `true` while the mute is on |
| `current` | The view of the alert on stream, or `null`. Its `endsAt` is the server time when the banner goes. |
| `waiting` | The number of alerts in the line |
| `goal` | `null` in this version |

- See [Alerts and the goal](channel-connections.md#alerts-and-the-goal) for the fields of a view.
- `kind` is `follow`, `subscription`, `gift`, `bits`, `super_chat`, `raid`, `topic`, or `anonymous`. Without `kind`, the test is a `gift`.
  `anonymous` is a gift from a supporter who asked for no name.
- `id` is the `id` of a support event of the activity feed, with 1 to 160 characters.
  The server replays only an event that it still keeps: the newest 50 support events of the last 10 minutes.
- `mute` with `on: true` stops the alert on stream immediately and removes each alert from the line.
  While the mute is on, a support event makes no alert. After `on: false`, no alert from the muted time plays.
  The muted state stays until the owner changes it.
- A test and a replay add no support event, and no page gets an `event` message for them. They do not use `min` of the rule.
- `test` and `replay` count against the write quota of 60 changes each minute. `status`, `mute`, and `skip` do not.
  Thus the owner can always read the state and stop the alerts.
- Only the owner of the page can use this endpoint. Unknown fields return `400`.
- A refusal of the alert host has a code:

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `alerts_off_stream` | A test or a replay, and the saved alerts layer is not on stream in an output |
| `404` | `alert_gone` | A replay of an event that the server does not keep: the ID is unknown, or the event is older than 10 minutes |
| `409` | `alerts_muted` | A test or a replay while the mute is on |
| `409` | `alerts_unwatched` | A test or a replay while no overlay page, no **Streamer tools** page, and no dock is open |
| `409` | `alert_rule_off` | A test or a replay, and the rule of the alert has its three switches off |
| `409` | `alerts_full` | A test or a replay while 100 alerts wait in the line |
| `503` | `alerts_unavailable` | The alert host cannot read the saved layers, or it cannot answer |

- Other errors: `400` for an invalid body, `401` without sign-in, `403` for another origin, and `404` without a streamer page.
  Also `423` for a frozen or suspended page, and `429` above the quota.
  The endpoint returns `503` while the `CHANNELS_OFF` secret exists, and when the deployment has no `CHANNEL_INGEST` binding.

## OBS dock

See [OBS dock](streamer-tools.md#obs-dock).

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/dock/key` | `{}` | `{url}`. A new dock link for the page of the signed-in owner. The link shows one time. The old link stops immediately. |
| `POST /api/dock/:handle/overlay` | `{action: "showResults" \| "message" \| "layers", ...}` | `{overlay}`. A live control from the dock |
| `POST /api/dock/:handle/poll` | `{id}` | `{id}`. The poll takes no more votes |
| `POST /api/dock/:handle/alerts` | `{op: "status" \| "test" \| "mute" \| "skip" \| "replay", ...}` | `{at, muted, current, waiting, goal}`. An alert control from the dock |
| `GET /@handle/dock?key` | - | The dock page. Without the current dock key, the answer is `404`. |

- The three dock endpoints with `:handle` need no session. They need the dock key in the `X-SB-Dock-Key` header.
  A call without the current dock key of that page returns `403` with the code `dock_key`.
- `overlay` takes the same actions as `POST /api/overlay`, with these limits.
  A `layers` action can have only `items`, only for `poll`, `topic`, and `message`, and only the fields `enabled`, `ref`, and `qr`.
  `chatTest` and each other field return `403` with the code `dock_action`. `alerts` and `goal` are such fields.
- `alerts` takes the same controls as `POST /api/overlay/alerts` and gives the same answers and codes. See [Alert controls](#alert-controls).
  A test and a replay from the dock count against the write quota of the owner.
- An overlay key is not a dock key. It returns `403`.
- The live room (`/api/live/:handle`) and the activity feed (`/api/activity/:handle`) accept the dock key in `key`.
  A dock then has the seat and the data of the owner.

## Later phases

Overlay, Mash Battle, admin, step-up, and AI-interest handlers now exist in the registry.
For complete route definitions, inspect their modules in `app/server/api/`.
New modules export `ApiRoute[]` through `get()` and `write()` and join `apiRoutes` in `index.ts`.
Streamer-page writes must call `assertStreamerWritable()`.

## Discussion updates

| Route | Input | Result |
| --- | --- | --- |
| `POST /api/streamers/:handle` | `{action: "comment", id, text, parentId?, mentions?}` | `{id}`. New comment or reply. |
| `POST /api/comments` | `{action: "edit", id, text, mentions?}` | `{id}`. Only authors can edit their comments. Removed comments cannot change. An edit that changes the text stores the earlier text. |
| `GET /api/comments/:id/history` | None | `{revisions: {text, mentions, writtenAt, editedAt}[]}`, oldest first. The texts before each edit, kept for 90 days. Only the page owner and administrators can read them. An administrator needs a fresh step-up. Other accounts and signed-out readers get `404`. |
| `POST /api/comments/:id/answer` | `{action: "mark"}`, `{action: "unmark"}` or `{action: "offset", offsetSeconds}` (0 to 172800) | `{answer: {markedAt, stream} \| null}`. Only the page owner can set, change or remove the mark. Other accounts get `404`. `stream` is null when the page was not live at the mark. It has `platform`, `title`, `startedAt`, `offsetSeconds` and `link`. The link has a time code for a YouTube video and a Twitch VOD. `offset` on a mark without a stream gets `409`. A comment shows its mark as `answer`. A removed comment loses its mark. |
| `GET /api/streamer/answer-lead`, `PUT /api/streamer/answer-lead` | `{leadMinutes}` (0 to 60) | `{leadMinutes}`. The time code of a new mark is this many minutes before the mark. The default is 5. The signed-in owner's page only. |
| `GET /api/comments/:id` | None | `{comment, rootId, thread, handle, entryId}`. Exact comment and its thread, subject to page access. For a reply, `thread.replies` holds the 10 replies before and after it, and `thread.earlierReplies` counts the older ones it leaves out. |
| `GET /api/comments/:id/replies` | One of the `after`, `before` or `from` query parameters: a place `<createdAt>.<replyId>` | `{replies: Comment[], earlierReplies, laterReplies}`. Up to 50 replies of root comment `:id` after, before or from that place, oldest first. Without a parameter, the first 50. `earlierReplies` counts the replies before the first one and `laterReplies` the replies after the last one. Both are `null` for an empty page. The place stays valid after its reply goes. A reply or a hidden page gets `404`. Two parameters get `400`. |
| `POST /api/comments/:id/translation` | `{locale, text}`. `text` is the comment text that the reader sees. The answer is `409` when the comment changed. | `{translation: {text, mentions} \| null}`. Signed-in accounts only. `null`: the comment needs no translation, or the translation failed a check. `503` when translation is off. |
| `GET /api/entries/:id/mention-candidates` | `query`, at most 40 characters | `{users}`. At most 10 public profiles or participants in this community. Requires sign-in. |
| `GET /api/notifications` | Optional opaque `cursor` | `NotificationSnapshot`: at most 50 notifications, unread count, preferences and next cursor. Requires sign-in. |
| `POST /api/notifications` | `{action: "read", id, read}` | `{ok: true}`. Only the recipient can change read state. |
| `POST /api/notifications` | `{action: "preferences", replies, mentions}` | `{ok: true}`. Saves in-app delivery preferences for new events. |

Comments include `editedAt` and `mentions`. Each mention contains `{userId, start, end}`.
Offsets use UTF-16 indices into the exact comment text. Do not trim the text before you send it.
Each new selection must match `@name` for an available account.
You can select up to five distinct accounts.

An edit can keep an existing mention after the recipient changes their name.
Plain `@name` text without a selection does not send a notification.

New replies and selected mentions send in-app notifications. The sender receives no notification.
If a reply also mentions its parent author, the recipient receives one notification.
The service uses their delivery preferences to select the notification type.

Edits do not send notifications. If you remove a mention, the service deletes its notification.
The inbox and exact-comment lookup omit deleted comments and inaccessible pages.
Notifications contain no comment excerpts. They link to the current comment.
The service does not send email or push notifications.

Each inbox keeps up to 200 notifications for up to 90 days.
The next delivery deletes expired records.
Each sender can send up to 100 notifications per hour, with at most 10 per recipient.
Existing content quotas also apply.

## Comment translation

A reader sees each comment in the language of the site for that reader.
Workers AI translates a comment to one of the site locales.

The comment lists and the lookup of one comment give each comment with a `translation` field:

- `{text, mentions}`: the stored translation for the language of the reader.
- `null`: the comment needs no translation, or its translation failed a check.
- No field: the server has no result. The page of a signed-in reader then asks for the translation with `POST /api/comments/:id/translation`.

A signed-out reader gets the stored translations and starts no new one.
The page shows a control on each translated comment. The control shows the original text of that comment.

The server stores each result, so the model runs one time for each comment text and locale.
An edit or a removal of the comment deletes its stored translations.
Text without letters starts no model.

Text in the language of the reader has no translation and starts no model. The reader sees the original text.
The server finds this language without the model.
The letters tell Russian, Ukrainian, Hindi, Japanese and Chinese text.
For text in Latin letters, the library `eld` gives the language. When it is not sure, the language stays unknown.

The server shows a translation only if it has the same Markdown blocks, marks, code, links and mentions as the comment.
Lines in one paragraph can be different: the model joins lines that the author divided.
The translation must also be in the language of the reader. The model sometimes answers in a different language.
A line with only a link at the start or at the end of a comment does not go to the model. It stays as it is.

These rules also apply to topics, polls and ideas.

Each account has a limit of new translations in one minute.
All accounts together have a daily limit of model starts. An edit or a removal of a comment does not decrease the count, and a failed start stays in it.
Two readers who ask at the same time start the model one time: the second reader gets `409` and can try again.
A deployment without the `AI` binding has no translation.

## Translation of new content

A person posts a topic, a poll or a comment, or edits a comment.
The server then starts the translations of that item after the response.
It translates the item to each site language and stores the results. A reader then gets the translation with the page.

A job does the same work for content that has no stored result for each site language.
This job translates the content from before this feature, and it tries again after a failure.
It runs each 10 minutes and takes the newest items first, 4 comments and 4 entries in one run.
The same run translates the text of pages: one text of each of 2 pages.

The translation at the time of the read stays for content that the server did not translate yet.
The daily limit of model starts applies to all these paths.

## Topic and poll translation

A reader also sees each topic, poll and idea in the language of the site for that reader.
The translation has the title, the description and the answer options.
The model gets these three parts as JSON and answers with JSON of the same form.

The page loader, `GET /api/streamers/:handle` and `GET /api/entries/:id` give each entry with a `translation` field. The field has the same three states as the field of a comment, and its value is `{title, body, options}`.

`POST /api/entries/:id/translation` with `{locale, title, body, options}` gives `{translation}`. Send the text that the reader sees in the text fields. A different text gets the answer `409`.

The server shows a translation only if it passes these checks:

- The title has one line.
- The answer options have the same number and different names.
- The description has the same line breaks and links.

The limits, the daily count and the stored results are the same as for comments.

## Page text translation

A reader also sees the About text, the Community cards and the scheduled streams in the language of the site.

The page loader gives these fields:

- The page has `aboutTranslation`, a text.
- Each card has `translation` with `{title, body, buttonLabel}`.
- Each stream has `translation` with `{title, notes}`.

`GET /api/streamers/:handle/events` gives the same field with each stream.
`GET /api/streamers` and the directory give `aboutTranslation` with each page.
Each field has the same three states as the field of a comment.

The owner saves the page profile, the cards or a stream. The server then starts the translations after the response.
The server stores one result for each text and site language. Streams with the same title and notes use one result.
After a change of a text, the server deletes the results of the old text.

The page does not ask for these translations. A reader gets only the stored results.
The on-stream overlay and the calendar feed show the original text.

## Markdown in comments

The service stores the exact text that the author sends.
The page formats the text when it shows a comment or a reply.

The comment field is an editor that shows each format while the author types.
The toolbar of the editor has one button for each format in the table below.
When the author types Markdown syntax, the editor shows its format immediately.
`Ctrl+B` sets bold text, `Ctrl+I` sets italic text, and `Ctrl+K` opens the link field.
The editor sends the comment as Markdown text, so the stored text has the same syntax as before.

At first, the page shows a text field without formats.
This field works without the editor code.
The editor code loads after the page and then replaces the field.
The text and the mentions in the field move to the editor.

Comments support this Markdown syntax:

| Syntax | Result |
| --- | --- |
| `**text**` | Bold |
| `*text*` | Italic |
| `~~text~~` | Strikethrough |
| `` `text` `` | Inline code |
| `[label](https://example.com)` or a plain web address | Link |
| `- item` | Bullet list |
| `1. item` | Numbered list |
| `> text` | Quote |
| Three backticks on the lines before and after the text | Code block |

One line break in the text starts a new line. An empty line starts a new paragraph.
Selected mentions keep their highlight. A mention inside code shows as plain code text.

The page shows all other syntax as the typed text.
This rule applies to HTML, images, headings, tables, footnotes, task lists, rules, and reference links.

Safety rules:

- `parseCommentMarkdown()` uses the `marked` lexer and returns a typed tree.
- The page creates React elements from that tree. It never inserts HTML from a comment.
- A link must use `http:`, `https:`, or `mailto:`. The page shows other link syntax as text.
- Each link opens in a new tab with `rel="nofollow ugc noopener noreferrer"`.
- Quotes and lists can nest eight levels. The page shows deeper levels as text.
- Only code blocks scroll sideways. Other text wraps.
