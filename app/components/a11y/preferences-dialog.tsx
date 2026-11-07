import { useId, useRef, useState, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { applyPrefs, DEFAULT_PREFS, savePrefsCookie, setChangedPrefs } from "../../lib/prefs";
import { useShell } from "../../lib/shell";
import { usePrefs } from "../../lib/use-prefs";
import type { DisplayPrefs } from "../../types";
import { sendJson } from "../api";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { announce } from "./announcer";

type Prefs = Required<DisplayPrefs>;
type ChoiceKey = "cvd" | "contrast" | "text" | "motion" | "mashAssist";

interface Choice {
  value: string;
  label: MessageId | string;
  hint?: MessageId;
}

const GROUPS: readonly { key: ChoiceKey; legend: MessageId; choices: readonly Choice[] }[] = [
  {
    key: "cvd",
    legend: "prefs.cvd",
    choices: [
      { value: "default", label: "prefs.cvdDefault" },
      { value: "pd", label: "prefs.cvdPd", hint: "prefs.cvdPdHint" },
      { value: "tri", label: "prefs.cvdTri", hint: "prefs.cvdTriHint" },
    ],
  },
  {
    key: "contrast",
    legend: "prefs.contrast",
    choices: [
      { value: "default", label: "prefs.contrastDefault", hint: "prefs.contrastDefaultHint" },
      { value: "high", label: "prefs.contrastHigh" },
    ],
  },
  {
    key: "text",
    legend: "prefs.text",
    choices: [
      { value: "100", label: "100%" },
      { value: "115", label: "115%" },
      { value: "130", label: "130%" },
    ],
  },
  {
    key: "motion",
    legend: "prefs.motion",
    choices: [
      { value: "system", label: "prefs.motionSystem" },
      { value: "reduce", label: "prefs.motionReduce" },
      { value: "full", label: "prefs.motionFull" },
    ],
  },
];

const ASSIST: readonly Choice[] = [
  { value: "off", label: "prefs.assistOff" },
  { value: "hold", label: "prefs.assistHold", hint: "prefs.assistHoldHint" },
  { value: "toggle", label: "prefs.assistToggle", hint: "prefs.assistToggleHint" },
];

const SR_INTERVALS: readonly [Prefs["srInterval"], MessageId][] = [
  ["2", "prefs.sr2"],
  ["5", "prefs.sr5"],
  ["10", "prefs.sr10"],
  ["off", "prefs.srOff"],
];

/** Percentages and other labels that are the same in every language are not message ids. */
function label(value: MessageId | string): string {
  return value.startsWith("prefs.") ? t(value as MessageId) : value;
}

function Choices({
  name,
  value,
  choices,
  onChange,
}: Readonly<{ name: string; value: string; choices: readonly Choice[]; onChange: (value: string) => void }>) {
  return (
    <div className="pref-options">
      {choices.map((choice: Choice) => (
        <label key={choice.value} className="choice">
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>
            {label(choice.label)}
            {choice.hint && <small>{t(choice.hint)}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

function Check({
  checked,
  title,
  hint,
  onChange,
}: Readonly<{ checked: boolean; title: MessageId; hint?: MessageId; onChange: (checked: boolean) => void }>) {
  return (
    <label className="choice">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>
        {t(title)}
        {hint && <small>{t(hint)}</small>}
      </span>
    </label>
  );
}

/**
 * "Accessibility & display" (item 39): colour-vision palettes, contrast, text size, a readable font, link
 * underlines, motion, and the Mash Battle options (screen-reader updates, shortcuts, assisted tapping).
 * A change applies at once through the head script's function and is kept in a cookie for this browser.
 * Signed in, it is also saved to the account, one second after the last change.
 */
export function PreferencesDialog({ onClose }: Readonly<{ onClose: () => void }>): ReactNode {
  const shell = useShell();
  const toast = useToast();
  const current: Prefs = usePrefs();
  const [prefs, setPrefs] = useState<Prefs>(current);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const srLabel: string = useId();
  const assistLabel: string = useId();

  function save(next: Prefs): void {
    setPrefs(next);
    setChangedPrefs(next);
    applyPrefs(next);
    savePrefsCookie(next);
    if (!shell.viewer) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sendJson("PATCH", "/api/me/preferences", next).catch(() => toast(t("prefs.saveFailed"), { tone: "error" }));
    }, 1_000);
  }
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]): void => save({ ...prefs, [key]: value });

  return (
    <Sheet
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      title={t("prefs.title")}
      name="a11y"
      actions={
        <DialogActions cancel={false}>
          <button
            type="button"
            onClick={() => {
              save(DEFAULT_PREFS);
              announce(t("prefs.resetDone"));
            }}
          >
            <Icon name="reset" size={18} />
            {t("prefs.reset")}
          </button>
          <button type="button" className="gold" onClick={onClose}>
            {t("prefs.done")}
          </button>
        </DialogActions>
      }
    >
      <p>{t(shell.viewer ? "prefs.introAccount" : "prefs.intro")}</p>
      {GROUPS.map((group) => (
        <fieldset key={group.key} className="pref-group" id={`pref-${group.key}`}>
          <legend>{t(group.legend)}</legend>
          <Choices
            name={`pref-${group.key}`}
            value={prefs[group.key]}
            choices={group.choices}
            onChange={(value: string) => set(group.key, value as Prefs[typeof group.key])}
          />
        </fieldset>
      ))}
      <fieldset className="pref-group" id="pref-reading">
        <legend>{t("prefs.reading")}</legend>
        <div className="pref-options">
          <Check
            checked={prefs.font === "readable"}
            title="prefs.font"
            hint="prefs.fontHint"
            onChange={(on: boolean) => set("font", on ? "readable" : "default")}
          />
          <Check checked={prefs.underline} title="prefs.underline" onChange={(on: boolean) => set("underline", on)} />
        </div>
      </fieldset>
      <fieldset className="pref-group" id="pref-live">
        <legend>{t("prefs.live")}</legend>
        <div className="pref-options">
          <div className="field">
            <span className="field-label" id={srLabel}>
              {t("prefs.srInterval")}
            </span>
            <Select
              labelledBy={srLabel}
              options={SR_INTERVALS.map(([value, id]) => ({ value, label: t(id) }))}
              value={prefs.srInterval}
              onValueChange={(value: string) => set("srInterval", value as Prefs["srInterval"])}
            />
          </div>
          <Check
            checked={prefs.shortcuts}
            title="prefs.shortcuts"
            hint="prefs.shortcutsHint"
            onChange={(on: boolean) => set("shortcuts", on)}
          />
          <div className="field" role="radiogroup" aria-labelledby={assistLabel}>
            <span className="field-label" id={assistLabel}>
              {t("prefs.assist")}
            </span>
            <Choices
              name="pref-mashAssist"
              value={prefs.mashAssist}
              choices={ASSIST}
              onChange={(value: string) => set("mashAssist", value as Prefs["mashAssist"])}
            />
            <p className="muted">{t("prefs.assistNote")}</p>
          </div>
        </div>
      </fieldset>
    </Sheet>
  );
}
