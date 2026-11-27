import { describe, expect, it } from "vitest";
import {
  parseIntent,
  resultMessage,
  stateText,
  statusMessage,
  type ChannelView,
} from "../app/components/channels/channel-panel";
import { CHANNEL_STATUS_CODES, CONNECT_RESULTS, type ActivityPlatform } from "../app/lib/activity";
import { channelCardState, type ChannelCardState } from "../app/lib/channel-health";

/** The channel panel's messages: every callback result and status code, unknown values and the fallbacks. */

type Connection = NonNullable<ChannelView["connection"]>;

function connection(status: Connection["status"], code: string | null, lastEventAt: number | null = null): Connection {
  return { displayName: "Host", status, code, connectedAt: 1, lastEventAt, updatedAt: 1 };
}

/** A connected channel that reads support events, as after a connect of today. */
function channel(platform: ActivityPlatform, value: Connection, support: boolean = true): ChannelView {
  return { platform, available: true, connection: value, support };
}

/** The words of the status icon: its tooltip and its text for a screen reader. */
function words(view: ChannelView, now: number | null): string {
  const state: ChannelCardState | null = channelCardState(view);
  if (state === null) throw new Error("This card has no status icon.");
  return stateText(view, state, now);
}

describe("the words of the status icon", (): void => {
  const now: number = 1_800_000_000_000;

  it("names the health and the last chat event of a healthy connection", (): void => {
    expect(words(channel("kick", connection("active", null)), now)).toBe("Healthy. No chat event yet.");
    const recent: ChannelView = channel("kick", connection("active", null, now - 120_000));
    expect(words(recent, now)).toBe("Healthy. Last chat event 2 minutes ago.");
    expect(words(channel("kick", connection("active", null, now)), now)).toBe("Healthy. Last chat event just now.");
  });

  it("waits for the clock of the viewer before it names an age", (): void => {
    // The server render does not know the clock of the viewer.
    expect(words(channel("kick", connection("active", null, now - 120_000)), null)).toBe("Healthy");
    expect(words(channel("kick", connection("active", null)), null)).toBe("Healthy. No chat event yet.");
  });

  it("is the problem of a connection that is not healthy", (): void => {
    const revoked: ChannelView = channel("kick", connection("needs_reauth", "authorization_revoked"));
    expect(words(revoked, now)).toBe("Access ended. Reconnect to keep receiving chat.");
    const refused: ChannelView = channel("twitch", connection("error", "webhooks_rejected"));
    expect(words(refused, null)).toBe(
      "The feed cannot accept events from the platform right now. It checks again on its own: you do not need to reconnect.",
    );
  });

  it("names the reset time of the YouTube quota only with the clock of the viewer", (): void => {
    const spent: ChannelView = channel("youtube", connection("error", "quota_exhausted"));
    expect(words(spent, null)).toBe("Needs attention");
    expect(words(spent, now)).toMatch(/^The daily YouTube limit /);
  });

  it("asks the owner of a Twitch channel without the new permissions to reconnect one time", (): void => {
    const old: ChannelView = channel("twitch", connection("active", null, now - 120_000), false);
    expect(channelCardState(old)).toBe("support_missing");
    for (const clock of [now, null])
      expect(words(old, clock)).toBe(
        "Reconnect Twitch one time so alerts and goals can read follows, subscriptions and Bits.",
      );
  });

  it("names the platform when another provider refused the support events", (): void => {
    expect(words(channel("kick", connection("active", null), false), now)).toBe(
      "Kick does not send the events for alerts and goals. Reconnect Kick to try again.",
    );
  });
});

describe("resultMessage", (): void => {
  it("has a message for every callback result, with the platform name", (): void => {
    const messages = CONNECT_RESULTS.map((result) => resultMessage("kick", result));
    expect(new Set(messages).size).toBe(CONNECT_RESULTS.length);
    expect(resultMessage("kick", "connected")).toBe("Kick connected.");
    expect(resultMessage("twitch", "support_denied")).toBe(
      "The channel is connected for chat. Twitch did not give the permissions for alerts and goals. Reconnect to try again.",
    );
    expect(resultMessage("youtube", "channel_taken")).toBe(
      "This YouTube channel is already connected to another StreamBullets page.",
    );
  });

  it("shows nothing for an unknown result or platform, also for inherited object keys", (): void => {
    expect(resultMessage("kick", "nope")).toBeNull();
    expect(resultMessage("kick", "toString")).toBeNull();
    expect(resultMessage("kick", null)).toBeNull();
    expect(resultMessage("tiktok", "connected")).toBeNull();
    expect(resultMessage("constructor", "connected")).toBeNull();
    expect(resultMessage(null, "connected")).toBeNull();
  });
});

describe("statusMessage", (): void => {
  it("says nothing for a healthy connection", (): void => {
    expect(statusMessage(connection("active", null), null, "kick")).toBeNull();
  });

  it("explains every status code", (): void => {
    const messages = CHANNEL_STATUS_CODES.map((code) => statusMessage(connection("error", code), "Tue 9:00 AM", "kick"));
    expect(messages.join(" ")).not.toContain("()");
    expect(messages.every((message) => typeof message === "string" && message.length > 0)).toBe(true);
    expect(statusMessage(connection("error", "quota_exhausted"), "Tue 9:00 AM", "kick")).toBe(
      "The daily YouTube limit is used up. Chat resumes after the daily reset (Tue 9:00 AM).",
    );
    // When the reset already passed, there is no time to name.
    expect(statusMessage(connection("error", "quota_exhausted"), null, "kick")).toBe(
      "The daily YouTube limit was used up. Chat resumes when an overlay connects.",
    );
    expect(statusMessage(connection("needs_reauth", "authorization_revoked"), null, "kick")).toBe(
      "Access ended. Reconnect to keep receiving chat.",
    );
  });

  it("tells a YouTube owner that a revoked connection goes after 7 days", (): void => {
    expect(statusMessage(connection("needs_reauth", "authorization_revoked"), null, "youtube")).toContain("after 7 days");
    expect(statusMessage(connection("needs_reauth", null), null, "youtube")).toContain("after 7 days");
    expect(statusMessage(connection("error", "delivery_failed"), null, "youtube")).not.toContain("7 days");
  });

  it("falls back by status for an unknown or missing code", (): void => {
    expect(statusMessage(connection("needs_reauth", null), null, "kick")).toBe("Access ended. Reconnect to keep receiving chat.");
    expect(statusMessage(connection("needs_reauth", "hasOwnProperty"), null, "kick")).toBe(
      "Access ended. Reconnect to keep receiving chat.",
    );
    expect(statusMessage(connection("error", "something_new"), null, "kick")).toBe(
      "This channel has a problem. Reconnect to try again.",
    );
  });
});

describe("parseIntent", (): void => {
  const now: number = 1_800_000_000_000;
  const stored = (value: unknown): string =>
    JSON.stringify(typeof value === "object" && value !== null ? { owner: "owner_page", ...value } : value);

  it("reads a recent intent for a known platform and action", (): void => {
    expect(parseIntent(stored({ platform: "twitch", action: "connect", at: now - 1000 }), now, "owner_page")).toEqual({
      platform: "twitch",
      action: "connect",
    });
    expect(parseIntent(stored({ platform: "kick", action: "disconnect", at: now }), now, "owner_page")).toEqual({
      platform: "kick",
      action: "disconnect",
    });
  });

  it("refuses the intent of the switch for support events, which is gone", (): void => {
    expect(parseIntent(stored({ platform: "twitch", action: "support", at: now }), now, "owner_page")).toBeNull();
  });

  it("refuses an intent of another page owner, and each intent when no owner is signed in", (): void => {
    const raw: string = stored({ platform: "twitch", action: "connect", at: now });
    expect(parseIntent(raw, now, "other_page")).toBeNull();
    expect(parseIntent(raw, now, null)).toBeNull();
    expect(parseIntent(JSON.stringify({ platform: "twitch", action: "connect", at: now }), now, "owner_page")).toBeNull();
  });

  it("refuses an old intent, a future one, and one without a time", (): void => {
    expect(parseIntent(stored({ platform: "twitch", action: "connect", at: now - 10 * 60 * 1000 - 1 }), now, "owner_page")).toBeNull();
    expect(parseIntent(stored({ platform: "twitch", action: "connect", at: now + 1 }), now, "owner_page")).toBeNull();
    expect(parseIntent(stored({ platform: "twitch", action: "connect" }), now, "owner_page")).toBeNull();
  });

  it("refuses unknown platforms and actions, and values that are not an intent", (): void => {
    expect(parseIntent(stored({ platform: "tiktok", action: "connect", at: now }), now, "owner_page")).toBeNull();
    expect(parseIntent(stored({ platform: "constructor", action: "connect", at: now }), now, "owner_page")).toBeNull();
    expect(parseIntent(stored({ platform: "twitch", action: "reconnect", at: now }), now, "owner_page")).toBeNull();
    expect(parseIntent(stored("twitch"), now, "owner_page")).toBeNull();
    expect(parseIntent(stored(null), now, "owner_page")).toBeNull();
    expect(parseIntent("{", now, "owner_page")).toBeNull();
    expect(parseIntent(null, now, "owner_page")).toBeNull();
  });
});
