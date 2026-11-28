import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../db/enums";
import { MAX_TEXT_LENGTH, feedEventSchema, isSupport, type ActivityEvent, type ActivitySupport } from "./activity";
import { cut, type AlertSubject } from "./alerts";
import { onAnyOutput, type OverlayLayers } from "./overlay-layers";

/**
 * The topic credit (issue #1043): when the owner features a topic on stream, its author gets a support event of the
 * kind `topic`. The event goes through the ingest object of the page as each support event does: one time for each
 * feature, into the support snapshot and the activity rows, and to the alert of the `topic` rule. This module is
 * pure: the feature transition, the event, and the internal operation that the API sends to the object.
 */

/** The longest display name of a supporter in a support event (activity.ts). */
const NAME_LENGTH = 100;

/** The ID of a topic credit: the topic, and the revision of the overlay that put it on stream. */
const CREDIT_ID = /^direct:topic:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\d{1,16}$/;

/**
 * The topic that a layer change features, or null. A topic is featured when the topic layer is on stream in an
 * output with a topic, and before the change the layer was not on stream with that topic. Thus a change that keeps
 * the same topic on stream, a change that takes the layer off stream, and a change of each other layer feature
 * nothing.
 */
export function featuredTopic(before: OverlayLayers, after: OverlayLayers): string | null {
  const ref: string | null = after.items.topic.ref;
  if (ref === null || !onAnyOutput(after, "topic")) return null;
  const shown: boolean = onAnyOutput(before, "topic") && before.items.topic.ref === ref;
  return shown ? null : ref;
}

/** The delivery ID of the credit of one feature. A second feature of the same topic has a new revision. */
export function topicDeliveryId(entryId: string, revision: number): string {
  return `topic:${entryId}:${revision}`;
}

/** The topic of a topic credit, from the ID of its event, or null for the ID of a different event. */
export function creditedTopic(eventId: string): string | null {
  return CREDIT_ID.exec(eventId)?.[1] ?? null;
}

/** The author of a topic, as a participant of StreamBullets: the user ID and the display name. */
export interface TopicAuthor {
  id: string;
  name: string;
}

/**
 * The support event of a topic credit at the server time `now`. The sender is the author as a user of StreamBullets,
 * never a platform identity. The text is the title of the topic. The event is live: it counts and plays one time.
 */
export function topicSupport(
  entryId: string,
  revision: number,
  title: string,
  author: TopicAuthor,
  now: number,
): ActivitySupport {
  const deliveryId: string = topicDeliveryId(entryId, revision);
  return {
    kind: "topic",
    id: `direct:${deliveryId}`,
    platform: "direct",
    deliveryId,
    sender: { id: author.id, displayName: cut(author.name, NAME_LENGTH) },
    anonymous: false,
    amount: null,
    currency: null,
    text: cut(title, MAX_TEXT_LENGTH),
    receivedAt: now,
    replay: false,
  };
}

/** True for the live support event of a topic credit. */
function isCredit(event: ActivityEvent): event is ActivitySupport {
  return isSupport(event) && event.kind === "topic" && !event.replay && creditedTopic(event.id) !== null;
}

/**
 * The participant whose character reacts to a topic credit: the Twitch account that the author signed in with.
 * Only the API reads it, and only the alert host uses it, in memory: no message to a page and no storage has it.
 */
const subjectSchema: z.ZodType<AlertSubject> = z
  .object({ platform: z.enum(CHANNEL_PLATFORMS), userId: z.string().min(1).max(128) })
  .strict();

const creditEventSchema: z.ZodType<ActivitySupport> = feedEventSchema.transform(
  (event: ActivityEvent, context: z.RefinementCtx): ActivitySupport => {
    if (isCredit(event)) return event;
    context.addIssue({ code: "custom", message: "Not a topic credit" });
    return z.NEVER;
  },
);

/**
 * The internal operations of a topic credit, on the object path `/alert-credit`. Only the API sends them: the routes
 * of the owner and of the dock never forward them. `credit` takes in the event of a feature. `replay` plays the alert
 * of a topic credit that the object still keeps. Each one has the subject that the API read just now, or null when
 * the author has no linked account.
 */
export const alertCreditSchema = z.union([
  z.object({ op: z.literal("credit"), event: creditEventSchema, subject: subjectSchema.nullable() }).strict(),
  z.object({ op: z.literal("replay"), id: z.string().regex(CREDIT_ID), subject: subjectSchema.nullable() }).strict(),
]);
export type AlertCredit = z.infer<typeof alertCreditSchema>;
