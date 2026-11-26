import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../app/lib/activity";
import { CHAT_TEST_MS, CHAT_TEST_SCRIPT, chatTestLeft, chatTestScript } from "../app/lib/chat-test";

describe("chat test", () => {
  it("runs one minute and reads a past or missing end time as off", () => {
    expect(CHAT_TEST_MS).toBe(60_000);
    expect(chatTestLeft(10_000, 4_000)).toBe(6_000);
    expect(chatTestLeft(10_000, 10_000)).toBe(0);
    expect(chatTestLeft(10_000, 12_000)).toBe(0);
    expect(chatTestLeft(0, 12_000)).toBe(0);
    // An end time further away than one test never runs longer than one test.
    expect(chatTestLeft(10_000_000, 0)).toBe(CHAT_TEST_MS);
  });

  it("plays chat from all three platforms, a deleted message and a timeout of shown messages", () => {
    const chats = CHAT_TEST_SCRIPT.filter((event: ActivityEvent) => event.kind === "chat");
    expect(new Set(chats.map((event) => event.platform))).toEqual(new Set(["twitch", "youtube", "kick"]));
    const removal = CHAT_TEST_SCRIPT.find((event: ActivityEvent) => event.kind === "delete");
    const timeout = CHAT_TEST_SCRIPT.find((event: ActivityEvent) => event.kind === "ban");
    if (removal?.kind !== "delete" || timeout?.kind !== "ban") throw new Error("The script needs a delete and a ban.");
    expect(chats.some((event) => event.messageId === removal.messageId && event.platform === removal.platform)).toBe(
      true,
    );
    expect(chats.some((event) => event.user.id === timeout.userId && event.platform === timeout.platform)).toBe(true);
    // A timeout, not a permanent ban: the player adds the send time.
    expect(timeout.until).toBeGreaterThan(0);
    // Each event of a deleted or timed-out message comes before its moderation event.
    expect(CHAT_TEST_SCRIPT.indexOf(removal)).toBeGreaterThan(
      CHAT_TEST_SCRIPT.findIndex((event) => event.kind === "chat" && event.messageId === removal.messageId),
    );
    expect(CHAT_TEST_SCRIPT.at(-1)).toBe(timeout);
  });

  it("plays only the events of the platform of an output that shows one platform", () => {
    expect(chatTestScript(null)).toBe(CHAT_TEST_SCRIPT);
    const twitch = chatTestScript("twitch");
    expect(twitch.some((event: ActivityEvent) => event.kind === "chat")).toBe(true);
    expect(new Set(twitch.map((event: ActivityEvent) => event.platform))).toEqual(new Set(["twitch"]));
    // The events keep the order of the script.
    expect(twitch).toEqual(CHAT_TEST_SCRIPT.filter((event: ActivityEvent) => event.platform === "twitch"));
  });
});
