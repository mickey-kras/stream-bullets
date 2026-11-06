import { useId, useState, type FormEvent, type ReactNode } from "react";
import { MAX_SUPPORT_LINKS, SUPPORT_LINK_KINDS } from "../../../db/enums";
import { t } from "../../i18n";
import { isAllowedSupportLink, SUPPORT_PROVIDERS, supportLabel } from "../../lib/support";
import type { SupportLink, SupportLinkKind, SupportSettings } from "../../types";
import { errorMessage, sendJson } from "../api";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Select, type SelectOption } from "../ui/select";
import { Sheet } from "../ui/sheet";

/** "Support {name}" in About (item 34): up to four link-outs. StreamBullets never handles the payment. */
export function SupportSection({ name, support }: Readonly<{ name: string; support: SupportSettings }>): ReactNode {
  if (!support.visible || support.links.length === 0) return null;
  return (
    <section className="info-card support-section" id="sec-support" aria-labelledby="support-title">
      <h2 id="support-title">
        <Icon name="heart" size={24} />
        {t("support.title", { name: name.split(" ")[0] })}
      </h2>
      <div className="support-buttons">
        {support.links.map((link: SupportLink) => (
          <a
            key={link.id}
            className="button-link support-link"
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name={SUPPORT_PROVIDERS[link.kind].icon} size={18} />
            {supportLabel(link)}
            <Icon name="external" size={16} />
            <span className="sr-only"> {t("common.newTab")}</span>
          </a>
        ))}
      </div>
      <p className="muted support-fine">{t("support.fine")}</p>
    </section>
  );
}

type Row = Omit<SupportLink, "id"> & { key: string };

function rowError(row: Row, index: number): string {
  if (!isAllowedSupportLink(row.kind, row.url.trim()))
    return row.kind === "other"
      ? t("support.errorOther", { n: index + 1 })
      : t("support.errorDomain", { n: index + 1, provider: SUPPORT_PROVIDERS[row.kind].label });
  if (row.kind === "other" && !row.label?.trim()) return t("support.errorLabel", { n: index + 1 });
  return "";
}

const providerOptions: SelectOption[] = SUPPORT_LINK_KINDS.map((kind: SupportLinkKind) => ({
  value: kind,
  label: SUPPORT_PROVIDERS[kind].label,
  icon: SUPPORT_PROVIDERS[kind].icon,
}));

function LinkRow({
  row,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: Readonly<{
  row: Row;
  index: number;
  count: number;
  onChange: (row: Row) => void;
  onMove: (direction: number) => void;
  onRemove: () => void;
}>): ReactNode {
  const id = useId();
  return (
    <li className="support-row">
      <div className="support-row-top">
        <span className="sr-only" id={`${id}-kind`}>
          {t("support.provider", { n: index + 1 })}
        </span>
        <Select
          id={`${id}-kind-select`}
          labelledBy={`${id}-kind`}
          options={providerOptions}
          value={row.kind}
          onValueChange={(kind: string) => onChange({ ...row, kind: kind as SupportLinkKind })}
        />
      </div>
      {row.kind === "other" && (
        <label>
          <span>{t("support.buttonLabel")}</span>
          <input
            maxLength={30}
            required
            value={row.label ?? ""}
            placeholder={t("support.labelPlaceholder")}
            onChange={(event) => onChange({ ...row, label: event.currentTarget.value })}
          />
        </label>
      )}
      <div className="support-row-link">
        <label>
          <span>{t("support.link", { n: index + 1 })}</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            value={row.url}
            placeholder="https://"
            onChange={(event) => onChange({ ...row, url: event.currentTarget.value })}
          />
        </label>
        <div className="support-row-tools">
          <IconButton
            label={t("support.moveUp", { n: index + 1 })}
            icon="up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            label={t("support.moveDown", { n: index + 1 })}
            icon="down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton label={t("support.remove", { n: index + 1 })} icon="trash" iconSize={18} onClick={onRemove} />
        </div>
      </div>
    </li>
  );
}

/**
 * The support links editor: up to 4 links, https only, each on its provider's own domain (checked again on the
 * server), plus whether they show in About and as a Community card. It saves on its own, so the Edit your page
 * dialog can include it as a section.
 */
export function SupportEditor({
  support,
  onSaved,
}: Readonly<{ support: SupportSettings; onSaved: (support: SupportSettings) => void }>): ReactNode {
  const [rows, setRows] = useState<Row[]>(support.links.map((link: SupportLink) => ({ ...link, key: link.id })));
  const [visible, setVisible] = useState<boolean>(support.visible);
  const [card, setCard] = useState<boolean>(support.card);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);

  function move(index: number, direction: number): void {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + direction, 0, row);
    setRows(next);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const problem = rows.map(rowError).find(Boolean);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError("");
    try {
      const links = rows.map((row: Row) => ({
        kind: row.kind,
        label: row.kind === "other" ? row.label?.trim() || null : null,
        url: row.url.trim(),
      }));
      onSaved(await sendJson<SupportSettings>("PUT", "/api/support-links", { links, visible, card }));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <fieldset className="support-editor" id="sec-support-editor">
        <legend>{t("support.editorTitle")}</legend>
        <p className="muted">{t("support.editorHint")}</p>
        <ol className="support-rows">
          {rows.map((row: Row, index: number) => (
            <LinkRow
              key={row.key}
              row={row}
              index={index}
              count={rows.length}
              onChange={(next: Row) => setRows(rows.map((value: Row, i: number) => (i === index ? next : value)))}
              onMove={(direction: number) => move(index, direction)}
              onRemove={() => setRows(rows.filter((_: Row, i: number) => i !== index))}
            />
          ))}
        </ol>
        {rows.length < MAX_SUPPORT_LINKS ? (
          <button
            type="button"
            className="small-button"
            onClick={() => setRows([...rows, { key: crypto.randomUUID(), kind: "kofi", label: null, url: "" }])}
          >
            <Icon name="plus" size={16} />
            {t("support.add")}
          </button>
        ) : (
          <p className="muted">{t("support.max")}</p>
        )}
        <label className="choice">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.currentTarget.checked)} />
          <span>{t("support.showAbout")}</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={card} onChange={(event) => setCard(event.currentTarget.checked)} />
          <span>{t("support.showCard")}</span>
        </label>
      </fieldset>
      <p className="form-error" role="alert">
        {error}
      </p>
      <DialogActions>
        <button className="gold" type="submit" disabled={pending}>
          {pending ? t("common.saving") : t("support.save")}
        </button>
      </DialogActions>
    </form>
  );
}

/** The owner's way into the editor from About, until the Edit your page dialog carries it. */
export function SupportEditorSheet({
  open,
  support,
  onOpenChange,
  onSaved,
}: Readonly<{
  open: boolean;
  support: SupportSettings;
  onOpenChange: (open: boolean) => void;
  onSaved: (support: SupportSettings) => void;
}>): ReactNode {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("support.editorTitle")} name="support">
      <SupportEditor support={support} onSaved={onSaved} />
    </Sheet>
  );
}
