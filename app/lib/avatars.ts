import type { CSSProperties } from "react";
import { t, type MessageId } from "../i18n";
import { AVATAR_PRESET_COUNT, DEFAULT_AVATAR_PRESET } from "../../db/enums";

export { AVATAR_PRESET_COUNT, DEFAULT_AVATAR_PRESET } from "../../db/enums";

// Localized preset name (0..17).
export function avatarName(preset: number): string {
  return t(`avatar.${preset}` as MessageId);
}

// Default Space explorer first, then three rows of six.
export const AVATAR_ORDER: readonly number[] = [14, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 15];

export function isAvatarPreset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < AVATAR_PRESET_COUNT;
}

// Presets 0..15 use /assets/avatars.webp's 4x4 sprite; 16 and 17 use separate images.
export function portraitStyle(preset: number): CSSProperties {
  if (preset === 16 || preset === 17)
    return {
      backgroundImage: `url("/assets/avatar-${preset === 16 ? "jack-russell" : "alien"}.webp")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  return { backgroundPosition: `${((preset % 4) * 100) / 3}% ${(Math.floor(preset / 4) * 100) / 3}%` };
}

// Picture fallback: upload, preset, default Space explorer.
export type PictureSource = { kind: "photo"; url: string } | { kind: "preset"; preset: number };

export function personPicture(url: string | null | undefined, preset: number | null | undefined): PictureSource {
  if (url) return { kind: "photo", url };
  return { kind: "preset", preset: isAvatarPreset(preset) ? preset : DEFAULT_AVATAR_PRESET };
}

// Logo fallback: page logo, owner upload, owner preset, default Space explorer.
export function streamerPicture(page: {
  logo?: string | null;
  avatar?: string | null;
  ownerAvatarPreset?: number | null;
}): PictureSource {
  if (page.logo) return { kind: "photo", url: page.logo };
  return personPicture(page.avatar, page.ownerAvatarPreset);
}
