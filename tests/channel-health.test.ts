import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelProblem, lastEventText } from "../app/components/channels/channel-panel";
import { healthNews } from "../app/components/channels/channels-step";
import {
  CHANNEL_REFRESH_MS,
  REFRESH_FAILURES_SHOWN,
  startChannelRefresh,
} from "../app/components/channels/use-live-channels";
import type { ActivityPlatform } from "../app/lib/activity";
import {
  channelHealth,
  channelsResponseSchema,
  deliversChat,
  healthChanges,
  relativeAge,
  type ChannelView,
} from "../app/lib/channel-health";

/** The live channel health of Overlay control: the refresh, the changes between two reads and the event age. */

type Status = NonNullable<ChannelView["connection"]>["status"];

function channel(
  platform: ActivityPlatform,
  status: Status | null,
  code: string | null = null,
  available: boolean = true,
): ChannelView {
  const connection = {
    displayName: "Host",
    status: status ?? "active",
    code,
    connectedAt: 1,
    lastEventAt: null,
    updatedAt: 1,
  };
  return { platform, available, connection: status ? connection : null };
}

describe("channelHealth", (): void => {
  it("names the health of each card", (): void => {
    expect(channelHealth(channel("kick", "active"))).toBe("healthy");
    expect(channelHealth(channel("kick", "error", "delivery_failed"))).toBe("attention");
    expect(channelHealth(channel("kick", "needs_reauth"))).toBe("attention");
    expect(channelHealth(channel("kick", null))).toBe("none");
    expect(channelHealth(channel("kick", null, null, false))).toBe("none");
    // The site does not offer the platform: the owner cannot repair the connection here.
    expect(channelHealth(channel("kick", "active", null, false))).toBe("unavailable");
  });

  it("knows whether a connected platform delivers chat", (): void => {
    expect(deliversChat([channel("twitch", "error"), channel("kick", "active")])).toBe(true);
    expect(deliversChat([channel("twitch", "error"), channel("kick", null)])).toBe(false);
    expect(deliversChat([channel("youtube", "active", null, false)])).toBe(false);
    expect(deliversChat([])).toBe(false);
  });
});

describe("the response of GET /api/channels", (): void => {
  it("keeps the fields of the panel and drops the others", (): void => {
    const kick: ChannelView = channel("kick", "error", "quota_exhausted");
    const body: unknown = { channels: [{ ...kick, capabilities: { delete: true } }, channel("twitch", null)] };
    expect(channelsResponseSchema.parse(body)).toEqual({ channels: [kick, channel("twitch", null)] });
  });

  it("refuses another shape", (): void => {
    expect(
      channelsResponseSchema.safeParse({ channels: [{ platform: "tiktok", available: true, connection: null }] })
        .success,
    ).toBe(false);
    expect(channelsResponseSchema.safeParse({ error: "Sign in to continue." }).success).toBe(false);
  });
});

describe("healthChanges", (): void => {
  it("reports a healthy platform that got a problem", (): void => {
    const broken: ChannelView = channel("kick", "needs_reauth", "authorization_revoked");
    expect(
      healthChanges([channel("twitch", "active"), channel("kick", "active")], [channel("twitch", "active"), broken]),
    ).toEqual([{ channel: broken, to: "attention" }]);
  });

  it("reports a platform that works again", (): void => {
    const back: ChannelView = channel("twitch", "active");
    expect(healthChanges([channel("twitch", "error", "delivery_failed")], [back])).toEqual([
      { channel: back, to: "healthy" },
    ]);
  });

  it("reports nothing for the same state, also with another problem code", (): void => {
    const list: ChannelView[] = [channel("twitch", "active"), channel("kick", "error", "delivery_failed")];
    expect(healthChanges(list, list)).toEqual([]);
    expect(healthChanges(list, [channel("twitch", "active"), channel("kick", "needs_reauth")])).toEqual([]);
  });

  it("reports nothing on the first load, for a new connection or for a removed one", (): void => {
    expect(healthChanges([], [channel("kick", "error")])).toEqual([]);
    expect(healthChanges([channel("kick", null)], [channel("kick", "error")])).toEqual([]);
    expect(healthChanges([channel("kick", null)], [channel("kick", "active")])).toEqual([]);
    expect(healthChanges([channel("kick", "error")], [channel("kick", null)])).toEqual([]);
    // A platform that the site does not offer has no health to change.
    expect(healthChanges([channel("kick", "active", null, false)], [channel("kick", "error", null, false)])).toEqual(
      [],
    );
  });

  it("reports a used-up quota once: when it starts", (): void => {
    const healthy: ChannelView[] = [channel("youtube", "active")];
    const spent: ChannelView[] = [channel("youtube", "error", "quota_exhausted")];
    expect(healthChanges(healthy, spent)).toHaveLength(1);
    expect(healthChanges(spent, spent)).toEqual([]);
    expect(healthChanges(spent, [channel("youtube", "error", "quota_exhausted")])).toEqual([]);
  });
});

describe("healthNews", (): void => {
  it("says nothing without a change", (): void => {
    expect(healthNews([])).toBeNull();
  });

  it("names the platform and its problem as an urgent message", (): void => {
    const broken: ChannelView = channel("kick", "needs_reauth", "authorization_revoked");
    expect(channelProblem(broken)).toBe("Access ended. Reconnect to keep receiving chat.");
    expect(healthNews([{ channel: broken, to: "attention" }])).toEqual({
      message: "Kick: Access ended. Reconnect to keep receiving chat.",
      urgent: true,
    });
  });

  it("says that a platform is back, and that a used-up quota started, as polite messages", (): void => {
    expect(healthNews([{ channel: channel("twitch", "active"), to: "healthy" }])).toEqual({
      message: "Twitch chat is back.",
      urgent: false,
    });
    const spent = healthNews([{ channel: channel("youtube", "error", "quota_exhausted"), to: "attention" }]);
    expect(spent?.message).toMatch(/^YouTube: The daily YouTube limit /);
    expect(spent?.urgent).toBe(false);
  });

  it("joins the changes of one read into one message", (): void => {
    expect(
      healthNews([
        { channel: channel("twitch", "active"), to: "healthy" },
        { channel: channel("kick", "error", "delivery_failed"), to: "attention" },
      ]),
    ).toEqual({
      message: "Twitch chat is back. Kick: Twitch stopped sending events. Reconnect to resume.",
      urgent: true,
    });
  });

  it("has no problem text for a healthy, missing or not offered connection", (): void => {
    expect(channelProblem(channel("kick", "active"))).toBeNull();
    expect(channelProblem(channel("kick", null))).toBeNull();
    expect(channelProblem(channel("kick", "error", null, false))).toBeNull();
  });
});

describe("the age of the last chat event", (): void => {
  const now: number = 1_800_000_000_000;
  const SECOND: number = 1000;
  const MINUTE: number = 60 * SECOND;
  const HOUR: number = 60 * MINUTE;
  const DAY: number = 24 * HOUR;

  it("counts seconds, minutes, hours and days, each rounded down", (): void => {
    expect(relativeAge(now - SECOND, now, "en-US")).toBe("1 second ago");
    expect(relativeAge(now - 59 * SECOND, now, "en-US")).toBe("59 seconds ago");
    expect(relativeAge(now - MINUTE, now, "en-US")).toBe("1 minute ago");
    expect(relativeAge(now - (2 * MINUTE + 59 * SECOND), now, "en-US")).toBe("2 minutes ago");
    expect(relativeAge(now - 59 * MINUTE, now, "en-US")).toBe("59 minutes ago");
    expect(relativeAge(now - 5 * HOUR, now, "en-US")).toBe("5 hours ago");
    expect(relativeAge(now - 23 * HOUR, now, "en-US")).toBe("23 hours ago");
    expect(relativeAge(now - 3 * DAY, now, "en-US")).toBe("3 days ago");
    expect(relativeAge(now - 400 * DAY, now, "en-US")).toBe("400 days ago");
  });

  it("uses the words of the locale", (): void => {
    expect(relativeAge(now - 2 * MINUTE, now, "de")).toBe("vor 2 Minuten");
  });

  it("is just now for less than a second and for a time ahead of this clock", (): void => {
    expect(relativeAge(now, now, "en-US")).toBeNull();
    expect(relativeAge(now - 999, now, "en-US")).toBeNull();
    expect(relativeAge(now + 5 * MINUTE, now, "en-US")).toBeNull();
  });

  it("makes the sentence of the card", (): void => {
    expect(lastEventText(now - 2 * MINUTE, now)).toBe("Last chat event 2 minutes ago");
    expect(lastEventText(now + 5 * MINUTE, now)).toBe("Last chat event just now");
    expect(lastEventText(null, now)).toBe("No chat event yet");
  });
});

describe("the channel refresh", (): void => {
  /** The document of a tab: visible or hidden, with its visibility event. */
  class FakeDocument extends EventTarget {
    hidden: boolean = false;
    show(visible: boolean): void {
      this.hidden = !visible;
      this.dispatchEvent(new Event("visibilitychange"));
    }
  }
  const fresh: ChannelView[] = [channel("kick", "active")];
  let page: FakeDocument;
  let browser: EventTarget;
  let read: ReturnType<typeof vi.fn<() => Promise<ChannelView[]>>>;
  let report: ReturnType<typeof vi.fn<(channels: ChannelView[] | null, failures: number) => void>>;
  let stop: () => void;

  /** Lets a finished read report and set the next timer. */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach((): void => {
    vi.useFakeTimers();
    page = new FakeDocument();
    browser = new EventTarget();
    vi.stubGlobal("document", page);
    vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
    vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
    read = vi.fn<() => Promise<ChannelView[]>>((): Promise<ChannelView[]> => Promise.resolve(fresh));
    report = vi.fn<(channels: ChannelView[] | null, failures: number) => void>();
    stop = startChannelRefresh(read, report);
  });
  afterEach((): void => {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads every 20 seconds and not on load", async (): Promise<void> => {
    expect(CHANNEL_REFRESH_MS).toBe(20_000);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(fresh, 0);
    await vi.advanceTimersByTimeAsync(3 * CHANNEL_REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(4);
    // One timer: no second timer waits beside the next read.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops while the tab is hidden and reads at once when it shows again", async (): Promise<void> => {
    page.show(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * CHANNEL_REFRESH_MS);
    expect(read).not.toHaveBeenCalled();
    // The browser is online again, but nobody looks at the page.
    browser.dispatchEvent(new Event("online"));
    await settle();
    expect(read).not.toHaveBeenCalled();
    page.show(true);
    expect(read).toHaveBeenCalledTimes(1);
    await settle();
    expect(report).toHaveBeenLastCalledWith(fresh, 0);
    // The interval starts again from this read.
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads at once when the browser is online again", async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(5000);
    browser.dispatchEvent(new Event("online"));
    expect(read).toHaveBeenCalledTimes(1);
    await settle();
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not start a second read while one is open", async (): Promise<void> => {
    let finish: (channels: ChannelView[]) => void = (): void => undefined;
    read.mockImplementationOnce(
      (): Promise<ChannelView[]> =>
        new Promise<ChannelView[]>((resolve: (channels: ChannelView[]) => void): void => {
          finish = resolve;
        }),
    );
    browser.dispatchEvent(new Event("online"));
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(3 * CHANNEL_REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(1);
    finish(fresh);
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the data after a failed read, counts the failures and tries again at the next tick", async (): Promise<void> => {
    expect(REFRESH_FAILURES_SHOWN).toBe(3);
    read.mockRejectedValue(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    // No list replaces the last one. The count says how many reads failed in a row.
    expect(report).toHaveBeenLastCalledWith(null, 1);
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    expect(report).toHaveBeenLastCalledWith(null, 2);
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    expect(report).toHaveBeenLastCalledWith(null, 3);
    // The next success sets the count to zero.
    read.mockResolvedValue(fresh);
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    expect(report).toHaveBeenLastCalledWith(fresh, 0);
    read.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
    expect(report).toHaveBeenLastCalledWith(null, 1);
  });

  it("removes the timer and the listeners when it stops", async (): Promise<void> => {
    stop();
    expect(vi.getTimerCount()).toBe(0);
    page.show(true);
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10 * CHANNEL_REFRESH_MS);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports nothing and sets no timer when a read ends after the stop", async (): Promise<void> => {
    let finish: (channels: ChannelView[]) => void = (): void => undefined;
    let fail: (error: Error) => void = (): void => undefined;
    read.mockImplementationOnce(
      (): Promise<ChannelView[]> =>
        new Promise<ChannelView[]>((resolve: (channels: ChannelView[]) => void): void => {
          finish = resolve;
        }),
    );
    browser.dispatchEvent(new Event("online"));
    stop();
    finish(fresh);
    await settle();
    stop = startChannelRefresh(read, report, 1000);
    read.mockImplementationOnce(
      (): Promise<ChannelView[]> =>
        new Promise<ChannelView[]>(
          (_resolve: (channels: ChannelView[]) => void, reject: (error: Error) => void): void => {
            fail = reject;
          },
        ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    fail(new Error("gone"));
    await settle();
    expect(report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
