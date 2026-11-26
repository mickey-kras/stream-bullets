import { useId, useState, type FormEvent, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import type { Orientation, OverlayLayers } from "../../lib/overlay-layers";
import {
  LAYOUT_NAME_LENGTH,
  UNSAVED_LAYOUT,
  layoutChoices,
  type LayoutAction,
  type LayoutChoice,
  type OverlayLayouts,
  type PresetKey,
} from "../../lib/overlay-layouts";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";

const PRESET_NAMES: Readonly<Record<PresetKey, MessageId>> = {
  chatting: "overlay.layout.preset.chatting",
  gameplay: "overlay.layout.preset.gameplay",
  vertical: "overlay.layout.preset.vertical",
};

/** The list value that opens the dialog for a new layout. It is not a layout. */
const NEW_LAYOUT = "new";

/** The name of a list entry, as the list and the messages show it. */
function choiceName(choice: LayoutChoice): string {
  if (choice.preset) {
    const name: string = t(PRESET_NAMES[choice.preset]);
    return t(choice.changed ? "overlay.layout.presetChanged" : "overlay.layout.presetMark", { name });
  }
  return choice.id === UNSAVED_LAYOUT ? t("overlay.layout.unsaved") : choice.name;
}

/** The entries of the layout list of an output, with "New layout…" as the last one. */
export function layoutOptions(choices: readonly LayoutChoice[]): SelectOption[] {
  return [
    ...choices.map((choice: LayoutChoice): SelectOption => ({ value: choice.id, label: choiceName(choice) })),
    { value: NEW_LAYOUT, label: t("overlay.layout.new"), icon: "plus" },
  ];
}

/** Sends a layout action. True when the server saved it. */
export type LayoutAct = (action: LayoutAction) => Promise<boolean>;

/** The dialog for a new layout: a name, and a copy of the layout on stream or an empty grid. */
function NewLayoutDialog({
  output,
  busy,
  act,
  onClose,
}: Readonly<{ output: Orientation; busy: boolean; act: LayoutAct; onClose: () => void }>): ReactNode {
  const [name, setName] = useState<string>("");
  const [from, setFrom] = useState<"current" | "empty">("current");
  const nameId: string = useId();
  const formId: string = useId();
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const saved: boolean = await act({ action: "create", output, name, from, keep: t("overlay.layout.keepName") });
    if (saved) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      title={t("overlay.layout.newTitle")}
      actions={
        <DialogActions>
          <button type="submit" form={formId} className="gold" disabled={busy || name.trim() === ""}>
            {t("overlay.layout.create")}
          </button>
        </DialogActions>
      }
    >
      <form id={formId} className="ov-layout-form" onSubmit={(event) => void create(event)} data-layout-new>
        <label className="field-label" htmlFor={nameId}>
          {t("overlay.layout.name")}
        </label>
        <input
          id={nameId}
          required
          maxLength={LAYOUT_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          autoComplete="off"
        />
        <fieldset className="field">
          <legend className="sr-only">{t("overlay.layout.newTitle")}</legend>
          {(["current", "empty"] as const).map((value) => (
            <label className="choice" key={value}>
              <input type="radio" name="from" checked={from === value} onChange={() => setFrom(value)} />
              <span>{t(value === "current" ? "overlay.layout.fromCopy" : "overlay.layout.fromEmpty")}</span>
            </label>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}

/** One layout of the streamer in the dialog: its name, and the buttons that save the name and delete the layout. */
function OwnLayoutRow({
  output,
  choice,
  busy,
  act,
}: Readonly<{ output: Orientation; choice: LayoutChoice; busy: boolean; act: LayoutAct }>): ReactNode {
  const [name, setName] = useState<string>(choice.name);
  const noteId: string = useId();
  function rename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void act({ action: "rename", output, id: choice.id, name });
  }
  return (
    <li data-layout-row={choice.id}>
      <form className="ov-layout-row" onSubmit={rename}>
        <input
          aria-label={t("overlay.layout.nameOf", { name: choice.name })}
          required
          maxLength={LAYOUT_NAME_LENGTH}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || name.trim() === "" || name.trim() === choice.name}>
          {t("overlay.layout.rename")}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || choice.active}
          aria-describedby={choice.active ? noteId : undefined}
          onClick={() => void act({ action: "delete", output, id: choice.id })}
        >
          {t("overlay.layout.delete")}
        </button>
      </form>
      {choice.active && (
        <p className="muted ov-comp-note" id={noteId}>
          {t("overlay.layout.onStream")}
        </p>
      )}
    </li>
  );
}

/**
 * The layouts of the output that the editor shows: one list with the presets, the layouts of the streamer, and
 * "New layout…". A selected layout opens in the grid and goes on stream at once, as each other change does. There
 * is no separate step to pick a layout.
 */
export function LayoutPicker({
  output,
  layers,
  layouts,
  busy,
  act,
}: Readonly<{
  output: Orientation;
  /** The layers that the grid shows. */
  layers: OverlayLayers;
  layouts: OverlayLayouts;
  /** True while a layout action saves. */
  busy: boolean;
  act: LayoutAct;
}>): ReactNode {
  const labelId: string = useId();
  const [dialog, setDialog] = useState<"new" | "manage" | null>(null);
  const choices: LayoutChoice[] = layoutChoices(layouts, layers, output);
  const active: LayoutChoice | undefined = choices.find((choice: LayoutChoice): boolean => choice.active);
  const own: LayoutChoice[] = choices.filter(
    (choice: LayoutChoice): boolean => choice.preset === null && choice.id !== UNSAVED_LAYOUT,
  );
  function pick(id: string): void {
    if (id === NEW_LAYOUT) setDialog("new");
    else if (id !== active?.id) void act({ action: "select", output, id, keep: t("overlay.layout.keepName") });
  }
  return (
    <div className="ov-comp-bar ov-layout" data-layout-picker={output}>
      <span className="field-label" id={labelId}>
        {t("overlay.layout.label")}
      </span>
      <Select
        labelledBy={labelId}
        options={layoutOptions(choices)}
        value={active?.id}
        onValueChange={pick}
        disabled={busy}
        className="ov-layout-select"
      />
      <button type="button" disabled={busy} onClick={() => setDialog("new")} data-layout-save-as>
        <Icon name="copy" size={16} />
        {t("overlay.layout.saveAs")}
      </button>
      {active?.preset && active.changed && (
        <button type="button" disabled={busy} onClick={() => void act({ action: "reset", output })} data-layout-reset>
          <Icon name="reset" size={16} />
          {t("overlay.layout.reset")}
        </button>
      )}
      {own.length > 0 && (
        <button type="button" disabled={busy} onClick={() => setDialog("manage")} data-layout-manage>
          <Icon name="pencil" size={16} />
          {t("overlay.layout.manage")}
        </button>
      )}
      {dialog === "new" && <NewLayoutDialog output={output} busy={busy} act={act} onClose={() => setDialog(null)} />}
      <Dialog
        open={dialog === "manage"}
        onOpenChange={(open: boolean) => setDialog(open ? "manage" : null)}
        title={t("overlay.layout.manageTitle")}
      >
        <ul className="ov-layout-list" data-layout-list>
          {own.map((choice: LayoutChoice) => (
            <OwnLayoutRow key={`${choice.id}:${choice.name}`} output={output} choice={choice} busy={busy} act={act} />
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
