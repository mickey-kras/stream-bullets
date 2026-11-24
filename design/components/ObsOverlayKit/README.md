This kit shows the overlay that a streamer adds to OBS as a browser source (`/@handle/overlay?key=…`).

The OBS page is 1920 × 1080 and transparent. All sizes in the stage are design pixels. `Stage.jsx` scales them.
The stage is a grid of 16 × 9 cells of 120 pixels. Each layer has its own cell.

In the kit, the chat is 4 × 7 cells at the left. The poll is 11 × 6 cells and the other cards are 11 × 3 cells.

| File | Content |
| --- | --- |
| `Stage.jsx` | The frame of the Overlay control preview and its scale. The background is a transparent checkerboard or the CSS sample game. |
| `Content.jsx` | The content on air: the live poll, a Mash Battle, the topic spotlight, up next, the message banner, the community card, and support. |
| `Chat.jsx` | The merged Twitch, YouTube, and Kick chat. A new card comes each 2.4 s. A moderator removes one message in nine. |
| `OverlayApp.jsx` | A short copy of the bar of the Overlay control page. It is not a copy of the full page. |
| `overlay.css` | Only the layout of the kit page. The stage uses the classes of the app. |

`main.jsx` starts the kit. `node design/build.ts` builds it into `kit.js`, which `preview.html` loads.

Sources: `app/components/overlay/*`, `app/components/overlay/wasteland/*`, and `docs/overlay-composition.md`.
