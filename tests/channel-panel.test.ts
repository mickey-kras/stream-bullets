import { describe, expect, it } from "vitest";
import {
  parseIntent,
  problemRole,
  resultMessage,
  statusMessage,
  type ChannelView,
} from "../app/components/channels/channel-panel";
import { channelsStartOpen, channelsSummary } from "../app/components/channels/channels-step";
import { CHANNEL_STATUS_CODES, CONNECT_RESULTS, type ActivityPlatform } from "../app/lib/activity";

/** The channel panel's messages: every callback result and status code, unknown values and the fallbacks. */

type Connection = NonNullable<ChannelView["connection"]>;

function connection(status: Connection["status"], code: string | null): Connection {
  return { displayName: "Host", status, code, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
}

function channel(platform: ActivityPlatform, status: Connection["status"] | null, available: boolean = true): ChannelView {
  return { platform, available, connection: status ? connection(status, null) : null };
}

describe("the channels step", (): void => {
  it("starts open with no channel connected and names nothing", (): void => {
    const none: ChannelView[] = [channel("twitch", null), channel("kick", null)];
    expect(channelsSummary(none)).toBe("No channel connected yet");
    expect(channelsStartOpen(none, null)).toBe(true);
  });

  it("starts closed with a healthy connection and names the connected platforms", (): void => {
    const healthy: ChannelView[] = [channel("twitch", "active"), channel("youtube", null), channel("kick", "active")];
    expect(channelsSummary(healthy)).toBe("Connected: Twitch, Kick");
    expect(channelsStartOpen(healthy, null)).toBe(false);
  });

  it("starts open for a callback result or a connection that the owner can repair", (): void => {
    const healthy: ChannelView[] = [channel("twitch", "active")];
    expect(channelsStartOpen(healthy, "Twitch connected.")).toBe(true);
    const broken: ChannelView[] = [channel("twitch", "active"), channel("kick", "needs_reauth")];
    expect(channelsSummary(broken)).toBe("Connected: Twitch · Needs attention: Kick");
    expect(channelsStartOpen(broken, null)).toBe(true);
    // A platform that the site does not offer cannot be repaired here.
    const unavailable: ChannelView[] = [channel("youtube", "error", false)];
    expect(channelsSummary(unavailable)).toBe("Connected: YouTube");
    expect(channelsStartOpen(unavailable, null)).toBe(false);
  });
});

describe("resultMessage", (): void => {
  it("has a message for every callback result, with the platform name", (): void => {
    const messages = CONNECT_RESULTS.map((result) => resultMessage("kick", result));
    expect(new Set(messages).size).toBe(CONNECT_RESULTS.length);
    expect(resultMessage("kick", "connected")).toBe("Kick connected.");
    expect(resultMessage("twitch", "support_denied")).toBe(
      "The channel is connected. Twitch did not give the permissions for support events, so they stay off.",
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

  it("announces a spent quota politely and other problems as alerts", (): void => {
    expect([problemRole("quota_exhausted"), problemRole("subscribe_failed"), problemRole(null)]).toEqual(["status", "alert", "alert"]);
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
