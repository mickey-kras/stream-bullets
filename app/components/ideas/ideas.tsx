import type { ReactNode } from "react";
import { Link } from "react-router";
import { ENTRY_STATUSES } from "../../../db/enums";
import { t } from "../../i18n";
import { IDEA_CATEGORIES, type IdeaCategory } from "../../lib/ideas";
import type { Entry, EntryStatus } from "../../types";
import { categoryIcon } from "../topic-icon";
import { Icon, type IconName } from "../ui/icon";

export const statusIcons: Record<EntryStatus, IconName> = {
  review: "pending",
  planned: "schedule",
  progress: "timer",
  shipped: "success",
  declined: "close",
};

export function statusLabel(status: EntryStatus): string {
  return t(`ideas.status.${status}`);
}

export function categoryLabel(category: string): string {
  return (IDEA_CATEGORIES as readonly string[]).includes(category)
    ? t(`ideas.category.${category as IdeaCategory}`)
    : category;
}

/** "Under review", "Planned"… always an icon and a word, never colour alone. */
export function IdeaStatus({ status }: Readonly<{ status: EntryStatus | null }>): ReactNode {
  if (!status) return null;
  return (
    <span className={`idea-status st-${status}`}>
      <Icon name={statusIcons[status]} size={16} />
      <span>{statusLabel(status)}</span>
    </span>
  );
}

/** The status filters above the list. "Shipped" doubles as the changelog. */
export function IdeaFilters({ current }: Readonly<{ current: EntryStatus | null }>): ReactNode {
  return (
    <>
      <nav className="filter-chips" aria-label={t("ideas.filterLabel")}>
        <Link className="filter-chip" to="?view=topics" aria-current={current === null ? "true" : undefined}>
          {t("ideas.all")}
        </Link>
        {ENTRY_STATUSES.map((status: EntryStatus) => (
          <Link
            key={status}
            className="filter-chip"
            to={`?view=topics&status=${status}`}
            aria-current={current === status ? "true" : undefined}
          >
            <Icon name={statusIcons[status]} size={16} />
            {statusLabel(status)}
          </Link>
        ))}
      </nav>
      {current === "shipped" && (
        <p className="changelog-note">
          <Icon name="success" size={18} />
          {t("ideas.changelog")}
        </p>
      )}
    </>
  );
}

/** Why an idea is not planned, or when it shipped. */
export function IdeaOutcome({ entry }: Readonly<{ entry: Entry }>): ReactNode {
  if (entry.status === "declined" && entry.statusReason)
    return (
      <p className="idea-reason">
        <Icon name="about" size={18} />
        <span>
          <strong>{t("ideas.whyNot")}</strong> {entry.statusReason}
        </span>
      </p>
    );
  if (entry.status === "shipped")
    return (
      <p className="idea-reason shipped">
        <Icon name="success" size={18} />
        <span>{t("ideas.shipped")}</span>
      </p>
    );
  return null;
}

export function IdeaCategoryTag({ category }: Readonly<{ category: string }>): ReactNode {
  return (
    <span className="category">
      <Icon name={categoryIcon(category)} size={24} />
      {categoryLabel(category)}
    </span>
  );
}
