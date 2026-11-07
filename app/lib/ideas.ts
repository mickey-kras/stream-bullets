import type { EntryStatus } from "../types";

/** Topic categories on a normal streamer page. */
export const TOPIC_CATEGORIES = ["Tech & setups", "Gaming", "Creative", "Just chatting"] as const;

/** Categories on the official Ideas board (item 46). Stored in `entries.category`. */
export const IDEA_CATEGORIES = ["feature", "bug", "design", "a11y", "lang"] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];

/** Pre-filled Details for a bug report. Submitting it untouched is refused. */
export const BUG_TEMPLATE = "What happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n1. ";

/** True when the text is empty or still exactly the bug template (whitespace aside). */
export function isUntouchedTemplate(body: string): boolean {
  const value = body.trim();
  return value === "" || value === BUG_TEMPLATE.trim();
}

/** The status a new idea starts in. */
export const NEW_IDEA_STATUS: EntryStatus = "review";
