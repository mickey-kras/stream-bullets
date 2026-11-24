import { assetUrl } from "./assets.js";

// Presets 0..17, as in app/lib/avatars.ts. 14 is the default Space explorer.
export const AVATAR_PRESET_COUNT = 18;
export const DEFAULT_AVATAR_PRESET = 14;
// The order of the avatar picker: the default first, then three rows of six.
export const AVATAR_ORDER = [14, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 15];
// English preset names (avatar.0..17 in app/i18n/en.json).
export const AVATAR_NAMES = [
  "Dark hair & beard",
  "Natural curls",
  "Classic bob",
  "Dark hair & glasses",
  "Silver pixie",
  "Close crop & beard",
  "Short curls",
  "Teal headscarf",
  "Silver side part",
  "Red hair & freckles",
  "Waves & glasses",
  "Plum undercut",
  "Friendly robot",
  "Bookish cat",
  "Space explorer",
  "Night owl",
  "Jack Russell terrier",
  "Friendly alien",
];

// Presets 0..15 use the 4x4 sprite that the .portrait rule loads; 16 and 17 use separate images.
export function portraitStyle(preset) {
  if (preset === 16 || preset === 17)
    return {
      backgroundImage: `url("${assetUrl(`Avatars/avatar-${preset === 16 ? "jack-russell" : "alien"}.webp`)}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  return { backgroundPosition: `${((preset % 4) * 100) / 3}% ${(Math.floor(preset / 4) * 100) / 3}%` };
}

function isPreset(value) {
  return Number.isInteger(value) && value >= 0 && value < AVATAR_PRESET_COUNT;
}

// The app sizes the avatar with its container rules or the avatar-48, avatar-32 and avatar-20 classes.
// Any other size is an inline width and height, for previews outside those containers.
function sizing(size) {
  if (size === 48 || size === 32 || size === 20) return { sizeClass: `avatar-${size}`, sizeStyle: undefined };
  return { sizeClass: "", sizeStyle: size ? { width: size, height: size } : undefined };
}

// Decorative picture (app/components/ui/avatar.tsx Picture): the text next to it gives the name.
// Fallback: uploaded url, preset, default Space explorer. Never initials.
export function Avatar({ url = null, preset = null, size, className = "" }) {
  const { sizeClass, sizeStyle } = sizing(size);
  const classes = `${sizeClass} ${className}`.trim();
  if (url) return <img className={`user-avatar ${classes}`.trim()} src={url} alt="" loading="lazy" style={sizeStyle} />;
  const p = isPreset(preset) ? preset : DEFAULT_AVATAR_PRESET;
  return (
    <span
      className={`user-avatar portrait ${classes}`.trim()}
      style={{ ...portraitStyle(p), ...sizeStyle }}
      data-preset={p}
      aria-hidden="true"
    />
  );
}

// Page picture fallback (app StreamerLogo): page logo, owner upload, owner preset, default Space explorer.
export function StreamerLogo({ logo = null, avatar = null, ownerAvatarPreset = null, size, className = "" }) {
  return <Avatar url={logo || avatar} preset={ownerAvatarPreset} size={size} className={className} />;
}
