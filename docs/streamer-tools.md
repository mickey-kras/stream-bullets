# Streamer tools

**Streamer tools** is the page of the owner at `/tools`. The header of a streamer page has its **Tools** tab.
Only the owner of the page can open it.

| Section | Address | Use |
| --- | --- | --- |
| **Live** | `/tools` or `/tools?view=live` | Run the stream. |
| **Overlay** | `/tools?view=overlay` | Build the overlay and add it to OBS. See [overlay composition](overlay-composition.md). |
| **Channels** | `/tools?view=channels` | Connect the channels. Each connected channel reads its support events: the section has no switch for them. See [channel connections](channel-connections.md). |

The page opens the **Live** section. The old address `/overlay-control` opens the **Overlay** section.

| Area | File |
| --- | --- |
| Route and loader | `app/routes/tools.tsx` |
| Sections and their addresses | `app/lib/shell.ts` (`toolsViews`, `toolsPath`) |
| Title and section tabs | `app/components/tools/tools-head.tsx` |
| Live section | `app/components/tools/live-section.tsx` and the `live-*.tsx` files beside it |
| Chat log | `app/lib/live-chat.ts` |
| Support events in the chat log | `app/components/tools/live-support.tsx` |
| Overlay state and saves | `app/components/overlay/use-overlay-state.ts` |

## Title and section tabs

The approved design is in `design/components/StreamerTools/README.md`.

On a desktop, the title is the name of the page. The sections are text tabs below the title.

On a phone, the layout is different. A phone is a screen with a maximum width of 700 pixels.

- The sections are tabs of equal width in one line below the site header. The line has the full width of the screen.
- A tab shows only an icon: `live`, `layers`, or `channels`. The name of the section is the tooltip of the tab and its name for a screen reader.
- A tab is a minimum of 48 pixels high. The open tab has the gold fill.
- The line of tabs stays below the header while the page scrolls.
  On a screen with a maximum height of 544 pixels, the line scrolls with the page.
- The title is the name of the open section. The name of the page does not show.

The page has one `h1` title at each width. The title of the browser tab is the name of the page in each section.

The header of a streamer page can show a live pill. On a phone, the pill is below the name of the streamer.
The left edge of the pill is at the left edge of the name. The header does not become higher.
This applies to each page with that header.

If the header is too narrow for the pill below the name, the pill is on the lower edge of the avatar.
That occurs on a screen that is less than 360 pixels wide, and at a larger text size on a wider phone.

## Live

The **Live** section has the controls for a stream on one page. It has these parts:

- **Channels and OBS**
- **What OBS shows**
- **Poll**
- **Topics from your viewers**
- **Message banner**
- **Chat**

Each control saves with `POST /api/overlay`, or with the API of the poll for **Close voting**.
The live room sends each change to OBS and to the other tabs of the owner at once. OBS does not load the page again.
After a reconnect, the section shows the state of the server.

A control changes a layer that has a place on the grid of an output.
**Live** does not put a layer on the grid: the owner selects the place in the **Overlay** section.
For a layer without a place, the part shows a note and a link to the **Overlay** section.

### Channels and OBS

The part gives the health of each channel in words: connected, needs attention, or not connected.
For a channel that needs attention, it also gives the problem.
One line gives the number of OBS sources that use the overlay link, or the time when the last source went away.

### What OBS shows

The preview shows the composition of the output that the editor shows, with the real content and the real chat.
If that output shows Twitch chat only, the preview does the same.
See [Twitch chat only](overlay-composition.md#twitch-chat-only).
It uses the activity feed of the owner, without an overlay key.

The preview is read-only. A button with the `pencil` icon is beside the title of the part.
It opens the **Overlay** section, where the owner changes the overlay.

Live reads that feed through one connection, for the preview and for the chat part.
The page keeps the recent chat of that connection, without the messages that a moderator removed.
When the chat layer goes on stream while Live is open, the preview shows that recent chat at once, as OBS does.

### Poll

The part shows the poll of the poll layer. The poll layer shows the latest active poll, or the poll that the owner
selected in the **Overlay** section.

The names of some controls are in code format here: the writing check of this repository reads them as text.

| Control | Result |
| --- | --- |
| **Copy link** | Copies the address of the poll on the page. |
| **Show QR code** or **Hide QR code** | Shows or hides the QR code in the card on stream. |
| **Reveal results** or **Hide results** | Shows or hides the results on stream. Voting continues. |
| **Close voting** | Ends the vote on the page. The page then shows the results. You cannot open the vote again. |
| `Take off air` or `Put on air` | Hides or shows the poll layer. Voting stays open on the page. |

**Close voting** shows only while viewers can vote. A Mash Battle has its own controls and no **Close voting**.

**Copy link** and the button for the QR code are small buttons in one line.
The three controls below them change the stream. They fill one row in equal columns: two columns when **Close voting** does not show.
The row adapts to the width of the part:

| Width of the part | Layout |
| --- | --- |
| 30 rem or more | One row. The icon is before the label. |
| From 21.5 rem to 30 rem, as on a phone | One row. The icon is above the label. |
| Less than 21.5 rem, as in a narrow dock | One column of buttons with the same width. |

The widths are in rem. Thus a larger text size gets the narrow layout on a wider screen.
A label that is too long for its button continues on a second line. The button does not cut the label.

A poll layer that shows the latest active poll changes its poll when that poll closes.
It then shows the next open poll of the owner. If no poll is open, it shows the newest poll of the owner.

### Topics from your viewers

The part lists the six newest topics. If the topic layer shows an older topic, that topic is the first in the list.
**Feature on stream** shows a topic in the topic layer and turns the layer on.
`Take off air` turns the topic layer off. The topic stays on the page.

A line divides the rows of the list. The button of a topic is at the end of its row.
The buttons of the topics and the buttons of the message banner have one width and the same right edge.
In a part that is less than 30 rem wide, each of these buttons has the full width of the part.

### Message banner

The part has the text and the style of the message banner.
`Put on stream` saves the text and the style, and turns the message layer on.
**Update on stream** saves a changed text or style. `Take off air` turns the layer off.
The text is a draft while the layer is off: viewers do not get it.
The state of the banner, on air or off air, is at the start of the row of the buttons.

### Chat

The part shows the merged chat of the connected channels. It keeps the newest 500 rows.
The list follows the newest row.

The list also shows the support events of each connected channel that reads them.
See [Support events](#support-events).

- A scroll up pauses the list. **Pause chat** also pauses it.
- A paused list keeps its place and shows the number of new messages.
  It keeps each message that it shows, and at most 500 new messages.
- **Jump to latest** shows the new messages and follows the newest message again.
- A button for each platform shows or hides the messages of that platform.

The pause and the platform buttons apply to this browser only. They do not change what OBS shows.

**Hide chat commands (!jump)** in the settings of the chat layer also applies to this list. The option is on by default.
With the option on, the list has no row for a command, and a paused list does not count it.
The list keeps these messages: when you clear the option, they show again in their places.
See [Commands](overlay-composition.md#commands).

A message that a moderator deleted stays in its place without its text.
The same applies to each message of a viewer who got a ban or a timeout.
This also applies during a pause of the list.
After a reconnect, the server tells from which time its chat history is complete.
The part then shows each newer message that the server no longer has as removed.

The chat uses the activity feed of the owner. See [channel connections](channel-connections.md).
The owner can use the list with a keyboard: the list takes the focus, and the arrow keys scroll it.

### Support events

A support event is a row in the chat list, at the time of its arrival. The row has these parts:

- The icon of the platform.
- The name of the supporter, or "Anonymous" when the event names no supporter.
- A line that tells the kind and the amount, for example "100 Bits" or "subscribed for 3 months".
- The text of the supporter, if the event has one. The row shows it as text only.

The line shows money in its currency and in the format of the language. The page converts no amount.
A support row has a gold edge and a tint, so it does not look like a chat message.

These rules apply to support rows:

- The list has one row for each event. A replay and the copy in a reconnect snapshot add no second row.
- No moderation event removes a support row.
- The limit of 500 rows applies to chat and support rows together.
- The platform buttons also show or hide the support rows of the platform.
- A paused list counts new support rows with the new messages.

The full-screen chat and the dock show the same rows.
After a load of the page, the list has the support events that the server keeps: the newest 50, for 10 minutes.

### Full-screen chat

**Open chat full screen** shows the chat on the full screen. It is for a phone that stands in front of the streamer.
The view is in the address: `/tools?view=live&chat=full`. Thus the Back button of the browser also closes it.

The view has these controls:

- **Exit** closes the view. The **Live** section is then at the same place as before. The Escape key does the same.
- **Smaller text** and **Larger text** change the text size in five steps. The device keeps the size.
- The platform buttons and the pause work as in the chat part.
  A paused list keeps the message that the streamer reads when the view opens and when it closes.

One line gives the item on stream: the poll, or the topic, or the message banner.
With the phone upright, the controls are above the chat.
With the phone on its side, the controls are in a rail at the side, and the chat has the full height.

The view asks the browser for a screen wake lock, so the screen stays on while the view is open.
The browser takes the lock away when the page goes out of view. The view gets the lock again when the page shows again.
**Exit** releases the lock.
In a browser without the wake lock, or when the browser refuses the lock, the view shows a note.
The note tells the streamer to stop the screen lock of the device.

If the browser can show an element on the full screen, the view asks for that. Then the browser bars go away too.
If the streamer leaves the full screen of the browser, the view closes.
Safari on iPhone cannot show an element on the full screen. There, the view covers the page and its bars.

The page has a web app manifest, `public/tools.webmanifest`, with `display: standalone`.
A streamer can add **Streamer tools** to the home screen of a phone.
It then opens the full-screen chat without browser bars.

A new message fades in. The Motion setting of the site and of the system stop this motion.

The full-screen chat shows support events as the chat part does. See [Support events](#support-events).
Alerts on stream are not in this section yet.

## Overlay

The **Overlay** section has two steps. See [the editor](overlay-composition.md#editor) for each part.

1. **Build your overlay** is the overlay studio.
   - The toolbar is one line: the **Horizontal** and **Vertical** tabs, the list **Layout**, and three icon buttons at its right edge.
     The buttons are **Save as a new layout**, **Reset to the preset**, and **Start test**. Each button has a tooltip.
   - The layer list has the groups **Picture** and **Content**. Each group starts open, and you can close it.
   - The settings of the selected layer are below the grid of the horizontal output.
     They are beside the grid of the vertical output. On a phone, they are below the grid.
   - The help **How the grid works** stays closed until you open it.
2. **Add to OBS** has the links for OBS.
   - The title row has the buttons **Show links** and **Regenerate links** at its right edge.
   - One card for each output shows its name, its state in OBS, and the size of its browser source.
     While the links show, the card also shows the link and a button that copies it.
   - The step does not show a link for each layer. See [URLs](overlay-composition.md#urls).

## OBS dock

The OBS dock is a small page with the live controls, for a custom browser dock in OBS.
The streamer changes the stream there and does not go to a browser.
The dock has these parts of **Live**, in one column: the poll, the topics, the message banner, and the chat with its pause.
The chat of the dock also shows the support events.
It is usable from a width of 300 pixels. It scrolls in its panel.

An action in the dock shows in **Live** at once, and an action in **Live** shows in the dock at once.
When an action fails, the dock shows a message with the cause, as **Live** does.
The dock does not show the preview, the channel health, and the layout. For those, use **Streamer tools** in a browser.

### Dock link

The step **Add to OBS** of the **Overlay** section has a closed section, **Control your stream from inside OBS**.
**Create dock link** makes a private link: `https://<origin>/@<handle>/dock?key=<key>`.
The link shows one time. The server keeps only the SHA-256 hash of the key.

In OBS, open `Docks`. Select `Custom Browser Docks`, and paste the link.

The link gives control of the stream. Keep the dock off screen: do not capture it in a scene, and do not share the link.
**Regenerate dock link** makes a new key. The old link stops at once, and each open dock shows that its link does not work.

### What the dock key allows

The dock page has no session. Each call of the dock to the server has the dock key in the `X-SB-Dock-Key` header.
The key allows only these changes:

- The switch for the poll results, and the end of the voting of a poll.
- The text and the style of the message banner.
- For the poll, the topic, and the message banner: the switch **Show on stream**, the picked item, and the QR code.

The server refuses each other change with `403`: the layout, the outputs, the chat, the characters, the links, and the layouts.
The dock key is not a session. It gives no access to the account, to channel management, or to an overlay link.

The dock key and the overlay keys are different keys in different tables.
An overlay key never opens the dock and never allows a control action. The dock key never opens the overlay as an OBS source.
A wrong key, a page that does not exist, and a suspended page get the same answer.

In the live room and in the activity feed, a dock has the seat and the data of the owner.
It uses one of the 10 priority seats. See [live capacity](live-room-capacity.md).
The dock link sends no `Referer`.
