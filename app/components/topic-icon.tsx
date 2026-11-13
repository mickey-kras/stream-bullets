import type { ReactNode } from "react";
import { t, type MessageId } from "../i18n";
import type { IconName } from "./ui/icon";
import { Icon } from "./ui/icon";

const icons: Record<string, IconName> = {
  "Tech & setups": "cat-tech",
  Gaming: "cat-gaming",
  Creative: "cat-creative",
  "Just chatting": "cat-chatting",
  feature: "idea",
  bug: "warning",
  design: "eye",
  a11y: "about",
  lang: "globe",
};

export function categoryIcon(category: string): IconName {
  return icons[category] ?? "cat-tech";
}

export function TopicIcon({ category }: Readonly<{ category: string }>): ReactNode {
  return <Icon name={categoryIcon(category)} size={24} />;
}

const TOPIC_CATEGORY_LABELS: Readonly<Record<string, MessageId>> = {
  "Tech & setups": "category.tech",
  Gaming: "category.gaming",
  Creative: "category.creative",
  "Just chatting": "category.chatting",
};

// Translate stored English category names.
export function topicCategoryLabel(category: string): string {
  const id: MessageId | undefined = TOPIC_CATEGORY_LABELS[category];
  return id ? t(id) : category;
}
