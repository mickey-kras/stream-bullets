import type { AppEnv } from "../env";
import {
  ALERT_REFUSALS,
  alertRefusal,
  alertsReplySchema,
  type AlertControl,
  type AlertRefusal,
  type AlertsReply,
} from "../lib/alert-control";
import { assertStreamerWritable } from "./access.server";
import { activityAvailable } from "./channel-tokens.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { callIngest } from "./ingest-call.server";

/** What the API tells the owner for each refusal of the alert host. The code goes with it, for a client's own text. */
const REFUSAL_TEXT: Readonly<Record<AlertRefusal, string>> = {
  alerts_off_stream: "Put the alerts layer on stream first.",
  alert_gone: "This event is too old for a replay.",
  alerts_muted: "Alerts are muted. Turn the mute off first.",
  alerts_unwatched: "No page shows alerts now. Open the overlay in OBS first.",
  alert_rule_off: "The rule of this alert has each switch off. Turn one switch on first.",
  alerts_full: "Too many alerts wait. Try again after some of them played.",
  alerts_unavailable: "Alerts are not available. Try again.",
};

/**
 * Sends one control of the alerts to the alert host of a page and gives its answer. `ownerId` is the owner of the
 * page: the caller checked the session of the owner or the dock key. A test and a replay use the write quota of
 * the owner. `status`, `mute`, and `skip` never do, so the owner can always read the state and stop the alerts.
 */
export async function controlAlerts(
  env: AppEnv,
  streamerId: string,
  ownerId: string,
  control: AlertControl,
): Promise<AlertsReply> {
  await assertStreamerWritable(env, streamerId, ownerId);
  if (!activityAvailable(env)) throw new HttpError(503, "Alerts are off on this server.");
  if (control.op === "test" || control.op === "replay") await consumeMutationQuota(env, ownerId);
  const response: Response = await callIngest(env, streamerId, "alerts", {
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(control) },
  });
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    const refusal: AlertRefusal = alertRefusal(body) ?? "alerts_unavailable";
    throw new HttpError(ALERT_REFUSALS[refusal], REFUSAL_TEXT[refusal], refusal);
  }
  const reply = alertsReplySchema.safeParse(body);
  if (!reply.success) throw new Error("alerts state invalid");
  return reply.data;
}
