import { describe, expect, it } from "vitest";
import { problemRole, resultMessage, statusMessage, type ChannelView } from "../app/components/channels/channel-panel";
import { CHANNEL_STATUS_CODES, CONNECT_RESULTS } from "../app/lib/activity";

/** The channel panel's messages: every callback result and status code, unknown values and the fallbacks. */

type Connection = NonNullable<ChannelView["connection"]>;

function connection(status: Connection["status"], code: string | null): Connection {
  return { displayName: "Host", status, code, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
}

describe("resultMessage", (): void => {
  it("has a message for every callback result, with the platform name", (): void => {
    const messages = CONNECT_RESULTS.map((result) => resultMessage("kick", result));
    expect(new Set(messages).size).toBe(CONNECT_RESULTS.length);
    expect(resultMessage("kick", "connected")).toBe("Kick connected.");
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
