# StreamBullets design system

This folder holds the design system of StreamBullets.
Use it when you design or build an interface for the product.

| Path | Content |
| --- | --- |
| `README.md` | The rules for voice, color, type, spacing, shape, icons, and motion |
| `tokens.json` | Each design token with its value in each theme and a usage note |
| `design-system.json` | The index of the Claude design system: its name, libraries, and asset groups |
| `components/<Name>/README.md` | The guidelines and an example for one part of the interface |
| `components/<Name>/preview.html` | The live preview of one part |
| `components/src/` | The source of the parts, in JSX. `src/index.js` lists the public parts. |
| `components/index.d.ts` | The types of the parts |
| `components/lib/` | React 18.3.1, which the previews load |
| `components/WebsiteKit/`, `components/ObsOverlayKit/` | The UI kits of the website and the overlay |
| `assets/<Group>/` | The logos, avatars, station images, and reference screenshots |
| `fonts/` | The font files of Oswald, Figtree, and Onest |
| `build.ts`, `site.ts` | The build of the bundle, the style sheet, the kits, and the site page |

## Build

`node design/build.ts` builds the system. Git does not track the files that it writes.

- `components/bundle.css` is the CSS of the app. The build compiles `app/styles.css` with Tailwind and adds the fonts and the style sheets of the landing page and the overlay. The parts use the markup and the class names of the app, so this CSS gives them the look of production.
- `components/bundle.js` holds the parts of `components/src/`.
- `WebsiteKit/kit.js` and `ObsOverlayKit/kit.js` hold the UI kits.
- `site/index.html` shows the full design system: this brand book, the tokens, a live preview of each part, and the assets. Open it in a browser. It works without a server.

`node design/build.ts --claude` builds the files for the Claude design system. The images then use the upload addresses that `design-system.json` lists.

A page that loads the bundle supplies React 18 as the globals `React` and `ReactDOM`, and loads `bundle.js` before a kit.

## Tokens

The values in `app/styles/tokens.css` are the source for the application.
When a value changes there, change `tokens.json` in the same change.

This folder is a copy of the design system in Claude:
<https://claude.ai/artifact/KGz1HGxTYswMinnycdVgVt>.
The link opens only for accounts that have access to it.
The site page and the page of the Claude system show the previews. They load the CSS, React, and the bundle before each preview.
The parts copy the markup of the app components, with props in place of the data of the app. Some parts import modules of the app, such as the icon glyphs and the percentages of a poll.

## Product

StreamBullets is a web application for live streamers and their viewers.
Viewers suggest topics, vote in polls, and discuss the stream.
Streamers show polls and their Twitch, YouTube, and Kick chat in an OBS overlay.

The product has two surfaces:

- The website. It works from a 320px phone to a desktop. It has the landing page, the streamer directory, the streamer page, the settings, and Overlay control. The streamer page has the tabs Topics, Polls, Schedule, About, and Community.
- The OBS overlay. It is a transparent 1920×1080 or 1080×1920 browser source. It shows the content on air, the merged chat, and the interactive characters. The content on air is a poll, a topic spotlight, up next, a message, or a community card.

The look is a dark broadcast station: deep teal, cream text, one gold accent, and sharp corners.

## Parts

| Group | Parts |
| --- | --- |
| Core | Button, IconButton, Icon, Avatar, StreamerLogo, Logo |
| Forms | TextField, SearchField, Select, Choice, Tabs, Req, RequiredNote |
| Feedback | Dialog, Sheet, Toast, EmptyState, Banner, OwnerNotice, LivePill, OnAirTicker |
| Topic board | TopicRow, TopicDetail, VoteButtons, Category, TopicChip, TopicChips, Discussion, Thread, Comment, Composer |
| Polls | PollCard, PollStatus, PollResults, PollDiscussion |
| Shell | StreamerHeader, HeaderSuggestButton, SiteHeader, SiteLogo, HeaderLanguage, HeaderAccount, AccountMenu, NotificationLink, SignInButton, BackLink, SiteFooter |
| Overlay | OverlayCard, OverlayPoll, OverlayMash, OverlayQr, OverlayComposition, OverlayLayer, OverlayStage, ChatLayer |

Most parts come from these files in `app/components`:
`ui/{icon,icon-button,avatar,dialog,select,sheet,toast,required}.tsx`, `common.tsx` (EmptyState),
`streamer/{vote-buttons,topic-board,entry-detail,page-banner,polls-view}.tsx`, `discussion.tsx`, `comment-*.tsx`, `rich-comment-input.tsx`, `poll.tsx`,
`shell/{site-header,streamer-header,account-menu,back-link,footer,header-language}.tsx`, and `overlay/**`.

Some parts have no React file in the app. They copy the markup of the pages:

- Button copies the global `button` and `.gold` styles.
- TextField, SearchField, Choice, and Tabs copy the fields, the search forms, `.choice`, and `.tabs`.
- Category and TopicChip copy `.category` and `.topic-chip`.

The UI kits put the parts together:

- `WebsiteKit` is a streamer page that you can click through. It has the topic board, the polls, the directory, and the landing page.
- `ObsOverlayKit` is the 1920×1080 overlay with a live poll and chat that moves.

## Text

- Write short sentences in the active voice. Put one idea in a sentence. Start with the verb: "Suggest topics. Vote. Shape the stream."
- Address the reader as "you". The interface does not say "we", except in policy text. Name the streamer in the third person: "Suggest a topic for {name}'s next stream."
- Use sentence case for labels, buttons, and headings. The CSS changes headings to uppercase. Do not type capital letters in the text, because Japanese, Chinese, Hindi, and the readable-font mode turn the change off.
- End a full sentence with a period. This includes toasts: "Page link copied."
- Use the ellipsis character `…` for placeholders and progress: "Search topics…". Put the middle dot `·` between two items of metadata, as in the poll status line of Sunny.
- Give a control the name of its action. An example is the button that disconnects YouTube.
- An empty state has a title and one next step: "Start a conversation." and "Suggest a topic for Sunny's next stream."
- An error tells what occurred and what to do next: "Choose a JPG, PNG, or WebP image no larger than 5 MB."
- Do not use emoji or exclamation marks in the interface. Emoji occur only in user content, such as chat and comments.
- Do not translate the names Twitch, YouTube, and Kick.
- The tone is a friendly local radio station: "Your voice, on air.", "Behind the mic", "Up next", "On air". Use broadcast words, not technical words.
- The interface has 11 languages: en, de, es, fr, hi, ja, pl, pt-BR, ru, uk, and zh-CN. Let text wrap. Do not cut a label to make it fit.

## Color

- The page background is `bg`. Cards use `card`, dialogs use `modal`, and inputs use `field`. The landing page and the footers use `ink`.
- Primary text is `cream`. Secondary text is `muted`. Tertiary text is `text-dim`.
- `gold` is the only accent. Use it for the primary action, selected states, names, scores, and the focus ring.
- Use one gold button in a view. Text on a gold fill is `on-gold`.
- Borders are 1px lines in `line`. Inputs use `input-border`. Secondary buttons use `btn-border`. Comments and empty states use a dashed line.
- Red (`live`, `status-live`) has one meaning: the stream is live.
- Destructive actions use the `danger-*` tokens and a word on the button.
- A status always has a word. Do not show a status with color only.
- Do not add colors. The colors with names that start with `c-` are one-off shades, not tokens. They are in `components/bundle.css`.

## Themes

- `default` is the brand theme. It is dark. There is no light theme.
- `high-contrast` uses black and white, a brighter gold, and stronger borders. The app uses it when the viewer selects it, or when the system asks for more contrast.
- `protan-deutan` and `tritan` change the status colors and the Mash Battle colors for color-blind viewers. All other tokens keep their default values.
- The `wl-*` colors of the on-stream chat do not change with a theme.

## Type

- Headings, header tabs, and primary buttons use the `heading` family (Oswald) at weight 600, with a letter spacing of 0.4px to 2px.
- Text and controls use the `body` family (Figtree) at weight 400 or 600. For Cyrillic text, the family uses Onest.
- Body text is 1.125rem with a line height of 1.5. Controls are 1rem. Metadata is 0.875rem.
- The OBS chat uses the system fonts (Segoe UI, Arial) at 26px.
- An eyebrow is 0.75rem, weight 600, uppercase, and gold. Put it above a heading.
- The readable-font mode sets each heading in the body family. A layout must work in the two modes.
- The application can scale all type to 115% or 130%. Use `rem` sizes.
- Fluid type sizes in the app use `clamp()`. Each type style in `tokens.json` holds the maximum size.

## Surfaces

- The page is flat teal with a soft radial light at the top left (`grad-page`).
- A film grain of fractal noise at 10% opacity covers the page (`.sb-grain`). The high-contrast theme removes it.
- The landing page shows a 3D radio station of brass and teal in WebGL. When WebGL is not available, it shows `station-poster.webp`.
- Do not use photos of people. Avatars show illustrated portraits.
- Buttons and gold plates have a soft gradient of two colors at 110°. Panels have a teal gradient at 115° to 120°. Do not use purple, blue, or strong gradients.
- Cards have a teal fill, a 1px border, a 4px corner, and 30px of padding. A selected row in a list has a full gold fill with teal text.
- On the overlay, cards have a 6px gold rule on the left.

## Spacing, size, and shape

- Use the spacing steps: 4, 8, 12, 16, 24, 32, 48, and 64px.
- Each control is a minimum of 44px high and 44px wide.
- Corners are 4px on controls and panels. Use `radius-control` and `radius-panel`.
- Only chips, the live pill, the countdown pill of the overlay, and avatars have a full round shape.
- Page content is a maximum of 1250px wide.
- The header is sticky and a minimum of 100px high on a desktop. The footer is 52px high.
- The topic board divides into a list of 40% and a detail of 60%. Below 700px, the two parts are in one column.

## Shadows and transparency

- Panels are flat. A panel can have an inner shadow of `0 0 60px #0002`.
- Only dialogs, menus, and toasts have a shadow: `0 24px 100px #0009` for a dialog, `0 24px 60px #0009` for a menu, and `0 8px 30px #0009` for a toast.
- Buttons on the landing page have a hard shadow of `0 5px 0 #a27a25`.
- The backdrop of a dialog has the color `#000b` and a blur of 3px.
- The overlay card fill is `#0a2025ed`, which is 93% opacity. The chat card fill is `rgba(8,43,46,.9)`. The top 18% of the chat fades out.

## Buttons and states

- Secondary: a gradient from `btn-hi` to `btn-lo`, a `btn-border` line, and `cream` text.
- Primary: a gradient from `gold-hi` to `gold-lo` and `on-gold` text.
- Destructive: `danger-bg`, `danger-border`, and `danger-text`.
- On hover, the border of a secondary button becomes gold and the fill becomes `btn-hover`. A gold button becomes `gold-hover`. A link becomes gold. A button on the landing page goes up 2px.
- A pressed control (`aria-pressed`) has a gold fill, such as votes and tabs. A selected poll option gets a gold border or a gold inner ring. A pressed control does not get smaller.
- A disabled button has 55% opacity and the wait cursor.

## Focus

Keyboard focus shows a 2px `focus-ring` outline with a 2px offset and a 4px `focus-halo`.
In the high-contrast theme, the outline is 3px with a black halo.
Do not remove it.

## Accessibility settings

- High contrast: `data-contrast=high`, or `data-contrast=auto` to follow the system.
- Status colors for color-blind viewers: `data-cvd`.
- Readable font: `data-font=readable`. It uses Figtree only and no uppercase.
- Text size of 115% or 130%.
- Links with an underline.
- Reduced motion.

## Icons

- Icons are outline icons on a 24px grid with a 1.8 stroke and round line ends. They take the text color.
- Use 16px for metadata and the footer, and 18px for buttons and menus.
- Use 20px for navigation and close, 24px for votes and categories, and 40px for empty states.
- Custom glyphs are in `app/components/ui/icon-paths.tsx`. General icons come from Lucide (`lucide-react`).
- `components/src/core/Icon.jsx` imports the glyphs of the app and the same `lucide-react` package, so the icons of the design system are the icons of production.
- The thumb icons come from Bootstrap Icons (MIT license) at a scale of 24px. A filled thumb means "pressed".
- The OBS chat has its own mustard platform icons for Twitch, YouTube, and Kick. ChatLayer imports them from `app/components/overlay/wasteland/glyphs.tsx`.
- Do not use an icon font, PNG icons, emoji, or Unicode characters as icons. Icons are decorative. The control holds the label.
- The logo is the antenna mark. Use the files in `public/brand` or `assets/Logos`. Do not draw it again.

## Motion

Motion is short and has a function. Do not use bounces.

| Motion | Duration |
| --- | --- |
| Borders and chevrons | 0.15s, ease-out |
| Toasts | 0.2s |
| The fill of a poll bar | 0.4s |
| A new chat card goes up | 520ms, with transform and opacity only |
| The pulse of the live pill | 1.4s |

When the viewer asks for reduced motion in the site settings or in the system, nothing moves.

## Known differences

- The fonts in `tokens.json` list one file for each family: Latin for Oswald and Figtree, and Cyrillic for Onest. `fonts/` has the other subsets.
- The previews do not show the interactive 3D landing page or the characters layer. They use the poster image.
- The token `dur-chat` (520ms) comes from an earlier system. The app code does not have it.
- The app minifies its CSS with Lightning CSS. `bundle.css` has the same rules without this step.
- The parts take props in place of the data, the router, and the translations of the app. Their text is English.
