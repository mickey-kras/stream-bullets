# Courier sprite expansion

Seven new character rows and five prop groups for the wasteland playground.
This change does not touch runtime files or state mappings. Review this art before atlas integration.

## Repo audit

The audit used main commit `d50ab00344b66bbf2d522570222a59b334602abb`.

| Item | Finding |
| --- | --- |
| Existing character art | All 12 rows exist, with four frames each in the current indexed PNG. |
| Tint regions | Base, helmet, and scarf regions exist. The renderer applies platform colors to the helmet. |
| New actions | Dance, cheer, shoot, zip, climb, jet, and push still map to old rows. |
| New props | Viewer flags, hook, crown, pack, and flame use drawn stand-ins. Bridge planks reuse stair treads. |
| Terrain | Dirt variants, damage stages, ground, doors, pad, signs, and props exist. |
| Existing assets | Suitable as the visual reference. This PR does not claim full animation or OBS validation. |

## Character rows

| Row | Asset | Current state | Frames |
| --- | --- | --- | --- |
| 0 | Dance | `dance` | Four poses for a loop |
| 1 | Cheer | `cheer` | Anticipation, fists up, victory, recover |
| 2 | Grapple aim and fire | `shoot` | Hold, aim, fire, recover |
| 3 | Rope ride | `zip` | Hang, pull, knee lift, tuck |
| 4 | Climb | `climb` | Reach, pull, cross ledge, stand |
| 5 | Jetpack | `jet` | Launch, hover, forward lean, land |
| 6 | Push | `push` | Wind up, lunge, shove, recover |

The pack is part of the jetpack row. The flame is a separate prop.
Rope frames contain a short grip stub. Match the drawn rope attachment during integration.

## Files

| File | Size | Use |
| --- | --- | --- |
| `courier-actions.png` | 128 by 224 | Seven rows, four 32 by 32 cells per row |
| `courier-actions-4x.png` | 512 by 896 | Exact nearest-neighbor export at 4 times the logical size |
| `courier-actions-layers.png` | 384 by 224 | Base, helmet, and scarf regions, each 128 by 224 |
| `courier-helmet-mask.png` | 128 by 224 | Neutral helmet tint mask |
| `courier-scarf-mask.png` | 128 by 224 | Scarf tint mask |
| `props.png` | 64 by 64 | Four columns and four rows of 16 by 16 cells |
| `props-4x.png` | 256 by 256 | Props at 4 times the logical size |
| `viewer-flag-cloth-mask.png` | 64 by 64 | Cloth only. Poles stay brown. |
| `sprites.json` | JSON | Rectangles, anchors, row order, and provenance |
| `review-actions.png`, `review-props.png`, `review-tints.png` | Review images | Actual exported pixels with labels |
| `checksums.json` | JSON | File hashes |

Character poses face right. Mirror them at the anchor for left-facing actions.
Grounded feet end at cell row 29, with anchor `(16,30)`, as in the current atlas.
Suspended frames keep their movement within the cell.
All sprite alpha is binary. Transparent gutters surround character poses.

## Props

| Group | Frames | Logical size |
| --- | --- | --- |
| Bridge | Left cap, middle, right cap | 16 by 16, with art only in the top 6 pixels |
| Hook | One | 5 by 5 |
| Jetpack flame | Three | 6 by 8, attached at the top center |
| Crown | One | 10 by 7 |
| Viewer flag | Four | 10 by 16, with a registered pole |
| Stair | Optional redraw | 16 by 16 |

The first props row has the bridge pieces and the optional stair.
The second row has the hook and the three flame frames.
The third row has the crown. Its other three cells are empty.
The fourth row has the viewer flags.

Cloth is gray for platform tinting. Do not tint the pole.
Bridge edge pixels match across adjacent pieces. The space below the planks is transparent.

## Integration notes

Append these seven rows after the current 12 rows. Keep the existing rows in their current order.
The combined sheet needs 19 rows. Move the loose equipment strip below row 18.
With the current 16-pixel equipment strip, each region would be 128 by 624 pixels.

Update the row union, theme mappings, equipment rectangles, content hashes, and renderer tests together.
Remove the drawn pack and flame when you connect the jetpack row and flame prop.
Remove the dance mirroring and cheer bobbing stand-ins when you connect the new rows.

Use the cloth mask with the existing platform color. Keep ropes as drawn lines.

## Quality checks

Checks passed for 28 nonempty, distinct frames, cell padding, grounded alignment, binary alpha, and grayscale masks on base pixels.
The visible pixels and alpha of the 4-times export match the logical sheet exactly.
Prop checks cover bridge depth, matching seams, flag poles, and neutral cloth masks.
Review sheets show the exported files, not the larger generation concepts.

These are art handoff assets. Check the timing, the equipment tint, the rope attachment, and the left-facing poses in the game before release.

## Stair collision update

`stairs-right.png` is the 16 by 16 runtime tile. `stairs-right-4x.png` is its 4 times export.
The tile replaces the stair in `props.png`. The runtime terrain atlas holds it at (128, 154).

Its column heights are 4 px at x 0, 8 px at x 3, 12 px at x 5, and 16 px at x 8.
The renderer mirrors it for stairs to the left. `review-stair.png` shows the final exported pixels.
The earlier `review-props.png` shows the original proposal. Use `review-stair.png` for the revised stair.

The built-in image generator supplied the wood texture. The export crops and scales each step with nearest-neighbor sampling and applies the exact collision silhouette.
Prompt:

```text
One transparent side-view 16 by 16 pixel stair, rising left to right.
Use worn brown wood and rusty metal matching the props sheet.
Use heights 4, 8, 12, 16 at columns 0, 3, 5, 8.
Use solid risers and a limited palette. No text or logos.
```
