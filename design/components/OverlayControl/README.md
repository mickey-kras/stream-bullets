# Overlay control

Overlay control is the control page of the streamer at `/overlay-control`.
The two images are screenshots of the real app with test data. They are not a copy that we made again.
They are the start point for the new design.

## Structure today

1. **Connect channels**: the Twitch, YouTube, and Kick cards.
2. **Choose what shows**: the preview and on-air frames, Take, eight sources, the position, the size, and the settings of chat and characters.
3. **Place the layers**: the orientation, the preview background, and the grid of layers.
4. **Add to OBS**: the overlay link.

On a phone, a sticky bar keeps Preview, On air, and Take on the screen.

## Questions about the design

- Steps 2 and 3 show the same frame two times. Part 3 of issue 864 merges them into one studio.
- The settings of chat and characters are below the sources. They push the grid far down.
- The page is about 3,300px high on a desktop and 5,300px high on a phone.
