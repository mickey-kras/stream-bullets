import { CARD_TABS } from "../../../db/enums";
import { t } from "../../i18n";
import type { CardIcon, CardTab, CommunityCard } from "../../types";
import type { IconName } from "../ui/icon";

export const cardIcons: Record<CardIcon, IconName> = {
  chat: "comment",
  poll: "polls",
  calendar: "schedule",
  discord: "discord",
  heart: "heart",
  gift: "gift",
  star: "star",
  link: "link",
  mic: "mic",
  gamepad: "cat-gaming",
  palette: "palette",
  megaphone: "megaphone",
};

export const tabIcons: Record<CardTab, IconName> = {
  topics: "topics",
  polls: "polls",
  schedule: "schedule",
  about: "about",
  community: "community",
};

export const cardTabs: readonly CardTab[] = CARD_TABS;

// Two defaults until the owner's first save.
export function defaultCards(): CommunityCard[] {
  return [
    {
      id: "default-topics",
      icon: null,
      title: t("community.default.ideaTitle"),
      body: t("community.default.ideaBody"),
      buttonLabel: t("community.default.ideaButton"),
      buttonTarget: "tab:topics",
    },
    {
      id: "default-polls",
      icon: null,
      title: t("community.default.liveTitle"),
      body: t("community.default.liveBody"),
      buttonLabel: t("community.default.liveButton"),
      buttonTarget: "tab:polls",
    },
  ];
}

// PUT /api/community-cards body. IDs preserve overlay references.
export function cardInput(card: CommunityCard): CommunityCard {
  return {
    id: card.id,
    icon: card.icon,
    title: card.title,
    body: card.body,
    buttonLabel: card.buttonLabel,
    buttonTarget: card.buttonTarget,
  };
}
