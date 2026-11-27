import { z } from "zod";
import { TEST_ALERTS, alertViewSchema, type AlertsState } from "./alerts";
import { goalProgressSchema } from "./goals";

/**
 * The controls of the alerts (issue #1043): what the owner sends with `POST /api/overlay/alerts` and the OBS dock
 * with `POST /api/dock/:handle/alerts`, the answer, and the reasons for a refusal. The alert host of the page runs
 * a control (app/server/alert-host.ts).
 */

/**
 * One control. `status` only reads. `test` plays a sample alert, the gift when it names no kind. `mute` stops the
 * alerts or lets them play again. `skip` ends the alert on stream. `replay` plays the alert of a support event that
 * the server still keeps: `id` is the ID of the event. `goalReset` starts the count of the goal again at 0.
 */
export const alertControlSchema = z.union([
  z.object({ op: z.enum(["status", "skip", "goalReset"]) }).strict(),
  z.object({ op: z.literal("test"), kind: z.enum(TEST_ALERTS).optional() }).strict(),
  z.object({ op: z.literal("mute"), on: z.boolean() }).strict(),
  z.object({ op: z.literal("replay"), id: z.string().min(1).max(160) }).strict(),
]);
export type AlertControl = z.infer<typeof alertControlSchema>;

/** The answer to each control: the state of the alerts at the server time `at`. */
export interface AlertsReply extends AlertsState {
  at: number;
}

export const alertsReplySchema: z.ZodType<AlertsReply> = z.object({
  at: z.number().int().nonnegative(),
  muted: z.boolean(),
  current: alertViewSchema.nullable(),
  waiting: z.number().int().nonnegative(),
  goal: goalProgressSchema.nullable(),
});

/**
 * Why the alert host refuses a control, with the HTTP status of the answer. The code is stable: a client shows its
 * own text for it.
 */
export const ALERT_REFUSALS = {
  /** The alerts layer is not on stream in an output. */
  alerts_off_stream: 400,
  /** The goal layer has no place on the grid of an output, so the page counts no goal. */
  goal_off: 400,
  /** The event of a replay is not kept: the ID is not known, or the event is too old. */
  alert_gone: 404,
  /** The alerts are muted. */
  alerts_muted: 409,
  /** No page listens: no overlay page, Streamer tools, or dock is open. */
  alerts_unwatched: 409,
  /** The rule of the alert has its three switches off. */
  alert_rule_off: 409,
  /** The line of alerts is full. */
  alerts_full: 409,
  /** The host could not read the saved layers. */
  alerts_unavailable: 503,
} as const;
export type AlertRefusal = keyof typeof ALERT_REFUSALS;

function isRefusal(value: string): value is AlertRefusal {
  return Object.hasOwn(ALERT_REFUSALS, value);
}

/** The refusal in the answer of the alert host. Null: the answer has no refusal that this version knows. */
export function alertRefusal(body: unknown): AlertRefusal | null {
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return parsed.success && isRefusal(parsed.data.error) ? parsed.data.error : null;
}
