# StreamBullets design system

This folder holds the design rules of StreamBullets.
Use it when you design or build an interface for the product.

| File | Content |
| --- | --- |
| `README.md` | The rules for voice, color, type, spacing, shape, and icons |
| `tokens.json` | Each design token with its value in each theme and a usage note |

The values in `app/styles/tokens.css` are the source for the application.
When a value changes there, change `tokens.json` in the same change.

A copy with live previews of the interface parts is in Claude:
<https://claude.ai/artifact/KGz1HGxTYswMinnycdVgVt>.
The link opens only for accounts that have access to it.

## Product

StreamBullets is a web application for live streamers and their viewers.
Viewers suggest topics, vote in polls, and discuss the stream.
Streamers show polls and their Twitch, YouTube, and Kick chat in an OBS overlay.

The product has two surfaces:

- The website. It works from a 320px phone to a desktop.
- The OBS overlay. It is a transparent 1920×1080 browser source.

The look is a dark broadcast station: deep teal, cream text, one gold accent, and sharp corners.

## Text

- Write short sentences in the active voice. Address the reader as "you".
- Use sentence case for labels, buttons, and headings. The CSS changes headings to uppercase.
- Give a control the name of its action. An example is the button that disconnects YouTube.
- An error tells what occurred and what to do next.
- Do not use emoji or exclamation marks in the interface.
- The interface has 11 languages. Let text wrap. Do not cut a label to make it fit.

## Color

- The page background is `bg`. Cards use `card`, dialogs use `modal`, and inputs use `field`.
- Primary text is `cream`. Secondary text is `muted`. Tertiary text is `text-dim`.
- `gold` is the only accent. Use it for the primary action, selected states, and the focus ring.
- Use one gold button in a view. Text on a gold fill is `on-gold`.
- Borders are 1px lines in `line`. Inputs use `input-border`. Secondary buttons use `btn-border`.
- Red (`live`, `status-live`) has one meaning: the stream is live.
- Destructive actions use the `danger-*` tokens and a word on the button.
- A status always has a word. Do not show a status with color only.
- Do not add colors. The colors with names that start with `c-` are one-off shades, not tokens.

## Themes

- `default` is the brand theme. It is dark. There is no light theme.
- `high-contrast` uses black and white, a brighter gold, and stronger borders.
- `protan-deutan` and `tritan` change the status colors for color-blind viewers.
- The `wl-*` colors of the on-stream chat do not change with a theme.

## Type

- Headings, header tabs, and primary buttons use the `heading` family (Oswald) at weight 600.
- Text and controls use the `body` family (Figtree). For Cyrillic text, the family uses Onest.
- Body text is 1.125rem with a line height of 1.5. Controls are 1rem. Metadata is 0.875rem.
- An eyebrow is 0.75rem, weight 600, uppercase, and gold. Put it above a heading.
- The readable-font mode sets each heading in the body family. A layout must work in the two modes.
- The application can scale all type to 115% or 130%. Use `rem` sizes.

## Spacing, size, and shape

- Use the spacing steps: 4, 8, 12, 16, 24, 32, 48, and 64px.
- Each control is a minimum of 44px high and 44px wide.
- Corners are 4px on controls and panels. Use `radius-control` and `radius-panel`.
- Only status pills and avatars have a full circle shape.
- Page content is a maximum of 1250px wide.
- Panels are flat. Only dialogs, menus, and toasts have a shadow.

## Buttons

- Secondary: a gradient from `btn-hi` to `btn-lo`, a `btn-border` line, and `cream` text.
- Primary: a gradient from `gold-hi` to `gold-lo` and `on-gold` text.
- Destructive: `danger-bg`, `danger-border`, and `danger-text`.
- On hover, the border of a secondary button becomes gold.
- A disabled button has 55% opacity.

## Focus

Keyboard focus shows a 2px `focus-ring` outline with a 2px offset and a 4px `focus-halo`.
Do not remove it.

## Icons

- Icons are outline icons on a 24px grid with a 1.8 stroke. They take the text color.
- Custom glyphs are in `app/components/ui/icon-paths.tsx`. General icons come from Lucide.
- Sizes: 16px for metadata, 18px for buttons, 20px for navigation, 24px for votes, 40px for empty states.
- The logo is the antenna mark. Use the files in `public/brand`. Do not draw it again.

## Motion

Motion is short and has a function.
When the viewer asks for reduced motion, nothing moves.
