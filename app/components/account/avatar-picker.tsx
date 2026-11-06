import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import { AVATAR_NAMES, AVATAR_ORDER, DEFAULT_AVATAR_PRESET } from "../../lib/avatars";
import { Picture } from "../ui/avatar";
import { Icon } from "../ui/icon";

/** The picker's value: a preset number, or "photo" for the person's own (uploaded or newly cropped) picture. */
export type AvatarChoice = number | "photo";

/**
 * "Choose a picture": the person's photo first (when there is one), then the 18 presets in the approved
 * order, 6 per row (4 on phones). A radio group with a roving tab stop: arrows move by cell and row, Home and
 * End jump, and moving selects (APG radio group).
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
  const grid = useRef<HTMLDivElement | null>(null);
  const options: AvatarChoice[] = [...(photo ? (["photo"] as const) : []), ...AVATAR_ORDER];
  // Exactly one option is tabbable: the checked one, or the first when none is.
  const tabStop: AvatarChoice = options.includes(value) ? value : options[0];

  function select(choice: AvatarChoice): void {
    onChange(choice);
    grid.current?.querySelector<HTMLButtonElement>(`[data-avatar="${choice}"]`)?.focus();
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const template: string = grid.current ? getComputedStyle(grid.current).gridTemplateColumns : "";
    const columns: number = Math.max(1, template.split(" ").filter(Boolean).length);
    const next: number | undefined = {
      ArrowRight: index + 1,
      ArrowDown: index + columns,
      ArrowLeft: index - 1,
      ArrowUp: index - columns,
      Home: 0,
      End: options.length - 1,
    }[event.key];
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      select(options[index]);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    select(options[Math.max(0, Math.min(options.length - 1, next))]);
  }

  return (
    <fieldset className="avatar-picker">
      <legend id="avatar-picker-label">{t("profile.choosePicture")}</legend>
      {photo && onAdjust && (
        <button type="button" className="text-button" onClick={onAdjust}>
          <Icon name="crop" size={16} />
          {t("profile.adjustPhoto")}
        </button>
      )}
      <div className="avatar-grid" role="radiogroup" aria-labelledby="avatar-picker-label" ref={grid}>
        {options.map((choice: AvatarChoice, index: number) => {
          const checked: boolean = choice === value;
          let label: string = t("profile.yourPhoto");
          if (choice !== "photo")
            label =
              choice === DEFAULT_AVATAR_PRESET
                ? t("profile.defaultPreset", { name: AVATAR_NAMES[choice] })
                : AVATAR_NAMES[choice];
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              className="avatar-option"
              aria-checked={checked}
              tabIndex={choice === tabStop ? 0 : -1}
              aria-label={label}
              data-avatar={choice}
              onClick={() => select(choice)}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => keyDown(event, index)}
            >
              <Picture
                source={choice === "photo" && photo ? { kind: "photo", url: photo } : { kind: "preset", preset: choice === "photo" ? DEFAULT_AVATAR_PRESET : choice }}
              />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
