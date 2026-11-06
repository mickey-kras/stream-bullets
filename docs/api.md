# API changes for the mockup build (Phase 2)

The endpoints live in `app/server/api/*.ts` as one handler table (`app/server/api/index.ts`).
Reads (`GET`/`HEAD`) work signed out unless noted. Writes need a signed-in, same-origin call with
no query string, and answer `401`, `403` or `400` otherwise. Unknown paths answer `404`. A known
path with another method answers `405`. Types are in `app/types.ts`.

## Changed response shapes

| Where | Change |
|---|---|
| `Viewer` (`GET /api/me`, route loaders) | Adds `avatarPreset: number \| null` (0–17, and null shows preset 14), `locale: Locale \| null`, `displayPrefs: DisplayPrefs \| null`. |
| `Streamer` (directory, boards, `GET /api/me`) | Adds `logo: string \| null` (fall back to `avatar`, then the default spaceman), `isOfficial: boolean`, `status: "active" \| "frozen" \| "suspended"`, `statusReason` and `handleChangedAt`. Only the owner gets the last two, and admins also get the reason. Everyone else gets null. |
| `Entry` | Adds `status` (Ideas board: `review`, `planned`, `progress`, `shipped`, `declined`, or null) and `statusReason`. `comments` no longer counts "Comment removed" placeholders. |
| `Comment` | Adds `removed: boolean`. A removed comment that still has replies stays in the list as a placeholder with `author`, `authorId` and `text` set to `""`, `avatar: null` and `likes: 0`. Render "Comment removed". Users cannot like, report or delete it again. |
| Writes to a moderated page | Answer `423` with a message when an admin freezes or suspends the page. On a suspended page, anyone but the owner and admins gets `404`. |
| `GET /api/streamers` | Official pages come first, the list does not include suspended pages, and a `query` parameter (≤ 60 characters) matches the name or handle. Pass `nextCursor` back as `cursor` (it can now look like `1.handle`). |
| `GET /@handle`, `GET /api/streamers/:handle`, `GET /api/entries/:id` | `404` for a suspended page unless you are its owner or an admin. |
| `GET /@handle/overlay`, `/api/live/:handle` | `404` for a suspended page, for everyone. |

## New endpoints

| Endpoint | Body | Response |
|---|---|---|
| `PATCH /api/profile` | `{name?, avatarPreset?: 0..17 \| null}` (at least one) | `{viewer}` |
| `PATCH /api/me/locale` | `{locale: Locale \| null}` | `{locale}` |
| `PATCH /api/me/preferences` | the whole `DisplayPrefs` object. It replaces the saved object. Debounce by 1 s. | `{preferences}` |
| `PATCH /api/streamer` | `{name?, about?, handle?, logoMode?: "profile" \| "logo"}` (at least one) | `{streamer}` |
| `PUT /api/images/logo` | the image file with its `Content-Type` (PNG, JPEG or WebP, ≤ 5 MB) | `{url}` |
| `DELETE /api/images/logo` | none | `{logo: null}` |
| `GET /api/entries/:id/comments?view=thread` | `sort` and `cursor` as before | `{comments: CommentThread[], nextCursor}`: top-level comments paged, each with `replies` (every depth, oldest first, with `parentId`) |

Notes:
- A handle can change once every 30 days (`409` with the next allowed date). Old links stop working,
  and the link to the overlay also stops working. There are no redirects. Show the warning before saving.
- `logoMode: "profile"` (or `DELETE /api/images/logo`) drops the uploaded logo. `logoMode: "logo"`
  needs an uploaded logo (`400` otherwise).
- A preset avatar does not remove an uploaded picture: `avatar` wins when the viewer has both. The profile
  dialog decides which one to keep.

## Phase 3 changes

| Endpoint | Body | Response |
|---|---|---|
| `POST /api/streamer` | `{handle, name, about}` | `{streamer}`. It creates the page for an approved account or an admin. A second page gets `409`. |
| `DELETE /api/images/avatar` | none | `{avatar: null}`. The account then shows its preset, or the default. |
| `GET /api/me` | none | Adds `signInProvider`: `"google"`, `"tiktok"`, `"twitch"`, `"instagram"` or null. |

- Phase 3 removes `POST /api/profile` and `POST /api/account`. The settings page used them. Use
  `POST /api/streamer`, `PATCH /api/streamer` and `PATCH /api/profile`.
- `Streamer` adds `ownerAvatarPreset: number | null`. The page logo falls back to the uploaded logo,
  then the uploaded owner picture, then this preset, then preset 14.
- `/settings` answers `302` to `/streamers?dialog=profile`.
- Each account dialog opens over the current page with `?dialog=profile`, `host`, `data` or `page`.
- The directory card links carry the landing intent. `?intent=suggest` asks the streamer page to open
  Suggest a topic, or the sign-in dialog for a signed-out visitor. `?intent=discuss` asks it to open
  the discussion of the top topic. The streamer page (Phase 4) reads these parameters.
- The application queue shows an empty email for TikTok and Instagram accounts. These accounts have
  a placeholder address (`{id}@tiktok.invalid` or `{id}@instagram.invalid`) that is not real.

## Not done in Phase 2

- Schedule, Community cards, support links, overlay control, Mash Battle, admin moderation,
  step-up and the AI-interest counter have tables (migrations 0008–0012) but no endpoints yet. Each
  later phase adds one `app/server/api/<feature>.ts` and one line in `app/server/api/index.ts`.
