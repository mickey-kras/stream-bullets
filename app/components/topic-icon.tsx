import type { ReactNode } from "react";
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

/** The icon for a topic category or an Ideas board category. */
export function categoryIcon(category: string): IconName {
  return icons[category] ?? "cat-tech";
}

export function TopicIcon({ category }: Readonly<{ category: string }>): ReactNode {
  return <Icon name={categoryIcon(category)} size={24} />;
}
