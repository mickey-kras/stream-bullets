# Streamer tools: the Overlay section

Streamer tools is the page where a streamer runs the stream, at `/tools`.
Tools is a tab of the streamer header. Only the page owner sees it.
The page has the sections Live, Overlay, and Channels. The old address `/overlay-control` redirects to the page.
The two images are screenshots of the Overlay section of the real app with test data.

For the approved design of all the sections, see `StreamerTools`.

## Sections

- **Overlay**: the streamer builds the OBS overlay in two steps.
  1. **Build your overlay**: the studio.
  2. **Add to OBS**: one private link for the horizontal output and one for the vertical output.
- **Channels**: the Twitch, YouTube, and Kick cards. Each card shows the platform icon and the state of the connection.

## Studio

- The toolbar is one line. It has the **Horizontal** and **Vertical** tabs, the layout list, and three icon buttons at its right edge.
  - `save` saves the layout as a new layout.
  - `reset` goes back to the preset. It shows only for a preset that the streamer changed.
  - `play` starts the test of the chat and the characters. During a test it shows the `stop` icon and the gold fill.
- Each icon button has a tooltip and an accessible name. It shows no text.
- The layout list has the presets, the layouts of the streamer, **New layout…**, and **Rename or delete layouts…**.
- Each output keeps its own layout. The horizontal grid is 32 × 18 cells, and the vertical grid is 18 × 32 cells.
- The line below the toolbar has the preview background: transparent or a sample game.
- Each change goes live immediately. There is no preview step.
- **Layers · one of each** lists the nine layers in two groups. Each group can close, and all the groups start open.
  - Picture: chat, characters, and camera frame.
  - Content: poll, topic, up next, message banner, community card, and support banner.
- The title of a group shows its name and the number of its layers, such as "Picture · 3".
- Select a layer to put it at the first free place, or drag it onto the grid.
- **Camera frame** is a frame with a clear window. The streamer shows the camera through the window in OBS.
  In the editor, the window shows the text "Your OBS camera shows here".
- The grid has cells of 60 × 60 pixels. Drag a layer to move it. Drag a handle to change its size.
- Drag a layer back to the list to remove it.
- The panel with the properties of the selected layer is below the grid for the horizontal output and beside the grid for the vertical output.
- The help text for the grid is in a closed `details` element, "How the grid works". It gives the keys.
- The keyboard can do all of these actions. A screen reader reads the keys as the description of the grid. It does not need the open help.

On a phone, the layer list is above the grid, and the properties panel and the help are below the grid.

## Add to OBS

- The title row has two buttons at its right edge: one shows or hides the links, and one makes new links.
- One card for each output shows its name, its state in OBS, and the size of its browser source.
- While the links show, each card shows its link and a `copy` icon button. One line tells the streamer to keep the links private.
- The page does not show a link for each layer.
- The closed sections below the cards have the OBS guide, the OBS dock, and the Twitch chat switches.
