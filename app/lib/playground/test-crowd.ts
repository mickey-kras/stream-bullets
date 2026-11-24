import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../activity";
import { SAMPLE_CHAT } from "../chat-feed";
import { CHARACTERS_TEST_MS, TEST_USER_PREFIX } from "./constants";
import { COMMANDS } from "./crowd";
import { mulberry32 } from "./sim";

/**
 * The characters test (issue #664): a seeded, synthetic crowd that plays for CHARACTERS_TEST_MS. The server feeds
 * these events to the playground as live chat. Nothing goes to a provider.
 *
 * Each minute has each command, a deleted message and a timeout. From the second minute, each minute also has
 * an exit reversal: a participant silent for the default timeout speaks again while it walks to the exit.
 */

export interface TestCrowdEvent {
  /** Milliseconds after the start of the test. */
  atMs: number;
  event: ActivityEvent;
}

/** Synthetic participants. The first ones reuse the sample chat users. */
export const TEST_CROWD_SIZE = 60;
/** Participants kept silent for the exit reversals, one per minute. */
const RESERVED_FROM = 50;
const MINUTE_MS = 60_000;
/** The reversal comes this long after the participant's previous message: past the default timeout of 60 s. */
const REVERSAL_AFTER_MS = 62_000;
const TEST_TIMEOUT_MS = 30_000;
/** The commands of a minute come this far apart: all of them fit in the minute. */
const COMMAND_GAP_MS = 3_000;
const PLATFORMS: readonly ActivityPlatform[] = ["twitch", "youtube", "kick"];
const LINES: readonly string[] = [
  "who left the door open?",
  "smells like rust out here",
  "found a shiny bolt!",
  "gg chat",
  "brb, salvaging",
  "this dirt looks crumbly",
];

interface Member {
  platform: ActivityPlatform;
  userId: string;
  name: string;
}

function members(): Member[] {
  return Array.from({ length: TEST_CROWD_SIZE }, (_, i: number): Member => {
    const sample: ActivityChat | undefined = SAMPLE_CHAT[i];
    return {
      platform: sample ? sample.platform : PLATFORMS[i % PLATFORMS.length],
      userId: `${TEST_USER_PREFIX}${i + 1}`,
      name: sample ? sample.user.displayName : `Scav ${i + 1}`,
    };
  });
}

/** The test events from `startMs` (server time), sorted by time. The same seed always gives the same events. */
export function testCrowdScript(seed: number, startMs: number): TestCrowdEvent[] {
  const rng: () => number = mulberry32(seed);
  const crowd: Member[] = members();
  const events: TestCrowdEvent[] = [];
  let seq = 0;
  const say = (atMs: number, member: Member, text: string): ActivityChat => {
    seq += 1;
    const messageId = `test-${seq}`;
    const event: ActivityChat = {
      kind: "chat",
      id: `${member.platform}:${messageId}`,
      platform: member.platform,
      channelId: `test-${member.platform}`,
      messageId,
      user: { id: member.userId, displayName: member.name },
      text,
      fragments: [{ type: "text", text }],
      badges: [],
      sentAt: startMs + atMs,
      receivedAt: startMs + atMs,
      live: true,
    };
    events.push({ atMs, event });
    return event;
  };
  const pick = (): Member => crowd[Math.floor(rng() * RESERVED_FROM)];
  for (let minute = 0; minute * MINUTE_MS < CHARACTERS_TEST_MS; minute++) {
    const base: number = minute * MINUTE_MS;
    for (const member of crowd.slice(0, RESERVED_FROM)) {
      const count: number = Math.floor(rng() * 3);
      for (let k = 0; k < count; k++) {
        say(base + Math.floor(rng() * MINUTE_MS), member, LINES[Math.floor(rng() * LINES.length)]);
      }
    }
    for (const [i, command] of COMMANDS.entries()) say(base + 5_000 + i * COMMAND_GAP_MS, pick(), `!${command}`);
    const reverser: Member = crowd[RESERVED_FROM + minute];
    say(base + 1_000, reverser, "heading out soon");
    const back: number = base + 1_000 + REVERSAL_AFTER_MS;
    if (back < CHARACTERS_TEST_MS) say(back, reverser, "wait, I am back!");
    const deleted: ActivityChat = say(base + 20_000, pick(), "this message gets deleted");
    events.push({
      atMs: base + 21_000,
      event: {
        kind: "delete",
        platform: deleted.platform,
        messageId: deleted.messageId,
        receivedAt: startMs + base + 21_000,
      },
    });
    const banned: Member = pick();
    const banAt: number = startMs + base + 40_000;
    events.push({
      atMs: base + 40_000,
      event: {
        kind: "ban",
        platform: banned.platform,
        userId: banned.userId,
        until: banAt + TEST_TIMEOUT_MS,
        receivedAt: banAt,
      },
    });
  }
  return events.sort((a: TestCrowdEvent, b: TestCrowdEvent): number => a.atMs - b.atMs);
}
