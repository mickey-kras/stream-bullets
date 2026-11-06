import type { CSSProperties } from "react";
import { AVATAR_PRESET_COUNT, DEFAULT_AVATAR_PRESET } from "../../db/enums";

export { AVATAR_PRESET_COUNT, DEFAULT_AVATAR_PRESET };

/** Accessible names of the 18 preset pictures, by preset number. */
export const AVATAR_NAMES: readonly string[] = [
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

/** The picker's order (item 9): the default Space explorer first, then three rows of six. */
export const AVATAR_ORDER: readonly number[] = [14, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 15];

export function isAvatarPreset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < AVATAR_PRESET_COUNT;
}

/**
 * Presets 0–15 are cells of the 4×4 sprite `/assets/avatars.webp` (the `.portrait` class); 16 and 17 are
 * their own images.
 */
export function portraitStyle(preset: number): CSSProperties {
  if (preset === 16 || preset === 17)
    return {
      backgroundImage: `url("/assets/avatar-${preset === 16 ? "jack-russell" : "alien"}.webp")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  return { backgroundPosition: `${((preset % 4) * 100) / 3}% ${(Math.floor(preset / 4) * 100) / 3}%` };
}

/** A person's picture: the upload, else the preset, else the default Space explorer. */
export type PictureSource = { kind: "photo"; url: string } | { kind: "preset"; preset: number };

export function personPicture(url: string | null | undefined, preset: number | null | undefined): PictureSource {
  if (url) return { kind: "photo", url };
  return { kind: "preset", preset: isAvatarPreset(preset) ? preset : DEFAULT_AVATAR_PRESET };
}

/**
 * A streamer page's logo (item 18): the uploaded page logo, else the owner's profile picture (upload, then
 * preset), else the default Space explorer.
 */
export function streamerPicture(page: {
  logo?: string | null;
  avatar?: string | null;
  ownerAvatarPreset?: number | null;
}): PictureSource {
  if (page.logo) return { kind: "photo", url: page.logo };
  return personPicture(page.avatar, page.ownerAvatarPreset);
}
