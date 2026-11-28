import { z } from "zod";
import type { ActivitySupport, SupportKind } from "./activity";

/**
 * The goal of a page: one count that goes up to a target (issue #1043). The goal layer holds the title, the thing
 * to count, and the target (app/lib/overlay-layers.ts). The server holds the progress and sends it on the activity
 * socket (app/lib/alerts.ts). This module is pure: it has the amounts and the count of one support event.
 */

/** The things that a goal can count. A goal counts one of them: Bits, KICKs, and a currency do not convert. */
export const GOAL_COUNTS = ["subs", "follows", "bits", "kicks", "chatters", "votes"] as const;
export type GoalCount = (typeof GOAL_COUNTS)[number];

/** The target of a goal: the one source for the layers, the editor and the overlay. */
export const GOAL_TARGET = { min: 1, max: 10_000_000, default: 25 } as const;
/** The longest title of a goal on stream, in characters. */
export const GOAL_TITLE_LENGTH = 60;

/** The count of a goal. `counts` tells what `value` is a count of: a goal that counts a different thing starts again. */
export interface GoalProgress {
  counts: GoalCount;
  value: number;
  /** The server time when the count started. An event from before this time does not count. */
  startedAt: number;
}

export const goalProgressSchema: z.ZodType<GoalProgress> = z.object({
  counts: z.enum(GOAL_COUNTS),
  value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startedAt: z.number().int().nonnegative(),
});

/**
 * How each goal counts the support kinds. `event` counts 1 for each event. `amount` counts the amount of the event:
 * the gifts in a bundle, the Bits, or the KICKs. A subscription and a membership count 1, not their months.
 * `chatters` and `votes` count no support event: the server counts people who chat, poll votes, and new topics.
 */
const COUNTED: Readonly<Record<GoalCount, Partial<Record<SupportKind, "event" | "amount">>>> = {
  subs: { subscription: "event", membership: "event", gift: "amount" },
  follows: { follow: "event" },
  bits: { bits: "amount" },
  kicks: { kicks: "amount" },
  chatters: {},
  votes: {},
};

/**
 * The amount that a support event adds to a goal that counts `counts`. It is 0 for a kind that the goal does not
 * count, and for a replay: a replay of the owner, a test, and the snapshot of a reconnect never count.
 */
export function goalAmount(counts: GoalCount, event: ActivitySupport): number {
  const how: "event" | "amount" | undefined = COUNTED[counts][event.kind];
  if (how === undefined || event.replay) return 0;
  return how === "event" ? 1 : (event.amount ?? 0);
}

/**
 * `progress` after a support event. An event from before the start of the count adds nothing: a provider can send
 * an old event again a long time after it occurred (`sentAt`). The caller refuses an event ID that it knows
 * (`acceptDelivery`), so an event counts one time.
 */
export function countSupport(progress: GoalProgress, event: ActivitySupport): GoalProgress {
  if ((event.sentAt ?? event.receivedAt) < progress.startedAt) return progress;
  const amount: number = goalAmount(progress.counts, event);
  if (amount === 0) return progress;
  return { ...progress, value: Math.min(Number.MAX_SAFE_INTEGER, progress.value + amount) };
}
