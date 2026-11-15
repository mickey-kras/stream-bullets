# API reference

Registry: `app/server/api/index.ts`. Input schemas: `app/server/validation.ts` and each handler module.
Response types: `app/types.ts`. All paths below are relative to the application origin.

## HTTP rules

- Send JSON with `Content-Type: application/json`, except image uploads.
- Writes need the exact application `Origin` and reject query strings.
- Writes need sign-in unless marked public. Public writes still check the origin.
- `GET` also supports `HEAD`. Reads are public unless the access column says otherwise.
- Unknown paths return `404`. Unsupported methods on a known path return `405`.
- Errors return `{error, code?, details?}` with the HTTP status.
  Optional `details` has type `Record<string, string>`. Keep the message or translate its code.
- Common failures: `400` invalid input, `401` sign-in required, `403` forbidden, `404` missing, `409` conflict,
  `413` oversized body, `423` read-only page, `429` quota reached, `503` unavailable.
- Frozen pages remain readable. Suspended pages return `404` except to their owner and administrators.
  Live feeds and calendars hide suspended pages from everyone. Content writes on either status return `423`.
- Page owners manage their own page. Administrators need the configured security-key step-up for admin routes.
  Sensitive actions need a key check within two minutes. Ordinary actions allow fifteen minutes.
- Cursors are opaque. Send `nextCursor` back as `cursor`. Do not construct or change it.

## Account and preferences

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/me` | Public | No query | `{viewer, streamer, support, access, providers, signInProvider}`. Absent account fields are null |
| `GET /api/account/export` | Signed in | No query. The server rejects cross-site downloads | Downloadable JSON account export with `no-store` |
| `POST /api/account/delete` | Recent sign-in | `{confirm: "DELETE"}` | `{deleted: true}`. Expires the session |
| `PATCH /api/profile` | Signed in | `{name?, avatarPreset?: 0..17 or null}`. At least one field | `{viewer}` |
| `PATCH /api/me/locale` | Signed in | `{locale: Locale or null}` | `{locale}` |
| `PATCH /api/me/preferences` | Signed in | Complete `DisplayPrefs` | `{preferences}`. Replaces saved preferences |
| `POST /api/preference-cookies` | Public | `{locale?, prefs?: DisplayPrefs}` | `204`, preference `Set-Cookie` headers |

`Viewer` includes `avatarPreset`, `locale`, and `displayPrefs`. A null preset uses preset 14.
Uploaded avatars take precedence over presets. Selecting a preset does not delete the upload.

`signInProvider` is `google`, `tiktok`, `twitch`, `instagram`, or null.
Page owners receive `support: {links, visible, card}`. Other viewers receive `support: null`.
Better Auth's `/api/auth/*` routes handle sign-in, sign-out, provider callbacks, and account linking.

These routes use a separate registry.

- The API does not support `POST /api/profile` or `/api/account`. Use `POST /api/streamer`, `PATCH /api/streamer`, and `PATCH /api/profile`.
- `Streamer.ownerAvatarPreset` is `number | null`. Pictures use this order: logo, uploaded avatar of the owner, owner preset, preset 14.
- `/settings` redirects `302` to `/streamers?dialog=profile`.
- Account dialogs use `?dialog=profile`, `host`, `data`, or `page` over the current page.
- Directory `?intent=suggest` opens topic creation or sign-in. `?intent=discuss` opens the top topic's discussion.
- Applications hide placeholder emails from TikTok and Instagram: `{id}@tiktok.invalid` and `{id}@instagram.invalid`.

## Pages and content

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/streamers` | Public | `query?` (60 characters), `cursor?` | `{streamers, nextCursor}`. Official pages first. Excludes suspended pages |
| `GET /api/streamers/:handle` | Public | `kind?: topics or polls`, `sort?: newest or top`, `query?`, `cursor?`, Ideas `status?` | Board snapshot with `streamer`, `entries`, and `nextCursor` |
| `POST /api/streamer` | Approved account or admin | `{handle, name, about}` | `{streamer}`. `409` if already owned |
| `PATCH /api/streamer` | Owner | `{name?, about?, handle?, logoMode?: profile or logo}` | `{streamer}`. At least one field |
| `POST /api/streamers/:handle` | Signed in with rights for the action | Entry action below | Action result. Refreshes the live room |
| `GET /api/entries/:id` | Public | No query | `{entry}` |
| `GET /api/entries/:id/comments` | Public | `sort?: newest or top`, `cursor?`, `view?: flat or thread` | `DiscussionSnapshot` or `ThreadSnapshot` |
| `POST /api/comments` | Signed in | `{action: "like", id, liked}`, `{action: "delete", id}`, or `{action: "edit", id, text, mentions?}` | Comment mutation result. Only authors can edit |
| `GET /api/comments/:id` | Public with page access checks | No query | `{comment, rootId, thread, handle, entryId}` |
| `GET /api/entries/:id/mention-candidates` | Signed in | `query?`, at most 40 characters | `{users}`. At most 10 public profiles or community participants |
| `PUT /api/images/:kind` | Signed in. Owner for page images | Raw PNG, JPEG, or WebP, at most 5 MB. `kind`: `avatar`, `background`, or `logo` | `{url}` |
| `DELETE /api/images/avatar` | Signed in | No body | `{avatar: null}` |
| `DELETE /api/images/logo` | Owner | No body | `{logo: null}` |
| `GET /images/:key` | Public | Stored image key | Image bytes. `HEAD` omits the body |

Entry actions:

| Action | Fields and rights |
| --- | --- |
| `create` | `kind: topic, choice, or binary`, `title`, `body?`, `category?`, `options?`, `duration?`. Topics need details, category, and a title of at most 100 characters. Only the owner can create polls. Choice polls need 2-6 distinct options. Binary polls accept exactly two distinct labels and otherwise use the host account language. Duration is 0 or 15-3600 seconds. |
| `create` with `kind: mash` | Owner. Creation schema for Mash Battle in `app/server/mash.server.ts` |
| `vote` | `{id, choice: 0..5}`. Valid option on an open poll |
| `react` | `{id, value: -1, 0, or 1}` |
| `reveal` | `{id}`. Owner |
| `delete` | `{id}`. Author, owner, or stepped-up admin, subject to page rules |
| `comment` | `{id, text, parentId?, mentions?}`. Text at most 2000 characters |

Handle changes need thirty days. A `409` with code `handle_cooldown` includes `details.retryAt`, an ISO timestamp for the next allowed change.
Old page and overlay links stop working without redirects.

`logoMode: profile` removes the upload. `logoMode: logo` needs an existing upload.
Owners receive `statusReason` and `handleChangedAt`. Administrators receive the reason. Other viewers receive null.

Removed parent comments keep replies but expose no author or text and no controls to like, report, or delete.
Comment counts exclude removed placeholders. Thread view returns a page of parent comments with replies at every depth, oldest first.

`Entry.reported` and `Comment.reported` identify the viewer's open report.
Ideas on official pages use categories `feature`, `bug`, `design`, `a11y`, or `lang` and start in `review`.
Authors can delete Ideas only during `review`. The server rejects untouched bug templates.

## Discussion notifications

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/notifications` | Signed in | Optional opaque `cursor` | `NotificationSnapshot`: at most 50 notifications, unread count, preferences, and next cursor |
| `POST /api/notifications` | Signed in | `{action: "read", id, read}` or `{action: "preferences", replies, mentions}` | `{ok: true}`. Only the recipient can change read state |

Comments include `editedAt` and `mentions`. Each mention contains `{userId, start, end}`.
Offsets use UTF-16 indices into the exact comment text. Do not trim the text before sending it.

Each new selection must match `@name` for an available account. Select up to five distinct accounts.
An edit can keep an existing mention after the recipient changes their name.

Plain `@name` text without a selection does not send a notification.
New replies and selected mentions send in-app notifications. The sender receives none.
If a reply also mentions its parent author, preferences select one notification type.

Edits do not send notifications. Removing a mention deletes its notification.
The inbox and exact-comment lookup omit deleted comments and inaccessible pages.

Notifications contain no comment excerpts and link to the current comment.
The service does not send email or push notifications.
Each inbox keeps up to 200 notifications for up to 90 days. The next delivery deletes expired records.

Each sender can send up to 100 notifications per hour, with at most 10 per recipient.
Existing content quotas also apply.

## Schedule and community

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/streamers/:handle/events` | Public | UTC-millisecond `from`, `to`. Both needed. Span at most 200 days | `{events, serverNow}`. Overlapping streams, oldest first, at most 500 |
| `POST /api/events` | Owner | `{title, notes?, date, time, tz, durationMin, platform, url, repeatDays?, repeatUntil?, topicIds?}` | `{event}` for the first occurrence |
| `PATCH /api/events/:id` | Owner | `{action: "edit", scope, ...}`, `{action: "cancel"}`, or `{action: "replay", vodUrl}` | `{event}` |
| `DELETE /api/events/:id` | Owner | Optional `{scope: one or following}` | `{deleted: true}` |
| `GET /@:handle/schedule.ics` | Public | No query | `text/calendar`. Public cache for 300 seconds |
| `PUT /api/community-cards` | Owner | `{cards: [{icon, title, body, buttonLabel, buttonTarget}]}`. At most 8 | `{cards}`. Atomic replacement |
| `PUT /api/support-links` | Owner | `{links: [{kind, label, url}], visible, card}`. At most 4 | `{links, visible, card}` |

`date` is `YYYY-MM-DD`, `time` is `HH:MM`, and `tz` is an IANA zone.
Weekly `repeatDays` uses bit 0 for Sunday and includes the initial date's weekday.
Occurrences extend twelve weeks ahead. Local times survive daylight-saving changes.

Scope `following` replaces this and later occurrences. `one` changes only this occurrence.
Cancellation keeps the occurrence with status `cancelled` and calendar `STATUS:CANCELLED`.
Card targets accept `tab:topics`, `tab:polls`, `tab:schedule`, `tab:about`, `tab:community`, or HTTPS.

Support URLs need HTTPS and the provider domain. Kind `other` accepts a public host and needs `label`.

## Overlay and Mash Battle

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/overlay` | Owner | No body | `{overlay, data, handle}` |
| `POST /api/overlay` | Owner | `preview`, `take`, `layout`, or `message` action from `overlayActionSchema` | `{overlay}` |
| `POST /api/overlay/key` | Owner | `{}` | `{url}`. Shows a new key once and revokes the previous key |
| `POST /api/mash/:id/start` | Owner | `{countdown?}` | `{ok: true}` |
| `POST /api/mash/:id/end` | Owner | `{}` | `{ok: true}` |
| `POST /api/mash/:id/restart` | Owner | `{}` | `{ok: true}` |
| `GET /api/live/:handle` | Public WebSocket | WebSocket upgrade. Optional overlay `key` | Live room. Owners with a session can control the room. Invalid keys join as signed-out viewers |

Mash taps use the live WebSocket. The schemas in `app/server/overlay.server.ts` and
`app/server/mash.server.ts` define the action fields.

## Overlay layers

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/overlay` | `{action: "layers", write?, orientation?, chat?: {enabled?, hideCommands?}, characters?: {enabled?, timeout?}, cells?: {horizontal?, vertical?}}` | `{overlay}`. The whole new `OverlayState`, with `layers` |
| `POST /api/overlay` | `{action: "chatTest", on: boolean}` | `{overlay}`. The whole new `OverlayState`, with `chatTestUntil` |
| `POST /api/overlay/characters` | `{op: "status" \| "test" \| "stopTest" \| "pause" \| "resume" \| "reset"}` or `{op: "remove", id}` | `{paused, testEndsAt}`. The state of the character playground |
| `GET /@handle/overlay?key&layer` | Optional `layer`: `content`, `chat`, or `characters` | The overlay page. Without `layer`, it shows the composition. With `layer`, it shows that layer alone. An unknown value shows an empty page. |

- `orientation` is `horizontal` (a grid of 16 × 9 cells) or `vertical` (9 × 16 cells). A cell is 120 pixels.
- Each orientation in `cells` holds `{chat?, characters?, content?}`. Each value is a cell rectangle `{c, r, w, h}` of whole cells.
  `c + w` is at most the number of columns, and `r + h` is at most the number of rows.
- `content` accepts `null`. Then the content uses the full frame and its position and size settings.
- The minimum size is 3 × 2 cells for `chat`, 6 × 2 for `characters`, and 4 × 2 for `content`.
- After the merge, no two layers can overlap in an orientation. A content layer without a cell does not count.
- `write` is `{writer, seq}`. `writer` is a random ID of 8 to 64 letters, digits, `_` or `-`. `seq` is a positive integer.
  The server keeps the largest applied `seq` of each of the last 8 writers. It ignores a change with a `seq` that is not larger than the kept `seq` of its `writer`.
  The server then answers `200` with the current state and does not notify the overlay pages. A change without `write` always applies.
- The body changes only the fields that it names. The API merges each field into the saved layers.
  Thus send only the fields that you change. Unknown fields return `400`.
- The change goes live at once. Overlay pages get the new `layers` through the live room.
- `chatTest` with `on: true` sets `chatTestUntil` to the server time plus 60 seconds. With `on: false` it sets 0.
  `on: true` returns `400` when the chat layer is off. `on: false` always applies.
  A `layers` action that sets the chat layer to off also sets `chatTestUntil` to 0.
  Overlay pages get the value through the live room. A time in the past means no test.
- `characters.timeout` is the time in seconds without chat before a character walks out. It is a whole number from 10 to 600. The default is 60.
- Each `layers` action and each `chatTest` action with `on: true` counts against the write quota of 60 changes each minute.
- `POST /api/overlay/characters` controls the character playground of the page:
  - `status` changes nothing. It only returns the state.
  - `test` starts the characters test for 5 minutes, or starts it again. It also ends a pause.
    It returns `400` when the saved characters layer is off.
  - With the saved characters layer off, the playground keeps nothing. Then each operation returns `{paused: false, testEndsAt: null}`, and `remove` returns `404`.
  - `stopTest` stops the test. `pause` and `resume` stop and start the playground. `reset` removes all characters.
  - `remove` removes the character with the frame `id`. It returns `404` when no character has that `id`.
  - `testEndsAt` is the server time at which the test ends, or `null` when no test runs.
  - `test`, `reset`, and `remove` count against the write quota. The other operations do not.
  - It returns `503` while the `CHANNELS_OFF` secret exists, when the deployment has no `CHANNEL_INGEST` binding, or when the playground cannot answer.
- The action changes the streamer page of the signed-in user. A user who does not own a page gets `404`.
- Errors: `400` for an invalid body, a cell outside the grid, or overlapping layers, `401` without sign-in, and `403` for another origin.
  Also `404` without a streamer page, `409` when concurrent saves conflict, `423` for a frozen or suspended page, and `429` above the quota.
- `OverlayState.layers` and `OverlayPublic.layers` are `{orientation, chat: {enabled, hideCommands}, characters: {enabled, timeout}, cells: {horizontal, vertical}}`.
  Each orientation in `cells` is `{chat, characters, content}`. `content` is a cell or `null`.
  Missing, unknown, or incorrect stored fields take the defaults. Reads never fail because of a stored `layers` value. Chat and characters are off by default, and `hideCommands` is on.
- See [Overlay composition and merged chat](overlay-composition.md) for the layers, the URLs, the chat test, and the chat limits.

## Channel connections and activity

| Method and path | Access | Input | Response |
| --- | --- | --- | --- |
| `GET /api/channels` | Owner | No query | `{channels: [{platform, available, connection, capabilities}]}` |
| `POST /api/channels/:platform/connect` | Owner, recent sign-in | `{}` | `{authorizeUrl}`. Browser continues at provider |
| `POST /api/channels/:platform/reconnect` | Owner, recent sign-in | `{}` | `{authorizeUrl}`. Keeps connection row |
| `DELETE /api/channels/:platform` | Owner, recent sign-in | No body or `{}` | `{revoked}`. `404` if absent. `409 channel_conflict` after a concurrent change |
| `GET /channels/callback/:platform` | Matching owner session | Provider query | Redirect to `/overlay-control?channel=<platform>&result=<code>` |
| `GET /api/activity/:handle` | Owner or current overlay key | WebSocket upgrade. Optional `key` and `characters=1` | Activity feed. `characters=1` also sends playground frames. `400` for unsupported parameters, `426` without upgrade, `403` unauthorized, `404` missing or suspended, `503` disabled |
| `POST /hooks/twitch` | Provider signature | Raw EventSub body and Twitch signature headers | `204`. Subscription challenge returns `200`. Unknown-channel notifications return `410` |
| `POST /hooks/kick` | Provider signature | Raw provider body and Kick signature headers | `204` |

Platforms are `twitch`, `youtube`, and `kick`.
Connection fields are `displayName`, `status`, `code`, `connectedAt`, `lastEventAt`, and `updatedAt`.
Tokens and scopes never appear in responses. `updatedAt` changes with status or code.

Connection writes need sign-in within ten minutes. Otherwise they return `403 reauth_required`.
They consume the content quota of six changes per minute.
A connect returns `423` on a frozen or suspended page. A disconnect remains available on a frozen page.

Missing provider credentials return `503 platform_unavailable`.
Callback results: `connected`, `denied`, `state_invalid`, `session_mismatch`, `channel_taken`,
`disconnect_first`, `scope_missing`, or `failed`.

Webhooks reject invalid signatures or stale timestamps with `403`, large bodies with `413`,
floods of forged webhooks with `429`, and unavailable verification or ingestion with `503`.
`CHANNELS_OFF=1` disables connections and activity. The server acknowledges and drops Kick deliveries.
Twitch still processes revocations. See [Channel connections and activity](channel-connections.md).

## Applications and moderation

All `/api/admin/*` routes need administrator rights and security-key policy checks.

| Method and path | Input | Response |
| --- | --- | --- |
| `POST /api/application` | Signed in. `{links: [HTTPS channel URL], note?}`. 1-5 distinct links | `{application}` |
| `GET /api/admin/applications` | `status?: pending, approved, or rejected`, `cursor?` | Application page |
| `POST /api/admin/applications` | `{id, decision: approved or rejected}` | `{application}` |
| `POST /api/reports` | Signed in. `{targetKind: entry or comment, targetId, reason, details?}` | `{report}` |
| `GET /api/admin/reports` | `status?: open, actioned, or dismissed`, `cursor?` | Report page |
| `POST /api/admin/reports` | `{id, action: remove or dismiss}` | `{status, resolved}` |
| `GET /api/admin/streamers` | `status?: all, active, frozen, or suspended`, `query?`, `cursor?` | Moderation page list |
| `POST /api/admin/streamers/:id` | `{action: freeze, unfreeze, suspend, or unsuspend, reason, note?, notify?}` | `{page, emailed}` |
| `POST /api/admin/streamers/:id/official` | `{official: boolean}`. Sensitive key check | `{page}` |
| `GET /api/admin/report-groups` | `status?: open, resolved, or all`, `query?`, `cursor?` | Grouped report page |
| `GET /api/admin/report-groups/:id` | `status?: open, resolved, or all`, `cursor?` | Reported items for the page |
| `POST /api/admin/reports/resolve` | `{streamerId, action: dismiss}` or `{targetKind, targetId, action: remove or dismiss}` | `{status, resolved}` |
| `POST /api/admin/entries/:id/remove` | `{reason, note?}` | `{removed, resolved}` |
| `POST /api/admin/entries/:id/status` | `{status: review, planned, progress, shipped, declined, or null, reason?}` | `{id, status, statusReason}` |

Report reasons: `illegal`, `harassment`, `spam`, `privacy`, or `other`.
`illegal` and `other` need details. Moderation reasons use `MODERATION_REASONS` in `app/types.ts`.

Freezing and suspending need a key check within two minutes.

## Administrator security keys

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/admin/stepup` | No query | Current enforcement, enrollment, and verification status |
| `POST /api/admin/stepup/options` | No body needed | WebAuthn authentication options |
| `POST /api/admin/stepup/verify` | `assertionSchema` | Verification result for this session |
| `GET /api/admin/keys` | Verified admin session | `{keys}` |
| `POST /api/admin/keys/options` | Enrollment authorization | WebAuthn registration options |
| `POST /api/admin/keys` | `registrationSchema` | `201 {key}` |
| `PATCH /api/admin/keys/:id` | `{name}`. Verified admin session | `{id, name}` |
| `DELETE /api/admin/keys/:id` | Key-removal authorization | `{removed}` |

See WebAuthn schemas and rules for enrollment and recovery in `app/server/stepup.server.ts`.

## Public counters

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/ai-interest` | No query | `{available, totals: {up, down}, mine}` |
| `POST /api/ai-interest` | `{vote: up or down, agent?}` | `{counted, totals}`. One unverified visitor vote per day |
| `POST /api/conversions` | `{id: UUID, event: CTA_EVENTS}` | `{counted}`. Duplicate IDs do not count twice |

See `CTA_EVENTS` in `app/lib/conversions.ts`. Clients report clicks only. Committed writes count completions.
