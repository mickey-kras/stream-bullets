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
| Chat appearance and motion | `app/components/overlay/wasteland/`, `app/components/overlay/use-row-motion.ts` |
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
| `chat` | `x` 979, `y` 73, 826 × 934 | 280 × 160 |
| `characters` | `x` 0, `y` 760, 1920 × 320 | 640 × 160 |

The page scales the design pixels to the size of the browser source.

When the chat layer is on, the composition puts all of its layers, the content too, in one 1920 × 1080 canvas.
This canvas is the same as the canvas of the editor preview. Thus the layout is the same at all 16:9 sizes, and the same as in the preview.
If the source is not 1920 × 1080, the on-air content changes size when the chat layer comes on.
The editor shows this note under **Show on stream** for the chat layer.

With a source that is not 16:9, the full canvas stays in the source. The free space is at the right or at the bottom.
When no feed layer is on, the content layer keeps its responsive layout. Thus an existing OBS scene does not change.

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

Use a browser source of 1920 × 1080 for the composition. A different 16:9 size, such as 1280 × 720, also works.
Use a 16:9 source. With the chat layer on, all 16:9 sizes show the same layout as the preview.
For a layer source, use the size of its layer rectangle, or the same ratio at a smaller size.
The editor and the link panel show the size of each layer.

A larger layer source shows the layer larger.

The overlay background is transparent, so you do not need custom CSS.

After the update that added the chat layer, refresh each open OBS source one time.
You do this step only one time. An OBS source that opened before this update does not show the chat.
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

The editor does not wait for the result of a change that it sends while you leave.
If that change fails, the editor shows an error when you go back to it within 60 seconds.
The error names the layer of your last change, tells you to make the change again, and gives the reason.
The page scrolls to the error, so that you can see it.
The editor sends the newest value last, also while an earlier save is in progress.
A slow earlier save can still arrive after the newest value.

Each save counts against the write quota of 60 changes each minute.
If a save fails, the editor shows the saved layers again.
If two saves finish in a different sequence, the editor keeps the result with the higher revision.

When the chat layer covers part of the on-air content in the preview, a note shows under the preview.
Move the chat layer to a free area to remove the note. The note does not stop a save.

The note changes only after a move is complete, not during a drag. A screen reader reads it after your first change on the page.
The default chat rectangle is the right half of the frame, in a safe margin.
The margin is 5% of the frame plus 19.2 pixels: 115 pixels on the right and 73 pixels at the top and bottom.
A poll fills the top of the frame. Thus with a poll on air, the note can show for the default rectangle.

The preview plays sample chat. It opens no activity socket and reads no live chat.
The samples include all three platforms, Unicode text, emoji, an emote, and a command.

## Chat behavior

The chat shows one card for each message. Each card has a platform icon, the user name, and the message.
All platform icons have the same mustard color. Each icon has its own shape and an accessible platform name.
Thus the color is not the only cue.
The newest card is at the bottom.

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
The chat also limits the number of rows that leave at the same time to 8.
This limit includes the removed rows that fade out. Thus a flood of deleted messages does not fill the layer with empty rows.

### Chat appearance

The chat uses the approved compact cards of issue #663.

| Item | Value |
| --- | --- |
| Font | Segoe UI, then Arial. Only system fonts. 26 pixels at 1080p, line height 1.22. |
| Card | Dark teal, `rgba(8, 43, 46, 0.9)`, with a 1-pixel border, `#b89649` |
| User name | Mustard, `#e5bd54`, weight 750, and a colon |
| Message | Ivory, `#f4ebce`, weight 500. A long message wraps in its card. |
| Newest card | Mustard border and a 3-pixel mustard bar on the left edge. A removed or leaving card does not get this style. |
| Badge labels | Small gray text, `#c4c2a8`, before the user name |
| Removed message | Gray italic text. In Japanese, Chinese, and Hindi, gray upright text. |
| Top edge | The column fades out in the top 18% |

A new card moves up from below its place and fades in. The other cards move up at the same time.
The movement takes 520 milliseconds. When a card goes, the column closes with the same movement.
A leaving card fades out in 300 milliseconds.

The movement uses only `transform` and `opacity`. Thus the browser does no layout during the movement.

With reduced motion, the cards do not move. The chat uses the **Motion** setting of the site or the setting of the operating system.
A reconnect snapshot and a burst show their cards at once, without movement.
When a snapshot removes a card, the card goes at once. Then the column closes with the movement.

When the activity feed is not available, the chat starts again with no cards. All cards go at once, without a fade.
A removed card fades out in 300 milliseconds from the time that it leaves the chat, also when the page is slow.

### Moderation

| Event | Result |
| --- | --- |
| `delete` | The row shows "message removed by a moderator" for 1.4 seconds. Then the card fades out and the column closes. |
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
- In the preview, the label of the characters slot shows in the wider free part of the slot beside the chat layer.
  If the chat layer leaves less than 640 pixels free on each side, the label does not show.
- The overlay has one theme. There is no theme selection.
- Layer edits go live at once. They have no preview and take step.
- Kick has no message deletion events. YouTube has no clear events. See the capability matrix in
  [Channel connections and activity](channel-connections.md#capability-matrix).
