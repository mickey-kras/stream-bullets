# Overlay composition and merged chat

The overlay page shows a composition of layers in one transparent browser source.
The chat layer shows the merged chat of the connected Twitch, YouTube, and Kick channels.
The owner places each layer in **Overlay control**. Changes go live at once.
The chat reads the activity feed of [Channel connections and activity](channel-connections.md).
It makes no provider connection of its own.

The code is in these files:

| Part | File |
| --- | --- |
| Layer model, limits, and URL helpers | `app/lib/overlay-layers.ts` |
| Chat state machine and sample chat | `app/lib/chat-feed.ts` |
| Activity socket client | `app/lib/activity-socket.ts`, `app/components/overlay/activity-feed.tsx` |
| Chat rows and the composition | `app/components/overlay/chat-layer.tsx`, `app/components/overlay/overlay-composition.tsx` |
| Editor | `app/components/overlay/composition-editor.tsx` |
| Overlay page | `app/routes/overlay.tsx` |
| Layer action | `app/server/overlay.server.ts`, `app/server/api/live.ts` |

## Layers

The composition has three layers. This list starts at the bottom layer:

1. `characters`: the interactive characters. This layer comes with issue #664. Until then it shows nothing.
2. `content`: the on-air poll, topic, card, or message. It keeps its own position and size settings.
3. `chat`: the merged chat. It is on top of the other layers.

The chat layer and the characters layer are off by default. Thus an existing OBS scene does not change.
The theme is separate from the layout and the behavior. The overlay has one theme, the wasteland theme.

## Design space

All layers use one fixed design space of 1920 × 1080 pixels.
A layer rectangle has four integers: `x`, `y`, `w`, and `h`.
The rectangle must stay in the frame: `x + w` is at most 1920 and `y + h` is at most 1080.

| Layer | Default rectangle | Minimum size |
| --- | --- | --- |
| `chat` | `x` 1240, `y` 372, 640 × 660 | 280 × 160 |
| `characters` | `x` 0, `y` 760, 1920 × 320 | 640 × 160 |

The page scales the design pixels to the width of the browser source. Thus the layout is the same at all sizes.

The overlay reads stored and broadcast layers leniently. Thus a value from an older or newer version never stops the page:

- It ignores unknown fields.
- A field with an incorrect value takes its default value.
- A rectangle outside the frame or below the minimum size takes the default rectangle of its layer.
- A layer with an incorrect value takes the defaults of that layer.

The API is strict for changes. See [Overlay layers](api.md#overlay-layers).

## URLs

The overlay page has one URL for the composition:

```text
https://<origin>/@<handle>/overlay?key=<key>
```

Add the `layer` parameter to show one layer alone. Use one browser source for each layer:

```text
https://<origin>/@<handle>/overlay?key=<key>&layer=chat
https://<origin>/@<handle>/overlay?key=<key>&layer=content
https://<origin>/@<handle>/overlay?key=<key>&layer=characters
```

A layer source keeps the aspect ratio of its layer and uses as much of the viewport as possible.
It aligns the layer with the bottom-right corner of the viewport. Thus the newest chat rows are always visible.
The free space stays transparent, at the left or at the top.

An unknown `layer` value shows an empty transparent page. It never shows an error.
The `poll` parameter still selects a poll for the content layer.

The characters layer URL shows nothing until issue #664. Until then, it opens no live-room socket,
and **Overlay control** does not show it.

**Overlay control** shows the full URL and the layer URLs once, when you make a new key.
The server keeps only the SHA-256 hash of the key. Thus it cannot show the URL again.
If you have the composition URL, add `&layer=chat` to its end for a chat source.
If you lost the URL, select **Regenerate link**. Then update all OBS sources.

## OBS browser source

Use a browser source of 1920 × 1080 for the composition. A size of 1280 × 720 also works.
Keep the 16:9 aspect ratio. With a different ratio, the layer heights do not agree with their contents.
For a layer source, use the size of its layer rectangle, or the same ratio at a smaller size.
The editor and the link panel show the size of each layer.

A larger layer source shows the layer larger.

The overlay background is transparent, so you do not need custom CSS.

After you update to the release with the chat layer, refresh each open OBS source one time.
An OBS source that opened before this release does not show the chat.
The editor shows this step under **Show on stream** for the chat layer.

### Live-room seats

Each OBS source with the overlay key uses one of the 10 owner seats of the live room.
The signed-in tabs of the streamer use the same seats.
When all 10 seats are full, a new connection replaces the oldest owner connection.
Thus, where possible, use one composition source for each scene, not one source for each layer.
See [live capacity](live-room-capacity.md).

## Editor

The **Composition** section of **Overlay control** shows a preview of the 1920 × 1080 frame.
The preview uses the same code as the OBS page. Thus the layer positions in the preview and in OBS agree.
Under **Preview background**, select **Transparent** or **Sample game**.

To change a layer, do these steps:

1. Select **Show on stream** for the layer.
2. Drag the layer to move it. Drag its corner to change its size.
3. Alternatively, use the arrow keys. An arrow key moves the layer 1 pixel. Shift and an arrow key move it 10 pixels.
4. Alternatively, type the values in the `X`, `Y`, `Width`, and `Height` fields.

A drag saves when you release the pointer. A key or a field saves after 400 milliseconds without a change.
If you close the page or go to a different page before then, the editor sends the change at once.
Each save counts against the write quota of 60 changes each minute.
If a save fails, the editor shows the saved layers again.
If two saves finish in a different sequence, the editor keeps the result with the higher revision.

When the chat layer covers part of the on-air content in the preview, a note shows under the preview.
Move the chat layer to a free area to remove the note. The note does not stop a save.
The default chat rectangle is in the bottom-right corner, 40 pixels from the right edge and 48 pixels from the bottom edge.
A poll fills the top of the frame and can go below `y` 372. Thus with a poll on air, the note can show for the default rectangle.

The preview plays sample chat. It opens no activity socket and reads no live chat.
The samples include all three platforms, Unicode text, emoji, an emote, and a command.

## Chat behavior

The chat shows one row for each message. Each row has a platform badge, the user name, and the message.
Each platform has its own color: YouTube red, Twitch purple, and Kick green.
The badge also has a shape and an accessible platform name. Thus the color is not the only cue.
The newest row is at the bottom.

The layer clips rows at the top. The chat keeps the order in which the messages arrive. The send time from the platform does not change the order.

| Item | Limit |
| --- | --- |
| Rows on screen | 40. The oldest row leaves first. |
| Lifetime of a row | 2 minutes |
| Visible characters of a message | 200. An emote counts as one character. A cut never splits an emoji. |
| User name | 20 characters, with an ellipsis at the end of a longer name |
| Badge labels | 2 for each row |
| Messages that wait to show | 8. A full queue drops its oldest message. |
| Time between two new rows | 150 milliseconds |

In a burst, fresh chat is more important than complete chat.
When more than 4 messages wait, the chat shows all of them at once, without animation.
The chat also limits the number of rows that leave at the same time.

### Moderation

| Event | Result |
| --- | --- |
| `delete` | The row shows "message removed by a moderator" for 1.4 seconds. Then the row closes. |
| `ban`, `clear_user` | All rows of that user on that platform show the removed state. Then they close. |
| `clear` | All rows of that platform leave. |

Each moderation event also removes the matching messages that wait to show.
The chat keeps the IDs of removed messages. Thus a late copy of a removed message does not show again.

### Commands

The chat hides commands by default. A command is a message that starts with `!` and a word, such as `!jump`.
The full-width `！` also starts a command. A message that starts with `!` and no word, such as `! hi` or `!!!`, is not a command.

To show commands, clear **Hide chat commands (!jump)** in the editor.
When you select the option again, the chat also hides the command rows that are on the screen.
The chat never runs a command. It only shows or hides the message.

### Reconnection

The page keeps one activity socket. It connects again after each failure, with backoff and jitter.
The first wait is 1 second. The wait doubles after each failure, up to 60 seconds.
When the socket opens, the server sends a snapshot of recent chat.

The snapshot is the truth for its time window. The chat removes rows that are missing from it.
Rows from a snapshot never animate. Rows on screen stay and do not animate again.
The chat adds only the snapshot rows that are newer than the newest row on screen. Thus a reconnect never shows a row twice.

An `unavailable` message clears the chat. The server sends it when the key changes or when an administrator suspends the page.
The page then keeps trying with a longer wait.

For troubleshooting, the root element of the overlay page has the `data-feed-status` attribute.
It shows the status of the activity feed.

## YouTube quota and sockets

The server polls YouTube chat only while at least one activity socket of the page is open.
Each open activity socket keeps the poll alive, and each poll costs YouTube quota.
Thus close the overlay sources that you do not use.

- The page opens an activity socket only when it shows an enabled chat layer. Hide the chat layer to close it.
- The editor preview opens no activity socket.
- Each browser source opens its own sockets. A layer source uses one live-room socket.
  A chat source also uses one activity socket. The characters layer source opens no socket until issue #664.
- A page can have at most 20 activity sockets (`MAX_SOCKETS`).
- Valid-key overlays and the owner share 10 owner seats in the live room. See [Live-room seats](#live-room-seats).

## Security

- The chat shows user names, messages, and badge labels as text. It never inserts them as HTML.
- An emote image loads only from a host in `EMOTE_HOSTS`, over HTTPS. Other emotes show their name as text.
- On all pages, the Content Security Policy allows images from the site, `blob:` URLs, `data:` URLs,
  and each host in `EMOTE_HOSTS` over HTTPS (`https://static-cdn.jtvnw.net`).
  The policy applies to a full page load. A link in the app opens **Overlay control** without a new page load.
  Thus a policy only for that page does not apply to the preview.
- The Twitch image CDN gets the IP address of the device that shows an emote. The privacy policy (`/privacy`) names this recipient.
- The overlay page sends no `Referer`. Thus an emote image does not get the key.
- The overlay key gives access to the activity feed. Without a valid key or an owner session, the socket gets `403`.
- **Regenerate link** makes a new key. The old key stops at once, and its open sockets close.
- The chat ignores `user.color`. It uses the theme colors only.

## Limits and known gaps

- The characters layer shows nothing until issue #664. Its editor control stays disabled until then.
- The overlay has one theme. There is no theme selection.
- Layer edits go live at once. They have no preview and take step.
- Kick has no message deletion events. YouTube has no clear events. See the capability matrix in
  [Channel connections and activity](channel-connections.md#capability-matrix).
