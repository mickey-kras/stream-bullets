import { useId, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { MASH_DURATIONS, MASH_MAX_SIDES, MASH_MIN_SIDES, MASH_SIDE_LENGTH } from "../../lib/mash";
import { IconButton } from "../ui/icon-button";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { sideStyle } from "./mash-parts";

/** The Mash Battle part of the create poll form: 2–4 sides and the battle length. */
export function MashFields(): ReactNode {
  const [sides, setSides] = useState<number[]>([0, 1]);
  const [next, setNext] = useState<number>(2);
  const durationLabel: string = useId();
  return (
    <>
      <fieldset className="mash-fields">
        <legend>{t("mash.create.sides")}</legend>
        <ul className="mash-side-inputs">
          {sides.map((key: number, index: number) => (
            <li key={key} style={sideStyle(index)}>
              <span className="mash-swatch" aria-hidden="true" />
              <input
                name="side"
                required
                maxLength={MASH_SIDE_LENGTH}
                aria-label={t("mash.create.sideLabel", { n: index + 1 })}
              />
              {index >= MASH_MIN_SIDES && (
                <IconButton
                  label={t("mash.create.removeSide", { n: index + 1 })}
                  icon="close"
                  iconSize={18}
                  onClick={() => setSides((current: number[]) => current.filter((item: number) => item !== key))}
                />
              )}
            </li>
          ))}
        </ul>
        {sides.length < MASH_MAX_SIDES && (
          <button
            type="button"
            className="small-button"
            onClick={() => {
              setSides((current: number[]) => [...current, next]);
              setNext((value: number) => value + 1);
            }}
          >
            <Icon name="plus" size={16} />
            {t("mash.create.addSide")}
          </button>
        )}
      </fieldset>
      <div className="field">
        <span className="field-label" id={durationLabel}>
          {t("mash.battleLengthLabel")}
        </span>
        <Select
          name="durationS"
          labelledBy={durationLabel}
          defaultValue="30"
          options={MASH_DURATIONS.map((seconds: number) => ({
            value: String(seconds),
            label: seconds === 120 ? t("mash.create.twoMinutes") : t("mash.create.seconds", { n: seconds }),
          }))}
        />
      </div>
      <p className="muted">{t("mash.create.help")}</p>
    </>
  );
}
