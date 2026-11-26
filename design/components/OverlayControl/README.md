# Streamer tools: the Overlay section

Streamer tools is the page where a streamer runs the stream, at `/tools`.
Tools is a tab of the streamer header. Only the page owner sees it.
The page has the sections Overlay and Channels. The old address `/overlay-control` redirects to the page.
The two images are screenshots of the Overlay section of the real app with test data.

## Sections

- **Overlay**: the streamer builds the OBS overlay in two steps.
  1. **Build your overlay**: the studio.
  2. **Add to OBS**: one private link for the horizontal output and one for the vertical output. Each link shows its state in OBS.
- **Channels**: the Twitch, YouTube, and Kick cards. Each card shows the platform icon and the state of the connection.

## Studio

- The orientation is horizontal 32 × 18 or vertical 18 × 32. Each orientation keeps its own layout.
- The preview background is transparent or a sample game.
- **Start test** shows test chat and characters when Chat or Characters is on stream.
- Each change goes live immediately. There is no preview step.
- **Layers · one of each** lists the nine sources. Select a layer to put it at the first free place, or drag it onto the grid.
- **Camera frame** is a frame with a clear window. The streamer shows the camera through the window in OBS.
  In the editor, the window shows the text "Your OBS camera shows here".
- The grid has cells of 60 × 60 pixels. Drag a layer to move it. Drag a handle to change its size.
- Drag a layer back to the list to remove it.
- The panel on the right shows the properties of the selected layer.
- The keyboard can do all of these actions. The help text below the grid gives the keys.

On a phone, the layer list is two columns above the grid, and the properties panel is below the grid.
