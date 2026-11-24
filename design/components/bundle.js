/* @ds-bundle: {"format":4,"namespace":"StreamBulletsDesignSystem_e1d9fa","components":[{"name":"Avatar"},{"name":"Button"},{"name":"Icon"},{"name":"IconButton"},{"name":"Logo"},{"name":"Choice"},{"name":"Req"},{"name":"SearchField"},{"name":"Select"},{"name":"Tabs"},{"name":"TextField"},{"name":"Banner"},{"name":"Dialog"},{"name":"EmptyState"},{"name":"LivePill"},{"name":"Sheet"},{"name":"Toast"},{"name":"Category"},{"name":"Discussion"},{"name":"TopicChip"},{"name":"TopicDetail"},{"name":"TopicRow"},{"name":"VoteButtons"},{"name":"PollCard"},{"name":"AccountMenu"},{"name":"BackLink"},{"name":"SiteFooter"},{"name":"SiteHeader"},{"name":"StreamerHeader"},{"name":"ChatLayer"},{"name":"OverlayCard"}]} */

(() => {

const __ds_ns = (window.StreamBulletsDesignSystem_e1d9fa = window.StreamBulletsDesignSystem_e1d9fa || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
// Presets 0–15 come from the 4×4 avatars.webp sprite; 16 = Jack Russell, 17 = alien. 14 = default Space explorer.
function Avatar({
  src,
  preset = 14,
  size = 42,
  ring = "gold",
  alt = "",
  className = "",
  style
}) {
  const s = {
    width: size,
    height: size,
    ...style
  };
  if (src) return /*#__PURE__*/React.createElement("img", {
    className: `sb-avatar ${className}`.trim(),
    src: src,
    alt: alt,
    style: s,
    "data-ring": ring === "cream" ? "cream" : undefined
  });
  const p = preset >= 0 && preset < 18 ? preset : 14;
  const pos = p < 16 ? `${p % 4 * 100 / 3}% ${Math.floor(p / 4) * 100 / 3}%` : undefined;
  return /*#__PURE__*/React.createElement("span", {
    className: `sb-avatar ${className}`.trim(),
    "data-portrait": "",
    "data-preset": p,
    "data-ring": ring === "cream" ? "cream" : undefined,
    role: alt ? "img" : undefined,
    "aria-label": alt || undefined,
    "aria-hidden": alt ? undefined : "true",
    style: {
      ...s,
      backgroundPosition: pos
    }
  });
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
// Glyph data copied from app/components/ui/icon-paths.tsx (24px grid, 1.8 stroke, currentColor).
const THUMB_UP = "M6.956 1.745C7.021.81 7.908.087 8.864.325l.261.066c.463.116.874.456 1.012.965.22.816.533 2.511.062 4.51a10 10 0 0 1 .443-.051c.713-.065 1.669-.072 2.516.21.518.173.994.681 1.2 1.273.184.532.16 1.162-.234 1.733q.086.18.138.363c.077.27.113.567.113.856s-.036.586-.113.856c-.039.135-.09.273-.16.404.169.387.107.819-.003 1.148a3.2 3.2 0 0 1-.488.901c.054.152.076.312.076.465 0 .305-.089.625-.253.912C13.1 15.522 12.437 16 11.5 16H8c-.605 0-1.07-.081-1.466-.218a4.8 4.8 0 0 1-.97-.484l-.048-.03c-.504-.307-.999-.609-2.068-.722C2.682 14.464 2 13.846 2 13V9c0-.85.685-1.432 1.357-1.615.849-.232 1.574-.787 2.132-1.41.56-.627.914-1.28 1.039-1.639.199-.575.356-1.539.428-2.59z";
const THUMB_DOWN = "M6.956 14.534c.065.936.952 1.659 1.908 1.42l.261-.065a1.38 1.38 0 0 0 1.012-.965c.22-.816.533-2.512.062-4.51q.205.03.443.051c.713.065 1.669.071 2.516-.211.518-.173.994-.68 1.2-1.272a1.9 1.9 0 0 0-.234-1.734c.058-.118.103-.242.138-.362.077-.27.113-.568.113-.856 0-.29-.036-.586-.113-.857a2 2 0 0 0-.16-.403c.169-.387.107-.82-.003-1.149a3.2 3.2 0 0 0-.488-.9c.054-.153.076-.313.076-.465a1.86 1.86 0 0 0-.253-.912C13.1.757 12.437.28 11.5.28H8c-.605 0-1.07.08-1.466.217a4.8 4.8 0 0 0-.97.485l-.048.029c-.504.308-.999.61-2.068.723C2.682 1.815 2 2.434 2 3.279v4c0 .851.685 1.433 1.357 1.616.849.232 1.574.787 2.132 1.41.56.626.914 1.28 1.039 1.638.199.575.356 1.54.428 2.591";
const P = d => ["path", {
  d
}];
const C = (cx, cy, r) => ["circle", {
  cx,
  cy,
  r
}];
const R = (x, y, width, height, rx) => ["rect", {
  x,
  y,
  width,
  height,
  rx
}];
const thumb = (d, filled) => ["g", {
  transform: "translate(1.5 1.5) scale(1.3125)",
  strokeWidth: 1.371,
  fill: filled ? "currentColor" : undefined
}, [P(d)]];
const LOCAL_ICONS = {
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
  down: [P("m6 9 6 6 6-6")]
};

// Semantic name → Lucide icon (app/components/ui/icon.tsx). Rendered from the Lucide UMD build at 1.8 stroke.
const LUCIDE_ICONS = {
  streamers: "Tv",
  "your-page": "RadioTower",
  admin: "Shield",
  home: "House",
  user: "UserRound",
  pencil: "Pencil",
  mic: "Mic",
  data: "Database",
  "sign-in": "LogIn",
  "sign-out": "LogOut",
  "at-sign": "AtSign",
  plus: "Plus",
  minus: "Minus",
  close: "X",
  send: "Send",
  save: "Save",
  link: "Link",
  copy: "Copy",
  external: "ExternalLink",
  image: "Image",
  crop: "Crop",
  reset: "RotateCcw",
  "chevron-left": "ChevronLeft",
  "chevron-right": "ChevronRight",
  "arrow-right": "ArrowRight",
  "sort-top": "TrendingUp",
  "sort-new": "Clock",
  "poll-choice": "ListChecks",
  "poll-binary": "ToggleRight",
  timer: "Timer",
  live: "Radio",
  eye: "Eye",
  "eye-off": "EyeOff",
  stop: "CircleStop",
  lock: "Lock",
  overlay: "Cast",
  wifi: "Wifi",
  "wifi-off": "WifiOff",
  requests: "Inbox",
  key: "KeyRound",
  approve: "UserCheck",
  reject: "UserX",
  mail: "Mail",
  globe: "Globe",
  "shield-check": "ShieldCheck",
  success: "CircleCheck",
  error: "CircleAlert",
  warning: "TriangleAlert",
  pending: "Hourglass",
  rejected: "CircleX",
  idea: "Lightbulb",
  compass: "Compass",
  privacy: "LockKeyhole",
  terms: "FileText",
  zap: "Zap"
};
const LUCIDE_SRC = "https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js";
const listeners = new Set();
let loading = false;
function ensureLucide() {
  if (typeof window === "undefined" || window.lucide || loading) return;
  loading = true;
  const s = document.createElement("script");
  s.src = LUCIDE_SRC;
  s.onload = () => listeners.forEach(f => f());
  document.head.appendChild(s);
}
function lucideNode(name) {
  const lib = typeof window !== "undefined" ? window.lucide : null;
  const node = lib && lib.icons && lib.icons[name];
  if (!node) return null;
  return node[0] === "svg" ? node[2] : node;
}
function draw(nodes) {
  return nodes.map(([tag, attrs, kids], i) => React.createElement(tag, {
    key: i,
    ...attrs
  }, kids ? draw(kids) : undefined));
}
function Icon({
  name,
  size = 18,
  className = "",
  style,
  label
}) {
  const lucide = LUCIDE_ICONS[name];
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!lucide) return undefined;
    const f = () => tick(n => n + 1);
    listeners.add(f);
    ensureLucide();
    return () => listeners.delete(f);
  }, [lucide]);
  const nodes = LOCAL_ICONS[name] || (lucide ? lucideNode(lucide) : null) || [];
  return /*#__PURE__*/React.createElement("svg", {
    className: `sb-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    style: {
      width: size,
      height: size,
      ...style
    },
    "aria-hidden": label ? undefined : "true",
    role: label ? "img" : undefined,
    "aria-label": label,
    focusable: "false"
  }, draw(nodes));
}
Object.assign(__ds_scope, { LOCAL_ICONS, LUCIDE_ICONS, Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/board/Category.jsx
try { (() => {
function Category({
  icon = "cat-tech",
  children,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `sb-category ${className}`.trim()
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 24
  }), children);
}
Object.assign(__ds_scope, { Category });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/Category.jsx", error: String((e && e.message) || e) }); }

// components/board/TopicChip.jsx
try { (() => {
function TopicChip({
  icon,
  children,
  pressed,
  onClick,
  className = ""
}) {
  const inner = /*#__PURE__*/React.createElement(React.Fragment, null, icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 18
  }), children);
  if (onClick || pressed !== undefined) return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `sb-chip ${className}`.trim(),
    "aria-pressed": pressed,
    onClick: onClick
  }, inner);
  return /*#__PURE__*/React.createElement("span", {
    className: `sb-chip ${className}`.trim()
  }, inner);
}
Object.assign(__ds_scope, { TopicChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TopicChip.jsx", error: String((e && e.message) || e) }); }

// components/board/TopicRow.jsx
try { (() => {
function TopicRow({
  title,
  icon = "cat-chatting",
  likes = 0,
  dislikes = 0,
  comments = 0,
  selected = false,
  onClick,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `sb-topic ${className}`.trim(),
    "aria-current": selected || undefined,
    onClick: onClick
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-topic-icon"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 32
  })), /*#__PURE__*/React.createElement("span", {
    className: "sb-topic-main"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-topic-title"
  }, title), /*#__PURE__*/React.createElement("span", {
    className: "sb-topic-meta"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "thumbs-up-filled",
    size: 16
  }), likes), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "thumbs-down-filled",
    size: 16
  }), dislikes), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "comment",
    size: 16
  }), comments))), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-right",
    size: 16
  }));
}
Object.assign(__ds_scope, { TopicRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TopicRow.jsx", error: String((e && e.message) || e) }); }

// components/board/VoteButtons.jsx
try { (() => {
function VoteButtons({
  reaction = 0,
  likes = 0,
  dislikes = 0,
  disabled = false,
  size = "lg",
  onReact,
  likeLabel = "Like",
  dislikeLabel = "Dislike",
  className = ""
}) {
  const btn = v => {
    const like = v === 1;
    const pressed = reaction === v;
    const icon = (like ? "thumbs-up" : "thumbs-down") + (pressed ? "-filled" : "");
    return /*#__PURE__*/React.createElement("button", {
      type: "button",
      disabled: disabled,
      "aria-pressed": pressed,
      onClick: () => onReact && onReact(pressed ? 0 : v)
    }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: icon,
      size: 24
    }), /*#__PURE__*/React.createElement("span", {
      className: "sb-vote-word"
    }, like ? likeLabel : dislikeLabel), /*#__PURE__*/React.createElement("b", null, like ? likes : dislikes));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-votes ${className}`.trim(),
    "data-size": size === "sm" ? "sm" : undefined,
    role: "group"
  }, btn(1), btn(-1));
}
Object.assign(__ds_scope, { VoteButtons });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/VoteButtons.jsx", error: String((e && e.message) || e) }); }

// components/board/TopicDetail.jsx
try { (() => {
function TopicDetail({
  category,
  categoryIcon,
  number,
  title,
  author,
  authorPreset = 14,
  description,
  likes = 0,
  dislikes = 0,
  reaction = 0,
  onReact,
  children,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("article", {
    className: `sb-detail ${className}`.trim()
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-detail-content"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-detail-top"
  }, category ? /*#__PURE__*/React.createElement(__ds_scope.Category, {
    icon: categoryIcon
  }, category) : /*#__PURE__*/React.createElement("span", null), number && /*#__PURE__*/React.createElement("span", {
    className: "sb-detail-num"
  }, number)), /*#__PURE__*/React.createElement("h1", null, title), author && /*#__PURE__*/React.createElement("div", {
    className: "sb-author"
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: authorPreset,
    size: 32
  }), /*#__PURE__*/React.createElement("span", null, "Posted by ", /*#__PURE__*/React.createElement("strong", null, author))), description && /*#__PURE__*/React.createElement("p", {
    className: "sb-description"
  }, description), /*#__PURE__*/React.createElement(__ds_scope.VoteButtons, {
    likes: likes,
    dislikes: dislikes,
    reaction: reaction,
    onReact: onReact
  })), children);
}
Object.assign(__ds_scope, { TopicDetail });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/TopicDetail.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Button({
  variant = "default",
  size = "md",
  font = "body",
  icon,
  iconEnd,
  landing = false,
  pressed,
  type = "button",
  className = "",
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: `sb-btn ${className}`.trim(),
    "data-variant": variant === "default" ? undefined : variant,
    "data-size": size === "md" ? undefined : size,
    "data-font": font === "display" ? "display" : undefined,
    "data-landing": landing || undefined,
    "aria-pressed": pressed
  }, rest), icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === "sm" ? 16 : 18
  }), children, iconEnd && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: iconEnd,
    size: size === "sm" ? 16 : 18
  }));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function IconButton({
  label,
  icon,
  iconSize = 20,
  variant = "default",
  title,
  type = "button",
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: `sb-icon-btn ${className}`.trim(),
    "data-variant": variant === "bare" ? "bare" : undefined,
    "aria-label": label,
    title: title ?? label
  }, rest), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: iconSize
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Logo.jsx
try { (() => {
function Logo({
  kind = "full",
  height,
  label = "StreamBullets",
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `sb-logo ${className}`.trim(),
    "data-kind": kind === "icon" ? "icon" : undefined,
    role: "img",
    "aria-label": label,
    style: height ? {
      height
    } : undefined
  });
}
Object.assign(__ds_scope, { Logo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Logo.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Banner.jsx
try { (() => {
function Banner({
  tone = "frozen",
  children,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-banner ${className}`.trim(),
    role: "note",
    "data-tone": tone === "suspended" ? "suspended" : undefined
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: tone === "suspended" ? "warning" : "lock",
    size: 20
  }), /*#__PURE__*/React.createElement("span", null, children));
}
Object.assign(__ds_scope, { Banner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Banner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
function Dialog({
  open = true,
  onOpenChange,
  title,
  description,
  children,
  actions,
  cancel = true,
  cancelLabel = "Cancel",
  inline = false,
  className = ""
}) {
  React.useEffect(() => {
    if (!open || inline) return undefined;
    const k = e => {
      if (e.key === "Escape") onOpenChange && onOpenChange(false);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, inline, onOpenChange]);
  if (!open) return null;
  const close = () => onOpenChange && onOpenChange(false);
  const box = /*#__PURE__*/React.createElement("div", {
    className: `sb-dialog ${className}`.trim(),
    role: "dialog",
    "aria-modal": inline ? undefined : "true",
    "aria-label": title,
    "data-inline": inline || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-dialog-head"
  }, /*#__PURE__*/React.createElement("h2", {
    tabIndex: -1
  }, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Close",
    icon: "close",
    variant: "bare",
    onClick: close
  })), description && /*#__PURE__*/React.createElement("p", {
    className: "sb-dialog-desc"
  }, description), children && /*#__PURE__*/React.createElement("div", {
    className: "sb-dialog-body"
  }, children), (actions || cancel) && /*#__PURE__*/React.createElement("div", {
    className: "sb-dialog-actions"
  }, cancel && /*#__PURE__*/React.createElement(__ds_scope.Button, {
    onClick: close
  }, cancelLabel), actions));
  if (inline) return box;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "sb-backdrop",
    onClick: close
  }), box);
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/EmptyState.jsx
try { (() => {
function EmptyState({
  title,
  icon,
  children,
  action,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-empty ${className}`.trim()
  }, icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 40
  }), /*#__PURE__*/React.createElement("h2", null, title), children && /*#__PURE__*/React.createElement("p", null, children), action && /*#__PURE__*/React.createElement("div", {
    className: "sb-empty-cta"
  }, action));
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/feedback/LivePill.jsx
try { (() => {
function LivePill({
  label = "Live",
  pulse = true,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `sb-live-pill ${className}`.trim(),
    "data-pulse": pulse || undefined
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-live-dot"
  }), label);
}
Object.assign(__ds_scope, { LivePill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/LivePill.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Sheet.jsx
try { (() => {
function Sheet({
  open = true,
  onOpenChange,
  title,
  onBack,
  backLabel = "Back",
  children,
  actions,
  inline = false,
  className = ""
}) {
  if (!open) return null;
  const close = () => onOpenChange && onOpenChange(false);
  const box = /*#__PURE__*/React.createElement("div", {
    className: `sb-dialog sb-sheet ${className}`.trim(),
    role: "dialog",
    "aria-label": title,
    "data-inline": inline || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-dialog-head"
  }, onBack && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sb-back",
    onClick: onBack
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-left",
    size: 18
  }), backLabel), /*#__PURE__*/React.createElement("h2", {
    tabIndex: -1,
    style: {
      flex: 1
    }
  }, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    label: "Close",
    icon: "close",
    variant: "bare",
    onClick: close
  })), /*#__PURE__*/React.createElement("div", {
    className: "sb-sheet-body"
  }, children), actions && /*#__PURE__*/React.createElement("div", {
    className: "sb-dialog-actions"
  }, actions));
  if (inline) return box;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "sb-backdrop",
    onClick: close
  }), box);
}
Object.assign(__ds_scope, { Sheet });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Sheet.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function Toast({
  message,
  tone = "status",
  action,
  floating = false,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-toast ${className}`.trim(),
    role: tone === "error" ? "alert" : "status",
    "data-tone": tone === "error" ? "error" : undefined,
    "data-floating": floating || undefined
  }, /*#__PURE__*/React.createElement("span", null, message), action && /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sb-toast-action",
    onClick: action.onClick
  }, action.label));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/forms/Choice.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Choice({
  type = "radio",
  label,
  help,
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `sb-choice ${className}`.trim()
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: type
  }, rest)), /*#__PURE__*/React.createElement("span", null, label, help && /*#__PURE__*/React.createElement("small", null, help)));
}
Object.assign(__ds_scope, { Choice });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Choice.jsx", error: String((e && e.message) || e) }); }

// components/forms/Req.jsx
try { (() => {
function Req() {
  return /*#__PURE__*/React.createElement("span", {
    className: "sb-req",
    "aria-hidden": "true"
  }, " *");
}
function RequiredNote({
  children = "Required"
}) {
  return /*#__PURE__*/React.createElement("p", {
    className: "sb-req-note",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-req"
  }, "*"), " ", children);
}
Object.assign(__ds_scope, { Req, RequiredNote });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Req.jsx", error: String((e && e.message) || e) }); }

// components/forms/SearchField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SearchField({
  label = "Search topics",
  placeholder = "Search topics…",
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `sb-search ${className}`.trim()
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "search",
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    className: "sr-only"
  }, label), /*#__PURE__*/React.createElement("input", _extends({
    type: "search",
    placeholder: placeholder
  }, rest)));
}
Object.assign(__ds_scope, { SearchField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/SearchField.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  label,
  className = "",
  style
}) {
  const [inner, setInner] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const current = value ?? inner;
  const selected = options.find(o => o.value === current);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const pick = v => {
    setInner(v);
    onValueChange && onValueChange(v);
    setOpen(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-select ${className}`.trim(),
    ref: ref,
    style: style
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sb-select-trigger",
    "aria-haspopup": "listbox",
    "aria-expanded": open,
    "aria-label": label,
    "data-placeholder": selected ? undefined : "",
    onClick: () => setOpen(!open)
  }, selected && selected.icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: selected.icon,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    className: "sb-select-value"
  }, selected ? selected.label : placeholder), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-down",
    size: 16,
    className: "sb-chev"
  })), open && /*#__PURE__*/React.createElement("ul", {
    className: "sb-select-list",
    role: "listbox"
  }, options.map(o => /*#__PURE__*/React.createElement("li", {
    key: o.value,
    role: "option",
    "aria-selected": o.value === current,
    className: "sb-select-option",
    onClick: () => pick(o.value)
  }, o.icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: o.icon,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    className: "sb-select-label"
  }, o.label), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "check",
    size: 16,
    className: "sb-check"
  })))));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/board/Discussion.jsx
try { (() => {
function Discussion({
  title = "Discussion",
  count,
  sort = true,
  children,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("section", {
    className: `sb-discussion ${className}`.trim()
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-discussion-head"
  }, /*#__PURE__*/React.createElement("h3", null, title), count !== undefined && /*#__PURE__*/React.createElement("span", {
    className: "sb-discussion-count"
  }, count, " comments"), sort && /*#__PURE__*/React.createElement(__ds_scope.Select, {
    label: "Sort comments",
    defaultValue: "top",
    style: {
      width: 125
    },
    options: [{
      value: "top",
      label: "Top"
    }, {
      value: "new",
      label: "Newest"
    }]
  })), children);
}
function Comment({
  name,
  role,
  preset = 14,
  time,
  children,
  likes = 0,
  liked = false,
  reply = false,
  onLike,
  onReply
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "sb-comment",
    "data-reply": reply || undefined
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: preset,
    size: 42
  }), /*#__PURE__*/React.createElement("div", {
    className: "sb-comment-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-comment-meta"
  }, /*#__PURE__*/React.createElement("strong", null, name), role && /*#__PURE__*/React.createElement("small", null, role), time && /*#__PURE__*/React.createElement("time", null, time)), /*#__PURE__*/React.createElement("p", null, children), /*#__PURE__*/React.createElement("div", {
    className: "sb-comment-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-pressed": liked,
    onClick: onLike
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: liked ? "thumbs-up-filled" : "thumbs-up",
    size: 20
  }), likes), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onReply
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "reply",
    size: 18
  }), "Reply"))));
}
function Composer({
  placeholder = "Write a comment…",
  postLabel = "Post",
  value,
  onChange,
  onPost,
  replyingTo
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, replyingTo && /*#__PURE__*/React.createElement("p", {
    className: "sb-replying"
  }, "Replying to ", replyingTo), /*#__PURE__*/React.createElement("div", {
    className: "sb-composer"
  }, /*#__PURE__*/React.createElement("textarea", {
    rows: 1,
    placeholder: placeholder,
    value: value,
    onChange: onChange,
    "aria-label": placeholder
  }), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "gold",
    onClick: onPost
  }, postLabel)));
}
Object.assign(__ds_scope, { Discussion, Comment, Composer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/board/Discussion.jsx", error: String((e && e.message) || e) }); }

// components/forms/Tabs.jsx
try { (() => {
function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  label,
  className = ""
}) {
  const [inner, setInner] = React.useState(defaultValue ?? (items[0] && items[0].value));
  const current = value ?? inner;
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-tabs ${className}`.trim(),
    role: "group",
    "aria-label": label
  }, items.map(it => /*#__PURE__*/React.createElement("button", {
    key: it.value,
    type: "button",
    "aria-pressed": it.value === current,
    onClick: () => {
      setInner(it.value);
      onValueChange && onValueChange(it.value);
    }
  }, it.label)));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/forms/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function TextField({
  label,
  help,
  error,
  required = false,
  multiline = false,
  rows = 4,
  id,
  className = "",
  ...rest
}) {
  const auto = React.useId();
  const fid = id || auto;
  const Tag = multiline ? "textarea" : "input";
  return /*#__PURE__*/React.createElement("label", {
    className: `sb-field ${className}`.trim(),
    htmlFor: fid
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-field-label"
  }, label, required && /*#__PURE__*/React.createElement(__ds_scope.Req, null)), /*#__PURE__*/React.createElement(Tag, _extends({
    id: fid,
    className: "sb-input",
    required: required,
    rows: multiline ? rows : undefined,
    "aria-invalid": error ? "true" : undefined
  }, rest)), error ? /*#__PURE__*/React.createElement("small", {
    className: "sb-error"
  }, error) : help ? /*#__PURE__*/React.createElement("small", null, help) : null);
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TextField.jsx", error: String((e && e.message) || e) }); }

// components/overlay/ChatLayer.jsx
try { (() => {
// Platform glyphs from app/components/overlay/wasteland/glyphs.tsx (24×24; fill or 2px stroke).
const GLYPHS = {
  youtube: [["M6 5h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z", "stroke"], ["m10 8 6 4-6 4z", "fill"]],
  twitch: [["M4 2h18v13l-6 6h-5l-4 3v-3H2V6zm1 3v12h5v3l3-3h4l3-3V5z", "fill"], ["M11 7v6m5-6v6", "stroke"]],
  kick: [["M3 3h5v7h3V7h3V3h7v6h-4v3h-3v2h3v3h4v4h-7v-3h-3v-3H8v6H3z", "fill"]]
};
const NAMES = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick"
};
function PlatformIcon({
  platform
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", {
    className: "sb-chat-icon",
    viewBox: "0 0 24 24",
    "aria-hidden": "true",
    focusable: "false"
  }, (GLYPHS[platform] || []).map(([d, paint]) => paint === "fill" ? /*#__PURE__*/React.createElement("path", {
    key: d,
    fill: "currentColor",
    d: d
  }) : /*#__PURE__*/React.createElement("path", {
    key: d,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    d: d
  }))), /*#__PURE__*/React.createElement("span", {
    className: "sr-only"
  }, NAMES[platform], " "));
}
function short(name, max = 20) {
  const chars = Array.from(name);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : name;
}
function ChatLayer({
  rows,
  backgroundOpacity = 100,
  test = false,
  absolute = true,
  className = "",
  style
}) {
  return /*#__PURE__*/React.createElement("ol", {
    className: `sb-chat ${className}`.trim(),
    "data-static": absolute ? undefined : "",
    "data-outline": backgroundOpacity < 50 || undefined,
    "aria-label": "Chat",
    style: {
      "--wl-bg": String(backgroundOpacity / 100),
      ...style
    }
  }, test && /*#__PURE__*/React.createElement("li", {
    className: "sb-chat-test",
    "aria-hidden": "true"
  }, "TEST"), rows.map((r, i) => /*#__PURE__*/React.createElement("li", {
    key: r.id ?? i,
    className: "sb-chat-item",
    "data-phase": r.removed ? "removed" : undefined,
    "data-newest": i === rows.length - 1 && !r.removed || undefined,
    "data-enter": r.enter || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-chat-card"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-chat-line"
  }, /*#__PURE__*/React.createElement(PlatformIcon, {
    platform: r.platform
  }), !r.removed && (r.badges || []).slice(0, 2).map(b => /*#__PURE__*/React.createElement("span", {
    key: b,
    className: "sb-chat-badge"
  }, b)), /*#__PURE__*/React.createElement("span", {
    className: "sb-chat-user"
  }, /*#__PURE__*/React.createElement("bdi", null, short(r.name)), ": "), /*#__PURE__*/React.createElement("span", {
    className: "sb-chat-msg",
    dir: "auto"
  }, r.removed ? "message removed by a moderator" : r.text)), /*#__PURE__*/React.createElement("svg", {
    className: "sb-chat-vault",
    viewBox: "0 0 36 24",
    "aria-hidden": "true",
    focusable: "false"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 9h10M1 15h10M25 9h10M25 15h10"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "18",
    cy: "12",
    r: "9"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "18",
    cy: "12",
    r: "4"
  }))))));
}
Object.assign(__ds_scope, { ChatLayer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlay/ChatLayer.jsx", error: String((e && e.message) || e) }); }

// components/overlay/OverlayCard.jsx
try { (() => {
function OverlayCard({
  kind = "topic",
  eyebrow,
  title,
  author,
  authorPreset = 14,
  likes,
  when,
  startsIn,
  body,
  cta,
  messageStyle = "info",
  className = "",
  style
}) {
  const eb = {
    topic: ["topics", "Topic spotlight"],
    next: ["schedule", "Up next"],
    card: ["community", eyebrow]
  }[kind];
  return /*#__PURE__*/React.createElement("article", {
    className: `sb-ov-card ${className}`.trim(),
    style: style
  }, eb && /*#__PURE__*/React.createElement("span", {
    className: "sb-eyebrow"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: eb[0],
    size: 16
  }), eyebrow || eb[1]), /*#__PURE__*/React.createElement("h1", null, kind === "message" && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: messageStyle === "hype" ? "zap" : "megaphone",
    size: 40
  }), kind === "support" && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "heart",
    size: 40
  }), title), kind === "topic" && author && /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-meta"
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: authorPreset,
    size: 44
  }), /*#__PURE__*/React.createElement("span", null, "Suggested by ", /*#__PURE__*/React.createElement("strong", null, author)), likes !== undefined && /*#__PURE__*/React.createElement("span", {
    className: "sb-ov-likes"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "thumbs-up",
    size: 24
  }), likes)), kind === "next" && /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-meta"
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "timer",
    size: 24
  }), when, startsIn && /*#__PURE__*/React.createElement("span", {
    className: "sb-ov-pill"
  }, startsIn)), body && /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-body"
  }, body), cta && /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-cta"
  }, cta));
}
function OverlayPoll({
  streamer,
  title,
  options,
  counts,
  countdown,
  showResults = true,
  className = "",
  style
}) {
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const pct = counts ? counts.map(c => total ? Math.round(c * 100 / total) : 0) : [];
  return /*#__PURE__*/React.createElement("article", {
    className: `sb-poll sb-ov-poll ${className}`.trim(),
    style: style
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-eyebrow"
  }, streamer, " \xB7 Live poll"), /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-topline"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
    className: "sb-gold-dot"
  }), "Voting live"), /*#__PURE__*/React.createElement("span", null, countdown ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "timer",
    size: 16
  }), countdown) : "No time limit")), /*#__PURE__*/React.createElement("h1", null, title), showResults ? /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-options"
  }, options.map((o, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "sb-poll-option"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-opt-track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-opt-fill",
    style: {
      width: pct[i] + "%"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "sb-opt-label"
  }, o)), /*#__PURE__*/React.createElement("span", {
    className: "sb-opt-score"
  }, /*#__PURE__*/React.createElement("small", null, counts[i], " votes"), /*#__PURE__*/React.createElement("span", null, pct[i], "%"))))) : /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-hidden"
  }, "Results hidden"), /*#__PURE__*/React.createElement("p", {
    className: "sb-ov-total"
  }, total, " votes"));
}
Object.assign(__ds_scope, { OverlayCard, OverlayPoll });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlay/OverlayCard.jsx", error: String((e && e.message) || e) }); }

// components/polls/PollCard.jsx
try { (() => {
function shares(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map(c => c * 100 / total);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) {
      floor[i]++;
      left--;
    }
  });
  return floor;
}
function PollStatus({
  state = "live",
  countdown
}) {
  const badge = state === "live" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "sb-gold-dot"
  }), "Voting live") : state === "revealed" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "eye",
    size: 16
  }), "Results revealed") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "lock",
    size: 16
  }), "Voting closed");
  return /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-topline"
  }, /*#__PURE__*/React.createElement("span", null, badge), /*#__PURE__*/React.createElement("span", null, countdown ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "timer",
    size: 16
  }), countdown) : state === "live" ? "No time limit" : "Final"));
}
function PollResults({
  options,
  counts,
  myVote = null,
  onVote,
  disabled = false,
  kind = "choice"
}) {
  const pct = counts ? shares(counts) : [];
  return /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-options",
    "data-kind": kind === "binary" ? "binary" : undefined
  }, options.map((opt, i) => {
    const content = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
      className: "sb-opt-track"
    }, counts && /*#__PURE__*/React.createElement("span", {
      className: "sb-opt-fill",
      style: {
        width: pct[i] + "%"
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "sb-opt-label"
    }, onVote && myVote === i && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
      name: "check",
      size: 16
    }), opt)), counts && /*#__PURE__*/React.createElement("span", {
      className: "sb-opt-score"
    }, /*#__PURE__*/React.createElement("small", null, counts[i], " ", counts[i] === 1 ? "vote" : "votes"), /*#__PURE__*/React.createElement("span", null, pct[i], "%")));
    return onVote ? /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "sb-poll-option",
      "aria-pressed": myVote === i,
      disabled: disabled,
      onClick: () => onVote(i)
    }, content) : /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "sb-poll-option"
    }, content);
  }));
}
function PollCard({
  title,
  author,
  authorPreset = 14,
  options,
  counts,
  myVote = null,
  onVote,
  state = "live",
  countdown,
  kind = "choice",
  owner = false,
  onReveal,
  likes = 0,
  dislikes = 0,
  reaction = 0,
  onReact,
  comments = 0,
  onDiscuss,
  className = ""
}) {
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const msg = state !== "live" ? "Voting is closed. These are the final results." : myVote === null ? "Tap an option to vote." : "You can change your vote until voting closes.";
  return /*#__PURE__*/React.createElement("article", {
    className: `sb-poll ${className}`.trim()
  }, /*#__PURE__*/React.createElement(PollStatus, {
    state: state,
    countdown: countdown
  }), /*#__PURE__*/React.createElement("h2", null, title), author && /*#__PURE__*/React.createElement("div", {
    className: "sb-author"
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: authorPreset,
    size: 32
  }), /*#__PURE__*/React.createElement("span", null, "Posted by ", /*#__PURE__*/React.createElement("strong", null, author))), /*#__PURE__*/React.createElement(PollResults, {
    options: options,
    counts: counts,
    myVote: myVote,
    onVote: onVote,
    disabled: state !== "live",
    kind: kind
  }), /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-footer"
  }, /*#__PURE__*/React.createElement("p", null, total, " ", total === 1 ? "vote" : "votes", myVote !== null && " · Your vote is in", /*#__PURE__*/React.createElement("br", null), msg), owner && state === "live" && /*#__PURE__*/React.createElement(__ds_scope.Button, {
    font: "display",
    icon: "eye",
    onClick: onReveal
  }, "End & reveal")), /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-react"
  }, /*#__PURE__*/React.createElement("span", null, "React"), /*#__PURE__*/React.createElement(__ds_scope.VoteButtons, {
    size: "sm",
    likes: likes,
    dislikes: dislikes,
    reaction: reaction,
    onReact: onReact
  })), /*#__PURE__*/React.createElement("div", {
    className: "sb-poll-engagement"
  }, /*#__PURE__*/React.createElement(__ds_scope.Button, {
    className: "sb-discuss",
    icon: "comment",
    onClick: onDiscuss
  }, "Discuss \xB7 ", comments), /*#__PURE__*/React.createElement(__ds_scope.Button, {
    icon: "link"
  }, "Poll link")));
}
Object.assign(__ds_scope, { PollStatus, PollResults, PollCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/polls/PollCard.jsx", error: String((e && e.message) || e) }); }

// components/shell/AccountMenu.jsx
try { (() => {
const DEFAULT_ITEMS = [{
  id: "your-page",
  label: "Your page",
  icon: "your-page"
}, {
  id: "edit",
  label: "Edit your page",
  icon: "pencil"
}, {
  id: "overlay",
  label: "Overlay control",
  icon: "overlay"
}, {
  id: "profile",
  label: "Your profile",
  icon: "user"
}, {
  id: "data",
  label: "Your data",
  icon: "data"
}, "divider", {
  id: "sign-out",
  label: "Sign out",
  icon: "sign-out"
}];
function AccountMenu({
  name,
  role = "Viewer",
  preset = 1,
  items = DEFAULT_ITEMS,
  current,
  onSelect,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `sb-menu ${className}`.trim(),
    role: "menu",
    "aria-label": `Account menu for ${name}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-menu-id"
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: preset,
    size: 44
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("strong", null, name), /*#__PURE__*/React.createElement("span", null, role))), /*#__PURE__*/React.createElement("ul", null, items.map((it, i) => it === "divider" ? /*#__PURE__*/React.createElement("li", {
    key: i,
    className: "sb-menu-divider",
    role: "separator"
  }) : /*#__PURE__*/React.createElement("li", {
    key: it.id
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "menuitem",
    className: "sb-menu-item",
    "aria-current": current === it.id ? "page" : undefined,
    onClick: () => onSelect && onSelect(it.id)
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: it.icon,
    size: 18
  }), it.label)))));
}
Object.assign(__ds_scope, { AccountMenu });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/shell/AccountMenu.jsx", error: String((e && e.message) || e) }); }

// components/shell/BackLink.jsx
try { (() => {
function BackLink({
  children = "Back",
  href = "#",
  onClick
}) {
  return /*#__PURE__*/React.createElement("a", {
    className: "sb-back",
    href: href,
    onClick: onClick
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevron-left",
    size: 18
  }), children);
}
Object.assign(__ds_scope, { BackLink });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/shell/BackLink.jsx", error: String((e && e.message) || e) }); }

// components/shell/SiteFooter.jsx
try { (() => {
const LINKS = ["Privacy", "Terms", "Accessibility", "Contact", "Report content", "AI agents"];
function SiteFooter({
  links = LINKS,
  language = "English",
  onLanguage,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("footer", {
    className: `sb-footer ${className}`.trim()
  }, /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Footer"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-sep"
  }, "\xA9 StreamBullets"), links.map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#"
  }, l)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onLanguage
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "globe",
    size: 16
  }), language)));
}
Object.assign(__ds_scope, { SiteFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/shell/SiteFooter.jsx", error: String((e && e.message) || e) }); }

// components/shell/SiteHeader.jsx
try { (() => {
function SiteHeader({
  current = "streamers",
  links = [{
    id: "streamers",
    label: "Streamers",
    icon: "streamers"
  }],
  signedIn = true,
  avatarPreset = 1,
  onSignIn,
  onAccount,
  onNavigate,
  className = ""
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: `sb-header ${className}`.trim(),
    style: {
      gridTemplateColumns: "auto minmax(0,1fr) auto",
      minHeight: 76
    }
  }, /*#__PURE__*/React.createElement("a", {
    className: "sb-header-brand",
    href: "#",
    "aria-label": "StreamBullets home",
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate("home");
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Logo, null)), /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Main navigation"
  }, links.map(l => /*#__PURE__*/React.createElement("a", {
    key: l.id,
    className: "sb-nav-link",
    href: "#",
    "aria-current": current === l.id ? "page" : undefined,
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate(l.id);
    }
  }, l.icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: l.icon,
    size: 18
  }), l.label))), /*#__PURE__*/React.createElement("div", {
    className: "sb-header-end"
  }, signedIn ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sb-profile",
    "aria-label": "Account menu",
    onClick: onAccount
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: avatarPreset,
    size: 40
  })) : /*#__PURE__*/React.createElement(__ds_scope.Button, {
    icon: "sign-in",
    onClick: onSignIn
  }, "Sign in")));
}
Object.assign(__ds_scope, { SiteHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/shell/SiteHeader.jsx", error: String((e && e.message) || e) }); }

// components/shell/StreamerHeader.jsx
try { (() => {
const VIEWS = [{
  id: "topics",
  label: "Topics",
  icon: "topics"
}, {
  id: "polls",
  label: "Polls",
  icon: "polls"
}, {
  id: "schedule",
  label: "Schedule",
  icon: "schedule"
}, {
  id: "about",
  label: "About",
  icon: "about"
}, {
  id: "community",
  label: "Community",
  icon: "community"
}];
function StreamerHeader({
  name,
  preset = 14,
  current = "topics",
  onNavigate,
  live = false,
  ticker,
  own = false,
  action,
  signedIn = true,
  avatarPreset = 1,
  onAccount,
  compact = false,
  className = ""
}) {
  const views = own ? [...VIEWS, {
    id: "overlay",
    label: "Overlay",
    icon: "overlay"
  }] : VIEWS;
  return /*#__PURE__*/React.createElement("header", {
    className: `sb-header ${className}`.trim(),
    "data-compact": compact || undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: "sb-header-brand"
  }, /*#__PURE__*/React.createElement("a", {
    className: "sb-mark",
    href: "#",
    "aria-label": "StreamBullets home",
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate("home");
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Logo, {
    kind: "icon",
    height: 32
  })), /*#__PURE__*/React.createElement("span", {
    className: "sb-divider",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("a", {
    className: "sb-streamer-home",
    href: "#",
    "aria-label": `${name} home`,
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate("topics");
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: preset,
    size: compact ? 48 : 76,
    ring: "cream"
  }), /*#__PURE__*/React.createElement("span", {
    className: "sb-streamer-name"
  }, name)), live && /*#__PURE__*/React.createElement(__ds_scope.LivePill, null)), /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Main navigation"
  }, views.map(v => /*#__PURE__*/React.createElement("a", {
    key: v.id,
    className: "sb-nav-tab",
    href: "#",
    title: v.label,
    "aria-label": compact ? v.label : undefined,
    "aria-current": current === v.id ? "page" : undefined,
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate(v.id);
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: v.icon,
    size: 20
  }), /*#__PURE__*/React.createElement("span", {
    className: "sb-nav-label"
  }, v.label)))), /*#__PURE__*/React.createElement("div", {
    className: "sb-header-end"
  }, /*#__PURE__*/React.createElement("a", {
    className: "sb-streamers-link sb-hide-compact",
    href: "#",
    onClick: e => {
      e.preventDefault();
      onNavigate && onNavigate("streamers");
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "streamers",
    size: 20
  }), "Streamers"), action !== undefined ? action : /*#__PURE__*/React.createElement(__ds_scope.Button, {
    variant: "gold",
    font: "display",
    size: "lg",
    icon: "plus",
    className: "sb-hide-compact"
  }, "Suggest a topic"), signedIn ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "sb-profile",
    "aria-label": "Account menu",
    onClick: onAccount
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    preset: avatarPreset,
    size: 40
  })) : /*#__PURE__*/React.createElement(__ds_scope.Button, {
    icon: "sign-in"
  }, "Sign in")), ticker && /*#__PURE__*/React.createElement("div", {
    className: "sb-ticker"
  }, /*#__PURE__*/React.createElement("strong", null, /*#__PURE__*/React.createElement("span", {
    className: "sb-live-dot"
  }), "On air"), /*#__PURE__*/React.createElement("span", null, ticker)));
}
Object.assign(__ds_scope, { StreamerHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/shell/StreamerHeader.jsx", error: String((e && e.message) || e) }); }

// ui_kits/obs-overlay/Chat.jsx
try { (() => {
const POOL = [{
  platform: "twitch",
  name: "PixelLuna",
  badges: ["SUB"],
  text: "that build is so clean"
}, {
  platform: "kick",
  name: "grizzly_gg",
  text: "how loud are the fans at full load?"
}, {
  platform: "youtube",
  name: "TechNomad",
  badges: ["MOD"],
  text: "ran a 7B model on a mini PC last week, fine for small tasks"
}, {
  platform: "twitch",
  name: "orbit",
  text: "voting Mass Effect, it got good later"
}, {
  platform: "youtube",
  name: "Мария",
  text: "Привет из Киева! 👋"
}, {
  platform: "kick",
  name: "a_very_long_username_indeed",
  text: "first time here, love the station look"
}, {
  platform: "twitch",
  name: "ねこ",
  text: "こんばんは！"
}, {
  platform: "youtube",
  name: "Hannah",
  text: "No Man's Sky deserves it"
}];
function Chat({
  opacity
}) {
  const {
    ChatLayer
  } = window.StreamBulletsDesignSystem_e1d9fa;
  const [rows, setRows] = React.useState(() => POOL.slice(0, 4).map((r, i) => ({
    ...r,
    id: "s" + i
  })));
  React.useEffect(() => {
    let n = 4;
    const i = setInterval(() => {
      const base = POOL[n % POOL.length];
      const row = n % 9 === 7 ? {
        platform: "twitch",
        name: "spam_bot_42",
        removed: true
      } : base;
      setRows(rs => [...rs.slice(-11).map(r => ({
        ...r,
        enter: false
      })), {
        ...row,
        id: "m" + n,
        enter: true
      }]);
      n++;
    }, 2400);
    return () => clearInterval(i);
  }, []);
  return /*#__PURE__*/React.createElement(ChatLayer, {
    rows: rows,
    backgroundOpacity: opacity
  });
}
window.Chat = Chat;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/obs-overlay/Chat.jsx", error: String((e && e.message) || e) }); }

// ui_kits/obs-overlay/Content.jsx
try { (() => {
function Content({
  source
}) {
  const {
    OverlayCard,
    OverlayPoll
  } = window.StreamBulletsDesignSystem_e1d9fa;
  const [t, setT] = React.useState(0);
  React.useEffect(() => {
    const i = setInterval(() => setT(n => n + 1), 1500);
    return () => clearInterval(i);
  }, []);
  if (source === "poll") {
    const counts = [61 + t * 2, 27 + t, 12 + Math.floor(t / 2)];
    return /*#__PURE__*/React.createElement(OverlayPoll, {
      streamer: "Sunny",
      title: "Which game deserves a second chance?",
      options: ["Mass Effect: Andromeda", "No Man's Sky", "Cyberpunk 2077"],
      counts: counts,
      countdown: "1 min left"
    });
  }
  if (source === "topic") return /*#__PURE__*/React.createElement(OverlayCard, {
    kind: "topic",
    title: "Can AI run my homelab?",
    author: "TechNomad",
    authorPreset: 0,
    likes: 142
  });
  if (source === "next") return /*#__PURE__*/React.createElement(OverlayCard, {
    kind: "next",
    title: "Building a quiet streaming PC",
    when: "Fri 8:00 PM",
    startsIn: "in 45 min"
  });
  if (source === "message") return /*#__PURE__*/React.createElement(OverlayCard, {
    kind: "message",
    messageStyle: "hype",
    title: "Raid incoming. Say hi!"
  });
  if (source === "support") return /*#__PURE__*/React.createElement(OverlayCard, {
    kind: "support",
    title: /*#__PURE__*/React.createElement(React.Fragment, null, "Support the stream: ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--gold)"
      }
    }, "ko-fi.com/sunny"))
  });
  return null;
}
window.Content = Content;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/obs-overlay/Content.jsx", error: String((e && e.message) || e) }); }

// ui_kits/obs-overlay/OverlayApp.jsx
try { (() => {
function OverlayApp() {
  const {
    Tabs,
    Button,
    Choice
  } = window.StreamBulletsDesignSystem_e1d9fa;
  const [source, setSource] = React.useState(localStorage.getItem("sb-ov-source") || "poll");
  const [bg, setBg] = React.useState("checker");
  const [chat, setChat] = React.useState(true);
  const [opacity, setOpacity] = React.useState(100);
  const take = s => {
    setSource(s);
    localStorage.setItem("sb-ov-source", s);
  };
  const full = source === "poll";
  return /*#__PURE__*/React.createElement("div", {
    className: "ov-page"
  }, /*#__PURE__*/React.createElement(Stage, {
    background: bg
  }, chat && /*#__PURE__*/React.createElement("div", {
    className: "ov-layer",
    style: {
      left: 0,
      top: 0,
      width: 600,
      height: 840
    }
  }, /*#__PURE__*/React.createElement(Chat, {
    opacity: opacity
  })), /*#__PURE__*/React.createElement("div", {
    className: "ov-layer ov-content",
    "data-full": full || undefined,
    style: chat ? {
      left: 720,
      top: 0,
      width: 1200,
      height: 1080
    } : {
      left: 0,
      top: 0,
      width: 1920,
      height: 1080
    }
  }, /*#__PURE__*/React.createElement(Content, {
    source: source
  }))), /*#__PURE__*/React.createElement("div", {
    className: "ov-controls"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "sb-eyebrow"
  }, "On air"), /*#__PURE__*/React.createElement(Tabs, {
    label: "On air",
    value: source,
    onValueChange: take,
    items: [{
      value: "poll",
      label: "Poll"
    }, {
      value: "topic",
      label: "Topic"
    }, {
      value: "next",
      label: "Up next"
    }, {
      value: "message",
      label: "Message"
    }, {
      value: "support",
      label: "Support"
    }, {
      value: "hidden",
      label: "Hidden"
    }]
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "sb-eyebrow"
  }, "Preview background"), /*#__PURE__*/React.createElement(Tabs, {
    label: "Preview background",
    value: bg,
    onValueChange: setBg,
    items: [{
      value: "checker",
      label: "Transparent"
    }, {
      value: "game",
      label: "Sample game"
    }]
  })), /*#__PURE__*/React.createElement("div", {
    className: "ov-chat-ctl"
  }, /*#__PURE__*/React.createElement(Choice, {
    type: "checkbox",
    label: "Show chat on stream",
    checked: chat,
    onChange: e => setChat(e.target.checked)
  }), /*#__PURE__*/React.createElement("label", {
    className: "ov-range"
  }, "Message background ", opacity, "%", /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: "0",
    max: "100",
    step: "5",
    value: opacity,
    onChange: e => setOpacity(+e.target.value)
  })))));
}
window.OverlayApp = OverlayApp;
if (window.__SB_KIT === "overlay") ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(OverlayApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/obs-overlay/OverlayApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/obs-overlay/Stage.jsx
try { (() => {
// 1920×1080 design canvas scaled to fit its container (overlay-composition.tsx / use-design-scale.ts).
function Stage({
  background,
  children
}) {
  const ref = React.useRef(null);
  const [scale, setScale] = React.useState(0.5);
  React.useLayoutEffect(() => {
    const el = ref.current;
    const fit = () => setScale(Math.min(el.clientWidth / 1920, el.clientHeight / 1080));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "ov-frame",
    ref: ref,
    "data-background": background
  }, /*#__PURE__*/React.createElement("div", {
    className: "ov-scaler",
    style: {
      transform: `scale(${scale})`
    }
  }, background === "game" && /*#__PURE__*/React.createElement("div", {
    className: "ov-game"
  }), children));
}
window.Stage = Stage;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/obs-overlay/Stage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Directory.jsx
try { (() => {
function Directory({
  go
}) {
  const {
    SiteHeader,
    SearchField,
    Avatar,
    LivePill
  } = window.StreamBulletsDesignSystem_e1d9fa;
  const [q, setQ] = React.useState("");
  const list = window.SB_DATA.streamers.filter(s => (s.name + s.handle).toLowerCase().includes(q.toLowerCase()));
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SiteHeader, {
    current: "streamers",
    onNavigate: id => go(id === "home" ? "landing" : "streamers"),
    links: [{
      id: "streamers",
      label: "Streamers",
      icon: "streamers"
    }, {
      id: "your-page",
      label: "Your page",
      icon: "your-page"
    }]
  }), /*#__PURE__*/React.createElement("main", {
    className: "page-panel"
  }, /*#__PURE__*/React.createElement("h1", null, "Streamers"), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Find a community. Suggest topics. Vote."), /*#__PURE__*/React.createElement(SearchField, {
    label: "Search streamers",
    placeholder: "Search by name or @handle\u2026",
    value: q,
    onChange: e => setQ(e.target.value),
    style: {}
  }), /*#__PURE__*/React.createElement("p", {
    className: "count"
  }, "Showing ", list.length, " pages"), /*#__PURE__*/React.createElement("div", {
    className: "streamer-grid"
  }, list.map(s => /*#__PURE__*/React.createElement("a", {
    key: s.handle,
    href: "#",
    className: "streamer-card",
    onClick: e => {
      e.preventDefault();
      go("topics");
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    preset: s.preset,
    size: 60
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", null, s.name, s.live && /*#__PURE__*/React.createElement(LivePill, null), s.official && /*#__PURE__*/React.createElement("span", {
    className: "official"
  }, "Official")), /*#__PURE__*/React.createElement("p", {
    className: "handle"
  }, "@", s.handle), /*#__PURE__*/React.createElement("p", {
    className: "bio"
  }, s.bio)))))));
}
window.Directory = Directory;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Directory.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Landing.jsx
try { (() => {
function Landing({
  go
}) {
  const {
    Logo,
    Button
  } = window.StreamBulletsDesignSystem_e1d9fa;
  return /*#__PURE__*/React.createElement("div", {
    className: "lp"
  }, /*#__PURE__*/React.createElement("header", {
    className: "lp-head"
  }, /*#__PURE__*/React.createElement(Logo, {
    height: 72
  }), /*#__PURE__*/React.createElement("nav", null, /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    font: "display",
    onClick: () => go("streamers")
  }, "Streamers"), /*#__PURE__*/React.createElement(Button, {
    landing: true,
    variant: "gold",
    onClick: () => go("streamers")
  }, "Sign in"))), /*#__PURE__*/React.createElement("img", {
    className: "lp-station",
    src: "/_blob/36c2158ea840e29094802fe4ecc4c0ef",
    alt: ""
  }), /*#__PURE__*/React.createElement("div", {
    className: "lp-copy"
  }, /*#__PURE__*/React.createElement("h1", null, "Your voice,", /*#__PURE__*/React.createElement("br", null), "on air."), /*#__PURE__*/React.createElement("p", null, "Suggest topics. Vote. Shape the stream."), /*#__PURE__*/React.createElement("div", {
    className: "lp-actions"
  }, /*#__PURE__*/React.createElement(Button, {
    landing: true,
    variant: "gold",
    onClick: () => go("streamers")
  }, "Get started"), /*#__PURE__*/React.createElement(Button, {
    landing: true,
    onClick: () => go("streamers")
  }, "Browse streamers"))), /*#__PURE__*/React.createElement("div", {
    className: "lp-topics"
  }, /*#__PURE__*/React.createElement("span", null, "Topics"), /*#__PURE__*/React.createElement("em", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "Polls"), /*#__PURE__*/React.createElement("em", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, "Discussions")));
}
window.Landing = Landing;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Landing.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/PollsView.jsx
try { (() => {
function PollsView({
  toast
}) {
  const {
    PollCard,
    Button,
    EmptyState
  } = window.StreamBulletsDesignSystem_e1d9fa;
  const [vote, setVote] = React.useState(null);
  const [state, setState] = React.useState("live");
  const [react, setReact] = React.useState(0);
  const base = [48, 31, 9];
  const counts = base.map((c, i) => c + (vote === i ? 1 : 0));
  return /*#__PURE__*/React.createElement("main", {
    className: "page-panel polls"
  }, /*#__PURE__*/React.createElement("div", {
    className: "page-title"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "Polls"), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Vote on what happens next on stream.")), /*#__PURE__*/React.createElement(Button, {
    variant: "gold",
    font: "display",
    icon: "plus"
  }, "New poll")), /*#__PURE__*/React.createElement(PollCard, {
    title: "Should we explore more local AI on stream?",
    author: "Sunny",
    authorPreset: 14,
    options: ["Yes, more local AI", "A mix of both", "Stick to cloud tools"],
    counts: counts,
    myVote: vote,
    onVote: i => {
      setVote(i);
      toast("Your vote is in.");
    },
    state: state,
    countdown: state === "live" ? "2 min left" : undefined,
    owner: true,
    onReveal: () => setState("revealed"),
    likes: 1 + (react === 1 ? 1 : 0),
    dislikes: react === -1 ? 1 : 0,
    reaction: react,
    onReact: setReact,
    comments: 1,
    onDiscuss: () => toast("Discussion opened.")
  }), /*#__PURE__*/React.createElement(PollCard, {
    title: "Retro night: which era?",
    author: "PixelLuna",
    authorPreset: 2,
    kind: "binary",
    options: ["8-bit", "16-bit"],
    state: "closed",
    counts: [22, 35],
    likes: 4,
    comments: 3
  }));
}
window.PollsView = PollsView;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/PollsView.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/TopicBoard.jsx
try { (() => {
function TopicBoard({
  toast
}) {
  const NS = window.StreamBulletsDesignSystem_e1d9fa;
  const {
    SearchField,
    Tabs,
    TopicRow,
    TopicDetail,
    Discussion,
    Comment,
    Composer
  } = NS;
  const D = window.SB_DATA;
  const [sel, setSel] = React.useState(1);
  const [sort, setSort] = React.useState("top");
  const [q, setQ] = React.useState("");
  const [votes, setVotes] = React.useState({});
  const [comments, setComments] = React.useState(D.comments);
  const [draft, setDraft] = React.useState("");
  let topics = D.topics.filter(t => t.title.toLowerCase().includes(q.toLowerCase()));
  if (sort === "new") topics = [...topics].reverse();
  const t = D.topics.find(x => x.id === sel);
  const r = votes[sel] || 0;
  return /*#__PURE__*/React.createElement("main", {
    className: "board"
  }, /*#__PURE__*/React.createElement("section", {
    className: "browse"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intro"
  }, /*#__PURE__*/React.createElement("h1", null, "Pick the next conversation"), /*#__PURE__*/React.createElement("p", null, "Sunny \xB7 Suggest topics. Vote. Chat.")), /*#__PURE__*/React.createElement(SearchField, {
    value: q,
    onChange: e => setQ(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "list-toolbar"
  }, /*#__PURE__*/React.createElement(Tabs, {
    label: "Topic sorting",
    value: sort,
    onValueChange: setSort,
    items: [{
      value: "top",
      label: "Top"
    }, {
      value: "new",
      label: "New"
    }]
  }), /*#__PURE__*/React.createElement("span", {
    className: "count"
  }, topics.length, " topics")), /*#__PURE__*/React.createElement("div", {
    className: "topics"
  }, topics.map(x => /*#__PURE__*/React.createElement(TopicRow, {
    key: x.id,
    title: x.title,
    icon: x.icon,
    likes: x.likes + (votes[x.id] === 1 ? 1 : 0),
    dislikes: x.dislikes + (votes[x.id] === -1 ? 1 : 0),
    comments: x.comments,
    selected: x.id === sel,
    onClick: () => setSel(x.id)
  })))), /*#__PURE__*/React.createElement(TopicDetail, {
    category: t.cat,
    categoryIcon: t.icon,
    number: "Topic 00" + t.id,
    title: t.title,
    author: t.author,
    authorPreset: t.authorPreset,
    description: t.body,
    likes: t.likes + (r === 1 ? 1 : 0),
    dislikes: t.dislikes + (r === -1 ? 1 : 0),
    reaction: r,
    onReact: v => setVotes({
      ...votes,
      [sel]: v
    })
  }, /*#__PURE__*/React.createElement(Discussion, {
    count: t.comments + comments.length - 2
  }, comments.map((c, i) => /*#__PURE__*/React.createElement(Comment, {
    key: i,
    name: c.name,
    role: c.role,
    preset: c.preset,
    likes: c.likes,
    time: c.time
  }, c.text)), /*#__PURE__*/React.createElement(Composer, {
    value: draft,
    onChange: e => setDraft(e.target.value),
    onPost: () => {
      if (!draft.trim()) return;
      setComments([...comments, {
        name: "You",
        preset: 1,
        likes: 0,
        text: draft,
        time: "Just now"
      }]);
      setDraft("");
      toast("Comment posted.");
    }
  }))));
}
window.TopicBoard = TopicBoard;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/TopicBoard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/WebsiteApp.jsx
try { (() => {
function WebsiteApp() {
  const NS = window.StreamBulletsDesignSystem_e1d9fa;
  const {
    StreamerHeader,
    SiteFooter,
    Toast,
    Dialog,
    Button,
    TextField,
    Select,
    AccountMenu,
    EmptyState
  } = NS;
  const saved = localStorage.getItem("sb-kit-screen") || "topics";
  const [screen, setScreen] = React.useState(saved);
  const [msg, setMsg] = React.useState(null);
  const [suggest, setSuggest] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const go = s => {
    setScreen(s);
    localStorage.setItem("sb-kit-screen", s);
    setMenu(false);
  };
  const toast = m => {
    setMsg(m);
    clearTimeout(window.__t);
    window.__t = setTimeout(() => setMsg(null), 3200);
  };
  const streamerScreens = ["topics", "polls", "schedule", "about", "community"];
  if (screen === "landing") return /*#__PURE__*/React.createElement(Landing, {
    go: go
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "shell sb-grain"
  }, screen === "streamers" ? /*#__PURE__*/React.createElement(Directory, {
    go: go
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StreamerHeader, {
    name: "Sunny",
    preset: 14,
    current: screen,
    live: true,
    ticker: "Live now \xB7 Can AI run my homelab?",
    own: true,
    onAccount: () => setMenu(!menu),
    onNavigate: v => go(v === "home" ? "landing" : v === "overlay" ? "topics" : v),
    action: /*#__PURE__*/React.createElement(Button, {
      variant: "gold",
      font: "display",
      size: "lg",
      icon: "plus",
      onClick: () => setSuggest(true)
    }, "Suggest a topic")
  }), menu && /*#__PURE__*/React.createElement("div", {
    className: "menu-pop"
  }, /*#__PURE__*/React.createElement(AccountMenu, {
    name: "Sunny",
    role: "Streamer \xB7 @sunny",
    preset: 14,
    current: "your-page",
    onSelect: id => {
      setMenu(false);
      if (id === "sign-out") go("landing");
    }
  })), screen === "topics" && /*#__PURE__*/React.createElement(TopicBoard, {
    toast: toast
  }), screen === "polls" && /*#__PURE__*/React.createElement(PollsView, {
    toast: toast
  }), !["topics", "polls"].includes(screen) && /*#__PURE__*/React.createElement("main", {
    className: "page-panel"
  }, /*#__PURE__*/React.createElement(EmptyState, {
    icon: screen,
    title: "Not in this kit"
  }, "This view exists in the product but is not recreated here."))), /*#__PURE__*/React.createElement(SiteFooter, null), /*#__PURE__*/React.createElement(Dialog, {
    open: suggest,
    onOpenChange: setSuggest,
    title: "Suggest a topic",
    description: "What would make a great conversation?",
    actions: /*#__PURE__*/React.createElement(Button, {
      variant: "gold",
      font: "display",
      onClick: () => {
        setSuggest(false);
        toast("Topic submitted.");
      }
    }, "Submit topic")
  }, /*#__PURE__*/React.createElement(TextField, {
    label: "Title",
    required: true,
    placeholder: "Can AI run my homelab?"
  }), /*#__PURE__*/React.createElement("label", {
    className: "sb-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sb-field-label"
  }, "Category"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(Select, {
    placeholder: "Choose a category",
    options: [{
      value: "tech",
      label: "Tech & setups",
      icon: "cat-tech"
    }, {
      value: "gaming",
      label: "Gaming",
      icon: "cat-gaming"
    }, {
      value: "creative",
      label: "Creative",
      icon: "cat-creative"
    }, {
      value: "chat",
      label: "Just chatting",
      icon: "cat-chatting"
    }]
  }))), /*#__PURE__*/React.createElement(TextField, {
    label: "Details",
    multiline: true,
    rows: 3
  })), msg && /*#__PURE__*/React.createElement(Toast, {
    floating: true,
    message: msg
  }));
}
window.WebsiteApp = WebsiteApp;
if (window.__SB_KIT === "website") ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(WebsiteApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/WebsiteApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/data.js
try { (() => {
window.SB_DATA = {
  streamer: {
    name: "Sunny",
    handle: "sunny",
    preset: 14
  },
  topics: [{
    id: 1,
    title: "Can AI run my homelab?",
    icon: "cat-tech",
    cat: "Tech & setups",
    likes: 142,
    dislikes: 18,
    comments: 24,
    author: "Sunny",
    authorPreset: 14,
    body: "I'm curious how far we can actually take AI in a self-hosted setup. Can it realistically run useful models on a homelab without breaking the bank? What hardware works well, what are the real limitations, and is it actually worth it for a creator setup?\nLet's talk real-world experiences, configs, and what you'd do differently."
  }, {
    id: 2,
    title: "Which game deserves a second chance?",
    icon: "cat-gaming",
    cat: "Gaming",
    likes: 96,
    dislikes: 12,
    comments: 18,
    author: "PixelLuna",
    authorPreset: 2,
    body: "Some launches were rough. Which one got good later and deserves a fresh look on stream?"
  }, {
    id: 3,
    title: "Building a quiet streaming PC",
    icon: "cat-tech",
    cat: "Tech & setups",
    likes: 88,
    dislikes: 7,
    comments: 15,
    author: "grizzly_gg",
    authorPreset: 3,
    body: "Fans, cases, undervolting. How quiet can a streaming rig get without losing performance?"
  }, {
    id: 4,
    title: "Best tools for content creators right now?",
    icon: "cat-chatting",
    cat: "Just chatting",
    likes: 70,
    dislikes: 9,
    comments: 11,
    author: "TechNomad",
    authorPreset: 0,
    body: "Editing, captions, thumbnails, scheduling. What is in your kit this year?"
  }, {
    id: 5,
    title: "Questions for a future Q&A stream",
    icon: "cat-creative",
    cat: "Creative",
    likes: 52,
    dislikes: 6,
    comments: 27,
    author: "orbit",
    authorPreset: 7,
    body: "Drop the questions you want answered live."
  }],
  comments: [{
    name: "TechNomad",
    role: "Community member",
    preset: 0,
    likes: 27,
    text: "I've been running a local model on a mini PC and it's surprisingly capable for smaller tasks. Not a replacement for cloud, but perfect for learning and experimenting."
  }, {
    name: "PixelLuna",
    role: "Community member",
    preset: 2,
    likes: 19,
    text: "Depends on what you want to do. For text and simple workflows it's totally doable. For bigger models you'll definitely feel the hardware limits. Worth it for the control though!"
  }],
  streamers: [{
    name: "Sunny",
    handle: "sunny",
    preset: 14,
    live: true,
    bio: "Homelabs, quiet PCs and honest takes on AI tools. Live Tue and Fri."
  }, {
    name: "PixelLuna",
    handle: "pixelluna",
    preset: 2,
    bio: "Cozy games, pixel art and a lot of tea."
  }, {
    name: "grizzly_gg",
    handle: "grizzly",
    preset: 5,
    bio: "Retro shooters and speedrun practice. Bring snacks."
  }, {
    name: "StreamBullets",
    handle: "streambullets",
    preset: 12,
    official: true,
    bio: "Help shape StreamBullets. Suggest improvements and vote on what we build next."
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/data.js", error: String((e && e.message) || e) }); }

__ds_ns.Category = __ds_scope.Category;

__ds_ns.Discussion = __ds_scope.Discussion;

__ds_ns.Comment = __ds_scope.Comment;

__ds_ns.Composer = __ds_scope.Composer;

__ds_ns.TopicChip = __ds_scope.TopicChip;

__ds_ns.TopicDetail = __ds_scope.TopicDetail;

__ds_ns.TopicRow = __ds_scope.TopicRow;

__ds_ns.VoteButtons = __ds_scope.VoteButtons;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.LOCAL_ICONS = __ds_scope.LOCAL_ICONS;

__ds_ns.LUCIDE_ICONS = __ds_scope.LUCIDE_ICONS;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Logo = __ds_scope.Logo;

__ds_ns.Banner = __ds_scope.Banner;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.LivePill = __ds_scope.LivePill;

__ds_ns.Sheet = __ds_scope.Sheet;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Choice = __ds_scope.Choice;

__ds_ns.Req = __ds_scope.Req;

__ds_ns.RequiredNote = __ds_scope.RequiredNote;

__ds_ns.SearchField = __ds_scope.SearchField;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.ChatLayer = __ds_scope.ChatLayer;

__ds_ns.OverlayCard = __ds_scope.OverlayCard;

__ds_ns.OverlayPoll = __ds_scope.OverlayPoll;

__ds_ns.PollStatus = __ds_scope.PollStatus;

__ds_ns.PollResults = __ds_scope.PollResults;

__ds_ns.PollCard = __ds_scope.PollCard;

__ds_ns.AccountMenu = __ds_scope.AccountMenu;

__ds_ns.BackLink = __ds_scope.BackLink;

__ds_ns.SiteFooter = __ds_scope.SiteFooter;

__ds_ns.SiteHeader = __ds_scope.SiteHeader;

__ds_ns.StreamerHeader = __ds_scope.StreamerHeader;

})();
