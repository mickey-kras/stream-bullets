# OBS setup for the overlay

This guide is for a streamer who uses OBS Studio for the first time.
The step **Add to OBS** of the **Overlay** section in **Streamer tools** shows the same steps in a closed section:
`First time in OBS? Set it up step by step`.

The names of OBS menus and fields are in English, as OBS shows them in that language.
The names agree with these sources, read on 2026-11-25:

- The OBS knowledge base, [Browser Source](https://obsproject.com/kb/browser-source): `URL`, `Width`, and `Height`.
- The Twitch help page [Dual Format Streaming on Twitch](https://help.twitch.tv/s/article/dual-format-vertical-video): `Settings`, `Stream`, `Enhanced Broadcasting`, and `Additional Canvas`. Twitch asks for OBS Studio 32.0.0 or newer for Dual Format.

The plugin names in this guide are examples. A different plugin that adds a vertical canvas or more outputs also works.

## Add the overlay

1. In **Add to OBS**, make the link of the horizontal output and copy it.
2. In OBS, in the `Sources` list, select `+`. In the menu, select `Browser`. Give the source a name.
3. Paste the link into `URL`. Set `Width` to 1920 and `Height` to 1080. Select `OK`.
4. Drag the new source to the top of the `Sources` list. It must be above your game and your camera.
5. If your layout has the camera frame, keep your camera below the overlay source.
   Move the camera and change its size until it fills the window of the frame.
   See [Camera frame](overlay-composition.md#camera-frame).
6. To do a check, select `Start test` in the step **Build your overlay**. Sample chat shows in OBS.

The overlay background is transparent. You do not need custom CSS.

## Add the vertical output

The vertical output is optional. Use it for a vertical stream, or for the vertical view of Twitch.

1. Install a plugin that adds a vertical canvas to OBS. An example is Aitum Vertical.
2. In **Add to OBS**, make the link of the vertical output and copy it.
3. In the vertical canvas, add a `Browser` source with this link. Set `Width` to 1080 and `Height` to 1920.
4. Keep your camera below the overlay source in the vertical canvas too.

The two outputs are on stream at the same time. Each output has its own layout.
See [Outputs](overlay-composition.md#outputs) and [Layouts](overlay-composition.md#layouts).

## Choose which platforms get each output

1. Twitch gets the horizontal output.
   To send the vertical output to Twitch too, open `Settings` in OBS. Open `Stream`.
   Select `Enhanced Broadcasting`, and select your vertical canvas in `Additional Canvas`.
2. To stream to YouTube and Kick together with Twitch, install a plugin that adds more outputs.
   An example is Aitum Multistream. Add one output for each platform.
3. For a vertical stream on a different platform, add one more output in that plugin.
   Select the vertical canvas for this output.
4. In the **Channels** section of **Streamer tools**, make sure that each channel shows as connected.

Twitch adds its own chat to its vertical view. Thus a chat layer in a vertical output for Twitch is not necessary.

## Related sections

- The rule of Twitch about chat from other platforms has its own closed section in **Add to OBS**.
  See [Twitch chat only](overlay-composition.md#twitch-chat-only).
- For the size of each source, see [OBS browser source](overlay-composition.md#obs-browser-source).
