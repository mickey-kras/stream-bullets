# Streamer tools: the approved design

Streamer tools is the page where a streamer runs the stream, at `/tools`.
This page gives the design that the owner approved for its sections: Live, Overlay, Channels, and Reports.
The app has the **Overlay** section of this design, with the **Alerts** and **Goal** layers. See [Overlay](#overlay).
The app does not have all of the other sections yet: **Live** and the dock have no **Activity** part, and there is no **Reports** section.
Build each section to this page, then replace this note with screenshots of the app.

The mockup has each screen: <https://claude.ai/artifact/VP62UitqK7mL6hANMbq32W>.
The link opens only for accounts that have access to it.
The preview on this page shows the patterns with the parts and the tokens of the design system.

## Principle

A streamer must know what each control does when they look at it. Do not make them read a paragraph first.

- Use few words. Put the text that explains a part in a closed `details` element.
- Use one style for one type of control.
- Keep the text of a row wider than its buttons. The text is the information.

## Sections

| Section | Icon | Use |
| --- | --- | --- |
| Live | `live` | Run the stream. |
| Overlay | `layers` | Build the overlay and add it to OBS. |
| Channels | `channels` | Connect the channels. |
| Reports | `reports` | Read the results after the stream. |

- On a desktop, the sections are text tabs.
- On a phone, the sections are four tabs in a second line of the header. Each tab shows an icon and has the same width.
- A tab on a phone has no text. It has a tooltip and an accessible name. The open tab has the gold fill.
- On a phone, the name of the open section is the title of the content. The content does not show the name of the page.
- On a phone, the On air pill is below the name of the streamer in the header.

## Live

- The parts are: channel health, the preview, the poll, the topics, the message banner, the chat, and the activity.
- The preview shows the two outputs. It is read-only. A `pencil` button beside its title opens the Overlay section.
- The poll actions (reveal the results, close the voting, take the poll off air) fill one row in three equal columns.
- The three buttons that feature a topic and the button that puts the message on stream have one width.
- Activity has the buttons to test an alert and to mute the alerts in its title row.
- The alert on stream shows in a box with a gold border and a Skip button. A row has a Replay button while the server keeps its event.
- Skip and Replay have the same width and the same left and right edges.
- In an activity row, the title is beside the button. The details line is below them and uses the full width of the row.
- A test and a replay show an alert again. They do not count for a goal, a report, or revenue.
- Mute stops the alert on stream at once and removes the alerts that wait. The alerts of the muted time do not play later.

The app has the activity of Live. It has the test and mute buttons, the box of the alert on stream with Skip, and the Replay buttons.
The behavior is in `docs/streamer-tools.md`, in the section Activity.

## Overlay

- Step 1 has a toolbar: the Horizontal and Vertical tabs, the layout list, and three icon buttons at the right.
  - `save` saves the layout as a new layout.
  - `reset` goes back to the preset. Only the horizontal output has it.
  - `play` starts the test.
- The layer list has three groups. Each group can close, and all the groups start open.
  - Picture: chat, characters, and camera frame.
  - Recognition: alerts and goal.
  - Content: poll, topic, up next, message banner, community card, and support banner.
- Alerts and Goal are layers. They are not a section.
- The details of the selected layer are below the grid for the horizontal output and beside the grid for the vertical output.
- The Alerts layer has a list of test alerts with a button that sends the test. It also has the switch that shows the layer on stream.
- The Alerts layer has a table of rules. For each event, a rule gives the amount where the alert starts.
  A rule also has three switches: the banner, the mark in chat, and the reaction of the character.
  On a phone, each rule stacks. The event is on one line, and its four cells are below it in two columns.
- The Goal layer counts one thing. It has the title on stream, the thing that it counts, the target, and a button that starts the count again.
- The help text for the grid stays closed until the streamer opens it.
- Step 2 has two buttons beside its title, at the right: one shows or hides the links, and one makes new links. One card for each output shows the link and a copy button when the links show.
- The page does not show a link for each layer.

## Channels

- The cards are in one row and have the same height.
- A connected card has three lines:
  1. The platform pill is at the left. The status icon and the account name are at the right, with their centers on one line.
  2. Reconnect (`refresh`) and Disconnect (`close`) fill the line in two equal columns. They look the same on each card. The **Disconnect** button uses the `danger-*` tokens.
  3. A closed `details` element at the bottom of the card gives what the app reads and the limits.
- The status is an icon with a tooltip, not a line of text.
- A card without a connection has the platform pill and the **Connect** button on one line.
- Alerts and goals read the support events from each connected channel. There is no switch.
  Twitch asks for three more permissions at the connection. A Twitch channel from before this change must connect again one time.

## Reports

- The title row has two buttons: one downloads the CSV file and one downloads the PDF file. The PDF arrives as a file. The browser does not show a print dialog.
- Direct tips show only after the owner connects a payment provider.

## Dock

The private OBS dock has the same actions as Live in a width of 360px.
It has the poll, the next topic, the chat, and the activity. The activity has the buttons to mute, test, skip, and replay.
The app has the activity of the dock with these four actions.

## Not decided

- One goal or two goals at one time.
- A limit for the line of alerts. One alert shows for 6 seconds.
- The amounts where alerts start: 100 Bits, 100 KICKs, and a raid of 5 viewers.
