import type { ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import type { CardTab, CommunityCard } from "../../types";
import { Icon } from "../ui/icon";
import { cardIcons, tabIcons } from "./cards";

// Buttons target a local tab or HTTPS URL in a new tab.
function CardButton({ card }: Readonly<{ card: CommunityCard }>): ReactNode {
  if (!card.buttonLabel || !card.buttonTarget) return null;
  if (card.buttonTarget.startsWith("tab:")) {
    const [tab, anchor] = card.buttonTarget.slice(4).split("#") as [CardTab, string | undefined];
    const fragment: string = anchor ? `#${anchor}` : "";
    return (
      <Link className="button-link gold" to={`?view=${tab}${fragment}`}>
        <Icon name={anchor ? "heart" : tabIcons[tab]} size={18} />
        {card.buttonLabel}
      </Link>
    );
  }
  return (
    <a className="button-link gold" href={card.buttonTarget} target="_blank" rel="noopener noreferrer">
      {card.buttonLabel}
      <Icon name="external" size={18} />
      <span className="sr-only"> {t("common.newTab")}</span>
    </a>
  );
}

export function CardContent({ card }: Readonly<{ card: CommunityCard }>): ReactNode {
  return (
    <>
      <h2>
        {card.icon && (
          <span className="card-icon">
            <Icon name={cardIcons[card.icon]} size={18} />
          </span>
        )}
        {card.title}
      </h2>
      <p>{card.body}</p>
      <CardButton card={card} />
    </>
  );
}
