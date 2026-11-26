import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../app/components/api";
import {
  SupportSwitch,
  changeSupport,
  supportOutcome,
  supportPermissions,
} from "../app/components/channels/support-switch";
import type { ActivityPlatform } from "../app/lib/activity";
import type { ChannelView } from "../app/lib/channel-health";

// The switch for the support events of a connected channel, in the Channels card of Streamer tools.

const TWITCH_SCOPES: string[] = ["moderator:read:followers", "channel:read:subscriptions", "bits:read"];

function channel(platform: ActivityPlatform, support: boolean): ChannelView {
  return {
    platform,
    available: true,
    connection: { displayName: "Host", status: "active", code: null, connectedAt: 1, lastEventAt: null, updatedAt: 1 },
    support,
    supportScopes: platform === "twitch" ? TWITCH_SCOPES : [],
  };
}

function markup(platform: ActivityPlatform, more: Partial<Parameters<typeof SupportSwitch>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SupportSwitch, {
      channel: channel(platform, false),
      on: false,
      busy: false,
      denied: false,
      onChange: (): void => undefined,
      ...more,
    }),
  );
}

describe("permissions for support events", (): void => {
  it("names each Twitch permission in plain words", (): void => {
    expect(supportPermissions(TWITCH_SCOPES)).toBe("read your followers, read your subscribers, and read Bits");
  });

  it("names none for a platform that asks for none, and keeps a permission that it does not know", (): void => {
    expect(supportPermissions([])).toBeNull();
    expect(supportPermissions(["bits:read", "channel:read:new", "toString"])).toBe(
      "read Bits, channel:read:new, and toString",
    );
  });
});

describe("support events switch", (): void => {
  it("is off without a word about permissions for YouTube and Kick, and says what the events are", (): void => {
    const youtube: string = markup("youtube");
    expect(youtube).toMatch(/<input type="checkbox" aria-describedby="[^"]+" data-support-switch="true"\/>/);
    expect(youtube).toContain("<span>YouTube support events</span>");
    expect(youtube).toContain(
      "Shows Super Chats, Super Stickers, memberships and gifted memberships in Live and in the OBS dock.</p>",
    );
    const kick: string = markup("kick");
    expect(kick).toContain(
      "Shows follows, subscriptions, gifted subscriptions and KICKs in Live and in the OBS dock.</p>",
    );
    for (const card of [youtube, kick]) expect(card).not.toContain("permissions");
  });

  it("names the new Twitch permissions while it is off, and says that the Twitch page opens", (): void => {
    const twitch: string = markup("twitch");
    expect(twitch).toContain("<span>Twitch support events</span>");
    expect(twitch).toContain(
      "Shows follows, subscriptions, gifted subscriptions, Bits and raids in Live and in the OBS dock. " +
        "Twitch asks for these permissions: read your followers, read your subscribers, and read Bits. " +
        "If you did not give them before, the Twitch page opens when you turn this on.</p>",
    );
    // The text is the description of the checkbox.
    const id: string | undefined = /aria-describedby="([^"]+)"/.exec(twitch)?.[1];
    expect(twitch).toContain(`<p class="muted" id="${id}">`);
  });

  it("is on without the permissions, takes no change while a change runs, and tells a refusal", (): void => {
    const on: string = markup("twitch", { channel: channel("twitch", true), on: true });
    expect(on).toMatch(/<input type="checkbox"[^>]* checked=""\/>/);
    expect(on).not.toContain("permissions");
    expect(on).not.toContain("disabled");
    // A busy switch keeps the keyboard focus: it is not a disabled control, and it says that it takes no change.
    expect(markup("twitch", { busy: true })).toMatch(/<input type="checkbox" aria-disabled="true"[^>]*\/>/);
    expect(markup("kick")).not.toContain('role="alert"');
    const denied: string = markup("kick", { denied: true });
    expect(denied).toContain('<p class="ch-problem" role="alert">');
    expect(denied).toContain(
      "The channel is connected. Kick did not give the permissions for support events, so they stay off.",
    );
  });
});

describe("the answer to a change of the switch", (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetched = vi.fn((): Promise<Response> => Promise.resolve(Response.json(body, { status })));
    vi.stubGlobal("fetch", fetched);
    return fetched;
  }

  it("sends the browser to the provider page when the answer has an address", (): void => {
    const url: string = "https://id.twitch.tv/oauth2/authorize?state=s";
    expect(supportOutcome({ url, support: false }, true)).toEqual({ url });
  });

  it("sets the switch from the answer, and tells a refusal only when the streamer turned it on", (): void => {
    expect(supportOutcome({ url: null, support: true }, true)).toEqual({ url: null, support: true, denied: false });
    expect(supportOutcome({ url: null, support: false }, true)).toEqual({ url: null, support: false, denied: true });
    expect(supportOutcome({ url: null, support: false }, false)).toEqual({ url: null, support: false, denied: false });
  });

  it("posts the new state for the platform and reads the answer", async (): Promise<void> => {
    const fetched = respond(200, { url: null, support: true, more: 1 });
    expect(await changeSupport("kick", true)).toEqual({ url: null, support: true });
    expect(fetched).toHaveBeenCalledWith(
      "/api/channels/kick/support",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ on: true }) }),
    );
  });

  it("fails with the code of the server, so the card can ask for a new sign-in", async (): Promise<void> => {
    respond(403, { error: "Sign in again to change channel connections.", code: "reauth_required" });
    const error: unknown = await changeSupport("twitch", true).catch((value: unknown): unknown => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "reauth_required" });
  });

  it("fails for an answer of another shape", async (): Promise<void> => {
    for (const body of [{ url: 5, support: true }, { url: null }, { url: "", support: false }, null]) {
      respond(200, body);
      const error: unknown = await changeSupport("twitch", false).catch((value: unknown): unknown => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ message: "The request failed. Please try again.", code: null });
    }
  });
});
