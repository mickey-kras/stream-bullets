import { BUG_TEMPLATES } from "./bug-templates";
import type { EntryStatus } from "../types";

export const TOPIC_CATEGORIES = ["Tech & setups", "Gaming", "Creative", "Just chatting"] as const;

// Official Ideas board categories stored in entries.category.
export const IDEA_CATEGORIES = ["feature", "bug", "design", "a11y", "lang"] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];

// Reject unchanged bug-report templates.
export const BUG_TEMPLATE = BUG_TEMPLATES.en;

// Empty or unchanged template, ignoring whitespace.
export function isUntouchedTemplate(body: string): boolean {
  const value = body.trim();
  return value === "" || Object.values(BUG_TEMPLATES).some((template: string): boolean => value === template.trim());
}

export const NEW_IDEA_STATUS: EntryStatus = "review";
