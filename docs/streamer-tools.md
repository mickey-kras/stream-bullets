# Streamer tools

**Streamer tools** is the page of the owner at `/tools`. The header of a streamer page has its **Tools** tab.
Only the owner of the page can open it.

| Section | Address | Use |
| --- | --- | --- |
| **Live** | `/tools` or `/tools?view=live` | Run the stream. |
| **Overlay** | `/tools?view=overlay` | Build the overlay and add it to OBS. See [overlay composition](overlay-composition.md). |
| **Channels** | `/tools?view=channels` | Connect the channels. See [channel connections](channel-connections.md). |

The page opens the **Live** section. The old address `/overlay-control` opens the **Overlay** section.

| Area | File |
| --- | --- |
| Route and loader | `app/routes/tools.tsx` |
| Sections and their addresses | `app/lib/shell.ts` (`toolsViews`, `toolsPath`) |
| Live section | `app/components/tools/live-section.tsx` and the `live-*.tsx` files beside it |
| Chat log | `app/lib/live-chat.ts` |
| Overlay state and saves | `app/components/overlay/use-overlay-state.ts` |

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

A control changes a layer that has a place on the grid of the selected orientation.
**Live** does not put a layer on the grid: the owner selects the place in the **Overlay** section.
For a layer without a place, the part shows a note and a link to the **Overlay** section.

### Channels and OBS

The part gives the health of each channel in words: connected, needs attention, or not connected.
For a channel that needs attention, it also gives the problem.
One line gives the number of OBS sources that use the overlay link, or the time when the last source went away.

### What OBS shows

The preview shows the composition of the selected orientation with the real content and the real chat.
It uses the activity feed of the owner, without an overlay key.

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

A poll layer that shows the latest active poll changes its poll when that poll closes.
It then shows the next open poll of the owner. If no poll is open, it shows the newest poll of the owner.

### Topics from your viewers

The part lists the six newest topics. If the topic layer shows an older topic, that topic is the first in the list.
**Feature on stream** shows a topic in the topic layer and turns the layer on.
`Take off air` turns the topic layer off. The topic stays on the page.

### Message banner

The part has the text and the style of the message banner.
`Put on stream` saves the text and the style, and turns the message layer on.
**Update on stream** saves a changed text or style. `Take off air` turns the layer off.
The text is a draft while the layer is off: viewers do not get it.

### Chat

The part shows the merged chat of the connected channels. It keeps the newest 500 messages.
The list follows the newest message.

- A scroll up pauses the list. **Pause chat** also pauses it.
- A paused list keeps its place and shows the number of new messages.
  It keeps each message that it shows, and at most 500 new messages.
- **Jump to latest** shows the new messages and follows the newest message again.
- A button for each platform shows or hides the messages of that platform.

The pause and the platform buttons apply to this browser only. They do not change what OBS shows.

A message that a moderator deleted stays in its place without its text.
The same applies to each message of a viewer who got a ban or a timeout.
This also applies during a pause of the list.
After a reconnect, it applies to each message of the last 9 minutes that the server no longer has.

The chat uses the activity feed of the owner. See [channel connections](channel-connections.md).
The owner can use the list with a keyboard: the list takes the focus, and the arrow keys scroll it.

Alerts and support events are not in this section yet.
