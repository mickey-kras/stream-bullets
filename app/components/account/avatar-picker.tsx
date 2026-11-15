import type { ReactNode } from "react";
import { t } from "../../i18n";
import { AVATAR_ORDER, avatarName, DEFAULT_AVATAR_PRESET } from "../../lib/avatars";
import { Picture } from "../ui/avatar";
import { Icon } from "../ui/icon";

// Preset number or photo for uploaded/newly cropped image.
export type AvatarChoice = number | "photo";

function optionLabel(choice: AvatarChoice): string {
  if (choice === "photo") return t("profile.yourPhoto");
  return choice === DEFAULT_AVATAR_PRESET
    ? t("profile.defaultPreset", { name: avatarName(choice) })
    : avatarName(choice);
}

// Photo first, then 18 presets; six columns, four on phones. Native radios provide arrow navigation and one
// Tab stop.
export function AvatarPicker({
  value,
  photo,
  onChange,
  onAdjust,
}: Readonly<{
  value: AvatarChoice;
  // Null without a photo.
  photo: string | null;
  onChange: (choice: AvatarChoice) => void;

  onAdjust?: () => void;
}>): ReactNode {
  const options: AvatarChoice[] = [...(photo ? (["photo"] as const) : []), ...AVATAR_ORDER];
  return (
    <fieldset className="avatar-picker">
      <legend>{t("profile.choosePicture")}</legend>
      {photo && onAdjust && (
        <button type="button" className="text-button" onClick={onAdjust}>
          <Icon name="crop" size={16} />
          {t("profile.adjustPhoto")}
        </button>
      )}
      <div className="avatar-grid">
        {options.map((choice: AvatarChoice) => (
          <label key={choice} className="avatar-option" data-avatar={choice}>
            <input
              type="radio"
              className="sr-only"
              name="avatar"
              value={choice}
              checked={choice === value}
              aria-label={optionLabel(choice)}
              onChange={() => onChange(choice)}
            />
            <Picture
              source={
                choice === "photo" && photo
                  ? { kind: "photo", url: photo }
                  : { kind: "preset", preset: choice === "photo" ? DEFAULT_AVATAR_PRESET : choice }
              }
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
