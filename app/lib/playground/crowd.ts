import type { ActivityPlatform } from "../activity";
import {
  COMMAND_COOLDOWN_TICKS,
  PLATFORM_RESERVE_MIN,
  PLATFORM_RESERVE_SHARE,
  RANKED_SHARE,
  SCORE_COOLDOWN_TICKS,
  SCORE_DECAY_TICKS,
} from "./constants";
import type { CharState } from "./protocol";

/**
 * The participant registry and the choice of who is visible. A participant is `platform:userId`; display names are
 * never identities. The choice first keeps places for each platform (see platformReserve), then gives the ranked
 * slots to the highest decayed scores and the rotating slots to the other active participants in turn, in
 * registration order (see crowdSlots). A participant has at most one slot. Repeated messages do not move a
 * participant forward: the score rises at most once per SCORE_COOLDOWN_TICKS and the rotation order is fixed.
 */

export const COMMANDS = [
  "left",
  "right",
  "look",
  "stop",
  "jump",
  "block",
  "up",
  "stairs",
  "bridge",
  "grapple",
  "jetpack",
  "dig",
  "boom",
  "dance",
  "wave",
  "cheer",
  "push",
  "flag",
] as const;
export type Command = (typeof COMMANDS)[number];

/** Other words for a command. `build` is the name that `stairs` had before. */
export const COMMAND_ALIASES: Readonly<Record<string, Command>> = {
  l: "left",
  r: "right",
  turn: "look",
  box: "block",
  crate: "block",
  pillar: "up",
  build: "stairs",
  hook: "grapple",
  jet: "jetpack",
  hi: "wave",
  shove: "push",
};

/** A command with its number (0 when the text has none) and its side (0 when the text has none). */
export interface CommandCall {
  name: Command;
  n: number;
  side: 1 | -1 | 0;
}

/** Work of more than one step that a character does: the kind, the steps left, and the cell it works on. */
export interface Job {
  kind: "block" | "up" | "stairs" | "bridge" | "dig" | "flag";
  left: number;
  /** A dig to this side, or 0 for a dig down. */
  side: 1 | -1 | 0;
  c: number;
  r: number;
  /** True when the job did a step: a later step that cannot be done ends the job without the unavailable mark. */
  done: boolean;
}

interface PendingCommand extends CommandCall {
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
  /** A viewer steered this character: after an action it stands still. Without it, the character walks around. */
  piloted: boolean;
  job: Job | null;
  /** The start, the end and the length in ticks of a climb, a zip or a jetpack flight. */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  span: number;
  /** A walk of some blocks took one more block, so it does not end on another character. */
  extra: boolean;
  /** The character fell off an edge in a walk of some blocks: the walk goes on after the landing. */
  resume: boolean;
  /** The hook point of a grapple and whether it holds, or null. */
  rope: { x: number; y: number; hit: boolean } | null;
  /** The frame id of the character that a push throws. */
  victim: number;
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
    piloted: false,
    job: null,
    sx: 0,
    sy: 0,
    tx: 0,
    ty: 0,
    span: 0,
    extra: false,
    resume: false,
    rope: null,
    victim: 0,
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

/** The split of `max` visible slots: RANKED_SHARE of them are ranked, rounded, and the others rotate. */
export function crowdSlots(max: number): { ranked: number; rotating: number } {
  const ranked: number = Math.round(max * RANKED_SHARE);
  return { ranked, rotating: max - ranked };
}

/** The slots that each platform with active participants keeps: PLATFORM_RESERVE_SHARE of `max`, at least PLATFORM_RESERVE_MIN. */
export function platformReserve(max: number): number {
  return Math.max(PLATFORM_RESERVE_MIN, Math.round(max * PLATFORM_RESERVE_SHARE));
}

/**
 * The participants that keep a place for their platform: the highest scores of each platform, at most
 * `platformReserve(max)` of each. `ranked` is in score order. The places come from the ranked slots. With fewer
 * ranked slots than places, each platform gets its first place before a platform gets a second one.
 */
function reserved(ranked: readonly Participant[], max: number, rankedSlots: number): Set<Participant> {
  const each: number = platformReserve(max);
  const platforms = new Map<ActivityPlatform, Participant[]>();
  for (const p of ranked) {
    const list: Participant[] = platforms.get(p.platform) ?? [];
    if (list.length < each) list.push(p);
    platforms.set(p.platform, list);
  }
  const kept = new Set<Participant>();
  for (let place = 0; place < each; place++) {
    for (const list of platforms.values()) if (place < list.length && kept.size < rankedSlots) kept.add(list[place]);
  }
  return kept;
}

/**
 * Chooses the participants for `max` visible slots and sets `eligible` and `slot` on every participant. Returns the
 * chosen ones in admission order: ranked, then rotating. `participants` is in registration order.
 */
export function chooseCrowd(
  participants: readonly Participant[],
  clock: number,
  timeoutTicks: number,
  rotation: number,
  max: number,
): Participant[] {
  const slots = crowdSlots(max);
  const active: Participant[] = participants.filter(
    (p: Participant): boolean => !p.removed && clock - p.lastChat < timeoutTicks && p.score > 0,
  );
  // The sort is stable: equal scores keep registration order.
  const ranked: Participant[] = active
    .map((p: Participant): [Participant, number] => [p, decayedScore(p, clock)])
    .sort((a: [Participant, number], b: [Participant, number]): number => b[1] - a[1])
    .map((entry: [Participant, number]): Participant => entry[0]);
  // The platform places come first, so a small platform stays on screen beside a large one. The other ranked slots
  // go to the highest scores. With one platform, its places are the highest scores, so nothing changes.
  const top: Set<Participant> = reserved(ranked, max, slots.ranked);
  for (const p of ranked) if (top.size < slots.ranked) top.add(p);
  const remaining: Participant[] = active.filter((p: Participant): boolean => !top.has(p));
  // When fewer than the rotating slots remain, all of them are chosen: no slot stays empty while someone waits.
  // The ranked ones stay in score order: free slots go to the highest scores first.
  const selected: Participant[] = ranked.filter((p: Participant): boolean => top.has(p));
  for (let i = 0; i < Math.min(slots.rotating, remaining.length); i++) {
    selected.push(remaining[(rotation + i) % remaining.length]);
  }
  const chosen = new Set<Participant>(selected);
  for (const p of participants) {
    p.eligible = chosen.has(p);
    p.slot = top.has(p) ? "ranked" : "rotating";
  }
  return selected;
}
