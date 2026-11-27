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
import { IconButton } from "../ui/icon-button";
import { Select, type SelectOption } from "../ui/select";

const PRESET_NAMES: Readonly<Record<PresetKey, MessageId>> = {
  chatting: "overlay.layout.preset.chatting",
  gameplay: "overlay.layout.preset.gameplay",
  vertical: "overlay.layout.preset.vertical",
};

/** The list value that opens the dialog for a new layout. It is not a layout. */
const NEW_LAYOUT = "new";
/** The list value that opens the dialog with the layouts of the streamer. It is not a layout. */
const MANAGE_LAYOUTS = "manage";

/** A layout that the streamer made and saved: it can get a new name, and it can go. */
function isOwn(choice: LayoutChoice): boolean {
  return choice.preset === null && choice.id !== UNSAVED_LAYOUT;
}

/** The name of a list entry, as the list and the messages show it. */
function choiceName(choice: LayoutChoice): string {
  if (choice.preset) {
    const name: string = t(PRESET_NAMES[choice.preset]);
    return t(choice.changed ? "overlay.layout.presetChanged" : "overlay.layout.presetMark", { name });
  }
  return choice.id === UNSAVED_LAYOUT ? t("overlay.layout.unsaved") : choice.name;
}

/**
 * The entries of the layout list of an output: the layouts, then "New layout…". With a layout of the streamer, the
 * last entry opens the dialog that renames and deletes those layouts.
 */
export function layoutOptions(choices: readonly LayoutChoice[]): SelectOption[] {
  const options: SelectOption[] = [
    ...choices.map((choice: LayoutChoice): SelectOption => ({ value: choice.id, label: choiceName(choice) })),
    { value: NEW_LAYOUT, label: t("overlay.layout.new"), icon: "plus" },
  ];
  if (choices.some(isOwn)) options.push({ value: MANAGE_LAYOUTS, label: t("overlay.layout.manage"), icon: "pencil" });
  return options;
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
 * The layouts of the output that the editor shows, in the toolbar of the studio. The list has the presets, the
 * layouts of the streamer, "New layout…" and, with a layout of the streamer, the entry that renames and deletes
 * them. A selected layout opens in the grid and goes on stream at once, as each other change does. At the right
 * edge are the icon buttons: save as a new layout, and the reset of a preset that the streamer changed. `children`
 * are the other tools of the toolbar: they come after these buttons.
 */
export function LayoutPicker({
  output,
  layers,
  layouts,
  busy,
  act,
  children,
}: Readonly<{
  output: Orientation;
  /** The layers that the grid shows. */
  layers: OverlayLayers;
  layouts: OverlayLayouts;
  /** True while a layout action saves. */
  busy: boolean;
  act: LayoutAct;
  children?: ReactNode;
}>): ReactNode {
  const labelId: string = useId();
  const [dialog, setDialog] = useState<"new" | "manage" | null>(null);
  const choices: LayoutChoice[] = layoutChoices(layouts, layers, output);
  const active: LayoutChoice | undefined = choices.find((choice: LayoutChoice): boolean => choice.active);
  const own: LayoutChoice[] = choices.filter(isOwn);
  function pick(id: string): void {
    if (id === NEW_LAYOUT) setDialog("new");
    else if (id === MANAGE_LAYOUTS) setDialog("manage");
    else if (id !== active?.id) void act({ action: "select", output, id, keep: t("overlay.layout.keepName") });
  }
  return (
    <div className="ov-layout" data-layout-picker={output}>
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
      <div className="ov-comp-tools" data-comp-tools>
        <IconButton
          label={t("overlay.layout.saveAs")}
          icon="save"
          disabled={busy}
          onClick={() => setDialog("new")}
          data-layout-save-as
        />
        {active?.preset && active.changed && (
          <IconButton
            label={t("overlay.layout.reset")}
            icon="reset"
            disabled={busy}
            onClick={() => void act({ action: "reset", output })}
            data-layout-reset
          />
        )}
        {children}
      </div>
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
