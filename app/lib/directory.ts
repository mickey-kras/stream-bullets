// Landing destination: /streamers?then=suggest|vote|discuss.
export const INTENTS = ["suggest", "vote", "discuss"] as const;
export type Intent = (typeof INTENTS)[number];

export function readIntent(value: string | null): Intent | null {
  return (INTENTS as readonly (string | null)[]).includes(value) ? (value as Intent) : null;
}

// Suggest intent opens the form or sign-in. Discuss opens the top topic's discussion.
export function streamerTarget(handle: string, intent: Intent | null, official: boolean = false): string {
  const base = `/@${handle}`;
  if (intent === "suggest") return `${base}?view=topics&intent=suggest`;
  if (intent === "vote") return `${base}?view=${official ? "topics" : "polls"}`;
  if (intent === "discuss") return `${base}?view=topics&sort=top&intent=discuss`;
  return base;
}

// Mast order: top left, bottom left, right.
export const SIGN_INTENTS: readonly Intent[] = ["suggest", "vote", "discuss"];

export function directoryHref(intent: Intent | null): string {
  return intent ? `/streamers?then=${intent}` : "/streamers";
}
