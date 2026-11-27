# Interactive characters

The characters layer shows a playground on the overlay (issue #664).
Each viewer who writes in the chat gets a character. Chat commands move the character and build with blocks.
The characters start on the ground. The viewers build up from there, as high as the layer.
The viewer needs no Stream Bullets account.

The server runs the playground. The overlay pages only draw the frames from the server.
Thus the editor preview, a composition source, and a characters source always show the same playground.

| Part | Files |
| --- | --- |
| Rules and constants | `app/lib/playground/constants.ts`, `core.ts`, `crowd.ts`, `sim.ts`, `motion.ts`, `works.ts`, `terrain.ts`, `checkpoint.ts` |
| Frame contract | `app/lib/playground/protocol.ts` |
| Characters test | `app/lib/playground/test-crowd.ts` |
| Server host | `app/server/playground-host.ts`, `app/server/channel-ingest.ts` |
| Owner controls API | `app/server/api/live.ts` |
| Renderer | `app/components/overlay/characters/*`, `app/components/overlay/wasteland/playground-theme.ts` |
| Editor controls | `app/components/overlay/characters-controls.tsx` |
| Art | `public/assets/overlay/wasteland-courier.png`, `public/assets/overlay/wasteland-terrain.png` |

## Identity

- A participant is the platform and the platform user ID. The playground never uses the display name as an identity.
- The same person on two platforms gets two characters.
- The helmet shows the platform color: YouTube red, Twitch purple, and Kick green.
  Instagram copper stays reserved for a future channel platform. Other platforms get gray.
- The name tag shows the platform glyph before the name, in the platform color. The chat cards use the same glyphs.
  A platform without a glyph gets a ring with three dots. Thus the color is never the only cue.
- Frames use short numbers as character IDs. They never contain a platform user ID.

## Rules and constants

The rules clock has 30 ticks each second. The values come from the approved prototype.
To change a value, change `app/lib/playground/constants.ts` and this table.

| Rule | Value |
| --- | --- |
| Visible characters, entrance, exit, and respawn included | 40. The owner can set 5 to 40. |
| Ranked slots | 75 percent of the visible characters, rounded: 30 of 40 |
| Rotating slots | The other visible characters: 10 of 40 |
| Rotation interval | 15 seconds (450 ticks). The rotating slots then advance by their own number of participants. |
| Minimum time on screen | 10 seconds (300 ticks) |
| Score of a message | +1, at most one time in 3 seconds (90 ticks) |
| Score decay | `exp(-elapsed / 1800 ticks)`, a time constant of 60 seconds |
| Command cooldown | 3 seconds (90 ticks) for each viewer |
| Queued commands | 1 for each viewer. It expires after 10 seconds (300 ticks). |
| Bubble time | 4 seconds for a message, 2 seconds for a command |
| Bubbles at one time | 4. A new bubble removes the bubble that is nearest to its end. |
| Bubble text | 80 user-perceived characters |
| Name | 24 user-perceived characters. A longer name ends with an ellipsis (…). |
| Name label after admission | 3 seconds |
| Hole repair in the ground | 30 seconds (900 ticks) after the last hit |
| Block size | 16 world pixels, the size of a ground tile |
| Blocks at one time | 47 percent of the cells of the block grid: 357 in a full frame. The oldest block goes first. |
| Walk of one command | 1 block. A number gives more, to a maximum of 20. |
| Speed of a commanded walk | 1 world pixel each tick: about 2 blocks each second |
| Dig, stairs, and bridge of one command | 1 block. A number gives more, to a maximum of 5. |
| Jetpack | 5 blocks up. A number gives fewer. |
| Grapple reach | 6 blocks |
| Boom reach | All builds with their center within 2.3 blocks. Characters within 40 world pixels fly away. |
| Fall that flattens a character | More than 40 world pixels: 3 blocks or more |
| Platform places | 20 percent of the visible characters for each platform, and 2 at the minimum |
| Crown | The highest character that stands 2 blocks or more above the ground |
| Respawn wait | 2.5 seconds (75 ticks) |
| Inactivity timeout | 60 seconds. The owner can set 10 to 600 seconds. |
| Registry | 500 participants. A participant goes after 30 minutes without a message. |
| Restrictions | 500 banned or timed-out participants |
| Characters test | 5 minutes |

## Lifecycle

1. A first message registers the participant. The participant then asks for a slot.
2. A participant with a slot enters through the entrance door.
   The character then walks to a free place on the ground: the place that is farthest from the other characters.
   Thus new characters do not stand on each other.
3. The character walks on the ground. It turns and stops at random times.
   After a command that steers it, the character stands still between commands.
   A respawn makes it walk around again.
4. A new message resets the inactivity time and shows a bubble.
5. After the timeout without a message, the character walks to the exit door and leaves.
6. A message while the character walks to the exit cancels an inactivity exit. The character turns to the center.
7. A message after the exit asks for a slot again. The character then enters again.
8. A character that falls out of the world or explodes waits 2.5 seconds.
   If it still has a slot, it then comes back on the respawn pad.

If the timeout or a replacement comes during an action, the action ends first. Then the character leaves.

## Admission

The playground chooses the visible participants again after each change:

- An active participant has a score above 0 and a message in the timeout period. A removed participant is not active.
- The owner sets the maximum number of visible characters, from 5 to 40. The default is 40.
- The ranked slots are 75 percent of the slots, as a rounded whole number. The other slots rotate.
  Thus 40 slots give 30 and 10, and 5 slots give 4 and 1.
- The active participants with the highest decayed scores get the ranked slots.
- The other active participants get the rotating slots in turn, in the order of registration.
- When fewer participants wait than rotating slots exist, all of them get a slot.
  Thus no slot stays empty while a participant waits.
- Each platform with active participants keeps places in the ranked slots, for its highest scores.
  The places are 20 percent of the maximum, and 2 at the minimum: 8 of 40 for each platform.
  Thus 1 viewer on Twitch and 1 viewer on Kick stay on screen while 100 viewers write on YouTube.
  With fewer ranked slots than places, each platform gets its first place before a platform gets a second place.
  A platform cannot keep more places than it has active participants. The free places go to the highest scores.
- A participant has at most one slot.
- The slots include characters that enter, leave, or wait for a respawn. Thus a respawn cannot go above the maximum.
- When the owner sets a maximum below the number of visible characters, the extra characters lose their slot.
  They walk to the exit door and leave, as a replaced character does. No new character enters until a slot is free.

Many messages do not move a participant forward. The score increases at most one time in 3 seconds.
The rotation order does not change with new messages. Thus a viewer cannot jump the queue.

## Commands

A command is `!` and a word. Some commands take a number, a side, or both, in any sequence: `!dig 3`, `!dig left`, `!dig r 3`.
The sides are `left`, `right`, `l`, and `r`. Capital letters make no difference.

| Command | Other words | Action |
| --- | --- | --- |
| `!left`, `!right` | `!l`, `!r` | Walk 1 block to that side. `!right 3` walks 3 blocks. The character goes up 1 block alone. At an edge it walks off and falls. After the fall, the walk continues. It stops at a higher wall and at a door zone. |
| `!look left`, `!look right` | `!turn` | Turn to that side without a step. `!turn` turns around. |
| `!stop` | | Stop a walk, and stop work of more than one block. It works at once. |
| `!jump` | | Jump to the side that the character faces. The jump goes as high as a wall of 2 blocks. |
| `!block` | `!box`, `!crate` | Put a dirt block in front. In front of a block, put a second block on top. |
| `!up` | `!pillar` | Put a dirt block under the feet. The character goes up 1 block. |
| `!stairs` | `!build` | Build 1 stair in front and walk up it. `!stairs 3` builds 3 stairs. |
| `!bridge` | | Put 1 plank in front at the level of the floor and walk on it. `!bridge 3` puts 3 planks. It needs a build to start from. |
| `!dig` | | Break the block under the feet. `!dig 3` goes 3 blocks down. `!dig left` breaks the block in front and, with a number, walks into the gap and digs on. On the ground, `!dig` makes a hole in dirt. |
| `!grapple` | `!hook` | Shoot a hook up and to the front. If the hook catches a block, the rope pulls the character on top of that column. |
| `!jetpack` | `!jet` | Fly 5 blocks up, through blocks. `!jetpack 3` flies 3 blocks. With a block under the feet at the top, the character stays there. If not, it falls back. |
| `!boom` | | A cartoon explosion, then a respawn. It breaks the builds near the character and throws the characters there. |
| `!dance`, `!wave`, `!cheer` | `!hi` for `!wave` | Dance, wave, or cheer on the spot |
| `!push` | `!shove` | Push the character in front. That character flies 1 block or more. |
| `!flag` | | Plant a flag in the platform color. Each character has one flag. A new flag moves the old one. |

- A command controls only the character of its sender. Blocks and holes affect all characters.
- A side on a build command turns the character first: `!block left`.
- Only live chat runs a command. A message from a snapshot or a late provider retry never runs a command.
  See [Channel connections and activity](channel-connections.md#event-contract).
- A command from a viewer without a character waits in the queue. The character first enters.
  The command then runs when the character walks in the walking limits. The playground never runs a command that viewers cannot see.
- A command in the cooldown does nothing. A queued command that is older than 10 seconds expires.
- Work of more than one block ends before the next command starts. `!stop` ends it at once.
- A character stays on screen until its action ends. Each action has a fixed end.
- Some commands cannot run: a block in a door zone, a dig on protected ground, a hook that catches nothing.
  Then a red cross shows above the character.
- The dig and the dirt blocks use the art of the ground. Each other action has its own pictures.
  The rope of the grapple is a drawn line.

## Terrain

The world size comes from the characters cell. A cell is 20 × 20 world pixels, and a world pixel is 3 pixels of the design.
A cell of 32 × 4 cells across the horizontal frame gives a world of 640 × 80 world pixels.
A cell of 18 × 6 cells across the vertical frame gives 360 × 120. The minimum cell of 12 × 4 cells gives 240 × 80.
A full horizontal frame of 32 × 18 cells gives 640 × 360.

- The ground is 18 world pixels above the bottom of the world. More height gives more room to build.
- The ground has tiles of 16 world pixels.
- The entrance zone and the exit zone each have 6 protected girder tiles. The respawn pad is on a protected run.
- The middle of the ground repeats a pattern: 5 dirt tiles and 3 girder tiles.
- Only dirt can break. Girders never break, so the entrance and the exit always stay usable.
- A hole in the ground repairs 30 seconds after the last hit.

A change of the characters cell makes a new world. The characters keep their relative position, and their actions stop.
The builds of the old world go.

## Builds

The space above the ground is a grid of cells of 16 world pixels. Each cell holds no block or one block.
The characters move and build only in the characters cell. To give the viewers less of the screen, make the cell smaller.

| Block | From | Rule |
| --- | --- | --- |
| Dirt block | `!block`, `!up` | A wall and a floor. It shows the ground dirt. |
| Stair | `!stairs` | Four steps up in one direction. A character walks up it, or behind it. |
| Plank | `!bridge` | A floor of a bridge. To a character at its level, it is a wall. |

- A block holds when it is on solid ground or touches another block, also at a corner.
- A block that does not hold falls 1 row each 3 ticks. A block that lands on a character breaks, and the character lies flat for a moment.
- A block over a hole in the ground falls out.
- Nothing removes a build with time. `!dig` and `!boom` break builds. A dig breaks a block with 3 hits. The block cracks two times. The third hit breaks it.
- At the block limit, the oldest block goes for each new block.
- The grid ends 30 world pixels below the top of the world. That space stays free for bubbles and badges.
- Nobody builds in a door zone below row 5, or above the respawn pad below row 3. Thus the doors and the pad stay usable.
- A steered character keeps its cell: no block goes there. A character that only walks around does not. A block lifts it.
- Blocks do not stop a character that leaves. Thus a build cannot keep a character on screen.
- The highest character on the builds gets a crown. It keeps the crown until a different character stands higher.

## Bubbles

- A message shows a bubble above its sender. A command shows a short command bubble.
- At most 4 bubbles show at one time. A fresh bubble is more important than an old one.
- A speaking character has no separate name tag. The top row of its bubble shows the platform icon and the name.
  The message text comes below that row.
- A bubble has at most 3 lines of text. Near the top of the layer it has fewer lines, but it always has 1 line.
  A text that does not fit ends with an ellipsis.
- The bubbles stand side by side and do not overlap. Each bubble starts above its sender.
  Bubbles that touch move apart as a row, and the row stays inside the layer. The tail of each bubble points to its sender.
- A bubble is at most 360 pixels wide, or a third of the layer width on a narrow layer.
  If the bubbles do not fit next to each other, the oldest bubbles do not show.
- The overlay draws the name tags first and the bubbles after them, the newest bubble last.
  A name tag that a bubble would cover does not show.
- The server removes control characters and bidirectional marks and limits the length.
  The overlay draws names and bubble text with `fillText`. It never inserts them as HTML.

## Moderation

| Event | Effect |
| --- | --- |
| `delete` | The bubble, the queued text, and the queued command of that message go. |
| `ban` or timeout | The character goes at once and frees its slot. Its queued command and bubble go. The playground ignores the chat of the participant until the restriction ends. A ban without an end lasts 30 minutes. |
| `clear_user` | The bubbles of that user go. |
| `clear` | All bubbles of that platform go. |

Moderation applies also while the playground does not run.
Kick has no message deletion events, and YouTube has no clear events.
See the [capability matrix](channel-connections.md#capability-matrix).

## Controls

The characters layer is one of the layers in step 1 (**Build your overlay**) of the **Overlay** section of **Streamer tools**.
To put it on the grid, select its chip in the palette. Its settings show when you select the layer:

- **Show on stream** shows or hides the layer. The layer stays on the grid.
- **Seconds without chat before a character walks out** sets the inactivity timeout, from 10 to 600 seconds.
  The editor saves the value in the layers (`characters.timeout`) when you leave the field or press Enter.
- **Maximum characters on screen** sets the number of visible characters, from 5 to 40.
  The editor saves the value in the layers (`characters.max`) in the same way.
- **Pause** stops the playground. The characters stand still and commands do nothing. **Resume** starts it again.
- **Clear all builds** removes all blocks, stairs, planks, and flags with one click. The characters stay and fall to the ground.
- **Reset playground** asks for a confirmation. Then all characters and all builds go at once and the ground becomes complete again.
  Removed viewers can come back. Chat bans and timeouts stay.
- Pause, clear, and reset need the saved characters layer on stream.
  When it is off stream, the buttons are unavailable and a hint tells you to show the layer.
- Viewers see a **PAUSED** badge during a pause, and a **TEST** badge during a test.
- **Characters on the playground** lists the visible characters with their platforms. **Remove** takes one character off.
  A removed participant stays off until a reset, or until the registry forgets the participant.
- **Remove from grid** takes the layer off the grid of the selected orientation.

**Start test** in the toolbar of the studio plays a synthetic crowd for 5 minutes. **Stop test** ends it.
The same button starts the chat test. See [Test](overlay-composition.md#test).

The characters test needs the saved characters layer on stream.
A start of the test also resumes a paused playground, so the test shows at once.
During a pause, the text beside the button and the start message tell you this.

The layer is on stream when it has a cell in an output and **Show on stream** is on.
One playground serves the two outputs. See [Outputs](overlay-composition.md#outputs).
The preview opens the owner's own characters socket while the characters layer is on stream.
The editor reads the pause and the test only while the saved characters layer is on stream.

The chat preview still shows sample messages.
When the server has no playground (`503`), the editor shows "Characters are off on this server" instead of an error.
The controls use `POST /api/overlay/characters`. See [API](api.md#overlay-layers).

## Characters test

The test plays about 60 synthetic participants on Twitch, YouTube, and Kick for 5 minutes.
The participants reuse the sample chat users. The script has a fixed seed for each test.
Each minute has each command, a deleted message, and a timeout. From the second minute, each minute also has an exit reversal.

The test events go only to the playground. They never go to a provider or to the activity sockets.
Stopping the test removes the synthetic participants. The real participants stay.

## Frame protocol

The frames use the activity socket of the page. A socket gets frames only when it asks for them with `characters=1`.
`app/lib/playground/protocol.ts` has the contract (version 2).

- The first frame on each socket is a full frame (`full: true`). It has `roster`, `bubbles`, `terrain`, `extras`, and `mode`.
- A tick frame (`full: false`) comes each 100 ms. It has `chars`. It has the other sections only when they changed.
- `terrain.blocks` is the block grid as text: one character for each cell, in rows from the ground up.
  A letter from `a` to `r` gives the kind, the direction, and the damage of a block. A period is an empty cell.
  The text ends after the highest row that has a block. The full frame has at most 1480 cells.
- `extras` has the grapple ropes, the flags, and the ID of the character with the crown.
- A character is a tuple: `[id, x × 10, y × 10, state, ticks in state, direction, flags]`.
- A reconnect or a restarted object sends a new full frame. The overlay then replaces its state.
- The overlay ignores a tick frame before the first full frame.
- A frame is at most 32 KiB. A typical tick frame is 1 to 1.5 KB. A frame with a changed terrain adds the block grid.

The overlay keeps the newest frames and draws 100 ms behind them. Thus it can move characters smoothly between two frames.
A move of more than 24 world pixels, or a change of state, does not slide.
Dust and other particles come only from the overlay. Thus they can be different in two sources.
Positions, terrain, rankings, and the results of actions come only from the server.

With reduced motion, the overlay shows each frame as it arrives, without particles and with still pictures.

## Server host

The playground of a page runs in the `ChannelIngest` Durable Object of that page (`PlaygroundHost`).

The playground runs only when all these conditions are true:

- At least one socket that asked for characters is open.
- The saved characters layer is on stream.
- The owner did not pause the playground.

Each 100 ms, the host runs the rules ticks that are due, at most 10. Then it sends one frame.
After a longer stop, the host does not run the missing ticks.

### Registry mode

When the playground does not run, it is in registry mode. In registry mode no tick frames go to the sockets:

- Chat changes only the scores and the time of the last message.
- Moderation applies.
- The playground drops commands. It never keeps them for later.

When the playground runs again, its clock moves over the gap. Due repairs and expiries apply.
Each visible character then walks. The playground drops actions, bubbles, and queued commands.

In registry mode the host sets an alarm for the next expiry of a participant, a restriction, or the test.
While the playground keeps a state, the alarm comes at least once each minute (`LAYER_CHECK_MS`).
The alarm reads the saved layers again, moves the clock, forgets the expired data, and saves the checkpoint.
When the playground keeps no participant and no restriction, has no pause, and runs no test, the alarm deletes the checkpoint.

A control while the playground stands sends a full frame. Thus the badges and the list in the editor change at once.
Moderation while the playground stands also sends a full frame. Thus a removed character or bubble goes from the stream at once.

### Checkpoint and eviction

The host keeps one checkpoint in the storage of the object (key `playground`, at most 60,000 characters).
It saves the checkpoint at most each 5 seconds while the state changes, and when the playground stops.
The checkpoint holds the clock, the registry, the restrictions, the terrain with its builds and flags, the rotation, the pause, the test, and the settings.

After an eviction, the object restores the checkpoint. The visible characters come back and walk. The builds stay.
Actions, bubbles, and queued commands are not in the checkpoint. Thus a restored playground never runs an old command again.

While the playground runs, the host keeps an alarm 15 seconds ahead (the watchdog).
The alarm starts a playground again when an eviction stopped its interval.

### Configuration

After each saved layer change, the server asks the object to read the layers again (one D1 read).
Other overlay changes do not ask. The server asks only when the deployment has the activity feed.
The object reads the layers only while a characters socket is open or the playground keeps a state.
A change that comes during a read causes one more read after it.

A new cell makes a new world. A new timeout and a new maximum apply at once.
A layer that is off stops the playground and deletes its state and its checkpoint.

## Kill switch and environments

The `CHANNELS_OFF` secret stops the activity sockets. Thus it also stops the playground,
and `POST /api/overlay/characters` returns `503`. See [Turn the feature off](channel-connections.md#turn-the-feature-off).

The open characters layers go empty.

A deployment without the `CHANNEL_INGEST` binding has no characters, and `POST /api/overlay/characters` returns `503`.
The `test` environment in `wrangler.jsonc` has the binding, so the characters run there.

## Rollback

A rollback to a version without the playground leaves the checkpoint in the object storage.
The old version does not read it. The alarm of a later version deletes it when it holds no participant.
After a rollback, refresh each OBS browser source with the characters layer.

Version 2 of the frames and of the checkpoint came with the builds. An overlay page that loaded before the update ignores the new frames, so refresh it.
A version with a different contract does not read a stored checkpoint. The playground then starts with no characters and no builds.

An old version that saves the layers drops the characters timeout. The timeout then goes back to 60 seconds.
A version without the maximum drops `characters.max` in the same way. The maximum then goes back to 40.

## Cost

The object is active only while the playground runs.
The estimate is about 0.006 US dollars for each hour a characters source or the editor preview is open.
A playground without a characters socket costs nothing more than the activity feed and its expiry alarms.

## Logs

Logs never contain message text, user IDs, or names. Each log has only an event name and an error class.

| Event | Meaning |
| --- | --- |
| `playground_tick_failed` | A tick failed. The playground stops until the next layer change or socket. |
| `playground_frame_invalid` | A full frame broke the contract. The host sends a full frame at the next frame. |
| `playground_config_failed` | The layers read failed. The playground keeps the last known settings. |
| `playground_checkpoint_failed` | A checkpoint write failed. The host tries again later. |
| `playground_checkpoint_delete_failed` | A checkpoint delete failed. The alarm tries again. |
| `playground_alarm_failed` | After a stop, the checkpoint or the next alarm failed. The next change or alarm tries again. |
| `playground_checkpoint_invalid` | A stored checkpoint did not agree with the contract. The playground starts with no characters. |
| `characters_layer_failed` | In the browser console of the overlay: the pictures did not load or the canvas failed. The layer stays empty. |

## Retention

The registry holds the platform user ID, the display name, the score, and the time of the last message.
It never holds message text. The privacy policy (`app/routes/privacy.tsx`) describes this list.

- The registry keeps at most 500 participants. A participant goes 30 minutes after their last message.
  This includes a visible participant while the playground does not run.
- When the registry is full, the participant without a slot with the oldest message goes first.
- A removed participant stays off until a reset or until the registry forgets the participant.
- Restrictions end at their end time. A ban without an end lasts 30 minutes. The playground keeps at most 500 restrictions.
- An alarm forgets each participant and restriction on time, also when no more chat comes.
  When the playground keeps no participant and no restriction, has no pause, and runs no test, the alarm deletes the checkpoint.
- With the characters layer off stream, the playground keeps nothing. Taking the layer off stream deletes the checkpoint at once.
  If the change notice to the object does not arrive, the next alarm deletes it. The alarm comes within one minute (`LAYER_CHECK_MS`).
- Deleting the page deletes the checkpoint.

## Asset provenance

We generated the courier and terrain art for this project. The design prototype of #664 approved it.
We removed the source files when we added the production files.

We made `public/assets/overlay/wasteland-courier.png` from the courier source with Python and Pillow:

1. We removed the edge pixels with an alpha below 112. We made the other pixels opaque.
2. We moved each frame to the mirror axis of its cell. We aligned the boots of the standing frames with row 29 of the cell.
3. We found the helmet and the scarf by color and by connection. Then we corrected each frame and examined it tinted at 8×.
4. The base region keeps the lightness of the helmet and the scarf as gray.
   The mask regions hold a tint shade of 16 levels, and their alpha is the tint strength.
5. We drew the flying helmet and the flying boot again from the pixel definitions of the prototype.
6. The file has one palette of 256 colors with exact alpha.

`public/assets/overlay/wasteland-terrain.png` holds the terrain pictures of the prototype.
We exported them from the drawing code of the prototype in headless Chromium.
Then we cleaned them to binary alpha and 128 colors. The file also holds the hole edge and the stair step.
The playground does not use the stair step now.

The art of the second set is in `design/assets/Imagery/characters/expansion-v1`. Its `README.md` gives the source and the checks.
We added that art to the two files with Python, Pillow, and NumPy:

1. Seven rows follow the first 12 rows of the courier: dance, cheer, shoot, rope ride, climb, jetpack, and push.
   The loose equipment is below row 18.
2. We made the helmet and scarf masks of the new rows lighter, to the 16 levels of the first masks.
   Thus a new row gets the same platform color as an old row.
3. The props are below the terrain pictures: the planks, the stair, the hook, the flames, the crown, and the viewer flags.
   The mask of the flag cloth is beside the flags. It gets the platform color.
4. Each file keeps one palette of 256 colors. To fit, we joined the two nearest opaque colors until 256 values were left.
   No color channel changed by more than 7 of 255. The alpha is exact.

Each atlas URL ends in `?v=` and the first 8 hexadecimal digits of the SHA-256 of the file.
The art ships under the project license.

## OBS setup

1. In the **Overlay** section of **Streamer tools**, select the **Characters** chip in the palette. The layer goes on the grid and on stream.
   Drag the layer to its place and drag a handle to give it its size.
2. Use the composition URL, or add a browser source with the characters layer URL:

   ```text
   https://<origin>/@<handle>/overlay?key=<key>&layer=characters
   ```

3. Give the source the size of the characters cell. The **Overlay** section shows it under **Layer URLs**.
   A cell across the bottom of the horizontal frame is 1920 × 240. A cell of the full frame is 1920 × 1080.
4. Keep the background of the source transparent.
5. Select **Start test** to see the playground in OBS before you go live.
6. After an update of Stream Bullets, refresh the browser source once.

Each open characters source keeps the playground running and uses one activity socket.
Close the sources that you do not use.
