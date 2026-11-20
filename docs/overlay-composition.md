# Overlay composition and merged chat

The overlay page shows a composition of layers in one transparent browser source.
The chat layer shows the merged chat of the connected Twitch, YouTube, and Kick channels.
The owner places each layer in **Overlay control**. Changes go live at once.
The chat reads the activity feed of [Channel connections and activity](channel-connections.md).
It makes no provider connection of its own.

The code is in these files:

| Part | File |
| --- | --- |
| Layer model, grid, limits, and URL helpers | `app/lib/overlay-layers.ts` |
| Grid edits and save patches | `app/lib/layer-geometry.ts` |
| Chat state machine and sample chat | `app/lib/chat-feed.ts` |
| Chat test | `app/lib/chat-test.ts` |
| Activity socket client | `app/lib/activity-socket.ts`, `app/components/overlay/activity-feed.tsx` |
| Chat rows and the composition | `app/components/overlay/chat-layer.tsx`, `app/components/overlay/overlay-composition.tsx` |
| Chat appearance and motion | `app/components/overlay/wasteland/`, `app/components/overlay/use-row-motion.ts` |
| Editor | `app/components/overlay/composition-editor.tsx`, `layout-grid.tsx`, `layer-palette.tsx`, `use-layer-draft.ts` |
| Overlay page | `app/routes/overlay.tsx` |
| Layer action | `app/server/overlay.server.ts`, `app/server/api/live.ts` |

## Layers

The composition has three layers. This list starts at the bottom layer:

1. `characters`: the interactive characters. See [Interactive characters](characters.md).
2. `content`: the on-air poll, topic, card, or message.
3. `chat`: the merged chat. It is on top of the other layers.

The chat layer and the characters layer are off by default. Thus an existing OBS scene does not change.
The theme is separate from the layout and the behavior. The overlay has one theme, the wasteland theme.

The model also has six source layers: `poll`, `topic`, `next`, `message`, `card`, and `support`.
Each source layer shows one content source in its own cell, at the same level as the `content` layer.
A source layer has no cell by default. Thus an existing OBS scene does not change.

The editor does not place the source layers. Only the API sets them. See [Source layers](#source-layers).

## Grid and orientation

The streamer selects the orientation of the frame. Each orientation has a grid of square cells of 120 pixels:

| Orientation | Frame | Grid |
| --- | --- | --- |
| `horizontal` (default) | 1920 × 1080 | 16 columns × 9 rows |
| `vertical` | 1080 × 1920 | 9 columns × 16 rows |

Each layer has one cell rectangle in each orientation. A rectangle has four integers: column `c`, row `r`, width `w`, and height `h`, all in cells.
The rectangle must stay in the grid: `c + w` is at most the number of columns, and `r + h` is at most the number of rows.
Two layers must not overlap. A shared edge is not an overlap.

Each orientation keeps its own layout. When you change the orientation, the layout of the other orientation stays.
The overlay shows only the selected orientation.

| Layer | Default cells, horizontal | Default cells, vertical | Minimum size |
| --- | --- | --- | --- |
| `chat` | `c` 0, `r` 0, 5 × 7 | `c` 0, `r` 8, 9 × 5 | 3 × 2 |
| `characters` | `c` 0, `r` 7, 16 × 2 | `c` 0, `r` 13, 9 × 3 | 6 × 2 |
| `content` | No cell | No cell | 4 × 2 |
| Each source layer | No cell | No cell | 4 × 2 |

The chat layer and the characters layer always have a stored cell, also while they are off.
A layer that is off is not on the grid of the editor. The server still keeps its cell free of the other cells.

The characters cell sets the size of the playground world: each cell is 40 × 40 world pixels.
A wide cell gives a long ground. A tall cell gives more sky above the ground.
In a small cell, such as the minimum of 6 × 2 cells, up to 40 characters stand close together on a short ground.
Give the characters a wide cell when your chat is busy.

The content layer can have no cell. Then it uses the full frame and its **Position** and **Size** settings, as before.
A content layer without a cell does not count for the overlap rule.

When the content has a cell, it shows in the middle of the cell. The **Position** setting does not apply then.
The **Size** setting still applies. If the content is larger than the cell, it becomes smaller until it fits.

### Source layers

A source layer is on stream when it has a cell in the selected orientation and its `enabled` setting is on.
The composition then shows the source of the layer in the middle of the cell, as for content with a cell.
A layer source URL with the `layer` parameter does not show the source layers.

Each source layer has these settings:

- `enabled`: the layer shows on stream. The default is on.
- `ref`: the poll, the topic, or the Community card that the layer shows.
  Without a `ref`, the `poll` layer shows the latest active poll and the `card` layer shows the first card.
  The `next`, `message`, and `support` layers have no `ref`.
- `backgroundOpacity`: the opacity of the card background in percent. The text stays opaque. The border and the shadow of the card stay.
- `qr`: the API stores this setting. The overlay does not show a QR code.

The `content` layer still shows the on-air source. To show only the source layers, put the **Hidden** source on air.

The stored layers have a limit of 1000 characters. The server refuses a change that goes above the limit.
With all six source layers on the grid in the two orientations, some changes to the settings can go above the limit.

The page scales the design pixels to the size of the browser source.

The composition puts all of its layers in one canvas in three cases. The chat layer is on, the content has a cell, or a source layer is on stream.
The canvas has the frame size of the selected orientation. It is the same as the canvas of the editor preview.
Thus the layout is the same at all source sizes with the same aspect ratio, and the same as in the preview.
If the source does not have the frame size, the on-air content changes size when the chat layer comes on.
The editor shows this note under **Show on stream** for the chat layer.

With a source of a different aspect ratio, the full canvas stays in the source. The free space is at the right or at the bottom.
When no feed layer is on and the content has no cell, the content keeps its responsive layout. Thus an existing OBS scene does not change.

The overlay reads stored and broadcast layers leniently. Thus a value from an older or newer version never stops the page:

- It ignores unknown fields.
- A field with an incorrect value takes its default value.
- A chat or characters cell outside the grid or below the minimum size takes the default cell of its layer.
- If the chat cell and the characters cell overlap, both take their default cells.
- An incorrect content cell, or a content cell that overlaps another layer, reads as no cell.
- An incorrect source layer cell reads as no cell. The same applies to a source layer cell that overlaps an earlier layer.
  The sequence is `chat`, `characters`, `content`, `poll`, `topic`, `next`, `message`, `card`, `support`.
- An incorrect source layer setting takes its default value.
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

A layer source keeps the aspect ratio of its cell and uses as much of the viewport as possible.
A content source without a cell keeps its responsive layout.
It aligns the layer with the bottom-right corner of the viewport. Thus the newest chat rows are always visible.
The free space stays transparent, at the left or at the top.

An unknown `layer` value shows an empty transparent page. It never shows an error.
The `poll` parameter still selects a poll for the content layer.

**Overlay control** shows the full URL and the layer URLs once, when you make a new key.
The server keeps only the SHA-256 hash of the key. Thus it cannot show the URL again.
If you have the composition URL, add `&layer=chat` to its end for a chat source.
If you lost the URL, select **Regenerate link**. Then update all OBS sources.

## OBS browser source

Set the size of the browser source for the composition to the frame size of the selected orientation:

- For the horizontal orientation, use 1920 × 1080. A different 16:9 size, such as 1280 × 720, also works.
- For the vertical orientation, use 1080 × 1920. A different 9:16 size, such as 720 × 1280, also works.

With the chat layer on, all sizes with the correct aspect ratio show the same layout as the preview.
The editor shows the correct size under the grid.
For a layer source, use the size of its cell, or the same ratio at a smaller size.
The editor and the link panel show the size of each layer.

A larger layer source shows the layer larger.

The overlay background is transparent, so you do not need custom CSS.

Upgrade note: after you deploy the release that added the chat layer, refresh each open OBS source one time.
An OBS source that opened before this release does not show the chat.

### Live-room seats

Each OBS source with the overlay key uses one of the 10 owner seats of the live room.
The signed-in tabs of the streamer use the same seats.
When all 10 seats are full, a new connection replaces the oldest owner connection.
Thus, where possible, use one composition source for each scene, not one source for each layer.
See [live capacity](live-room-capacity.md).

## Editor

**Overlay control** has four numbered steps:

1. **Connect channels**: the channel connections. With a connected channel, the step shows one status line.
   Select the line to open the full panel.
2. **Choose what shows**: the monitors, **Take**, and the sources of the on-air content.
   Below them are the switches of the chat and characters layers.
3. **Place the layers**: the layout grid.
4. **Add to OBS**: the overlay link.

A signed-in page owner opens the page from **Overlay** in the header of their own streamer page or from the account menu.
The site header has no **Overlay** entry.

Step 3 shows the grid of the selected orientation on a preview of the frame.
The preview uses the same code as the OBS page. Thus the layer positions in the preview and in OBS agree.
Each placed layer shows its name and its size in pixels.
The grid and the palette are separate components. The editor holds the selected layer and gives it to the grid.

The grid shows only the layers that are on it. A chat or characters layer that is off has no box and no content there.

Each placed layer also shows content. The chat layer shows sample messages.
A content cell with nothing on air shows a dimmed sample topic.
The samples are only in this preview. OBS does not show them and the server does not store them.

Under **Preview background**, select **Transparent** or **Sample game**.

To change the layout, do these steps:

1. Under **Screen orientation**, select **Horizontal 16 × 9** or **Vertical 9 × 16**.
   OBS changes to the new orientation at once. Each orientation keeps its own layout.
2. To select a placed layer, press it on the grid. The selected layer shows eight handles: four on its corners and four on its edges.
3. To move a placed layer, drag it.
4. To change the size of the selected layer, drag one of its handles.

There is no layer selector, and you cannot draw a layer on empty cells.
The handles change the size of a placed layer, and the palette adds a layer. Thus a drag on empty cells does nothing.

A handle changes the size in full cells. The edges that the handle does not hold stay in their place.
The layer, its label, and its content show the new size during the drag. The editor saves the change when you release the handle.

A layer stops at its minimum size and at the edge of the grid.
When a layer stops at its minimum size, a message under the grid gives the minimum.
The area that takes a press on a handle is a band of 28 screen pixels along each edge. A corner is where two bands cross.

During a move or a drop from the palette, a dashed rectangle shows the new cells. During a change of size, it shows around the layer.
If the new cells touch another layer, the rectangle is red.
Then the editor does not keep the change. A message under the grid gives the reason.

### Add and remove a layer

**Add a layer** shows one chip for each layer that is not on the grid of the selected orientation.
The chat layer and the characters layer are on the grid while they are on. The on-air content is on the grid while it has a cell.
With the default layers, the palette shows all three chips.

To add a layer, use its chip:

- Select the chip, or press Enter or Space on it. The layer goes to the first free place at its minimum size.
  The editor looks for the place row by row, from the top-left corner.
- Or drag the chip onto the grid, with a mouse, a finger, or a pen.
  The layer drops at its minimum size around the cell at the pointer, inside the grid.

If no place is free, or the drop touches another layer, the editor adds nothing and gives the reason.
After the editor adds a layer, it selects the layer and the grid has the focus.
A chat or characters layer that you add comes on. **Show on stream** for that layer shows a check mark.

To remove a layer, use one of these procedures:

- Drag the layer from the grid onto **Add a layer**. During the drag, the palette shows **Drop here to remove**.
  The palette changes color while the pointer is on it. Release the layer there.
- Select the layer on the grid and press Delete or Backspace.
- For the chat layer or the characters layer, clear **Show on stream**.
- For the on-air content, select **Remove from grid**.

The editor removes each layer in the way that its data permits:

| Layer | Result of a removal |
| --- | --- |
| `chat`, `characters` | The layer goes off in the two orientations. OBS does not show it. The server keeps its cells. |
| `content` | The content loses its cell in the selected orientation. It uses the full frame again. OBS continues to show it. |

The chip of a removed layer shows in the palette again. A message under the grid tells the removal.
**Show on stream** and the grid show the same state. When you set **Show on stream**, the layer comes back at its stored cell.

A layer that is off does not block the cells on the grid. You can put a different layer on its stored cell.
Then the editor moves the stored cell to a free place and saves the two cells together.

The stored cell keeps its size if that size has a free place. If not, it takes the minimum size.
If the grid has no free place for the stored cell, the editor does not keep the change.
It names the layer that has no room.

### Keyboard

You can use the keyboard on the grid:

| Key | Result |
| --- | --- |
| Arrow key | Moves the cursor one cell. |
| Space or Enter | Starts to move the layer at the cursor, and selects it. The next press keeps the change. |
| Shift and arrow key | Moves the selected layer one cell. |
| Alt and arrow key | Moves the bottom-right corner of the selected layer one cell. Right and Down make the layer larger. Left and Up make it smaller. |
| Delete or Backspace | Removes the selected layer from the grid. During a move, it removes the layer that moves. |
| Escape | Cancels a move. |

On a Mac, Alt is the Option key. The top-left corner stays in its place during a keyboard change of size.
To change the size from the top or the left, first change the size, then move the layer.

A screen reader reads each result from a polite live region under the grid.
The grid is in a region with the `application` role. Thus a screen reader sends the keys to the grid, also in browse mode.
If the orientation changes or the grid loses focus during a move or a change of size, the editor cancels it.

### How the content follows the size

A change of size does not scale a layer. Each layer uses the new space in its own way:

| Layer | Wider cell | Taller cell |
| --- | --- | --- |
| `chat` | The font stays at 26 pixels. A message wraps later, so its card has fewer lines. | More cards show. The layer clips the oldest cards at the top. |
| `characters` | The sprites keep their size: 1 world pixel is 3 design pixels. The ground is longer. | More sky shows above the ground. The sprites keep their size. |
| `content` | The content keeps its **Size** setting. If it is larger than the cell, it becomes smaller until it fits. | The same. The content stays in the middle of the cell. |

### Saves

A drag, a chip, or a key that puts down a layer saves at once.
Shift or Alt with an arrow key saves after 400 milliseconds without a change.
If you close the page or go to a different page before then, the editor sends the change at once.

The editor does not wait for the result of a change that it sends while you leave.
If that change fails, the editor shows an error when you go back to it within 60 seconds.
The error tells you to make the change again and gives the reason.
The page scrolls to the error, so that you can see it.

Each editor has a random ID. Each layer save sends this ID and a number that increases with each save.
The server keeps the largest applied number of each of the last 8 editors.
It ignores a save with a number that is not larger than the kept number of its editor. The answer is the current state, not an error.
Thus when you leave during a save, the newer value stays, also if a different tab saves before the older save arrives.

Each save counts against the write quota of 60 changes each minute.
If a save fails, the editor shows the saved layers again.
If two saves finish in a different sequence, the editor keeps the result with the higher revision.

When the content has no cell and the chat layer covers part of the on-air content in the preview, a note shows under the preview.
Move the chat layer to a free area, or give the content a cell, to remove the note. The note does not stop a save.
The note changes 500 milliseconds after a change. A screen reader reads it after your first change on the page.

The preview plays sample chat. It opens no activity socket and reads no live chat.
The samples include all three platforms, Unicode text, emoji, an emote, and a command.

## Chat test

Use the chat test to see the chat in your real OBS scene before you go live.
Under the chat layer in **Composition**, select **Start chat test**. The chat layer must be on. If it is off, the server refuses the start.

- The test runs for 60 seconds (`CHAT_TEST_MS`). **Stop** ends it at once.
- If you set the chat layer to off, the test also stops. It does not continue when the layer is on again.
- The editor shows the remaining time. A screen reader reads only the start and the end of the test.
- Each overlay page that shows the chat layer plays sample chat from all three platforms.
  The samples include a message that a moderator removes and a user timeout.
- A **TEST** tag shows in the top-right corner of the chat layer.
- The samples use the normal chat behavior and motion.

The overlay page makes the sample messages itself. Nothing goes to Twitch, YouTube, or Kick, and the server stores no messages.
The server stores only the end time of the test, in the overlay state.
The end time and the write sequence of the editors are technical values. The account export does not include them.

The live room sends the end time to each open overlay page. Thus an OBS source that opens during the test also shows it.
Each page ends the test with its own timer at the end time. An end time in the past means no test.

During the test, the real chat continues to collect messages, but it does not show.
When the test ends, the real chat shows again. Its rows show in place, without an entry animation.

A start of the chat test counts against the write quota. A stop does not, so you can always stop the test. Only the signed-in owner of the page can start or stop it.

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
| Text outline | Dark teal, `#041517e6`. It shows only when the message background is below 50%. |

A new card moves up from below its place and fades in. The other cards move up at the same time.
The movement takes 520 milliseconds. When a card goes, the column closes with the same movement.
A leaving card fades out in 300 milliseconds.

The movement uses only `transform` and `opacity`. Thus the browser does no layout during the movement.

With reduced motion, the cards do not move. The chat uses the **Motion** setting of the site or the setting of the operating system.
A reconnect snapshot and a burst show their cards at once, without movement.
When a snapshot removes a card, the card goes at once. Then the column closes with the movement.

When the activity feed is not available, the chat starts again with no cards. All cards go at once, without a fade.
A removed card fades out in 300 milliseconds from the time that it leaves the chat, also when the page is slow.

### Message background

**Message background** in the chat settings of the editor sets how much of the card shows behind each message.
The value is a percentage from 0 to 100 in steps of 5 (`CHAT_BACKGROUND`). The default is 100, which is the full card.
At 0, the chat shows no card: only the platform icon, the user name, and the message show.

The setting scales the card fill, the borders, the shadows, and the bar of the newest card together.
The platform icon, the badge labels, the user name, the message, and the emotes always stay fully opaque.
Below 50%, the text and the platform icon get a dark outline. Thus you can read the chat on a bright game.

Use the slider with a mouse, a finger, or the arrow keys. The preview shows each step at once.
The editor saves the value after 400 milliseconds without a change. Then OBS shows it without a reload.
To see the result on a game, select **Sample game** under **Preview background**.

The chat root has the `--wl-bg` CSS property, from 0 to 1. Only the card background reads it.
The layers store the value as `chat.backgroundOpacity`. A missing or incorrect stored value reads as 100.
Thus a layout from before this setting does not change.

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

- The page opens an activity socket only when it shows an enabled chat layer or an enabled characters layer.
  Hide both layers to close it.
- A page that shows the characters layer asks its socket for the playground frames (`characters=1`).
  Chat and characters then share that one socket.
- The editor preview opens an activity socket only while the characters layer is on. The chat preview shows sample messages.
- Each browser source opens its own sockets. A layer source uses one live-room socket.
  A chat source and a characters source also use one activity socket each.
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

- The server orders only the saves of one editor. If two editors save almost together, their saves can arrive in a different sequence.
- The overlay has one theme. There is no theme selection.
- Layer edits go live at once. They have no preview and take step.
- Kick has no message deletion events. YouTube has no clear events. See the capability matrix in
  [Channel connections and activity](channel-connections.md#capability-matrix).
