import type { ReactElement } from "react";

/* Generated from the approved icon set (scratchpad/icons/icons.js) by scratchpad/impl/p1/tools/gen_icons.cjs,
   then converted to JSX so the icons render without raw HTML injection.
   Local drawings for the prototype and custom glyphs that Lucide lacks or draws differently: streamer navigation,
   thumbs, categories, Google, TikTok, Twitch, Instagram and tilt. 24px grid, 1.8 stroke, currentColor. */
const THUMB_UP =
  "M6.956 1.745C7.021.81 7.908.087 8.864.325l.261.066c.463.116.874.456 1.012.965.22.816.533 2.511.062 4.51a10 10 0 0 1 .443-.051c.713-.065 1.669-.072 2.516.21.518.173.994.681 1.2 1.273.184.532.16 1.162-.234 1.733q.086.18.138.363c.077.27.113.567.113.856s-.036.586-.113.856c-.039.135-.09.273-.16.404.169.387.107.819-.003 1.148a3.2 3.2 0 0 1-.488.901c.054.152.076.312.076.465 0 .305-.089.625-.253.912C13.1 15.522 12.437 16 11.5 16H8c-.605 0-1.07-.081-1.466-.218a4.8 4.8 0 0 1-.97-.484l-.048-.03c-.504-.307-.999-.609-2.068-.722C2.682 14.464 2 13.846 2 13V9c0-.85.685-1.432 1.357-1.615.849-.232 1.574-.787 2.132-1.41.56-.627.914-1.28 1.039-1.639.199-.575.356-1.539.428-2.59z";
const THUMB_DOWN =
  "M6.956 14.534c.065.936.952 1.659 1.908 1.42l.261-.065a1.38 1.38 0 0 0 1.012-.965c.22-.816.533-2.512.062-4.51q.205.03.443.051c.713.065 1.669.071 2.516-.211.518-.173.994-.68 1.2-1.272a1.9 1.9 0 0 0-.234-1.734c.058-.118.103-.242.138-.362.077-.27.113-.568.113-.856 0-.29-.036-.586-.113-.857a2 2 0 0 0-.16-.403c.169-.387.107-.82-.003-1.149a3.2 3.2 0 0 0-.488-.9c.054-.153.076-.313.076-.465a1.86 1.86 0 0 0-.253-.912C13.1.757 12.437.28 11.5.28H8c-.605 0-1.07.08-1.466.217a4.8 4.8 0 0 0-.97.485l-.048.029c-.504.308-.999.61-2.068.723C2.682 1.815 2 2.434 2 3.279v4c0 .851.685 1.433 1.357 1.616.849.232 1.574.787 2.132 1.41.56.626.914 1.28 1.039 1.638.199.575.356 1.54.428 2.591";

/** The thumbs come from a 16px drawing, scaled onto the 24px grid. The filled forms share the outline. */
function thumb(d: string, filled: boolean): ReactElement {
  return (
    <g transform="translate(1.5 1.5) scale(1.3125)" strokeWidth="1.371" fill={filled ? "currentColor" : undefined}>
      <path d={d} />
    </g>
  );
}

export const localIcons = {
  topics: (
    <>
      <path d="M4 4h16v12H9l-5 4V4Z" />
      <path d="M8 8h8M8 12h5" />
    </>
  ),
  polls: (
    <>
      <path d="M5 20V10h4v10M10 20V4h4v16M15 20v-7h4v7" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4m10-4v4M3 11h18" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  community: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3" />
    </>
  ),
  google: (
    <>
      <path d="M18.36 5.64A9 9 0 1 0 21 12h-9" />
    </>
  ),
  twitch: (
    <>
      <path d="M21 2H3v16h5v4l4-4h5l4-4V2Z" />
      <path d="M11 11V7M16 11V7" />
    </>
  ),
  tiktok: (
    <>
      <path d="M13 3v12.5A3.5 3.5 0 1 1 9.5 12" />
      <path d="M13 3a5 5 0 0 0 5 5" />
    </>
  ),
  instagram: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </>
  ),
  check: (
    <>
      <path d="M20 6 9 17l-5-5" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 6 6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  reply: (
    <>
      <path d="M9 17 4 12l5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </>
  ),
  flag: (
    <>
      <path d="M4 22V4M4 4h13l-2 4 2 4H4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 6 6M10 7v6M7 10h6" />
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 6 6M7 10h6" />
    </>
  ),
  "chevron-down": (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  "chevron-up": <path d="m6 15 6-6 6 6" />,
  "thumbs-up":thumb(THUMB_UP, false),
  "thumbs-up-filled": thumb(THUMB_UP, true),
  "thumbs-down": thumb(THUMB_DOWN, false),
  "thumbs-down-filled": thumb(THUMB_DOWN, true),
  comment: (
    <>
      <path d="M3 4h18v13H9l-6 4Z" />
    </>
  ),
  "cat-tech": (
    <>
      <rect x="2" y="3" width="20" height="14" rx="1" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  "cat-gaming": (
    <>
      <path d="M7 7h10c3 0 5 10 3 11-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 17 4 7 7 7Z" />
      <path d="M8 10v5M5.5 12.5h5M16 11h.1M18 14h.1" />
    </>
  ),
  "cat-creative": (
    <>
      <path d="M4 3h7l1 2 1-2h7v17h-7l-1 1-1-1H4Z" />
      <path d="M12 5v16" />
    </>
  ),
  "cat-chatting": (
    <>
      <path d="M3 4h18v13H9l-6 4Z" />
    </>
  ),
  "search-none": (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 6 6M12.5 7.5l-5 5M7.5 7.5l5 5" />
    </>
  ),
  tilt: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M3 9c-1 2-1 4 0 6M21 9c1 2 1 4 0 6" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type LocalIconName = keyof typeof localIcons;
