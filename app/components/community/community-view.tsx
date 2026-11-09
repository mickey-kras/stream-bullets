import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { MAX_COMMUNITY_CARDS } from "../../../db/enums";
import { t } from "../../i18n";
import type { CommunityCard, SupportSettings } from "../../types";
import { sendJson } from "../api";
import { EmptyState } from "../common";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { CardDialog } from "./card-dialog";
import { CardContent } from "./card-view";
import { cardInput, defaultCards } from "./cards";

function supportCard(name: string): CommunityCard {
  const first = name.split(" ")[0];
  return {
    id: "support",
    icon: "heart",
    title: t("community.supportTitle", { name: first }),
    body: t("community.supportBody"),
    buttonLabel: t("community.supportTitle", { name: first }),
    buttonTarget: "tab:about#sec-support",
  };
}

function CardTools({
  card,
  index,
  count,
  onMove,
  onEdit,
  onDelete,
  onDragStart,
}: Readonly<{
  card: CommunityCard;
  index: number;
  count: number;
  onMove: (direction: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: () => void;
}>): ReactNode {
  return (
    <fieldset className="card-tools">
      <legend className="sr-only">{t("community.cardOf", { n: index + 1, count, title: card.title })}</legend>
      <span
        className="drag-handle"
        draggable
        title={t("community.drag")}
        aria-hidden="true"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", card.id);
          onDragStart();
        }}
      >
        <Icon name="grip" size={18} />
      </span>
      <IconButton
        label={t("community.moveUp", { title: card.title })}
        icon="up"
        iconSize={18}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <IconButton
        label={t("community.moveDown", { title: card.title })}
        icon="down"
        iconSize={18}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      />
      <button
        type="button"
        className="small-button"
        aria-label={t("community.editNamed", { title: card.title })}
        onClick={onEdit}
      >
        <Icon name="pencil" size={16} />
        {t("common.edit")}
      </button>
      <button
        type="button"
        className="small-button"
        aria-label={t("community.deleteNamed", { title: card.title })}
        onClick={onDelete}
      >
        <Icon name="trash" size={16} />
        {t("common.delete")}
      </button>
    </fieldset>
  );
}

/**
 * The Community tab (item 24). Viewers see the owner's cards (or the two defaults until the first save, R18) and an
 * optional Support card. The owner adds, edits, deletes and reorders (drag, or the up and down buttons) up to 8 cards;
 * every change saves the whole list.
 */
export function CommunityView({
  name,
  cards: saved,
  support,
  owner,
  writable,
  adding,
  onAdding,
  onChanged,
}: Readonly<{
  name: string;
  cards: CommunityCard[] | null;
  support: SupportSettings;
  owner: boolean;
  writable: boolean;
  adding: boolean;
  onAdding: (open: boolean) => void;
  onChanged: () => Promise<void>;
}>): ReactNode {
  const toast = useToast();
  const [cards, setCards] = useState<CommunityCard[]>(saved ?? defaultCards());
  const [previous, setPrevious] = useState<CommunityCard[] | null>(saved);
  const [preview, setPreview] = useState<boolean>(false);
  const [editing, setEditing] = useState<CommunityCard | null>(null);
  const [deleting, setDeleting] = useState<CommunityCard | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");
  const dragged = useRef<string | null>(null);
  if (previous !== saved) {
    setPrevious(saved);
    setCards(saved ?? defaultCards());
  }
  const editable = owner && writable && !preview;
  const shown = [...cards, ...(support.card && support.visible && support.links.length > 0 ? [supportCard(name)] : [])];

  async function save(next: CommunityCard[], message?: string): Promise<void> {
    const before = cards;
    setCards(next);
    try {
      await sendJson("PUT", "/api/community-cards", { cards: next.map(cardInput) });
      if (message) toast(message);
      await onChanged();
    } catch (error_: unknown) {
      setCards(before);
      throw error_;
    }
  }

  function move(index: number, direction: number): void {
    const target = index + direction;
    if (target < 0 || target >= cards.length) return;
    const next = [...cards];
    const [card] = next.splice(index, 1);
    next.splice(target, 0, card);
    setAnnouncement(t("community.moved", { title: card.title, n: target + 1, count: next.length }));
    save(next).catch((error_: unknown) =>
      toast(error_ instanceof Error ? error_.message : t("common.failed"), { tone: "error" }),
    );
  }

  function remove(card: CommunityCard): void {
    const before = cards;
    setDeleting(null);
    setEditing(null);
    save(cards.filter((value: CommunityCard) => value.id !== card.id))
      .then(() =>
        toast(t("community.deleted", { title: card.title }), {
          action: { label: t("common.undo"), onClick: () => void save(before, t("community.restored")) },
        }),
      )
      .catch((error_: unknown) =>
        toast(error_ instanceof Error ? error_.message : t("common.failed"), { tone: "error" }),
      );
  }

  return (
    <>
      <span className="eyebrow">{t("community.eyebrow")}</span>
      <h1>{t("community.title", { name })}</h1>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {owner && writable && (
        <div className="community-mode">
          <button type="button" className="small-button" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            <Icon name={preview ? "pencil" : "eye"} size={16} />
            {preview ? t("community.backToEditing") : t("community.preview")}
          </button>
          {preview && <span className="muted">{t("community.previewNote")}</span>}
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState
          title={t("community.emptyTitle")}
          icon="community"
          action={
            <Link className="button-link gold" to="?view=topics">
              <Icon name="topics" size={18} />
              {t("schedule.exploreTopics")}
            </Link>
          }
        >
          {t("community.emptyBody", { name })}
        </EmptyState>
      ) : (
        <div className={`community-grid${editable ? " is-editing" : ""}`}>
          {shown.map((card: CommunityCard, index: number) => (
            <section
              key={card.id}
              className="info-card community-card"
              data-card={card.id}
              role="region"
              aria-label={card.title}
              onDragOver={(event) => {
                if (editable && dragged.current) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = cards.findIndex((value: CommunityCard) => value.id === dragged.current);
                dragged.current = null;
                if (from >= 0 && index < cards.length && from !== index) move(from, index - from);
              }}
            >
              {editable && card.id !== "support" && (
                <CardTools
                  card={card}
                  index={index}
                  count={cards.length}
                  onMove={(direction: number) => move(index, direction)}
                  onEdit={() => setEditing(card)}
                  onDelete={() => setDeleting(card)}
                  onDragStart={() => {
                    dragged.current = card.id;
                  }}
                />
              )}
              <CardContent card={card} />
            </section>
          ))}
          {editable && cards.length < MAX_COMMUNITY_CARDS && (
            <button type="button" className="add-card-tile" onClick={() => onAdding(true)}>
              <Icon name="plus" size={24} />
              {t("community.addCard")}
              <small>{t("community.count", { count: cards.length, max: MAX_COMMUNITY_CARDS })}</small>
            </button>
          )}
        </div>
      )}
      {(adding || editing) && (
        <CardDialog
          card={editing}
          onClose={() => {
            setEditing(null);
            onAdding(false);
          }}
          onDelete={editing ? () => setDeleting(editing) : undefined}
          onSave={async (card: CommunityCard) => {
            const next = editing
              ? cards.map((value: CommunityCard) => (value.id === editing.id ? card : value))
              : [...cards, { ...card, id: crypto.randomUUID() }];
            await save(next, t(editing ? "community.saved" : "community.added"));
            setEditing(null);
            onAdding(false);
          }}
        />
      )}
      <Sheet
        open={deleting !== null}
        onOpenChange={(open: boolean) => !open && setDeleting(null)}
        title={t("community.deleteTitle", { title: deleting?.title ?? "" })}
        name="card-delete"
        short
      >
        <p>{t("community.deleteBody")}</p>
        <DialogActions>
          <button type="button" className="danger" onClick={() => deleting && remove(deleting)}>
            {t("community.deleteCard")}
          </button>
        </DialogActions>
      </Sheet>
    </>
  );
}
