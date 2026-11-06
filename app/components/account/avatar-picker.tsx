import type { ReactNode } from "react";
import { t } from "../../i18n";
import { AVATAR_NAMES, AVATAR_ORDER, DEFAULT_AVATAR_PRESET } from "../../lib/avatars";
import { Picture } from "../ui/avatar";
import { Icon } from "../ui/icon";

/** The picker's value: a preset number, or "photo" for the person's own (uploaded or newly cropped) picture. */
export type AvatarChoice = number | "photo";

function optionLabel(choice: AvatarChoice): string {
  if (choice === "photo") return t("profile.yourPhoto");
  return choice === DEFAULT_AVATAR_PRESET ? t("profile.defaultPreset", { name: AVATAR_NAMES[choice] }) : AVATAR_NAMES[choice];
}

/**
 * "Choose a picture": the person's photo first (when there is one), then the 18 presets in the approved
 * order, 6 per row (4 on phones). Native radio buttons, so the arrow keys move the choice and one Tab
 * reaches the group.
 */
export function AvatarPicker({
  value,
  photo,
  onChange,
  onAdjust,
}: Readonly<{
  value: AvatarChoice;
  /** The photo option's image, or null when the person has none. */
  photo: string | null;
  onChange: (choice: AvatarChoice) => void;
  /** Shown as "Adjust your photo" when there is a photo. */
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
