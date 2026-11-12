import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { avatarName, isAvatarPreset, portraitStyle } from "../app/lib/avatars";
import { ownerNotice, reasonText } from "../app/lib/moderation";
import { NonceContext, useNonce } from "../app/lib/nonce";
import {
  applyPrefs,
  changedPrefs,
  DEFAULT_PREFS,
  setChangedPrefs,
  subscribePrefs,
  withDefaults,
} from "../app/lib/prefs";
import { effectiveStatus, expandSeries, upcomingRows } from "../app/lib/schedule";
import { localPath, paths, renamedPath, shellFromMatches, useShell, type ShellData } from "../app/lib/shell";
import { eventsJsonLd, personJsonLd, postingJsonLd, siteJsonLd } from "../app/lib/structured-data";
import { supportLabel } from "../app/lib/support";
import { replyParent, visibleReplies } from "../app/lib/threads";
import { usePrefs } from "../app/lib/use-prefs";
import { formatDate, isValidZone, parseDate } from "../app/lib/zoned";
import type { Comment, CommentThread, StreamEvent } from "../app/types";

const origin = "https://streambullets.test";
const hour = 3_600_000;

function shell(extra: Partial<ShellData> = {}): ShellData {
  return {
    viewer: null,
    providers: [],
    admin: false,
    ownStreamer: null,
    locale: "en",
    prefs: {},
    origin,
    ...extra,
  };
}

/** Renders `node` on the server inside a router whose root loader returned `data`. */
async function renderInRoot(node: () => ReactNode, data: ShellData | null): Promise<string> {
  const handler = createStaticHandler([
    { id: "root", path: "/", loader: () => data, Component: () => node() as ReactElement },
  ]);
  const context = await handler.query(new Request(`${origin}/`));
  if (context instanceof Response) throw new Error("Unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

function Json({ value }: { value: unknown }): ReactElement {
  return createElement("pre", null, JSON.stringify(value));
}

function parsed(html: string): unknown {
  return JSON.parse(html.replace(/^<pre>|<\/pre>$/g, "").replaceAll("&quot;", '"'));
}

describe("avatars", (): void => {
  it("names a preset in the page language and accepts only whole presets 0 to 17", (): void => {
    expect(avatarName(14)).toBe("Space explorer");
    expect(avatarName(16)).toBe("Jack Russell terrier");
    expect([0, 17].map(isAvatarPreset)).toEqual([true, true]);
    expect([-1, 18, 1.5, "3", null].map(isAvatarPreset)).toEqual([false, false, false, false, false]);
  });

  it("cuts presets 0 to 15 from the 4x4 sprite and gives 16 and 17 their own images", (): void => {
    expect(portraitStyle(0)).toEqual({ backgroundPosition: "0% 0%" });
    expect(portraitStyle(6)).toEqual({ backgroundPosition: `${200 / 3}% ${100 / 3}%` });
    expect(portraitStyle(15)).toEqual({ backgroundPosition: "100% 100%" });
    expect(portraitStyle(16)).toMatchObject({ backgroundImage: 'url("/assets/avatar-jack-russell.webp")' });
    expect(portraitStyle(17)).toEqual({
      backgroundImage: 'url("/assets/avatar-alien.webp")',
      backgroundSize: "cover",
      backgroundPosition: "center",
    });
  });
});

describe("moderation notices", (): void => {
  it("words a known reason and shows older free text as written", (): void => {
    expect(reasonText("spam")).toBe("Spam or scam");
    expect(reasonText("Posted my address")).toBe("Posted my address");
  });

  it("tells the owner of a frozen or suspended page what happened and why", (): void => {
    expect(ownerNotice("active", "spam")).toBe("");
    expect(ownerNotice("frozen", null)).toBe(
      "Your page is frozen. Your content stays visible, but no one can post or vote.",
    );
    expect(ownerNotice("suspended", "spam")).toBe(
      "Your page is suspended. It's hidden from the public until the suspension is lifted. Reason: Spam or scam.",
    );
  });
});

describe("display preferences", (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it("fills unset preferences with the defaults and keeps the set ones", (): void => {
    expect(withDefaults(null)).toEqual(DEFAULT_PREFS);
    expect(withDefaults({ text: "130", shortcuts: false })).toEqual({
      ...DEFAULT_PREFS,
      text: "130",
      shortcuts: false,
    });
  });

  it("applies preferences through the head script's function, and does nothing on the server", (): void => {
    expect(() => applyPrefs({ contrast: "high" })).not.toThrow();
    const sbApplyPrefs = vi.fn();
    vi.stubGlobal("window", { sbApplyPrefs });
    applyPrefs({ contrast: "high" });
    expect(sbApplyPrefs).toHaveBeenCalledWith({ contrast: "high" });
  });

  it("tells subscribers about a change until they unsubscribe", (): void => {
    const listener = vi.fn();
    const unsubscribe = subscribePrefs(listener);
    setChangedPrefs({ motion: "reduce" });
    expect(changedPrefs()).toEqual({ motion: "reduce" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setChangedPrefs({ motion: "system" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedPrefs()).toEqual({ motion: "system" });
  });

  it("renders with the saved preferences and the defaults on the server", async (): Promise<void> => {
    setChangedPrefs({ text: "115" });
    const html = await renderInRoot(
      () => createElement(Json, { value: usePrefs() }),
      shell({ prefs: { text: "130" } }),
    );
    expect(parsed(html)).toEqual({ ...DEFAULT_PREFS, text: "130" });
  });
});

describe("localPath", (): void => {
  it("keeps same-origin paths and rejects anything that could leave the site", (): void => {
    expect(localPath("/@alice?intent=suggest#top")).toBe("/@alice?intent=suggest#top");
    expect(localPath("/streamers")).toBe("/streamers");
    expect(localPath("/\u{1f600}?q=\u00e9")).toBe("/%F0%9F%98%80?q=%C3%A9");
    const unsafe = [null, undefined, "", "streamers", "//evil.example", "/\\evil.example", "/\t/evil.example"];
    for (const value of [...unsafe, "https://evil.example", "javascript:alert(1)"]) expect(localPath(value)).toBeNull();
    for (const codePoint of [...Array.from({ length: 32 }, (_, index: number): number => index), 127]) {
      expect(localPath(`/a${String.fromCodePoint(codePoint)}b`)).toBeNull();
    }
  });
});

describe("shell data", (): void => {
  it("reads the root loader's data, or a signed-out shell where the root loader did not run", async (): Promise<void> => {
    const data = shell({ admin: true, viewer: { id: "u1" } as ShellData["viewer"] });
    expect(parsed(await renderInRoot(() => createElement(Json, { value: useShell() }), data))).toEqual(data);
    expect(parsed(await renderInRoot(() => createElement(Json, { value: useShell() }), null))).toEqual({
      viewer: null,
      providers: [],
      admin: false,
      ownStreamer: null,
      locale: "en",
      prefs: {},
      origin: "",
    });
  });

  it("finds the root match in a meta function's matches", (): void => {
    const data = shell();
    expect(shellFromMatches([undefined, { id: "routes/home" }, { id: "root", loaderData: data }])).toBe(data);
    expect(shellFromMatches([{ id: "routes/home", loaderData: data }])).toBeNull();
  });


  it("links to a streamer page by handle", (): void => {
    expect(paths.streamer("zed_page")).toBe("/@zed_page");
  });

  it("hands the request's nonce to components, and none outside a request", (): void => {
    const Probe = (): ReactElement => createElement("i", null, useNonce() ?? "none");
    expect(renderToStaticMarkup(createElement(NonceContext.Provider, { value: "n0nce" }, createElement(Probe)))).toBe(
      "<i>n0nce</i>",
    );
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>none</i>");
  });
});

describe("structured data", (): void => {
  const streamer = { name: "Zed", handle: "zed_page", about: "" };

  it("describes the site and the organisation behind it", (): void => {
    const site = siteJsonLd(origin);
    expect(site["@context"]).toBe("https://schema.org");
    expect(site["@graph"]).toEqual([
      expect.objectContaining({
        "@type": "WebSite",
        url: `${origin}/`,
        publisher: { "@id": `${origin}/#organization` },
      }),
      expect.objectContaining({ "@type": "Organization", logo: `${origin}/brand/stream-bullets-icon.svg` }),
    ]);
  });

  it("describes a streamer, with at most 300 characters of about text", (): void => {
    expect(personJsonLd(streamer, origin)).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: "Zed",
      alternateName: "@zed_page",
      url: `${origin}/@zed_page`,
    });
    expect(personJsonLd({ ...streamer, about: "x".repeat(400) }, origin).description).toBe("x".repeat(300));
  });

  it("lists upcoming and live streams, at most the limit, and leaves out ended and cancelled ones", (): void => {
    const now = Date.UTC(2026, 10, 7, 12);
    const event = (id: string, extra: Partial<StreamEvent>): StreamEvent =>
      ({
        id,
        title: id,
        startsAt: now + hour,
        durationMin: 90,
        platform: "twitch",
        url: "https://twitch.tv/zed",
        status: "scheduled",
        ...extra,
      }) as StreamEvent;
    const events = [
      event("live", { status: "live", startsAt: now - hour }),
      event("cancelled", { status: "cancelled" }),
      event("ended", { status: "ended" }),
      event("stale", { startsAt: now - 25 * hour }),
      event("next", { platform: "kick" }),
      event("odd", { platform: "unknown" as StreamEvent["platform"] }),
    ];
    const items = eventsJsonLd(events, streamer, origin, now);
    expect(items.map((item) => item.name)).toEqual(["live", "next", "odd"]);
    expect(items[1]).toEqual({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "next",
      startDate: new Date(now + hour).toISOString(),
      endDate: new Date(now + hour + 90 * 60_000).toISOString(),
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
      location: { "@type": "VirtualLocation", name: "Kick", url: "https://twitch.tv/zed" },
      organizer: { "@type": "Person", name: "Zed", url: `${origin}/@zed_page` },
      url: `${origin}/@zed_page?view=schedule&event=next`,
    });
    expect(items[2].location).toMatchObject({ name: "Online" });
    expect(eventsJsonLd(events, streamer, origin, now, 1)).toHaveLength(1);
  });

  it("describes a topic or poll with its counts and a link to its tab", (): void => {
    const entry = {
      id: "e1",
      kind: "topic" as const,
      title: "Boss",
      body: "y".repeat(600),
      author: "Ann",
      createdAt: 0,
      comments: 3,
      likes: 4,
    };
    const topic = postingJsonLd(entry, streamer, origin);
    expect(topic).toMatchObject({
      "@type": "DiscussionForumPosting",
      headline: "Boss",
      author: { "@type": "Person", name: "Ann" },
      datePublished: "1970-01-01T00:00:00.000Z",
      url: `${origin}/@zed_page?view=topics&entry=e1`,
    });
    expect(topic.text).toBe("y".repeat(500));
    expect(topic.interactionStatistic).toEqual([
      expect.objectContaining({ interactionType: "https://schema.org/CommentAction", userInteractionCount: 3 }),
      expect.objectContaining({ interactionType: "https://schema.org/LikeAction", userInteractionCount: 4 }),
    ]);
    const poll = postingJsonLd({ ...entry, kind: "choice", body: "" }, streamer, origin);
    expect(poll.url).toBe(`${origin}/@zed_page?view=polls&entry=e1`);
    expect(poll).not.toHaveProperty("text");
  });
});

describe("support buttons", (): void => {
  it("uses the owner's label for other links, else the provider's name", (): void => {
    expect(supportLabel({ kind: "other", label: "My shop" })).toBe("My shop");
    expect(supportLabel({ kind: "other", label: null })).toBe("Support");
    expect(supportLabel({ kind: "other", label: "" })).toBe("Support");
    expect(supportLabel({ kind: "kofi", label: "ignored" })).toBe("Ko-fi");
    expect(supportLabel({ kind: "twitch", label: null })).toBe("Twitch subscribe");
  });
});

describe("comment threads", (): void => {
  const comment = (id: string, extra: Partial<Comment> = {}): Comment =>
    ({ id, createdAt: 0, parentId: null, removed: false, likes: 0, ...extra }) as Comment;


  it("shows two replies until the thread is expanded", (): void => {
    const replies = [comment("r3", { createdAt: 3 }), comment("r1", { createdAt: 1 }), comment("r2", { createdAt: 2 })];
    expect(visibleReplies(replies, false)).toEqual({ shown: [replies[1], replies[2]], hidden: 1 });
    expect(visibleReplies(replies, true).hidden).toBe(0);
  });

  it("finds the parent a reply answers", (): void => {
    const reply = comment("r2", { parentId: "r1" });
    const thread = { ...comment("t"), replies: [comment("r1", { parentId: "t" }), reply] } as CommentThread;
    expect(replyParent(thread, reply)?.id).toBe("r1");
    expect(replyParent(thread, thread.replies[0])).toBe(thread);
    expect(replyParent(thread, comment("x"))).toBeNull();
    expect(replyParent(thread, comment("y", { parentId: "gone" }))).toBeNull();
  });
});

describe("schedule and time helpers", (): void => {
  it("writes no occurrences for a series without weekdays", (): void => {
    const rule = { first: { year: 2026, month: 11, day: 9 }, hour: 18, minute: 0, zone: "UTC", until: null };
    expect(expandSeries({ ...rule, days: 0 }, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(expandSeries({ ...rule, days: 127 }, Number.POSITIVE_INFINITY, 2)).toEqual([
      Date.UTC(2026, 10, 9, 18),
      Date.UTC(2026, 10, 10, 18),
    ]);
  });

  it("keeps a stream marked live as live before its planned start, and upcoming otherwise", (): void => {
    const start = Date.UTC(2026, 10, 9, 18);
    expect(effectiveStatus("live", start, 60, start - hour)).toBe("live");
    expect(effectiveStatus("scheduled", start, 60, start - hour)).toBe("scheduled");
    expect(effectiveStatus("scheduled", start, 60, start)).toBe("live");
    expect(effectiveStatus("live", start, 60, start + hour)).toBe("ended");
    expect(effectiveStatus("cancelled", start, 60, start)).toBe("cancelled");
  });

  it("knows real zone names only", (): void => {
    expect(isValidZone("Europe/Berlin")).toBe(true);
    expect(isValidZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidZone("")).toBe(false);
    expect(isValidZone(`Europe/${"x".repeat(60)}`)).toBe(false);
  });


  it("formats and parses calendar days, and refuses days that do not exist", (): void => {
    expect(formatDate({ year: 26, month: 3, day: 9 })).toBe("0026-03-09");
    expect(parseDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseDate("2026-02-29")).toBeNull();
    expect(parseDate("2026-2-9")).toBeNull();
  });
});

describe("upcomingRows", () => {
  const row = (id: string, startsAt: number, status: string, seriesId: string | null) => ({
    id,
    startsAt,
    status: status as "scheduled" | "cancelled" | "live" | "ended",
    seriesId,
  });

  it("keeps a cancelled stream from hiding the next stream of its series", () => {
    const hero = row("solo", 1_000, "scheduled", null);
    const cancelled = row("w1", 2_000, "cancelled", "weekly");
    const replacement = row("w2", 3_000, "scheduled", "weekly");
    const later = row("w3", 4_000, "scheduled", "weekly");
    const rows = upcomingRows([hero, cancelled, replacement, later], hero, 500);
    expect(rows.map((r) => r.id)).toEqual(["w1", "w2"]);
  });

  it("shows one row per series, skips the hero's series and past streams, and keeps one-offs", () => {
    const hero = row("h", 1_000, "scheduled", "a");
    const rows = upcomingRows(
      [
        row("past", 100, "ended", "b"),
        hero,
        row("a2", 2_000, "scheduled", "a"),
        row("b1", 2_500, "scheduled", "b"),
        row("b2", 3_000, "scheduled", "b"),
        row("one", 3_500, "scheduled", null),
      ],
      hero,
      500,
    );
    expect(rows.map((r) => r.id)).toEqual(["b1", "one"]);
    expect(upcomingRows([row("x", 900, "scheduled", "c")], undefined, 500).map((r) => r.id)).toEqual(["x"]);
  });

  it("lists every live stream but the hero first, so overlapping live streams never disappear", () => {
    const hero = row("live-a", 100, "live", "a");
    const rows = upcomingRows(
      [
        hero,
        row("live-b", 200, "live", "b"),
        row("live-solo", 300, "live", null),
        row("b2", 2_000, "scheduled", "b"),
        row("c1", 2_500, "scheduled", "c"),
      ],
      hero,
      500,
    );
    // A live stream takes its series' row like the next stream would, and an ended one stays out.
    expect(rows.map((r) => r.id)).toEqual(["live-b", "live-solo", "c1"]);
  });
});

describe("renamedPath", () => {
  it("moves only the renamed page's own paths, never a page whose handle starts the same", (): void => {
    expect(renamedPath("/@abc", "abc", "xyz")).toBe("/@xyz");
    expect(renamedPath("/@abc/overlay", "abc", "xyz")).toBe("/@xyz/overlay");
    expect(renamedPath("/@abcd", "abc", "xyz")).toBeNull();
    expect(renamedPath("/@abcd/overlay", "abc", "xyz")).toBeNull();
    expect(renamedPath("/streamers", "abc", "xyz")).toBeNull();
  });
});
