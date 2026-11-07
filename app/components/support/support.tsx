import { useId, useState, type ReactNode } from "react";
import { MAX_SUPPORT_LINKS, SUPPORT_LINK_KINDS } from "../../../db/enums";
import { t } from "../../i18n";
import { isAllowedSupportLink, providerLabel, SUPPORT_PROVIDERS, supportLabel } from "../../lib/support";
import type { SupportLink, SupportLinkKind, SupportSettings } from "../../types";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Select, type SelectOption } from "../ui/select";

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

export type Row = Omit<SupportLink, "id"> & { key: string };

function rowError(row: Row, index: number): string {
  if (!isAllowedSupportLink(row.kind, row.url.trim()))
    return row.kind === "other"
      ? t("support.errorOther", { n: index + 1 })
      : t("support.errorDomain", { n: index + 1, provider: providerLabel(row.kind) });
  if (row.kind === "other" && !row.label?.trim()) return t("support.errorLabel", { n: index + 1 });
  return "";
}

const providerOptions: SelectOption[] = SUPPORT_LINK_KINDS.map((kind: SupportLinkKind) => ({
  value: kind,
  label: providerLabel(kind),
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

/** The editor's working copy of the support settings. */
export interface SupportDraft {
  rows: Row[];
  visible: boolean;
  card: boolean;
  setRows: (rows: Row[]) => void;
  setVisible: (visible: boolean) => void;
  setCard: (card: boolean) => void;
}

export function useSupportDraft(support: SupportSettings): SupportDraft {
  const [rows, setRows] = useState<Row[]>(support.links.map((link: SupportLink) => ({ ...link, key: link.id })));
  const [visible, setVisible] = useState<boolean>(support.visible);
  const [card, setCard] = useState<boolean>(support.card);
  return { rows, visible, card, setRows, setVisible, setCard };
}

/** The `PUT /api/support-links` body for a draft. */
export function supportPayload(draft: SupportDraft): {
  links: { kind: SupportLinkKind; label: string | null; url: string }[];
  visible: boolean;
  card: boolean;
} {
  const links = draft.rows.map((row: Row) => ({
    kind: row.kind,
    label: row.kind === "other" ? row.label?.trim() || null : null,
    url: row.url.trim(),
  }));
  return { links, visible: draft.visible, card: draft.card };
}

/** The first problem in a draft, or an empty string. The server checks the same rules again. */
export function supportDraftError(draft: SupportDraft): string {
  return draft.rows.map(rowError).find(Boolean) ?? "";
}

/** Whether a draft differs from the saved settings. */
export function supportChanged(draft: SupportDraft, support: SupportSettings): boolean {
  const saved = JSON.stringify({
    links: support.links.map(({ kind, label, url }) => ({ kind, label: kind === "other" ? label : null, url })),
    visible: support.visible,
    card: support.card,
  });
  return JSON.stringify(supportPayload(draft)) !== saved;
}

/**
 * The Support links section of Edit your page (item 34): up to 4 links, https only, each on its provider's own
 * domain (checked again on the server), plus whether they show in About and as a Community card.
 */
export function SupportFields({ draft }: Readonly<{ draft: SupportDraft }>): ReactNode {
  const { rows, setRows } = draft;

  function move(index: number, direction: number): void {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(index + direction, 0, row);
    setRows(next);
  }

  return (
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
        <input
          type="checkbox"
          checked={draft.visible}
          onChange={(event) => draft.setVisible(event.currentTarget.checked)}
        />
        <span>{t("support.showAbout")}</span>
      </label>
      <label className="choice">
        <input type="checkbox" checked={draft.card} onChange={(event) => draft.setCard(event.currentTarget.checked)} />
        <span>{t("support.showCard")}</span>
      </label>
    </fieldset>
  );
}
