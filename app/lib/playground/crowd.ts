import type { ActivityPlatform } from "../activity";
import {
  COMMAND_COOLDOWN_TICKS,
  RANKED_SLOTS,
  ROTATING_SLOTS,
  SCORE_COOLDOWN_TICKS,
  SCORE_DECAY_TICKS,
} from "./constants";
import type { CharState } from "./protocol";

/**
 * The participant registry and the choice of who is visible. A participant is `platform:userId`; display names are
 * never identities. The choice gives RANKED_SLOTS to the highest decayed scores and ROTATING_SLOTS to the other
 * active participants in turn, in registration order. A participant has at most one slot. Repeated messages do not move a participant forward: the score rises at most once per
 * SCORE_COOLDOWN_TICKS and the rotation order is fixed.
 */

export const COMMANDS = ["jump", "dig", "build", "wave", "boom"] as const;
export type Command = (typeof COMMANDS)[number];

interface PendingCommand {
  name: Command;
  /** The command is dropped after this tick. */
  expires: number;
  /** `platform:messageId` of the message, so a delete drops it. */
  key: string;
}

interface PendingText {
  text: string;
  expires: number;
  key: string;
}

export interface Bubble {
  text: string;
  ticks: number;
  key: string;
  /** The tick at which it showed: frames list bubbles oldest first. */
  at: number;
}

export interface Participant {
  /** `platform:userId`. */
  key: string;
  /** Short id for frames. Never a platform id. */
  id: number;
  platform: ActivityPlatform;
  userId: string;
  name: string;
  score: number;
  scoreAt: number;
  lastScored: number;
  lastChat: number;
  lastCommand: number;
  /** Removed by the owner: never admitted again until a reset or registry expiry. */
  removed: boolean;
  /** Holds a visible slot (entrance, exit and respawn included). */
  admitted: boolean;
  admittedAt: number;
  /** Chosen for a slot in the latest choice. */
  eligible: boolean;
  slot: "ranked" | "rotating";
  pending: PendingCommand | null;
  pendingText: PendingText | null;
  bubble: Bubble | null;
  /** Ticks left of the unavailable mark. */
  mark: number;
  /** Walking speed in logical px per tick. */
  speed: number;
  state: CharState | "away";
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: 1 | -1;
  /** Walking in from the entrance or out to the exit: walking limits and turns do not apply. */
  free: boolean;
  wait: number;
  /** The y where the latest jump or fall started. */
  fromY: number;
  target: number;
  after: CharState;
  exitReason: "timeout" | "capacity" | null;
  steps: number;
  bx: number;
  by: number;
}

export function newParticipant(
  key: string,
  id: number,
  platform: ActivityPlatform,
  userId: string,
  name: string,
  clock: number,
  speed: number,
): Participant {
  return {
    key,
    id,
    platform,
    userId,
    name,
    score: 0,
    scoreAt: clock,
    lastScored: clock - SCORE_COOLDOWN_TICKS,
    lastChat: clock,
    lastCommand: clock - COMMAND_COOLDOWN_TICKS,
    removed: false,
    admitted: false,
    admittedAt: 0,
    eligible: false,
    slot: "rotating",
    pending: null,
    pendingText: null,
    bubble: null,
    mark: 0,
    speed,
    state: "away",
    t: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    dir: 1,
    free: false,
    wait: 0,
    fromY: 0,
    target: 0,
    after: "walk",
    exitReason: null,
    steps: 0,
    bx: 0,
    by: 0,
  };
}

function decayedScore(participant: Participant, clock: number): number {
  return participant.score * Math.exp(-(clock - participant.scoreAt) / SCORE_DECAY_TICKS);
}

/** Adds 1 to the score unless the participant scored in the last SCORE_COOLDOWN_TICKS. */
export function addScore(participant: Participant, clock: number): void {
  if (clock - participant.lastScored < SCORE_COOLDOWN_TICKS) return;
  participant.score = decayedScore(participant, clock) + 1;
  participant.scoreAt = clock;
  participant.lastScored = clock;
}

/**
 * Chooses the participants for the visible slots and sets `eligible` and `slot` on every participant. Returns the
 * chosen ones in admission order: ranked, then rotating. `participants` is in registration order.
 */
export function chooseCrowd(
  participants: readonly Participant[],
  clock: number,
  timeoutTicks: number,
  rotation: number,
): Participant[] {
  const active: Participant[] = participants.filter(
    (p: Participant): boolean => !p.removed && clock - p.lastChat < timeoutTicks && p.score > 0,
  );
  // The sort is stable: equal scores keep registration order.
  const ranked: Participant[] = active
    .map((p: Participant): [Participant, number] => [p, decayedScore(p, clock)])
    .sort((a: [Participant, number], b: [Participant, number]): number => b[1] - a[1])
    .map((entry: [Participant, number]): Participant => entry[0]);
  const top = new Set<Participant>(ranked.slice(0, RANKED_SLOTS));
  const remaining: Participant[] = active.filter((p: Participant): boolean => !top.has(p));
  // When fewer than ROTATING_SLOTS remain, all of them are chosen: no slot stays empty while someone waits.
  const selected: Participant[] = [...top];
  for (let i = 0; i < Math.min(ROTATING_SLOTS, remaining.length); i++) {
    selected.push(remaining[(rotation + i) % remaining.length]);
  }
  const chosen = new Set<Participant>(selected);
  for (const p of participants) {
    p.eligible = chosen.has(p);
    p.slot = top.has(p) ? "ranked" : "rotating";
  }
  return selected;
}
