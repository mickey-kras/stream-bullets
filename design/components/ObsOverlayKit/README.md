# OBS overlay UI kit

This kit shows the transparent 1920×1080 browser source that a streamer adds to OBS (`/@handle/overlay?key=…`).
All sizes in the stage are design pixels. `Stage.jsx` scales them.
Do not use `rem` or `vw` for overlay content.

| File | Content |
| --- | --- |
| `Stage.jsx` | The frame and the scale. The background is a transparent checkerboard or the CSS sample game from `composition.css`. |
| `Content.jsx` | The content on air: the live poll on the full stage, the topic spotlight, up next, the hype message, and support. |
| `Chat.jsx` | The merged Twitch, YouTube, and Kick chat. A new card comes each 2.4s with the rise of 520ms. A moderator removes one message. |
| `OverlayApp.jsx` | A simple copy of Take and the switches of the chat layer. It is not a copy of the Overlay control page. |

The stage is a grid of 16×9 cells of 120px.
In the default layout, the chat is 5×7 cells (600×840) at the top left.
The content uses the remaining area.

`main.jsx` starts the kit. `node design/build.ts` builds it into `kit.js`, which `preview.html` loads.

Sources: `app/components/overlay/*`, `app/components/overlay/wasteland/*`, and `docs/overlay-composition.md`.
