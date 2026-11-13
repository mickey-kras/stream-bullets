# API reference

Handlers: `app/server/api/*.ts`. Registry: `app/server/api/index.ts`. Types: `app/types.ts`.

Reads (`GET`/`HEAD`) allow signed-out access unless noted.
Writes need sign-in, exact origin, and no query string. Failures return `401`, `403`, or `400`.
Unknown paths return `404`. Unsupported methods on known paths return `405`.

## Changed response shapes

| Type or route | Contract |
| --- | --- |
| `Viewer` | `avatarPreset: number \| null` (0-17. Null defaults to 14), `locale: Locale \| null`, `displayPrefs: DisplayPrefs \| null`. |
| `Streamer` | `logo: string \| null`, `isOfficial: boolean`, `status: "active" \| "frozen" \| "suspended"`, `statusReason`, `handleChangedAt`. Only owners receive both last fields. Administrators also receive the reason. Others receive null. |
| `Entry` | Ideas `status`: `review`, `planned`, `progress`, `shipped`, `declined`, or null. `statusReason`. Comment counts exclude removed placeholders. |
| `Comment` | `removed: boolean`. Removed parents keep replies with empty `author`, `authorId`, and `text`, null `avatar`, and zero `likes`. Render "Comment removed" without like, report, or delete controls. |
| Moderated-page writes | `423` for frozen or suspended pages. Suspended pages return `404` to users other than owners and administrators. |
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

- Handle changes need 30 days. Early changes return `409` with the next allowed date.
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

## Later phases

Overlay, Mash Battle, admin, step-up, and AI-interest handlers now exist in the registry.
For complete route definitions, inspect their modules in `app/server/api/`.
New modules export `ApiRoute[]` through `get()` and `write()` and join `apiRoutes` in `index.ts`.
Streamer-page writes must call `assertStreamerWritable()`.
