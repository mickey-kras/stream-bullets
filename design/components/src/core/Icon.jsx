import React from "react";

// Glyph data copied from app/components/ui/icon-paths.tsx (24px grid, 1.8 stroke, currentColor).
const THUMB_UP = "M6.956 1.745C7.021.81 7.908.087 8.864.325l.261.066c.463.116.874.456 1.012.965.22.816.533 2.511.062 4.51a10 10 0 0 1 .443-.051c.713-.065 1.669-.072 2.516.21.518.173.994.681 1.2 1.273.184.532.16 1.162-.234 1.733q.086.18.138.363c.077.27.113.567.113.856s-.036.586-.113.856c-.039.135-.09.273-.16.404.169.387.107.819-.003 1.148a3.2 3.2 0 0 1-.488.901c.054.152.076.312.076.465 0 .305-.089.625-.253.912C13.1 15.522 12.437 16 11.5 16H8c-.605 0-1.07-.081-1.466-.218a4.8 4.8 0 0 1-.97-.484l-.048-.03c-.504-.307-.999-.609-2.068-.722C2.682 14.464 2 13.846 2 13V9c0-.85.685-1.432 1.357-1.615.849-.232 1.574-.787 2.132-1.41.56-.627.914-1.28 1.039-1.639.199-.575.356-1.539.428-2.59z";
const THUMB_DOWN = "M6.956 14.534c.065.936.952 1.659 1.908 1.42l.261-.065a1.38 1.38 0 0 0 1.012-.965c.22-.816.533-2.512.062-4.51q.205.03.443.051c.713.065 1.669.071 2.516-.211.518-.173.994-.68 1.2-1.272a1.9 1.9 0 0 0-.234-1.734c.058-.118.103-.242.138-.362.077-.27.113-.568.113-.856 0-.29-.036-.586-.113-.857a2 2 0 0 0-.16-.403c.169-.387.107-.82-.003-1.149a3.2 3.2 0 0 0-.488-.9c.054-.153.076-.313.076-.465a1.86 1.86 0 0 0-.253-.912C13.1.757 12.437.28 11.5.28H8c-.605 0-1.07.08-1.466.217a4.8 4.8 0 0 0-.97.485l-.048.029c-.504.308-.999.61-2.068.723C2.682 1.815 2 2.434 2 3.279v4c0 .851.685 1.433 1.357 1.616.849.232 1.574.787 2.132 1.41.56.626.914 1.28 1.039 1.638.199.575.356 1.54.428 2.591";
const P = (d) => ["path", { d }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];
const R = (x, y, width, height, rx) => ["rect", { x, y, width, height, rx }];
const thumb = (d, filled) => ["g", { transform: "translate(1.5 1.5) scale(1.3125)", strokeWidth: 1.371, fill: filled ? "currentColor" : undefined }, [P(d)]];

export const LOCAL_ICONS = {
  topics: [P("M4 4h16v12H9l-5 4V4Z"), P("M8 8h8M8 12h5")],
  polls: [P("M5 20V10h4v10M10 20V4h4v16M15 20v-7h4v7")],
  schedule: [R(3, 5, 18, 16, 2), P("M7 3v4m10-4v4M3 11h18")],
  about: [C(12, 12, 9), P("M12 11v6m0-10v1")],
  community: [C(9, 8, 3), P("M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3")],
  google: [P("M18.36 5.64A9 9 0 1 0 21 12h-9")],
  twitch: [P("M21 2H3v16h5v4l4-4h5l4-4V2Z"), P("M11 11V7M16 11V7")],
  tiktok: [P("M13 3v12.5A3.5 3.5 0 1 1 9.5 12"), P("M13 3a5 5 0 0 0 5 5")],
  instagram: [R(2, 2, 20, 20, 5), C(12, 12, 4), P("M17.5 6.5h.01")],
  check: [P("M20 6 9 17l-5-5")],
  search: [C(10, 10, 7), P("m15 15 6 6")],
  refresh: [P("M21 12a9 9 0 1 1-2.64-6.36L21 8"), P("M21 3v5h-5")],
  reply: [P("M9 17 4 12l5-5"), P("M20 18v-2a4 4 0 0 0-4-4H4")],
  trash: [P("M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6")],
  flag: [P("M4 22V4M4 4h13l-2 4 2 4H4")],
  upload: [P("M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5")],
  download: [P("M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5")],
  "zoom-in": [C(10, 10, 7), P("m15 15 6 6M10 7v6M7 10h6")],
  "zoom-out": [C(10, 10, 7), P("m15 15 6 6M7 10h6")],
  "chevron-down": [P("m6 9 6 6 6-6")],
  "chevron-up": [P("m6 15 6-6 6 6")],
  "thumbs-up": [thumb(THUMB_UP, false)],
  "thumbs-up-filled": [thumb(THUMB_UP, true)],
  "thumbs-down": [thumb(THUMB_DOWN, false)],
  "thumbs-down-filled": [thumb(THUMB_DOWN, true)],
  comment: [P("M3 4h18v13H9l-6 4Z")],
  "cat-tech": [R(2, 3, 20, 14, 1), P("M8 21h8M12 17v4")],
  "cat-gaming": [P("M7 7h10c3 0 5 10 3 11-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 17 4 7 7 7Z"), P("M8 10v5M5.5 12.5h5M16 11h.1M18 14h.1")],
  "cat-creative": [P("M4 3h7l1 2 1-2h7v17h-7l-1 1-1-1H4Z"), P("M12 5v16")],
  "cat-chatting": [P("M3 4h18v13H9l-6 4Z")],
  "search-none": [C(10, 10, 7), P("m15 15 6 6M12.5 7.5l-5 5M7.5 7.5l5 5")],
  tilt: [R(7, 3, 10, 18, 2.5), P("M3 9c-1 2-1 4 0 6M21 9c1 2 1 4 0 6")],
  play: [C(12, 12, 10), P("m10 8 6 4-6 4Z")],
  youtube: [R(2.5, 5.5, 19, 13, 4), P("m10 9.2 5 2.8-5 2.8Z")],
  kick: [R(3, 3, 18, 18, 3), P("M8.5 7.5v9M8.5 12l4.5-4.5M8.5 12l4.5 4.5M13 7.5h2.5M13 16.5h2.5")],
  discord: [P("M7.5 7.5c3-1.3 6-1.3 9 0 1.7 2.6 2.4 5.3 2.2 8.3-1.4 1-2.8 1.6-4.2 2l-.9-1.6M7.5 7.5C5.8 10.1 5.1 12.8 5.3 15.8c1.4 1 2.8 1.6 4.2 2l.9-1.6"), P("M8 15.3c2.6 1.1 5.4 1.1 8 0"), C(9.6, 12.3, 0.9), C(14.4, 12.3, 0.9)],
  heart: [P("M19.5 12.6 12 20l-7.5-7.4A4.6 4.6 0 0 1 12 6.3a4.6 4.6 0 0 1 7.5 6.3Z")],
  gift: [R(3, 8, 18, 4, 1), P("M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5")],
  star: [P("m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z")],
  palette: [P("M12 3a9 9 0 0 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.2-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10Z"), C(7.5, 11.5, 1), C(10, 7.5, 1), C(15, 7.5, 1)],
  megaphone: [P("M3 10v4h3l7 4V6L6 10Z"), P("M16.5 9a4 4 0 0 1 0 6M6 14l1.5 5h2.5l-1-4.5")],
  more: [C(5, 12, 1.2), C(12, 12, 1.2), C(19, 12, 1.2)],
  grip: [C(9, 6, 0.8), C(15, 6, 0.8), C(9, 12, 0.8), C(15, 12, 0.8), C(9, 18, 0.8), C(15, 18, 0.8)],
  up: [P("m6 15 6-6 6 6")],
  down: [P("m6 9 6 6 6-6")],
};

// Semantic name → Lucide icon (app/components/ui/icon.tsx). Rendered from the Lucide UMD build at 1.8 stroke.
export const LUCIDE_ICONS = {
  streamers: "Tv", "your-page": "RadioTower", admin: "Shield", home: "House", user: "UserRound", pencil: "Pencil", mic: "Mic", data: "Database",
  "sign-in": "LogIn", "sign-out": "LogOut", "at-sign": "AtSign", plus: "Plus", minus: "Minus", close: "X", send: "Send", save: "Save", link: "Link",
  copy: "Copy", external: "ExternalLink", image: "Image", crop: "Crop", reset: "RotateCcw", "chevron-left": "ChevronLeft", "chevron-right": "ChevronRight",
  "arrow-right": "ArrowRight", "sort-top": "TrendingUp", "sort-new": "Clock", "poll-choice": "ListChecks", "poll-binary": "ToggleRight", timer: "Timer",
  live: "Radio", eye: "Eye", "eye-off": "EyeOff", stop: "CircleStop", lock: "Lock", overlay: "Cast", wifi: "Wifi", "wifi-off": "WifiOff", requests: "Inbox",
  key: "KeyRound", approve: "UserCheck", reject: "UserX", mail: "Mail", globe: "Globe", "shield-check": "ShieldCheck", success: "CircleCheck",
  error: "CircleAlert", warning: "TriangleAlert", pending: "Hourglass", rejected: "CircleX", idea: "Lightbulb", compass: "Compass",
  privacy: "LockKeyhole", terms: "FileText", zap: "Zap",
};

const LUCIDE_SRC = "https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js";
const listeners = new Set();
let loading = false;
function ensureLucide() {
  if (typeof window === "undefined" || window.lucide || loading) return;
  loading = true;
  const s = document.createElement("script");
  s.src = LUCIDE_SRC;
  s.onload = () => listeners.forEach((f) => f());
  document.head.appendChild(s);
}
function lucideNode(name) {
  const lib = typeof window !== "undefined" ? window.lucide : null;
  const node = lib && lib.icons && lib.icons[name];
  if (!node) return null;
  return node[0] === "svg" ? node[2] : node;
}

function draw(nodes) {
  return nodes.map(([tag, attrs, kids], i) => React.createElement(tag, { key: i, ...attrs }, kids ? draw(kids) : undefined));
}

export function Icon({ name, size = 18, className = "", style, label }) {
  const lucide = LUCIDE_ICONS[name];
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!lucide) return undefined;
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    ensureLucide();
    return () => listeners.delete(f);
  }, [lucide]);
  const nodes = LOCAL_ICONS[name] || (lucide ? lucideNode(lucide) : null) || [];
  return (
    <svg
      className={`sb-icon ${className}`.trim()}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ width: size, height: size, ...style }}
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      {draw(nodes)}
    </svg>
  );
}
