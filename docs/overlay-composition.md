# Overlay composition and merged chat

The overlay page shows a composition of layers in one transparent browser source.
The owner builds the composition in the **Overlay** section of **Streamer tools**. Each layer has a place on a grid. Changes go live at once.

The overlay shows only the layers that are on the grid.
The chat layer shows the merged chat of the connected Twitch, YouTube, and Kick channels.
The chat reads the activity feed of [Channel connections and activity](channel-connections.md).
It makes no provider connection of its own.

The code is in these files:

| Part | File |
| --- | --- |
| Layer model, grid, limits, and URL helpers | `app/lib/overlay-layers.ts` |
| Grid edits and save patches | `app/lib/layer-geometry.ts` |
| State from before the overlay studio | `app/lib/overlay-legacy.ts` |
| Chat state machine and sample chat | `app/lib/chat-feed.ts` |
| Chat test | `app/lib/chat-test.ts` |
| Activity socket client | `app/lib/activity-socket.ts`, `app/components/overlay/activity-feed.tsx` |
| Chat rows and the composition | `app/components/overlay/chat-layer.tsx`, `app/components/overlay/overlay-composition.tsx` |
| Content of a layer and its QR code | `app/components/overlay/overlay-stage.tsx`, `app/components/overlay/qr-code.tsx` |
| Chat appearance and motion | `app/components/overlay/wasteland/`, `app/components/overlay/use-row-motion.ts` |
| Editor | `app/components/overlay/composition-editor.tsx`, `layout-grid.tsx`, `layer-palette.tsx`, `use-layer-draft.ts` |
| Layer settings and the test | `app/components/overlay/layer-properties.tsx`, `studio-test.tsx`, `characters-controls.tsx` |
| Overlay page | `app/routes/overlay.tsx` |
| Overlay actions | `app/server/overlay.server.ts`, `app/server/overlay-state.ts`, `app/server/api/live.ts` |

## Layers

The composition has nine layers. Each layer can be on the grid one time.

| Layer | Name in the editor | What it shows |
| --- | --- | --- |
| `chat` | Chat | The merged chat |
| `characters` | Characters | The interactive characters. See [Interactive characters](characters.md). |
| `poll` | Poll | The latest active poll, or a poll or Mash Battle that the owner picks |
| `topic` | Topic | A topic that the owner picks |
| `next` | Up next | The next scheduled stream |
| `message` | Message banner | A short text of the owner, in the info style or the hype style |
| `card` | Community card | The first Community card, or a card that the owner picks |
| `support` | Support banner | The first support link |
| `camera` | Camera frame | A frame with a clear window for the camera source in OBS. See [Camera frame](#camera-frame). |

`poll`, `topic`, `next`, `message`, `card`, and `support` are the content layers.

A layer is on stream in an output when it has a cell in the orientation of that output and its `enabled` setting is on.
See [Outputs](#outputs).
In the editor, the `enabled` setting is **Show on stream**.
The characters are at the bottom, then the content layers and the camera frame, and the chat is on top.
Layers cannot overlap, so this sequence shows only at shared edges.

No layer is on the grid by default. The chat layer and the characters layer are off by default.
A page whose owner never saved the overlay shows the poll layer with the latest active poll.
See [State from before the overlay studio](#state-from-before-the-overlay-studio).

The theme is separate from the layout and the behavior. The overlay has one theme, the wasteland theme.

## Grid and orientation

The overlay has two orientations. Each orientation has a grid of square cells of 60 pixels:

| Orientation | Frame | Grid |
| --- | --- | --- |
| `horizontal` (default) | 1920 × 1080 | 32 columns × 18 rows |
| `vertical` | 1080 × 1920 | 18 columns × 32 rows |

A layer on the grid has one cell rectangle in that orientation.
A rectangle has four integers: column `c`, row `r`, width `w`, and height `h`, all in cells.
The rectangle must stay in the grid: `c + w` is at most the number of columns, and `r + h` is at most the number of rows.
Two layers must not overlap. A shared edge is not an overlap.
A layer that is on the grid and off stream also keeps its cells free of the other layers.

Each orientation keeps its own layout. When you change the orientation in the editor, the layout of the other orientation stays.
A layer can be on the grid of one orientation and off the grid of the other.

### Outputs

Each orientation is one output of the overlay: the horizontal output and the vertical output.
The two outputs are on stream at the same time. A streamer can use one output or the two.

- Each output has its own private link with its own key. The key of a link gives the output that the page shows.
- A link without a valid key shows the horizontal output.
- The `orientation` value of the layers is the output that the editor shows. It does not change the picture in OBS.
- The settings of a layer, such as `enabled` and `ref`, are the same in the two outputs. Only the cells are different.
- The two outputs use the same live room, the same activity feed, and the same chat. A second output adds no call to Twitch, YouTube, or Kick.

A server check that needs a layer on stream accepts the layer in one of the two outputs.
Examples are the chat test, the characters test, and the public text of the message banner.

The character playground is one world for the two outputs. Its size comes from the horizontal cell of the characters layer.
If the layer is not on the horizontal grid, the size comes from the vertical cell.
The other output shows the same world at the bottom of its cell. If the world does not fit in that cell, the output shows it smaller.
See [Interactive characters](characters.md).

### Twitch chat only

Each output shows the merged chat of all connected platforms by default.
Each output has one switch, **Show Twitch chat only**. It is off by default.

The Twitch rules for a simulcast do not allow chat from other platforms on the Twitch stream.
A streamer who sends one output to Twitch can set the switch for that output.
The switch of one output does not change the other output.

With the switch on, the output shows only what comes from Twitch:

- The chat layer shows Twitch messages. This includes the sample chat of a test.
- The characters layer shows the characters of Twitch viewers. The playground on the server does not change.
- Each other event of the activity feed that is not from Twitch does not show.

A change of the switch during a stream applies at once.
The Twitch messages on screen stay. The messages of the other platforms go, and they do not come back.
When the switch goes off again, the other platforms show from their next message.

Polls, topics, the message banner, and the other content layers do not change.
The **Live** section and the full-screen chat always show each platform.
A preview shows what its output shows, thus a preview of an output with the switch on shows Twitch only.

The switches are in a closed section of the step **Add to OBS**: **Streaming to Twitch and other platforms at once?**
The layers store them as `twitchOnly`, with one value for each output.
The overlay page of the two outputs reads the same activity feed. The page of an output with the switch on drops the other events.
Thus the switch adds no call to a platform.

Before the two outputs, a page had one link, and the editor selected the orientation that OBS showed.
Migration `0046` keeps that picture. The link of a page that showed the vertical orientation is now the link of the vertical output.
Each other link is the link of the horizontal output.
An OBS source that connected before the two outputs connects again one time when a link of the page changes.

| Layer | Minimum size in cells | Minimum size in pixels |
| --- | --- | --- |
| `chat` | 6 × 4 | 360 × 240 |
| `characters` | 12 × 4 | 720 × 240 |
| Each content layer | 8 × 4 | 480 × 240 |
| `camera` | 6 × 4 | 360 × 240 |

The characters cell sets the size of the playground world: each cell is 20 × 20 world pixels.
A wide cell gives a long ground. A tall cell gives more sky above the ground.
In a small cell, such as the minimum of 12 × 4 cells, up to 40 characters stand close together on a short ground.
Give the characters a wide cell when your chat is busy.

A content layer shows its content in the middle of its cell, at the full width of the cell.
If the content is higher than the cell, it becomes smaller until it fits.

### Layer settings

Each layer has the `enabled` setting. The other settings are these:

| Layer | Settings |
| --- | --- |
| `chat` | `hideCommands` and `backgroundOpacity`. See [Commands](#commands) and [Message background](#message-background). |
| `characters` | `timeout` and `max`. See [Interactive characters](characters.md). |
| Each content layer | `ref`, `backgroundOpacity`, and `qr` |
| `camera` | No other setting. See [Camera frame](#camera-frame). |

The settings of a content layer are these:

- `enabled`: the layer shows on stream. The default is on.
- `ref`: the poll, the topic, or the Community card that the layer shows.
  Without a `ref`, the `poll` layer shows the latest active poll and the `card` layer shows the first card.
  A `topic` layer without a `ref` shows nothing.
  The `next`, `message`, and `support` layers have no `ref`.
- `backgroundOpacity`: the opacity of the card background in percent. The text stays opaque.
  The border and the shadow of the card stay.
- `qr`: the card of the layer shows a QR code. The `poll` layer has `qr: true` by default.
  The other content layers have `qr: false`. See [QR code](#qr-code).

Two more values are not in the layers. They apply to the layer that uses them:

- `showResults` shows or hides the results of the poll in the poll layer.
- `message` and `messageStyle` are the text and the style of the message banner.
  The public overlay state has the text only while the message layer is on stream. Otherwise the text is a draft.

### QR code

A viewer scans the QR code with a phone. The phone then opens the public page of the item that the layer shows.

| Layer | The QR code opens |
| --- | --- |
| `poll` | The poll that the layer shows: `/@<handle>?view=polls&entry=<poll id>`. This applies also to the latest active poll. |
| `topic` | The topic: `/@<handle>?view=topics&entry=<topic id>` |
| `next` | The schedule: `/@<handle>?view=schedule` |
| `card` | The Community tab: `/@<handle>?view=community` |
| `support` | The support link of the page. Without a support link, it opens `/@<handle>`. |
| `message` | No QR code. The message banner has no page to open. |

- Each link starts with the origin of the app (`APP_ORIGIN`), the same value that gives the host in the **Tap at** hint.
- The code is in the card of the layer, at the right edge.
- The side of the code is 22 percent of the card height, and at least 96 design pixels.
  It is at most 30 percent of the card width, unless that is below the minimum.
  The card with the code becomes smaller with its cell, as each card does.
- On a poll card, the code is beside the question, and the question has the height of the code.
  There the code takes the height that the options and the status line leave, at most 30 percent of the cell width.
- The code has dark modules (`#0b2228`) on a light plate (`#f7edcf`) with a quiet zone of 2 modules.
  The plate stays opaque at each `backgroundOpacity`. Thus a phone can read the code on each background.
- The code is an SVG picture from the `uqr` package. Thus it stays sharp at each OBS source size.
- A screen reader reads the code as an image with the name **QR code: open on your phone**.
- A layer that shows nothing shows no code. Examples are a poll layer without a poll and a card layer with a deleted card.
- The API accepts `qr` for the `message` layer, but that layer never shows a code.

The stored layers have a limit of 4000 characters. The server stores only what is not a default.
All nine layers on the grid of the two orientations, with each setting changed, need less than half of the limit.
Migration `0032` raised the limit from 1000 characters. It builds the `overlay_state` table again and keeps all rows.
An older Worker can use the new table.

### Camera frame

The camera frame is a frame around a clear window. The overlay does not show a camera picture.
StreamBullets does not use the camera of the streamer, and it does not ask for the camera permission.
The camera is a source of the streamer in OBS.

To show the camera in the frame, do these steps:

1. In the editor, add the camera frame to the grid. Give it the place and the size of the camera picture.
2. In OBS, move the camera source below the overlay source in the list of sources.
3. In OBS, give the camera source the place and the size of the window of the frame.

The frame covers 19 design pixels at each edge of its cell. The remaining area of the cell is the window.
Thus the window starts 19 design pixels from the left edge and the top edge of the cell.
Its width and its height are 38 design pixels less than those of the cell.

The window has round corners. Thus the frame hides the corners of the camera picture.
The outer corners of the frame are also round. A camera picture as large as the cell shows outside them.
The label of the layer on the grid gives the size of the cell in design pixels.

In the editor, the window shows the text **Your OBS camera shows here**. The overlay page never shows this text.
The camera frame has no `ref`, no background setting, and no QR code.
The frame is a part of the content source (`layer=content`).

### Canvas

The page scales the design pixels to the size of the browser source.
The composition puts all of its layers in one canvas. The canvas has the frame size of the output.
It is the same as the canvas of the editor preview.

Thus the layout is the same at all source sizes with the same aspect ratio, and the same as in the preview.
With a source of a different aspect ratio, the full canvas stays in the source.
The free space is at the right or at the bottom.

### Stored values

The overlay reads stored and broadcast layers leniently. Thus a value from an older or newer version never stops the page:

- It ignores unknown fields.
- A field with an incorrect value takes its default value.
- A cell outside the grid or below the minimum size reads as no cell.
- A cell that overlaps an earlier layer reads as no cell.
  The sequence is `chat`, `characters`, `poll`, `topic`, `next`, `message`, `card`, `support`, `camera`.
- A layer with an incorrect value takes the defaults of that layer.

The API is strict for changes. See [Overlay layers](api.md#overlay-layers).

## Layouts

Each output has its own layouts, and one of them is on stream.
A layout is the cells of the layers of one output. The settings of a layer are not a part of a layout.
Thus a poll that the owner picked stays when the layout changes.

The list **Layout** is in the row above the grid, in the step **Build your overlay**. It has these entries:

- The presets of the output. The horizontal output has **Just chatting** and **Gameplay**. The vertical output has **Vertical**.
- The layouts of the streamer.
- **New layout…**

When you select a layout, it opens in the grid and goes on stream at once. OBS does not load the page again.
Each edit of the grid changes the layout on stream and saves at once, as before the layouts.
A layer that a layout adds to the grid of the output also gets **Show on stream**.
The switch of each other layer stays.

| Preset | Output | Layers |
| --- | --- | --- |
| Just chatting | Horizontal | A large camera frame, the chat at its side, the poll and the message banner below |
| Gameplay | Horizontal | A small camera frame, the chat, the poll, and the characters at the edges |
| Vertical | Vertical | The camera frame at the top, then the poll, the chat, and the characters |

A preset that you change keeps your version. The list then shows **preset, changed by you**.
**Reset to the preset** brings back the cells that the preset comes with.

**Save as a new layout** and **New layout…** make a layout with your name.
It starts from a copy of the layout on stream or from an empty grid, and it goes on stream.

A layout action first saves the edits of the grid. The grid takes no edit until the action ends.
When a different tab changes the layouts, the list shows the new layouts without a load of the page.

**Rename or delete layouts** opens the list of your layouts. Each layout can get a new name.
You cannot delete the layout on stream. Select a different layout first.
Each output can have 8 layouts of the streamer. The presets do not count.

The layout that a page had before the layouts stays on stream. The list shows it as **Your layout · not saved yet**.
When you select a different layout for the first time, it becomes a layout of the streamer with the name **My layout**.

### How the server stores layouts

The cells of the layout on stream are in the layers, as before. Thus the overlay page and the editor read them as before.
The column `overlay_state.layouts` holds the other layouts and the ID of the layout on stream. Migration `0047` adds it.
The stored cells of the layout on stream are old until a different layout goes on stream. Then they take the cells of the grid.

A layout action changes the layers and the layouts in one write.
The read of the stored layouts is lenient, as for the layers: a layout that is not valid is not in the list.
A Worker from before the layouts ignores the column.
The data export of **Your data** has the layouts. The row goes with the page when the owner deletes the account.

See [Overlay layouts](api.md#overlay-layouts) for the API.

## State from before the overlay studio

Before the overlay studio, the overlay showed one source on air, with a position and a size.
The owner changed the source with **Preview** and **Take**.
The chat layer and the characters layer always had a cell, and an optional `content` layer gave the source a cell.
Now the overlay shows only layers on the grid.

The stored layers have a version (`v`). The current version is 3. Stored layers without this version are old.
The server converts old layers each time it reads them. The result is always the same.

Stored layers without a version are from before the overlay studio.
For version 2, see [Cells of 120 pixels](#cells-of-120-pixels).

The first time the overlay page or **Streamer tools** reads the state, the server stores the result.
Each save also stores the current version. Thus the conversion happens one time.
The owner does nothing. The revision of the overlay does not change.

The database keeps the columns `air`, `preview`, `position`, `size`, and `instant`.
The server reads `air`, `position`, and `size` only for this conversion. It does not write these columns.

The conversion has these rules:

1. A chat or characters layer that was on keeps its cells in the two orientations. It stays on stream.
2. A chat or characters layer that was off leaves the grid. Its old cell only kept a place free.
3. The source that was on air becomes a content layer on the grid of the two orientations, with `enabled` on.
4. If a content layer already has a cell in an orientation, rule 3 does not apply.

| Old source on air | Layer | `ref` |
| --- | --- | --- |
| Auto, also for a page without saved state | `poll` | None: the latest active poll |
| A specific poll | `poll` | That poll |
| A specific poll, with no poll picked | No layer | - |
| Topic spotlight | `topic` | That topic |
| Up next | `next` | None |
| Message banner | `message` | None |
| Community card | `card` | That card, or none for the first card |
| Support banner | `support` | None |
| Hidden | No layer | - |

The layer goes to the old `content` cell of an orientation, if that orientation had one.
If not, the old position and size give the cell. A poll filled the frame and did not use the position.
Each cell in this table is `c`, `r`, `w` × `h`, in cells of 120 pixels.
The layer gets the same place in cells of 60 pixels: see [Cells of 120 pixels](#cells-of-120-pixels).

| Old position | Horizontal S | Horizontal M | Horizontal L | Vertical S | Vertical M | Vertical L |
| --- | --- | --- | --- | --- | --- | --- |
| Poll (full frame) | 5, 0, 9 × 5 | 5, 0, 11 × 7 | 0, 0, 16 × 9 | 0, 0, 7 × 6 | 0, 0, 9 × 8 | 0, 0, 9 × 10 |
| The lower third | 0, 7, 8 × 2 | 0, 6, 10 × 3 | 0, 5, 12 × 4 | 0, 14, 7 × 2 | 0, 13, 9 × 3 | 0, 12, 9 × 4 |
| Top bar | 0, 0, 12 × 2 | 0, 0, 16 × 2 | 0, 0, 16 × 3 | 0, 0, 7 × 2 | 0, 0, 9 × 2 | 0, 0, 9 × 3 |
| Corner | 11, 7, 5 × 2 | 10, 6, 6 × 3 | 8, 5, 8 × 4 | 5, 14, 4 × 2 | 4, 13, 5 × 3 | 3, 12, 6 × 4 |
| Center | 5, 3, 6 × 3 | 4, 3, 8 × 3 | 3, 2, 10 × 5 | 2, 7, 5 × 2 | 1, 6, 7 × 3 | 0, 6, 9 × 4 |

The poll cells at sizes S and M are beside the old default chat cell and above the old default characters cell.
Thus a scene with the poll, the chat, and the characters has no overlap.

If the cell touches the chat or the characters on stream, the layer takes free space.
It takes the largest free cell that is not larger than the cell in the table.
If the grid has no free cell of the minimum size, the layer stays off the grid. It keeps its settings.

A scene with only the chat or the characters looks the same as before.
A scene with a source on air shows the same source, in its cell and not in the full frame.
An OBS source that was open during the deploy loads the new page by itself after some failed updates.
Refresh an open OBS source one time after the deploy to get the new page at once.

## Cells of 120 pixels

Until version 2, a cell was 120 pixels: 16 columns × 9 rows in the horizontal orientation.
Version 3 has cells of 60 pixels. The frame did not change.

The server converts each old cell rectangle: `c`, `r`, `w`, and `h` become two times larger.
Thus each old cell is 2 × 2 cells, and each layer keeps its place and its size in pixels.
The minimum sizes are two times larger in cells and the same in pixels.
A cell that the old grid did not keep also reads as no cell after the conversion.

The conversion uses the version, as the conversion of the state from before the overlay studio does.
For stored layers without a version, the server converts the cells first. Then the rules above apply.
The first read stores the result at version 3. The revision of the overlay does not change.

The characters world keeps its size: a cell of the playground is 20 × 20 world pixels, and each old cell was 40 × 40.
The playground also reads a checkpoint with the old cells as the same world.

An overlay page or a **Streamer tools** page that was open during the deploy has the old grid.
It shows the layers at incorrect places until you load it again.
Refresh each open OBS source one time after the deploy.

## URLs

Each output has one URL for the composition. The two URLs have different keys:

```text
https://<origin>/@<handle>/overlay?key=<key of the horizontal output>
https://<origin>/@<handle>/overlay?key=<key of the vertical output>
```

Add the `layer` parameter to the URL of an output to show one part of that output alone. Use one browser source for each part:

```text
https://<origin>/@<handle>/overlay?key=<key>&layer=chat
https://<origin>/@<handle>/overlay?key=<key>&layer=content
https://<origin>/@<handle>/overlay?key=<key>&layer=characters
```

A chat source or a characters source keeps the aspect ratio of its cell and uses as much of the viewport as possible.
It aligns the layer with the bottom-right corner of the viewport. Thus the newest chat rows are always visible.
The free space stays transparent, at the left or at the top.

A content source (`layer=content`) shows all the content layers and the camera frame on stream, without the chat and the characters.
Each of these layers stays at its cell in the canvas of the output, as in the composition.
Thus a content source has the frame size, not the size of one layer.

An unknown `layer` value shows an empty transparent page. It never shows an error.

The `poll` parameter shows one poll in place of the content layers:
`https://<origin>/@<handle>/overlay?poll=<poll ID>`.
The poll layer then shows that poll, and no other content layer shows.
The poll layer keeps its cell. If it is off the grid, it takes the cell of a poll at size M, or free space near it.

The step **Add to OBS** has one part for each output. Each part shows the state of its link in OBS:
the number of connected sources, or the time when the last source went away.
A part shows the full URL and the layer URLs when you make a new key, and when you select **Show link**.
The server keeps the SHA-256 hash of each key for the check, and the encrypted key for **Show link**.
If you have the composition URL, add `&layer=chat` to its end for a chat source.

**Regenerate link** makes a new key for one output. The old key of that output stops at once, and its sockets close.
The link of the other output continues to work. After a new key, update the OBS sources of that output.

## OBS browser source

For a guide in steps for a first use of OBS, see [OBS setup for the overlay](obs-setup.md).

Set the size of the browser source for the composition to the frame size of its output:

- For the horizontal output, use 1920 × 1080. A different 16:9 size, such as 1280 × 720, also works.
- For the vertical output, use 1080 × 1920. A different 9:16 size, such as 720 × 1280, also works.

All sizes with the correct aspect ratio show the same layout as the preview.
The editor shows the correct size under the grid.
For a chat source or a characters source, use the size of its cell, or the same ratio at a smaller size.
For a content source, use the frame size.
The link panel shows the size for each layer URL.

A larger layer source shows the layer larger.

The overlay background is transparent, so you do not need custom CSS.

Upgrade note: after you deploy the release that added the chat layer, refresh each open OBS source one time.
An OBS source that opened before this release does not show the chat.

Upgrade note for the two outputs: apply migration `0046` before the deploy, and refresh each open OBS source one time after it.
An overlay page from before this release shows the orientation that the editor shows.

### Live-room seats

Each OBS source with an overlay key uses one of the 10 owner seats of the live room. The two outputs use the same seats.
The signed-in tabs of the streamer use the same seats.
When all 10 seats are full, a new connection replaces the oldest owner connection.
Thus, where possible, use one composition source for each scene, not one source for each layer.
See [live capacity](live-room-capacity.md).

## Editor

**Streamer tools** is the page of the owner at `/tools`. The header of a streamer page has its **Tools** tab.
The old address `/overlay-control` redirects to it. The page has three sections:

- **Live** (`/tools`) has the controls for a stream. See [Streamer tools](streamer-tools.md#live).
- **Overlay** (`/tools?view=overlay`) has two numbered steps:
  1. **Build your overlay**: the overlay studio.
  2. **Add to OBS**: the overlay link.
- **Channels** (`/tools?view=channels`) has the channel connections: one card for each platform.
  The cards follow the channel health while the page is open.

When the page has a link, one line in step 2 shows the OBS connection.
It shows the number of connected sources. Without a source, it shows when the last one connected or went away.
The live room counts the sockets that came in with the current key.
It sends each change to the owner's tabs.

A signed-in page owner opens the page from **Tools** in the header of their own streamer page or from the account menu.
The site header has no **Tools** entry.

The studio has these parts:

- A toolbar with the orientation, the preview background, **Start test**, and the note **Changes go live right away**.
- The palette **Layers · one of each**, with one chip for each layer.
- The grid of the selected orientation on a preview of the frame.
- The settings of the selected layer.

On a wide screen, the page shows the palette, the grid, and the settings side by side.
On a narrow screen, such as a phone, they are one below the other in that sequence.

The preview uses the same code as the OBS page. Thus the layer positions in the preview and in OBS agree.
Each layer on the grid shows its name, its size in pixels, and its real content.

The chat layer shows sample messages. The characters layer shows the live playground.
A layer with **Show on stream** off keeps a dashed box on the grid. The preview does not show its content.

The grid and the palette are separate parts. The editor holds the selected layer and gives it to both.
When the page opens, the editor has no selected layer.

In the toolbar, select **Transparent** or **Sample game** for the preview background.

To change the layout, do these steps:

1. In the toolbar, select **Horizontal 32 × 18** or **Vertical 18 × 32**. This is the output that you edit.
   The selection does not change the picture in OBS. Each output keeps its own layout.
2. To select a layer, press it on the grid, or select its chip in the palette.
   The selected layer shows eight handles: four on its corners and four on its edges.
3. To move a layer, drag it.
4. To change the size of the selected layer, drag one of its handles.

A press on an empty cell clears the selection. You cannot draw a layer on empty cells.

A handle changes the size in full cells. The edges that the handle does not hold stay in their place.
The layer, its label, and its content show the new size during the drag. The editor saves the change when you release the handle.

A layer stops at its minimum size and at the edge of the grid.
When a layer stops at its minimum size, a message under the grid gives the minimum.
The area that takes a press on a handle is a band of 28 screen pixels along each edge. A corner is where two bands cross.

During a move or a drop from the palette, a dashed rectangle shows the new cells. During a change of size, it shows around the layer.
If the new cells touch another layer, the rectangle is red.
Then the editor does not keep the change. A message under the grid gives the reason.

### Add and remove a layer

The palette shows one chip for each of the nine layers.
The chip of a layer on the grid of the selected orientation shows **Placed**.
Each layer can be on the grid one time.

To add a layer, use its chip:

- Select the chip, or press Enter or Space on it. The layer goes to the first free place at its minimum size.
  The editor looks for the place row by row, from the top-left corner.
- Or drag the chip onto the grid, with a mouse, a finger, or a pen.
  The layer drops at its minimum size around the cell at the pointer, inside the grid.

If no place is free, or the drop touches another layer, the editor adds nothing and gives the reason.
After the editor adds a layer, it selects the layer and the grid has the focus.
A layer that you add gets **Show on stream**.
A topic layer without a topic takes the newest topic of the page.

To remove a layer, use one of these procedures:

- Drag the layer from the grid onto the palette. During the drag, the palette shows **Drop here to remove**.
  The palette changes color while the pointer is on it. Release the layer there.
- Select the layer on the grid and press Delete or Backspace.
- Select the layer and select **Remove from grid** in its settings. The focus then goes to the chip of the layer.

A removed layer has no cell in the selected orientation. OBS does not show it.
The layer keeps its settings and its cell in the other orientation. Its chip offers it again.
A message under the grid tells the removal.

### Settings of the selected layer

The settings show the name of the selected layer and these controls:

| Control | Layers | Result |
| --- | --- | --- |
| **Show on stream** | All | Shows or hides the layer in OBS. The layer stays on the grid. |
| **Poll** | Poll | **Latest active poll**, or a poll of the page. The list names a Mash Battle and the author of a viewer poll. |
| **Show results** | Poll | Shows or hides the results of the poll. |
| **Topic** | Topic | The topic that the layer shows. |
| **Community card** | Community card | The card that the layer shows. |
| **Message** and **Message style** | Message banner | The text, up to 120 characters, and the info style or the hype style. **Save message** saves the text. |
| **Hide chat commands (!jump)** | Chat | See [Commands](#commands). |
| **Message background** | Chat | See [Message background](#message-background). |
| **Show QR code** | Each content layer but the message banner | Shows or hides the QR code in the card. See [QR code](#qr-code). |
| **Background** | Each content layer | The opacity of the card background, from 0 to 100 in steps of 5. |
| Timeout, **Maximum characters on screen**, **Pause**, **Reset playground**, and the participants | Characters | See [Interactive characters](characters.md). |
| **Remove from grid** | All | Takes the layer off the grid. |

Up next and the support banner have no picker. The characters layer has no background.
The camera frame shows only a note about the camera source in OBS. See [Camera frame](#camera-frame).
Without a selected layer, the settings show a hint.

The chat settings show a warning when the chat layer is on stream and no connected platform is healthy.
The warning text is "No channel delivers chat right now. See Channels." It links to the **Channels** section.
The warning uses the live channel list of the page.
See [Channel health in Streamer tools](channel-connections.md#channel-health-in-streamer-tools).

The settings are a region with the name of the layer, after the grid in the tab sequence.
When you select a layer with its chip, a screen reader reads the selection. The grid reads its own selections.

### Keyboard

Tab moves to the toolbar, the chips, the grid, and the settings, in that sequence.
Enter or Space on a chip adds its layer, or selects the layer if it is on the grid.

You can use the keyboard on the grid:

| Key | Result |
| --- | --- |
| Arrow key | Moves the cursor one cell. |
| Space or Enter | Starts to move the layer at the cursor, and selects it. The next press keeps the change. |
| Shift and arrow key | Moves the selected layer one cell. |
| Alt and arrow key | Moves the bottom-right corner of the selected layer one cell. Right and Down make the layer larger. Left and Up make it smaller. |
| Delete or Backspace | Removes the selected layer from the grid. During a move, it removes the layer that moves. |
| Escape | Cancels a move. The layer stays selected. |

On a Mac, Alt is the Option key. The top-left corner stays in its place during a keyboard change of size.
To change the size from the top or the left, first change the size, then move the layer.

A screen reader reads each result from a polite live region under the grid.
The grid is in a region with the `application` role. Thus a screen reader sends the keys to the grid, also in browse mode.
If the orientation changes or the grid loses focus during a move or a change of size, the editor cancels it.

### How the content follows the size

A change of size does not scale a chat layer or a characters layer. Each layer uses the new space in its own way:

| Layer | Wider cell | Taller cell |
| --- | --- | --- |
| `chat` | The font stays at 26 pixels. A message wraps later, so its card has fewer lines. | More cards show. The layer clips the oldest cards at the top. |
| `characters` | The sprites keep their size: 1 world pixel is 3 design pixels. The ground is longer. | More sky shows above the ground. The sprites keep their size. |
| Each content layer | The content uses the full width of the cell. | The content stays in the middle of the cell. If it is higher than the cell, it becomes smaller until it fits. |
| `poll` | The card fills the cell. The text and the code become larger. | The card fills the cell. In a cell that is higher than it is wide, each option has its own row. |

The poll card has three parts: the question beside the QR code, the options across the full width, and one status line.
Each option is a thin bar. It shows its share of the votes when the results are on.
The card is complete in a cell of 4 by 2.
Viewers cannot select an option on stream. They scan the code to vote.

An option name shows two lines at most and then an ellipsis.
When an option name has more than 12 characters, the options have wide bars with one line each.
Up to three such options have one row each. Four to six such options have two columns.
The page of the poll shows the full names.

### Saves

A drag, a chip, a key that puts down a layer, a picker, or a switch saves at once.
Shift or Alt with an arrow key, and a step of a background slider, save after 400 milliseconds without a change.
If you close the page or go to a different page before then, the editor sends the change at once.

The editor does not wait for the result of a change that it sends while you leave.
If that change fails, the editor shows an error when you go back to it within 60 seconds.
The error tells you to make the change again and gives the reason.
The page scrolls to the error, so that you can see it.

Each editor has a random ID. Each layer save sends this ID and a number that increases with each save.
The server keeps the largest applied number of each of the last 8 editors.
It ignores a save with a number that is not larger than the kept number of its editor. The answer is the current state, not an error.
Thus when you leave during a save, the newer value stays, also if a different tab saves before the older save arrives.

Each layer save counts against the write quota of 60 changes each minute.
If a save fails, the editor shows the saved layers again.
If two saves finish in a different sequence, the editor keeps the result with the higher revision.

The preview plays sample chat. It opens no activity socket for the chat and reads no live chat.
The samples include all three platforms, Unicode text, emoji, an emote, and a command.

## Test

Use the test to see the chat and the characters in your real OBS scene before you go live.
In the toolbar of the studio, select **Start test**. The same button, **Stop test**, ends the test at once.

One button starts two tests together:

- The chat test, if the saved chat layer is on stream. It runs for 60 seconds (`CHAT_TEST_MS`).
- The characters test, if the saved characters layer is on stream. It runs for 5 minutes.
  See [Characters test](characters.md#characters-test).

If only one of the two layers is on stream, the button starts only that test.
If neither is on stream, the button does nothing and its text gives the reason.
The server also refuses the start of a test whose layer is off stream.

- The text beside the button shows the remaining time of the longer test.
  A screen reader reads only the start and the end of the test.
- A start of the test also ends a pause of the playground.
- If you take the chat layer off stream, the chat test stops. It does not continue when the layer is on stream again.

During the chat test:

- Each overlay page that shows the chat layer plays sample chat from all three platforms.
  The samples include a message that a moderator removes and a user timeout.
- A **TEST** tag shows in the top-right corner of the chat layer.
- The samples use the normal chat behavior and motion.

The overlay page makes the sample messages itself. Nothing goes to Twitch, YouTube, or Kick, and the server stores no messages.
The server stores only the end time of the chat test, in the overlay state.
The end time and the write sequence of the editors are technical values. The account export does not include them.

The live room sends the end time to each open overlay page. Thus an OBS source that opens during the test also shows it.
Each page ends the test with its own timer at the end time. An end time in the past means no test.

During the chat test, the real chat continues to collect messages, but it does not show.
When the test ends, the real chat shows again. Its rows show in place, without an entry animation.

A start of a test counts against the write quota. A stop does not, so you can always stop the test.
Only the signed-in owner of the page can start or stop it.

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

**Message background** in the settings of the chat layer sets how much of the card shows behind each message.
The value is a percentage from 0 to 100 in steps of 5 (`CHAT_BACKGROUND`). The default is 100, which is the full card.
At 0, the chat shows no card: only the platform icon, the user name, and the message show.

The setting scales the card fill, the borders, the shadows, and the bar of the newest card together.
The platform icon, the badge labels, the user name, the message, and the emotes always stay fully opaque.
Below 50%, the text and the platform icon get a dark outline. Thus you can read the chat on a bright game.

Use the slider with a mouse, a finger, or the arrow keys. The preview shows each step at once.
The editor saves the value after 400 milliseconds without a change. Then OBS shows it without a reload.
To see the result on a game, select **Sample game** in the toolbar.

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

To show commands, clear **Hide chat commands (!jump)** in the settings of the chat layer.
When you select the option again, the chat also hides the command rows that are on the screen.
The chat never runs a command. It only shows or hides the message.

The option applies to each view of the merged chat:

- The chat layer in the two outputs, and in each preview of the composition
- The chat of **Live**, the full-screen chat, and the chat of the OBS dock. See [Chat](streamer-tools.md#chat).

The server sends each message to each page, and the page shows no row for a hidden command.
Thus a hidden command never shows, also not for a moment, and it leaves no empty row.
A hidden command for a character still moves the character and still counts for the score of the viewer.
The option does not change moderation: a removed message stays removed.
OBS and the other open pages of the owner get a change of the option at once, without a reload.

### Reconnection

The page keeps one activity socket. It connects again after each failure, with backoff and jitter.
The first wait is 1 second. The wait doubles after each failure, up to 60 seconds.
When the socket opens, the server sends a snapshot of recent chat.

The snapshot is the truth for its time window. The chat removes rows that are missing from it.
Rows from a snapshot never animate. Rows on screen stay and do not animate again.
The chat adds only the snapshot rows that are newer than the newest row on screen. Thus a reconnect never shows a row twice.

An `unavailable` message clears the chat. The server sends it when the key changes or when an administrator suspends the page.
The page then keeps trying with a longer wait.
When the server refuses the key (close code `4403`), the page stops. The value of `data-feed-status` is then `refused`.
The source needs the new link from the **Overlay** section.

For troubleshooting, the root element of the overlay page has the `data-feed-status` attribute.
It shows the status of the activity feed.

## YouTube quota and sockets

The server polls YouTube chat only while at least one activity socket of the page is open.
Each open activity socket keeps the poll alive, and each poll costs YouTube quota.
Thus close the overlay sources that you do not use.

- The page opens an activity socket only when it shows a chat layer or a characters layer that is on stream.
  Take both layers off stream to close it.
- A page that shows the characters layer asks its socket for the playground frames (`characters=1`).
  Chat and characters then share that one socket.
- The editor preview opens an activity socket only while the characters layer is on stream. The chat preview shows sample messages.
- Each browser source opens its own sockets. A chat, characters, or content source uses one live-room socket.
  A chat source and a characters source also use one activity socket each.
- A page can have at most 20 activity sockets (`MAX_SOCKETS`).
- Valid-key overlays and the owner share 10 owner seats in the live room. See [Live-room seats](#live-room-seats).

## Security

- The chat shows user names, messages, and badge labels as text. It never inserts them as HTML.
- An emote image loads only from a host in `EMOTE_HOSTS`, over HTTPS. Other emotes show their name as text.
- On all pages, the Content Security Policy allows images from the site, `blob:` URLs, `data:` URLs,
  and each host in `EMOTE_HOSTS` over HTTPS (`https://static-cdn.jtvnw.net`).
  The policy applies to a full page load. A link in the app opens **Streamer tools** without a new page load.
  Thus a policy only for that page does not apply to the preview.
- The Twitch image CDN gets the IP address of the device that shows an emote. The privacy policy (`/privacy`) names this recipient.
- The overlay page sends no `Referer`. Thus an emote image does not get the key.
- The overlay key gives access to the activity feed. Without a key or an owner session, the socket gets `403`.
  With a wrong or revoked key, the server closes the socket with the code `4403`, and the page does not try again.
- **Regenerate link** makes a new key for one output. The old key of that output stops at once, and its open sockets close.
- The key of one output gives no control of the other output. A key never gives a control action.
- The chat ignores `user.color`. It uses the theme colors only.

## Limits and known gaps

- The server orders only the saves of one editor. If two editors save almost together, their saves can arrive in a different sequence.
- The overlay has one theme. There is no theme selection.
- Layer edits go live at once. To prepare a layer, clear **Show on stream** for it first.
- Kick has no message deletion events. YouTube has no clear events. See the capability matrix in
  [Channel connections and activity](channel-connections.md#capability-matrix).
