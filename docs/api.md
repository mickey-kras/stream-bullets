# API reference

Handlers: `app/server/api/*.ts`. Registry: `app/server/api/index.ts`. Types: `app/types.ts`.

Reads (`GET`/`HEAD`) allow signed-out access unless noted.
Writes need sign-in, exact origin, and no query string. Failures return `401`, `403`, or `400`.
Unknown paths return `404`. Unsupported methods on known paths return `405`.

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
| `PATCH /api/me/preferences` | Complete `DisplayPrefs`. Replaces saved preferences. Debounce by 1 s. | `{preferences}` |
| `PATCH /api/streamer` | `{name?, about?, handle?, logoMode?: "profile" \| "logo"}`. At least one field | `{streamer}` |
| `PUT /api/images/logo` | PNG, JPEG, or WebP body with `Content-Type`. At most 5 MB | `{url}` |
| `DELETE /api/images/logo` | None | `{logo: null}` |
| `GET /api/entries/:id/comments?view=thread` | `sort`, `cursor` query parameters | `{comments: CommentThread[], nextCursor}`. Paged parents with all-depth `replies`, oldest first, keeping `parentId` |

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
| `GET /api/channels` | none | `{channels: [{platform, available, connection, capabilities}]}` for the owner's page. `connection` is null or `{displayName, status, code, connectedAt, lastEventAt, updatedAt}`. `updatedAt` is when the status or its code last changed. It never holds tokens or scopes. |
| `POST /api/channels/:platform/connect` | `{}` | `{authorizeUrl}`. The browser then goes to the provider. |
| `POST /api/channels/:platform/reconnect` | `{}` | `{authorizeUrl}`. The connection row stays. |
| `DELETE /api/channels/:platform` | none, or `{}` | `{revoked}`: true when the provider confirmed the revoke. `404` when the page has no connection for the platform. `409` (`channel_conflict`) when the row changed during the disconnect. A reconnect replaced it, or another disconnect or the expiry job removed it. |
| `GET /channels/callback/:platform` | provider query | A redirect to `/overlay-control?channel=<platform>&result=<code>`. |
| `GET /api/activity/:handle` | WebSocket upgrade, optional `key`, optional `characters=1` | The activity feed. Only the current overlay key or the signed-in owner can connect. With `characters=1` the socket also gets the character playground frames. `400` for another `characters` value or another parameter. `426` without a WebSocket upgrade, `403` without a key or owner session. A wrong or revoked key gets a socket that the server closes at once with the code `4403`. `404` for a missing or suspended page, `503` while the `CHANNELS_OFF` secret exists. |
| `POST /hooks/twitch`, `POST /hooks/kick` | signed provider webhook | `204`, or `200` with the challenge for a Twitch subscription check. `410` for a signed Twitch notification of an unknown channel. Twitch counts it as a failed delivery. It revokes the subscription after repeated failures. `403` for a bad signature or an old timestamp. `413` for a large body. `429` when an address with too many forged webhooks reaches the per-address limit. `503` when the server cannot check the webhook. |

- `:platform` is `twitch`, `youtube` or `kick`.
- The writes need a session from the last 10 minutes. Otherwise they answer `403` with the code
  `reauth_required`. They count against the content quota of 6 changes each minute.
- A connect answers `423` for a frozen or suspended page. A disconnect works on a frozen page too.
- A platform without credentials answers `503` with the code `platform_unavailable`.
- The callback result is `connected`, `denied`, `state_invalid`, `session_mismatch`, `channel_taken`,
  `disconnect_first`, `scope_missing` or `failed`.
- See [Channel connections and activity](channel-connections.md) for the event contract and the limits.

## Overlay layers

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/overlay` | - | `{overlay, data, handle}`. The `OverlayState` of the page of the signed-in owner, and the polls, topics, and cards for the pickers |
| `POST /api/overlay` | `{action: "layers", write?, orientation?, chat?: {enabled?, hideCommands?, backgroundOpacity?}, characters?: {enabled?, timeout?, max?}, items?: {poll?, topic?, next?, message?, card?, support?}, cells?: {horizontal?, vertical?}}` | `{overlay}`. The whole new `OverlayState`, with `layers` |
| `POST /api/overlay` | `{action: "showResults", on: boolean}` | `{overlay}`. The whole new `OverlayState`, with `showResults` |
| `POST /api/overlay` | `{action: "message", text, style: "info" \| "hype"}` | `{overlay}`. The whole new `OverlayState`, with `message` and `messageStyle` |
| `POST /api/overlay` | `{action: "chatTest", on: boolean}` | `{overlay}`. The whole new `OverlayState`, with `chatTestUntil` |
| `POST /api/overlay/key` | `{}` | `{url}`. A new private overlay link for the page of the signed-in owner. The old link stops immediately. |
| `POST /api/overlay/key/show` | `{}` | `{url}`. The current private overlay link, or `null` when the server kept no key. Only the owner can read it. |
| `POST /api/overlay/characters` | `{op: "status" \| "test" \| "stopTest" \| "pause" \| "resume" \| "reset"}` or `{op: "remove", id}` | `{paused, testEndsAt}`. The state of the character playground |
| `GET /@handle/overlay?key&layer&poll` | Optional `layer`: `content`, `chat`, or `characters`. Optional `poll`: a poll ID | The overlay page. Without `layer`, it shows the composition. With `layer`, it shows that part alone. An unknown value shows an empty page. |

- The overlay shows only the layers on the grid: `chat`, `characters`, and the content layers.
  The content layers are `poll`, `topic`, `next`, `message`, `card`, and `support`. Each content layer shows one content source.
  A layer is on stream when it has a cell in the selected orientation and its `enabled` value is `true`.
- `orientation` is `horizontal` (a grid of 16 × 9 cells) or `vertical` (9 × 16 cells). A cell is 120 pixels.
- Each orientation in `cells` holds `{chat?, characters?, poll?, topic?, next?, message?, card?, support?}`.
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
- `chat.backgroundOpacity` is the opacity of the message cards in percent: an integer from 0 to 100 that is a multiple of 5.
  Other values return `400`. See [Message background](overlay-composition.md#message-background).
- The minimum size is 3 × 2 cells for `chat`, 6 × 2 for `characters`, and 4 × 2 for each content layer.
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
  - `stopTest` stops the test. `pause` and `resume` stop and start the playground. `reset` removes all characters.
  - `remove` removes the character with the frame `id`. It returns `404` when no character has that `id`.
  - `testEndsAt` is the server time at which the test ends, or `null` when no test runs.
  - `test`, `reset`, and `remove` count against the write quota. The other operations do not.
  - It returns `503` while the `CHANNELS_OFF` secret exists, when the deployment has no `CHANNEL_INGEST` binding, or when the playground cannot answer.
- The action changes the streamer page of the signed-in user. A user who does not own a page gets `404`.
- Errors: `400` for an invalid body, a cell outside the grid, or overlapping layers, `401` without sign-in, and `403` for another origin.
  Also `404` without a streamer page, `409` when concurrent saves conflict, `423` for a frozen or suspended page, and `429` above the quota.
- `OverlayState` and `OverlayPublic` are `{showResults, message, messageStyle, layers, chatTestUntil, revision}`.
  `OverlayPublic` is what the overlay page and the live room get. Its `message` is empty unless the `message` layer is on stream.
- `layers` is `{orientation, chat: {enabled, hideCommands, backgroundOpacity}, characters: {enabled, timeout, max}, items, cells: {horizontal, vertical}}`.
  Each orientation in `cells` is `{chat, characters, poll, topic, next, message, card, support}`. Each value is a cell or `null`.
  `items` holds `{enabled, ref, backgroundOpacity, qr}` for each content layer.
  Missing, unknown, or incorrect stored fields take the defaults. Reads never fail because of a stored `layers` value.
  No layer has a cell by default. Chat and characters are off by default, `hideCommands` is on, and `backgroundOpacity` is 100.
  The defaults of a content layer are `enabled: true`, `ref: null`, and `backgroundOpacity: 100`. `poll` has `qr: true`. The other content layers have `qr: false`.
- With the `poll` parameter, the overlay page shows that poll in the poll layer, and no other content layer.
  A poll ID that the page does not have returns `404`.
- The API has no `preview`, `take`, or `layout` action now. Each of them returns `400`.
  The state has no `air`, `preview`, `position`, `size`, or `instant` value now.
  To show a source, put its layer on the grid with a `layers` action. To hide it, set `enabled` to `false` or its cell to `null`.
  The server converts saved state from before this change by itself.
  See [State from before the overlay studio](overlay-composition.md#state-from-before-the-overlay-studio).
- See [Overlay composition and merged chat](overlay-composition.md) for the layers, the URLs, the test, and the chat limits.

## Later phases

Overlay, Mash Battle, admin, step-up, and AI-interest handlers now exist in the registry.
For complete route definitions, inspect their modules in `app/server/api/`.
New modules export `ApiRoute[]` through `get()` and `write()` and join `apiRoutes` in `index.ts`.
Streamer-page writes must call `assertStreamerWritable()`.

## Discussion updates

| Route | Input | Result |
| --- | --- | --- |
| `POST /api/streamers/:handle` | `{action: "comment", id, text, parentId?, mentions?}` | `{id}`. New comment or reply. |
| `POST /api/comments` | `{action: "edit", id, text, mentions?}` | `{id}`. Only authors can edit their comments. Removed comments cannot change. |
| `GET /api/comments/:id` | None | `{comment, rootId, thread, handle, entryId}`. Exact comment and its thread, subject to page access. |
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

The server shows a translation only if it has the same Markdown structure, code, links and mentions as the comment.
Each account has a limit of new translations in one minute.
All accounts together have a daily limit of model starts. An edit or a removal of a comment does not decrease the count, and a failed start stays in it.
Two readers who ask at the same time start the model one time: the second reader gets `409` and can try again.
A deployment without the `AI` binding has no translation.

## Translation of new content

When a person posts a topic, a poll or a comment, or edits a comment, the server starts the translations of that item after the response.
It translates the content to each site language and stores the results. A reader then gets the translation with the page.

An hourly job does the same work for content that has no stored result for each site language.
This job translates the content from before this feature, and it tries again after a failure.
It takes the newest items first, 20 comments and 20 entries in one run.

The translation at the time of the read stays for content that the server did not translate yet.
The daily limit of model starts applies to all these paths.

## Topic and poll translation

A reader also sees each topic, poll and idea in the language of the site for that reader.
The translation has the title, the description and the answer options.

The page loader, `GET /api/streamers/:handle` and `GET /api/entries/:id` give each entry with a `translation` field. The field has the same three states as the field of a comment, and its value is `{title, body, options}`.

`POST /api/entries/:id/translation` with `{locale, title, body, options}` gives `{translation}`. Send the text that the reader sees in the text fields. A different text gets the answer `409`.

The server shows a translation only if it passes these checks:

- The title has one line.
- The answer options have the same number and different names.
- The description has the same line breaks and links.

The limits, the daily count and the stored results are the same as for comments.

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
