# Overlay studio (proposal)

This is a proposal for the new design of `/overlay-control`.
It is a mockup, not app code. Compare it with **OverlayControl**, which shows the page today.

## Changes

- The page uses the streamer header. "Overlay" is a tab next to Topics and Polls.
- Steps 2 and 3 are one step. Each source is a layer chip. Each layer can be on the grid one time.
- When you select a layer, its properties show on the right: its source, "Show on stream", the background opacity, and remove.
- The **Start test** button replaces the two buttons **Start chat test** and **Start characters test**.
- The channel cards show the platform icon.
- The Characters layer has "Maximum characters on screen".

## Decisions to make

- If Take and Preview go away, each change is live immediately.
- Layers can overlap, or they cannot. We must decide.
