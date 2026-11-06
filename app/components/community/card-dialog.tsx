import { useId, useState, type FormEvent, type ReactNode } from "react";
import { CARD_ICONS } from "../../../db/enums";
import { t } from "../../i18n";
import type { CardIcon, CardTab, CommunityCard } from "../../types";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { Sheet } from "../ui/sheet";
import { CardContent } from "./card-view";
import { cardIcons, cardTabs } from "./cards";

const iconChoices: readonly (CardIcon | null)[] = [null, ...CARD_ICONS];

function IconPicker({
  value,
  onChange,
}: Readonly<{ value: CardIcon | null; onChange: (icon: CardIcon | null) => void }>): ReactNode {
  const id = useId();
  return (
    <fieldset className="icon-field">
      <legend>{t("community.form.icon")}</legend>
      <div className="icon-grid">
        {iconChoices.map((icon: CardIcon | null) => (
          <label key={icon ?? "none"} className="icon-choice" title={t(`community.icon.${icon ?? "none"}`)}>
            <input
              className="icon-choice-input"
              type="radio"
              name={`${id}-icon`}
              checked={value === icon}
              onChange={() => onChange(icon)}
            />
            {icon ? <Icon name={cardIcons[icon]} size={20} /> : <span aria-hidden="true">∅</span>}
            <span className="sr-only">{t(`community.icon.${icon ?? "none"}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Add card / Edit card: a live preview above the form. A new card starts without a button. */
export function CardDialog({
  card,
  onClose,
  onSave,
  onDelete,
}: Readonly<{
  card: CommunityCard | null;
  onClose: () => void;
  onSave: (card: CommunityCard) => Promise<void>;
  onDelete?: () => void;
}>): ReactNode {
  const id = useId();
  const editing = card !== null;
  const [draft, setDraft] = useState<CommunityCard>(
    card ?? { id: "new", icon: null, title: "", body: "", buttonLabel: null, buttonTarget: null },
  );
  const [showButton, setShowButton] = useState<boolean>(Boolean(card?.buttonLabel));
  const [label, setLabel] = useState<string>(card?.buttonLabel ?? t("community.form.learnMore"));
  const [target, setTarget] = useState<string>(
    card?.buttonTarget?.startsWith("https://") ? "external" : (card?.buttonTarget ?? "tab:topics"),
  );
  const [url, setUrl] = useState<string>(card?.buttonTarget?.startsWith("https://") ? card.buttonTarget : "");
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const result: CommunityCard = {
    ...draft,
    buttonLabel: showButton ? label.trim() || null : null,
    buttonTarget: showButton ? (target === "external" ? url.trim() : target) : null,
  };
  const destinations: SelectOption[] = [
    ...cardTabs.map((tab: CardTab) => ({ value: `tab:${tab}`, label: t(`community.tab.${tab}`) })),
    { value: "external", label: t("community.form.external") },
  ];

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await onSave(result);
    } catch (error_: unknown) {
      setError(error_ instanceof Error ? error_.message : t("common.failed"));
      setPending(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open: boolean) => !open && onClose()}
      title={editing ? t("community.editCard") : t("community.addCard")}
      name="card"
    >
      <div className="card-preview" aria-label={t("community.form.preview")}>
        <span className="eyebrow">{t("community.form.preview")}</span>
        <section className="info-card community-card">
          <CardContent
            card={{
              ...result,
              title: result.title || t("community.form.previewTitle"),
              body: result.body || t("community.form.previewBody"),
              buttonTarget: result.buttonTarget || (result.buttonLabel ? "https://example.com" : null),
            }}
          />
        </section>
      </div>
      <form className="card-form" onSubmit={(event) => void submit(event)}>
        <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
        <label>
          <span>{t("community.form.title")}</span>
          <input
            name="title"
            required
            maxLength={60}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>{t("community.form.text")}</span>
          <textarea
            name="body"
            required
            maxLength={280}
            rows={3}
            value={draft.body}
            aria-describedby={`${id}-count`}
            onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
          />
          <small className="char-count" id={`${id}-count`}>
            {draft.body.length} / 280
          </small>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            name="show"
            checked={showButton}
            onChange={(event) => setShowButton(event.currentTarget.checked)}
          />
          <span>{t("community.form.showButton")}</span>
        </label>
        {showButton && (
          <div className="button-fields">
            <label>
              <span>{t("community.form.buttonLabel")}</span>
              <input
                name="label"
                required
                maxLength={30}
                value={label}
                onChange={(event) => setLabel(event.currentTarget.value)}
              />
            </label>
            <div className="field">
              <span className="field-label" id={`${id}-dest`}>
                {t("community.form.goesTo")}
              </span>
              <Select
                id={`${id}-dest-select`}
                labelledBy={`${id}-dest`}
                options={destinations}
                value={target}
                onValueChange={setTarget}
              />
            </div>
            {target === "external" && (
              <label className="external-field">
                <span>{t("community.form.link")}</span>
                <input
                  type="url"
                  name="url"
                  required
                  pattern="https://.+"
                  placeholder="https://discord.gg/yourserver"
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                />
              </label>
            )}
          </div>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <DialogActions>
          {onDelete && (
            <button type="button" className="danger" onClick={onDelete}>
              <Icon name="trash" size={18} />
              {t("common.delete")}
            </button>
          )}
          <button className="gold" type="submit" disabled={pending}>
            {editing ? t("community.saveCard") : t("community.addCard")}
          </button>
        </DialogActions>
      </form>
    </Sheet>
  );
}
