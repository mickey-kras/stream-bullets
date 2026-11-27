import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRoutesStub,
  RouterContextProvider,
  type LoaderFunctionArgs,
  type MetaArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appContext, type AppEnv } from "../app/env";
import type { Entry, LiveSnapshot, StepUpStatus, Streamer, StreamEvent, Viewer } from "../app/types";
import { DEFAULT_LAYERS, type OverlayLayers } from "../app/lib/overlay-layers";
import { DEFAULT_OVERLAY } from "../app/server/overlay-state";
import * as auth from "../app/server/auth.server";
import * as access from "../app/server/access.server";
import * as stepup from "../app/server/stepup.server";
import * as moderation from "../app/server/moderation.server";
import * as reports from "../app/server/report-groups.server";
import * as data from "../app/server/data.server";
import * as schedule from "../app/server/schedule.server";
import * as community from "../app/server/community.server";
import * as support from "../app/server/support.server";
import * as overlay from "../app/server/overlay.server";
import { EMPTY_LAYOUTS } from "../app/lib/overlay-layouts";
import * as dockKey from "../app/server/dock-key.server";
import * as overlayKey from "../app/server/overlay-key.server";
import * as overlayLayouts from "../app/server/overlay-layouts.server";
import * as channels from "../app/server/channels.server";
import * as account from "../app/server/api/account";
import * as featured from "../app/server/featured-streamer.server";
import * as ai from "../app/server/ai.server";
import * as adminRoute from "../app/routes/admin";
import * as streamerRoute from "../app/routes/streamer";
import * as overlayRoute from "../app/routes/overlay";
import * as controlRoute from "../app/routes/tools";
import * as legacyControlRoute from "../app/routes/overlay-control";
import * as directoryRoute from "../app/routes/streamers";
import * as signInRoute from "../app/routes/sign-in";
import * as aiRoute from "../app/routes/ai";
import * as commandsRoute from "../app/routes/commands";
import * as rootRoute from "../app/root";
import * as homeRoute from "../app/routes/home";
import * as privacyRoute from "../app/routes/privacy";
import * as termsRoute from "../app/routes/terms";
import { loadCatalog, setLocaleSource } from "../app/i18n";

// Keep validation, public projections, request caching and metadata real; isolate server I/O only.
vi.mock("../app/server/auth.server", async (original) => ({
  ...(await original<typeof import("../app/server/auth.server")>()),
  getViewerSession: vi.fn(),
}));
vi.mock("../app/server/access.server", async (original) => ({
  ...(await original<typeof import("../app/server/access.server")>()),
  isAdmin: vi.fn(),
  listApplications: vi.fn(),
}));
vi.mock("../app/server/stepup.server", async (original) => ({
  ...(await original<typeof import("../app/server/stepup.server")>()),
  getStepUpStatus: vi.fn(),
  listKeys: vi.fn(),
  requireAdminSession: vi.fn(),
}));
vi.mock("../app/server/moderation.server", async (original) => ({
  ...(await original<typeof import("../app/server/moderation.server")>()),
  listModerationPages: vi.fn(),
}));
vi.mock("../app/server/report-groups.server", async (original) => ({
  ...(await original<typeof import("../app/server/report-groups.server")>()),
  listReportGroups: vi.fn(),
}));
vi.mock("../app/server/data.server", async (original) => ({
  ...(await original<typeof import("../app/server/data.server")>()),
  getVisibleStreamer: vi.fn(),
  getStreamer: vi.fn(),
  getOwnStreamer: vi.fn(),
  getEntry: vi.fn(),
  listEntries: vi.fn(),
  listStreamers: vi.fn(),
  countStreamers: vi.fn(),
  getOverlaySnapshot: vi.fn(),
}));
vi.mock("../app/server/schedule.server", async (original) => ({
  ...(await original<typeof import("../app/server/schedule.server")>()),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  listTopicChoices: vi.fn(),
}));
vi.mock("../app/server/community.server", async (original) => ({
  ...(await original<typeof import("../app/server/community.server")>()),
  listCards: vi.fn(),
}));
vi.mock("../app/server/support.server", async (original) => ({
  ...(await original<typeof import("../app/server/support.server")>()),
  getSupport: vi.fn(),
}));
vi.mock("../app/server/overlay.server", async (original) => ({
  ...(await original<typeof import("../app/server/overlay.server")>()),
  getOverlayState: vi.fn(),
  getOverlayData: vi.fn(),
}));
vi.mock("../app/server/dock-key.server", async (original) => ({
  ...(await original<typeof import("../app/server/dock-key.server")>()),
  hasDockKey: vi.fn(),
}));
vi.mock("../app/server/overlay-layouts.server", async (original) => ({
  ...(await original<typeof import("../app/server/overlay-layouts.server")>()),
  getLayouts: vi.fn(),
}));
vi.mock("../app/server/overlay-key.server", async (original) => ({
  ...(await original<typeof import("../app/server/overlay-key.server")>()),
  overlayKeyOutputs: vi.fn(),
  overlayKeyOutput: vi.fn(),
}));
vi.mock("../app/server/channels.server", async (original) => ({
  ...(await original<typeof import("../app/server/channels.server")>()),
  listConnections: vi.fn(),
}));
vi.mock("../app/server/api/account", async (original) => ({
  ...(await original<typeof import("../app/server/api/account")>()),
  signInProvider: vi.fn(),
}));
vi.mock("../app/server/featured-streamer.server", async (original) => ({
  ...(await original<typeof import("../app/server/featured-streamer.server")>()),
  getFeaturedStreamer: vi.fn(),
}));
// The route tests have no database. The loader then has no stored translations.
vi.mock("../app/server/entry-translation.server", async (original) => ({
  ...(await original<typeof import("../app/server/entry-translation.server")>()),
  attachEntryTranslations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../app/server/page-translation.server", async (original) => ({
  ...(await original<typeof import("../app/server/page-translation.server")>()),
  attachAboutTranslations: vi.fn().mockResolvedValue(undefined),
  attachPageTranslations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../app/server/ai.server", async (original) => ({
  ...(await original<typeof import("../app/server/ai.server")>()),
  aiInterestStatus: vi.fn(),
}));

const now: number = 1_800_000_000_000;
const viewer: Viewer = {
  id: "owner",
  name: "Owner",
  avatar: null,
  avatarPreset: null,
  locale: null,
  displayPrefs: null,
  keepOriginal: [],
};
const streamer: Streamer = {
  id: "page",
  ownerId: "owner",
  handle: "zed",
  name: "Zed",
  about: "Public page biography",
  avatar: null,
  background: null,
  logo: null,
  ownerAvatarPreset: null,
  isOfficial: false,
  status: "active",
  statusReason: null,
  statusChangedAt: null,
  handleChangedAt: null,
};
const entry: Entry = {
  id: "topic",
  streamerId: "page",
  authorId: "author",
  author: "Author",
  avatar: null,
  avatarPreset: null,
  kind: "topic",
  title: "A public topic",
  body: "A public discussion",
  category: "Gaming",
  createdAt: now,
  endsAt: null,
  revealed: false,
  options: [],
  counts: null,
  total: 0,
  likes: 0,
  dislikes: 0,
  comments: 0,
  reaction: 0,
  myVote: null,
  status: null,
  statusReason: null,
  reported: false,
  mash: null,
};
const event: StreamEvent = {
  id: "event",
  seriesId: null,
  title: "Next stream",
  notes: "",
  startsAt: now + 60_000,
  durationMin: 60,
  platform: "twitch",
  url: "https://twitch.tv/zed",
  status: "scheduled",
  vodUrl: null,
  repeatDays: 0,
  repeatUntil: null,
  tz: "UTC",
  topics: [],
  alsoOn: [],
  category: null,
  image: null,
  updatedAt: now,
  sequence: 0,
};
const ready: StepUpStatus = {
  mode: "enforce",
  keys: 2,
  requiredKeys: 2,
  verifiedAt: now,
  freshUntil: now + 900_000,
  canRegister: true,
  registerBlock: "none",
  need: "none",
  serverNow: now,
};
const initial: LiveSnapshot = { type: "snapshot", revision: 3, serverNow: now, polls: [] };

function args(
  path: string,
  params: Record<string, string | undefined> = {},
  headers?: HeadersInit,
): LoaderFunctionArgs {
  const request: Request = new Request(`https://stream.example.test${path}`, { headers });
  const context = new RouterContextProvider();
  context.set(appContext, {
    env: {
      APP_ORIGIN: "https://stream.example.test",
      GOOGLE_CLIENT_ID: "public-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    } as AppEnv,
    nonce: "test",
    responseHeaders: new Headers(),
  });
  return { request, context, params, url: new URL(request.url), pattern: path.split("?")[0] };
}

function signedIn(person: Viewer = viewer): void {
  vi.mocked(auth.getViewerSession).mockResolvedValue({ viewer: person, sessionId: "session" });
}

beforeEach((): void => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(auth.getViewerSession).mockResolvedValue(null);
  vi.mocked(access.isAdmin).mockResolvedValue(false);
  vi.mocked(access.listApplications).mockResolvedValue({ applications: [], nextCursor: null });
  vi.mocked(stepup.getStepUpStatus).mockResolvedValue(ready);
  vi.mocked(stepup.listKeys).mockResolvedValue([]);
  vi.mocked(stepup.requireAdminSession).mockResolvedValue({ viewer, sessionId: "session", stepUp: "fresh" });
  vi.mocked(reports.listReportGroups).mockResolvedValue({ groups: [], next: null });
  vi.mocked(moderation.listModerationPages).mockResolvedValue({ pages: [], nextCursor: null });
  vi.mocked(data.getVisibleStreamer).mockResolvedValue(streamer);
  vi.mocked(data.getStreamer).mockResolvedValue(streamer);
  vi.mocked(data.getOwnStreamer).mockResolvedValue(null);
  vi.mocked(data.getEntry).mockResolvedValue(null);
  vi.mocked(data.listEntries).mockImplementation((_env, page) =>
    Promise.resolve({
      streamer: page,
      entries: [],
      nextCursor: null,
      revision: 0,
      serverNow: now,
    }),
  );
  vi.mocked(data.listStreamers).mockResolvedValue({ streamers: [streamer], nextCursor: null });
  vi.mocked(data.countStreamers).mockResolvedValue(1);
  vi.mocked(data.getOverlaySnapshot).mockResolvedValue(initial);
  vi.mocked(schedule.listEvents).mockResolvedValue([]);
  vi.mocked(schedule.getEvent).mockResolvedValue(null);
  vi.mocked(schedule.listTopicChoices).mockResolvedValue([]);
  vi.mocked(community.listCards).mockResolvedValue([]);
  vi.mocked(support.getSupport).mockResolvedValue({ links: [], visible: false, card: false });
  vi.mocked(overlay.getOverlayState).mockResolvedValue(DEFAULT_OVERLAY);
  vi.mocked(overlay.getOverlayData).mockResolvedValue({ polls: [], topics: [], cards: [], next: null, support: null });
  vi.mocked(overlayKey.overlayKeyOutputs).mockResolvedValue({ horizontal: false, vertical: false });
  vi.mocked(overlayLayouts.getLayouts).mockResolvedValue(EMPTY_LAYOUTS);
  vi.mocked(dockKey.hasDockKey).mockResolvedValue(false);
  vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue(null);
  vi.mocked(channels.listConnections).mockResolvedValue([]);
  vi.mocked(account.signInProvider).mockResolvedValue(null);
  vi.mocked(featured.getFeaturedStreamer).mockResolvedValue(null);
});

afterEach((): void => {
  vi.restoreAllMocks();
  setLocaleSource(() => "en");
});

describe("admin route authorization and view queries", (): void => {
  it("returns a signed-out screen before checking roles or loading private lists", async (): Promise<void> => {
    const result = await adminRoute.loader(args("/admin?view=reports&status=resolved"));
    expect(result).toMatchObject({
      screen: "signed-out",
      view: "reports",
      reportFilter: "resolved",
      queue: null,
      groups: null,
    });
    expect(result.providers).toEqual(["google"]);
    expect(access.isAdmin).not.toHaveBeenCalled();
    expect(stepup.requireAdminSession).not.toHaveBeenCalled();
  });

  it("hides admin from authenticated non-admins", async (): Promise<void> => {
    signedIn();
    await expect(adminRoute.loader(args("/admin"))).rejects.toMatchObject({ status: 404 });
    expect(stepup.getStepUpStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["keys", "setup"],
    ["step_up", "gate"],
  ] as const)("requires %s before private queues are loaded", async (need, screen): Promise<void> => {
    signedIn();
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    vi.mocked(stepup.getStepUpStatus).mockResolvedValue({ ...ready, need });
    expect(await adminRoute.loader(args("/admin"))).toMatchObject({ screen, stepUp: { need } });
    expect(stepup.requireAdminSession).not.toHaveBeenCalled();
    expect(access.listApplications).not.toHaveBeenCalled();
  });

  it.each([
    [null, "pending"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["unknown", "pending"],
  ] as const)("loads the request queue for status %s", async (requested, expected): Promise<void> => {
    signedIn();
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    const result = await adminRoute.loader(args(`/admin?view=unknown${requested ? `&status=${requested}` : ""}`));
    expect(result).toMatchObject({ screen: "admin", view: "requests", status: expected, queue: { applications: [] } });
    expect(access.listApplications).toHaveBeenCalledWith(expect.anything(), { status: expected, cursor: null });
    expect(stepup.requireAdminSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["resolved", "resolved"],
    ["all", "all"],
    ["bad", "open"],
  ] as const)("validates the report filter %s and trims the query", async (requested, expected): Promise<void> => {
    signedIn();
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    const result = await adminRoute.loader(args(`/admin?view=reports&status=${requested}&query=%20Zed%20`));
    expect(result).toMatchObject({ reportFilter: expected, reportQuery: "Zed", groups: { groups: [] } });
    expect(reports.listReportGroups).toHaveBeenCalledWith(expect.anything(), "owner", {
      group: "streamer",
      status: expected,
      query: "Zed",
      cursor: null,
    });
  });

  it("drops an overlong report search without losing its valid status", async (): Promise<void> => {
    signedIn();
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    const result = await adminRoute.loader(args(`/admin?view=reports&status=all&query=${"x".repeat(61)}`));
    expect(result.reportQuery).toBe("");
    expect(reports.listReportGroups).toHaveBeenCalledWith(expect.anything(), "owner", {
      group: "streamer",
      status: "all",
    });
  });

  it.each([
    ["frozen", "Zed", "frozen", "Zed"],
    ["bad", "Zed", "all", ""],
    ["active", "x".repeat(61), "all", ""],
  ])(
    "validates moderation page status %s and query",
    async (status, query, expectedStatus, expectedQuery): Promise<void> => {
      signedIn();
      vi.mocked(access.isAdmin).mockResolvedValue(true);
      const result = await adminRoute.loader(args(`/admin?view=pages&status=${status}&query=${query}`));
      expect(result).toMatchObject({ pageFilter: expectedStatus, pageQuery: expectedQuery, pages: { pages: [] } });
      expect(moderation.listModerationPages).toHaveBeenCalledWith(expect.anything(), "owner", {
        status: expectedStatus,
        query: expectedQuery,
        cursor: null,
      });
    },
  );

  it("loads default page filters and keys without an application queue", async (): Promise<void> => {
    signedIn();
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    expect(await adminRoute.loader(args("/admin?view=pages"))).toMatchObject({ pageFilter: "all", pageQuery: "" });
    expect(await adminRoute.loader(args("/admin?view=keys"))).toMatchObject({
      view: "keys",
      screen: "admin",
      queue: null,
    });
    expect(access.listApplications).not.toHaveBeenCalled();
  });
});

describe("streamer route data and visibility", (): void => {
  it.each([undefined, "zed"])(
    "rejects invalid handle segment %s before querying storage",
    async (handle): Promise<void> => {
      await expect(streamerRoute.loader(args("/zed", { handle }))).rejects.toMatchObject({ status: 404 });
      expect(data.getVisibleStreamer).not.toHaveBeenCalled();
    },
  );

  it("passes anonymous identity to the visibility gate and preserves its 404", async (): Promise<void> => {
    vi.mocked(data.getVisibleStreamer).mockResolvedValue(null);
    await expect(streamerRoute.loader(args("/@zed", { handle: "@zed" }))).rejects.toMatchObject({ status: 404 });
    expect(data.getVisibleStreamer).toHaveBeenCalledWith(expect.anything(), "zed", null);
    expect(data.listEntries).not.toHaveBeenCalled();
  });

  it("defaults invalid views, sort and status on ordinary public pages", async (): Promise<void> => {
    const result = await streamerRoute.loader(args("/@zed?view=unknown&sort=bad&status=planned", { handle: "@zed" }));
    expect(result).toMatchObject({
      view: "topics",
      sort: "top",
      query: "",
      status: null,
      viewer: null,
      moderator: false,
      mode: "feed",
    });
    expect(data.listEntries).toHaveBeenCalledWith(expect.anything(), streamer, null, {
      kind: "topics",
      sort: "top",
      query: "",
      status: null,
      cursor: null,
    });
  });

  it("loads community cards only for ordinary community pages", async (): Promise<void> => {
    const result = await streamerRoute.loader(
      args("/@zed?view=community&query=hello&sort=newest&intent=vote", { handle: "@zed" }),
    );
    expect(result).toMatchObject({ view: "community", cards: [], query: "hello", sort: "newest", intent: "vote" });
    expect(community.listCards).toHaveBeenCalledWith(expect.anything(), "page");
  });

  it("resolves an owner's off-range schedule event and topic choices", async (): Promise<void> => {
    signedIn();
    vi.mocked(schedule.getEvent).mockResolvedValue(event);
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    const result = await streamerRoute.loader(args("/@zed?view=schedule&mode=week&event=event", { handle: "@zed" }));
    expect(result).toMatchObject({
      view: "schedule",
      mode: "week",
      openEvent: "event",
      linkedEvent: event,
      moderator: true,
      topicChoices: [],
    });
    expect(schedule.getEvent).toHaveBeenCalledWith(expect.anything(), "event", now, "page");
    expect(schedule.listTopicChoices).toHaveBeenCalledWith(expect.anything(), "page");
    expect(data.getVisibleStreamer).toHaveBeenCalledWith(expect.anything(), "zed", "owner");
  });

  it("does not refetch an event already in the schedule or load owner controls for visitors", async (): Promise<void> => {
    signedIn({ ...viewer, id: "visitor" });
    vi.mocked(schedule.listEvents).mockResolvedValue([event]);
    const result = await streamerRoute.loader(args("/@zed?view=schedule&event=event&mode=invalid", { handle: "@zed" }));
    expect(result).toMatchObject({ mode: "feed", linkedEvent: null, events: [event], topicChoices: [] });
    expect(schedule.getEvent).not.toHaveBeenCalled();
    expect(schedule.listTopicChoices).not.toHaveBeenCalled();
  });

  it.each(["choice", "topic"] as const)(
    "selecting a %s chooses its board even from another view",
    async (kind): Promise<void> => {
      const selected: Entry = { ...entry, kind };
      vi.mocked(data.getEntry).mockResolvedValue(selected);
      const result = await streamerRoute.loader(args("/@zed?view=about&entry=topic", { handle: "@zed" }));
      expect(result).toMatchObject({
        selected,
        view: kind === "topic" ? "topics" : "polls",
        sort: kind === "topic" ? "top" : "newest",
      });
      expect(data.getEntry).toHaveBeenCalledWith(expect.anything(), "topic", null);
    },
  );

  it.each([null, { ...entry, streamerId: "other-page" }])(
    "rejects missing or cross-page selected conversations",
    async (selected): Promise<void> => {
      vi.mocked(data.getEntry).mockResolvedValue(selected);
      await expect(streamerRoute.loader(args("/@zed?entry=topic", { handle: "@zed" }))).rejects.toMatchObject({
        status: 404,
      });
      expect(data.listEntries).not.toHaveBeenCalled();
    },
  );

  it("restricts official views and keeps supported idea status filters", async (): Promise<void> => {
    const official: Streamer = { ...streamer, isOfficial: true };
    vi.mocked(data.getVisibleStreamer).mockResolvedValue(official);
    const result = await streamerRoute.loader(
      args("/@zed?view=schedule&event=event&status=planned&sort=top", { handle: "@zed" }),
    );
    expect(result).toMatchObject({ view: "topics", status: "planned", events: [], linkedEvent: null });
    expect(schedule.listEvents).not.toHaveBeenCalled();
    expect(schedule.getEvent).not.toHaveBeenCalled();
    vi.mocked(data.getVisibleStreamer).mockResolvedValue(official);
    expect(await streamerRoute.loader(args("/@zed?view=community&status=bad", { handle: "@zed" }))).toMatchObject({
      view: "community",
      status: null,
      cards: null,
    });
    expect(community.listCards).not.toHaveBeenCalled();
  });
});

describe("overlay loader contracts", (): void => {
  it.each([undefined, "zed"])("rejects invalid overlay handles %s", async (handle): Promise<void> => {
    await expect(overlayRoute.loader(args("/zed/overlay", { handle }))).rejects.toMatchObject({ status: 404 });
    expect(data.getStreamer).not.toHaveBeenCalled();
  });

  it.each([null, { ...streamer, status: "suspended" as const }])(
    "hides absent or suspended overlays",
    async (page): Promise<void> => {
      vi.mocked(data.getStreamer).mockResolvedValue(page);
      await expect(overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }))).rejects.toMatchObject({
        status: 404,
      });
      expect(overlay.getOverlayState).not.toHaveBeenCalled();
    },
  );

  const cell = (r: number): { c: number; r: number; w: number; h: number } => ({ c: 6, r, w: 4, h: 2 });
  /** The poll, the topic and the card layer on stream in the horizontal orientation. */
  const layers: OverlayLayers = {
    ...DEFAULT_LAYERS,
    items: {
      ...DEFAULT_LAYERS.items,
      topic: { ...DEFAULT_LAYERS.items.topic, ref: "layer-topic" },
      card: { ...DEFAULT_LAYERS.items.card, ref: "layer-card" },
    },
    cells: {
      ...DEFAULT_LAYERS.cells,
      horizontal: { ...DEFAULT_LAYERS.cells.horizontal, poll: cell(0), topic: cell(2), card: cell(4) },
    },
  };
  const picked: OverlayLayers = {
    ...layers,
    items: { ...layers.items, poll: { ...layers.items.poll, ref: "layer-poll" } },
  };
  const refs = (): (string | null)[] => vi.mocked(data.getOverlaySnapshot).mock.calls.map((call) => call[2]);

  it("loads the automatic poll for a page without saved state and returns the public overlay", async (): Promise<void> => {
    const result = await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }));
    expect(result).toMatchObject({
      handle: "zed",
      name: "Zed",
      host: "stream.example.test",
      origin: "https://stream.example.test",
      override: null,
    });
    expect(result.overlay).toEqual({ ...DEFAULT_OVERLAY, message: "" });
    expect(refs()).toEqual([null]);
    expect(overlay.getOverlayData).toHaveBeenCalledWith(expect.anything(), "page", []);
  });

  it("keeps the message private unless the message layer is on stream", async (): Promise<void> => {
    const state = { ...DEFAULT_OVERLAY, message: "Draft", layers };
    vi.mocked(overlay.getOverlayState).mockResolvedValue(state);
    expect((await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }))).overlay.message).toBe("");
    const cells = { ...layers.cells, horizontal: { ...layers.cells.horizontal, message: cell(6) } };
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...state, layers: { ...layers, cells } });
    expect((await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }))).overlay.message).toBe("Draft");
  });

  it("treats an empty poll override as absent", async (): Promise<void> => {
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...DEFAULT_OVERLAY, layers });
    expect(await overlayRoute.loader(args("/@zed/overlay?poll=", { handle: "@zed" }))).toMatchObject({
      override: null,
    });
    expect(refs()).toEqual([null]);
    expect(overlay.getOverlayData).toHaveBeenCalledWith(expect.anything(), "page", ["layer-topic"]);
  });

  it("rejects missing poll overrides and accepts an existing override", async (): Promise<void> => {
    await expect(overlayRoute.loader(args("/@zed/overlay?poll=missing", { handle: "@zed" }))).rejects.toMatchObject({
      status: 404,
    });
    vi.mocked(data.getOverlaySnapshot).mockResolvedValue({
      ...initial,
      polls: [{ ...entry, id: "override", kind: "choice", byOwner: true }],
    });
    const result = await overlayRoute.loader(args("/@zed/overlay?poll=override", { handle: "@zed" }));
    expect(result.override).toBe("override");
    expect(result.initial.polls.map((poll) => poll.id)).toEqual(["override"]);
    expect(data.getOverlaySnapshot).toHaveBeenLastCalledWith(expect.anything(), "page", "override");
  });

  it("loads the polls and the topic of the content layers on stream", async (): Promise<void> => {
    vi.mocked(data.getOverlaySnapshot).mockImplementation((_env, _id, ref) =>
      Promise.resolve({ ...initial, polls: [{ ...entry, id: ref ?? "auto", kind: "choice", byOwner: true }] }),
    );
    // A poll layer without a ref uses the automatic poll.
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...DEFAULT_OVERLAY, layers });
    let result = await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }));
    expect(refs()).toEqual([null]);
    expect(result.initial.polls.map((poll) => poll.id)).toEqual(["auto"]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", ["layer-topic"]);
    // A poll override shows in the poll layer in place of the content layers: only that poll loads, and no topic.
    vi.mocked(data.getOverlaySnapshot).mockClear();
    result = await overlayRoute.loader(args("/@zed/overlay?poll=override", { handle: "@zed" }));
    expect(refs()).toEqual(["override"]);
    expect(result.initial.polls.map((poll) => poll.id)).toEqual(["override"]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", []);
    // A picked poll loads after the first snapshot.
    vi.mocked(data.getOverlaySnapshot).mockClear();
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...DEFAULT_OVERLAY, layers: picked });
    result = await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }));
    expect(refs()).toEqual([null, "layer-poll"]);
    expect(result.initial.polls.map((poll) => poll.id)).toEqual(["auto", "layer-poll"]);
    // The output that the editor shows does not change the page: a link without a key shows the horizontal output.
    vi.mocked(data.getOverlaySnapshot).mockClear();
    vi.mocked(overlay.getOverlayState).mockResolvedValue({
      ...DEFAULT_OVERLAY,
      layers: { ...picked, orientation: "vertical" },
    });
    result = await overlayRoute.loader(args("/@zed/overlay", { handle: "@zed" }));
    expect(result.output).toBe("horizontal");
    expect(refs()).toEqual([null, "layer-poll"]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", ["layer-topic"]);
  });

  /** The layers of `picked`, and the card layer and the chat on the grid of the vertical output only. */
  const twoOutputs: OverlayLayers = {
    ...picked,
    chat: { ...picked.chat, enabled: true },
    cells: {
      horizontal: { ...picked.cells.horizontal, card: null },
      vertical: { ...DEFAULT_LAYERS.cells.vertical, card: cell(8), chat: { c: 0, r: 20, w: 18, h: 12 } },
    },
  };

  it("takes the output of the page from the key of its link", async (): Promise<void> => {
    vi.mocked(data.getOverlaySnapshot).mockImplementation((_env, _id, ref) =>
      Promise.resolve({ ...initial, polls: [{ ...entry, id: ref ?? "auto", kind: "choice", byOwner: true }] }),
    );
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...DEFAULT_OVERLAY, layers: twoOutputs });
    // The key of the vertical output: only the layers on the vertical grid load their content.
    vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue("vertical");
    let result = await overlayRoute.loader(args("/@zed/overlay?key=vertical-key&layer=content", { handle: "@zed" }));
    expect(overlayKey.overlayKeyOutput).toHaveBeenLastCalledWith(expect.anything(), "page", "vertical-key");
    expect(result.output).toBe("vertical");
    expect(refs()).toEqual([null]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", []);
    // The stored layers go to the page as they are: the page picks the cells of its output.
    expect(result.overlay.layers).toEqual(twoOutputs);
    // The key of the horizontal output.
    vi.mocked(data.getOverlaySnapshot).mockClear();
    vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue("horizontal");
    result = await overlayRoute.loader(args("/@zed/overlay?key=horizontal-key", { handle: "@zed" }));
    expect(result.output).toBe("horizontal");
    expect(refs()).toEqual([null, "layer-poll"]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", ["layer-topic"]);
    // No key, and a key that is wrong or revoked: the horizontal output.
    for (const path of ["/@zed/overlay", "/@zed/overlay?key=revoked"]) {
      vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue(null);
      result = await overlayRoute.loader(args(path, { handle: "@zed" }));
      expect(result.output, path).toBe("horizontal");
    }
    expect(overlayKey.overlayKeyOutput).toHaveBeenCalledWith(expect.anything(), "page", null);
    expect(overlayKey.overlayKeyOutput).toHaveBeenLastCalledWith(expect.anything(), "page", "revoked");
    // A poll override shows in the poll layer of the output of the key.
    vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue("vertical");
    result = await overlayRoute.loader(args("/@zed/overlay?key=vertical-key&poll=override", { handle: "@zed" }));
    expect(result).toMatchObject({ output: "vertical", override: "override" });
  });

  it("renders the cells of the output of the page, and not of the output that the editor shows", async (): Promise<void> => {
    const page = async (
      output: "horizontal" | "vertical" | null,
      editor: "horizontal" | "vertical",
    ): Promise<string> => {
      vi.mocked(overlay.getOverlayState).mockResolvedValue({
        ...DEFAULT_OVERLAY,
        layers: { ...twoOutputs, orientation: editor },
      });
      vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue(output);
      const path: string = output === null ? "/@zed/overlay" : "/@zed/overlay?key=its-key";
      const loaded = await overlayRoute.loader(args(path, { handle: "@zed" }));
      const Stub = createRoutesStub([{ id: "overlay", path: "/:handle/overlay", Component: overlayRoute.default }]);
      return renderToStaticMarkup(
        createElement(Stub, { initialEntries: [path], hydrationData: { loaderData: { overlay: loaded } } }),
      );
    };
    const boxes = (html: string): string[] =>
      [...html.matchAll(/class="ov-layer" data-layer="([a-z]+)"/g)].map((match: RegExpMatchArray): string => match[1]);
    for (const editor of ["horizontal", "vertical"] as const) {
      const vertical: string = await page("vertical", editor);
      expect(boxes(vertical), editor).toEqual(["card", "chat"]);
      // The frame of the vertical output is 1080 × 1920.
      expect(vertical, editor).toContain("width:1080px;height:1920px");
      for (const html of [await page("horizontal", editor), await page(null, editor)]) {
        expect(boxes(html), editor).toEqual(["poll", "topic"]);
        expect(html, editor).toContain("width:1920px;height:1080px");
      }
    }
  });

  it("shows one part of the output alone for a link with a layer parameter", async (): Promise<void> => {
    // Streamer tools no longer shows a link for each layer. A link that OBS already has must continue to work.
    vi.mocked(overlay.getOverlayState).mockResolvedValue({ ...DEFAULT_OVERLAY, layers: twoOutputs });
    vi.mocked(overlayKey.overlayKeyOutput).mockResolvedValue("vertical");
    const page = async (query: string): Promise<string> => {
      const path: string = `/@zed/overlay?key=its-key${query}`;
      const loaded = await overlayRoute.loader(args(path, { handle: "@zed" }));
      const Stub = createRoutesStub([{ id: "overlay", path: "/:handle/overlay", Component: overlayRoute.default }]);
      return renderToStaticMarkup(
        createElement(Stub, { initialEntries: [path], hydrationData: { loaderData: { overlay: loaded } } }),
      );
    };
    const boxes = (html: string): string[] =>
      [...html.matchAll(/class="ov-layer" data-layer="([a-z]+)"/g)].map((match: RegExpMatchArray): string => match[1]);
    // Without the parameter: the composition of the output.
    const all: string = await page("");
    expect(boxes(all)).toEqual(["card", "chat"]);
    expect(all).not.toContain("data-overlay-only");
    // The chat alone fills the page: it does not use the canvas of the output.
    const chat: string = await page("&layer=chat");
    expect(chat).toContain('data-overlay-only="chat"');
    expect(boxes(chat)).toEqual(["chat"]);
    expect(chat).toContain('class="overlay-screen ov-screen"');
    // The content layers alone stay at their cells in the canvas of the output.
    const content: string = await page("&layer=content");
    expect(content).toContain('data-overlay-only="content"');
    expect(boxes(content)).toEqual(["card"]);
    expect(content).toContain("width:1080px;height:1920px");
    // The characters layer is off stream in these layers: its source shows nothing.
    const characters: string = await page("&layer=characters");
    expect(characters).toContain('data-overlay-only="characters"');
    expect(boxes(characters)).toEqual([]);
    // An unknown layer shows an empty page, never an error.
    const unknown: string = await page("&layer=nope");
    expect(unknown).toMatch(/<main class="overlay-screen ov-screen" id="main-content" aria-label="[^"]*"><\/main>/);
  });

  it("sends the old Overlay control address to Streamer tools for good", (): void => {
    const moved = (path: string): string | null => {
      const response: Response = legacyControlRoute.loader(args(path));
      expect(response.status).toBe(301);
      return response.headers.get("Location");
    };
    expect(moved("/overlay-control")).toBe("/tools?view=overlay");
    // An old channel callback link opens the Channels section and keeps its result.
    expect(moved("/overlay-control?channel=twitch&result=connected")).toBe(
      "/tools?channel=twitch&result=connected&view=channels",
    );
    expect(moved("/overlay-control?view=channels")).toBe("/tools?view=channels");
    expect(moved("/overlay-control?view=unknown")).toBe("/tools?view=overlay");
    expect(moved("/overlay-control?view=live")).toBe("/tools?view=live");
  });

  it("redirects signed-out control users and returns 404 to users without a page", async (): Promise<void> => {
    const expectedHeaders: unknown = expect.any(Headers);
    await expect(controlRoute.loader(args("/tools"))).rejects.toMatchObject({
      status: 302,
      headers: expectedHeaders,
    });
    expect(data.getOwnStreamer).not.toHaveBeenCalled();
    signedIn();
    await expect(controlRoute.loader(args("/tools"))).rejects.toMatchObject({ status: 404 });
  });

  it("loads the picked poll and topic for the control page, also while their layers are off stream", async (): Promise<void> => {
    signedIn();
    vi.mocked(data.getOwnStreamer).mockResolvedValue(streamer);
    // The vertical orientation has no content layer on the grid. The pickers still need their entries.
    vi.mocked(overlay.getOverlayState).mockResolvedValue({
      ...DEFAULT_OVERLAY,
      layers: { ...picked, orientation: "vertical" },
    });
    vi.mocked(data.getOverlaySnapshot).mockImplementation((_env, _id, ref) =>
      Promise.resolve({
        ...initial,
        polls: [
          { ...entry, id: "recent", kind: "choice", byOwner: true },
          ...(ref ? [{ ...entry, id: ref, kind: "choice" as const, byOwner: true }] : []),
        ],
      }),
    );
    const result = await controlRoute.loader(args("/tools"));
    expect(result.initial.polls.map((poll) => poll.id)).toEqual(["recent", "layer-poll"]);
    expect(refs()).toEqual([null, "layer-poll"]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", ["layer-topic"]);
    expect(result).toMatchObject({
      handle: "zed",
      host: "stream.example.test",
      origin: "https://stream.example.test",
      hasOverlayKey: { horizontal: false, vertical: false },
      layouts: EMPTY_LAYOUTS,
      hasDockKey: false,
      channels: [],
    });
    expect(result.state.layers).toEqual({ ...picked, orientation: "vertical" });
  });

  it("loads only the automatic poll and no topic for a control page without picked entries", async (): Promise<void> => {
    signedIn();
    vi.mocked(data.getOwnStreamer).mockResolvedValue(streamer);
    await controlRoute.loader(args("/tools"));
    expect(refs()).toEqual([null]);
    expect(overlay.getOverlayData).toHaveBeenLastCalledWith(expect.anything(), "page", []);
  });
});

describe("directory, sign-in and root server boundaries", (): void => {
  it("loads a featured community only for an unfiltered directory", async (): Promise<void> => {
    expect(await directoryRoute.loader(args("/streamers"))).toMatchObject({
      query: "",
      total: 1,
      streamers: [streamer],
      intent: null,
    });
    expect(featured.getFeaturedStreamer).toHaveBeenCalledOnce();
    const query: string = "z".repeat(65);
    const result = await directoryRoute.loader(args(`/streamers?query=%20@${query}%20&then=discuss`));
    expect(result).toMatchObject({ query: "z".repeat(60), intent: "discuss", featured: null });
    expect(data.listStreamers).toHaveBeenLastCalledWith(expect.anything(), null, "z".repeat(60));
    expect(data.countStreamers).toHaveBeenLastCalledWith(expect.anything(), "z".repeat(60));
    expect(featured.getFeaturedStreamer).toHaveBeenCalledOnce();
  });

  it.each([
    ["account_not_linked", "signup.sameEmail"],
    ["account_already_linked_to_different_user", "signup.owned"],
    ["INVALID_DISPLAY_NAME", "signup.nameCorrection"],
    ["ELIGIBILITY_REQUIRED", "signup.eligibility"],
    ["reauth_required", "loginMethods.reauthenticate"],
    ["unable_to_link_account", "loginMethods.failed"],
    ["unknown", "signIn.failed"],
  ])("maps OAuth failure %s to its safe public message", (error, expected): void => {
    expect(signInRoute.loader(args(`/sign-in?error=${error}&next=%2F%40zed%3Fview%3Dpolls`))).toEqual({
      providers: ["google"],
      error: expected,
      next: "/@zed?view=polls",
    });
  });

  it.each(["", "https://other.test", "//other.test/path", "/\\other.test", "/path\nother"])(
    "refuses unsafe or absent return path %s",
    (next): void => {
      expect(signInRoute.loader(args(`/sign-in?next=${encodeURIComponent(next)}`))).toMatchObject({
        error: null,
        next: "/settings",
      });
    },
  );

  it("passes request identity and server time to the AI interest service", async (): Promise<void> => {
    const input: LoaderFunctionArgs = args("/ai", {}, { "CF-Connecting-IP": "192.0.2.1" });
    const status: ai.AiInterestStatus = { available: true, totals: { up: 4, down: 1 }, mine: "up" };
    vi.mocked(ai.aiInterestStatus).mockResolvedValue(status);
    expect(await aiRoute.loader(input)).toBe(status);
    expect(ai.aiInterestStatus).toHaveBeenCalledWith(input.context.get(appContext).env, input.request, now);
  });

  it("resolves anonymous locale/preferences and caches a session across nested loaders", async (): Promise<void> => {
    const input: LoaderFunctionArgs = args(
      "/admin",
      {},
      {
        Cookie: `sb_locale=de; sb_prefs=${encodeURIComponent(JSON.stringify({ contrast: "high" }))}`,
        "Accept-Language": "ja",
      },
    );
    const shell = await rootRoute.loader(input);
    expect(shell).toMatchObject({
      viewer: null,
      admin: false,
      ownStreamer: null,
      locale: "de",
      prefs: { contrast: "high" },
      origin: "https://stream.example.test",
    });
    expect(input.context.get(appContext).locale).toBe("de");
    await adminRoute.loader(input);
    expect(auth.getViewerSession).toHaveBeenCalledOnce();
  });

  it("prefers account settings and returns only the owner's shell page summary", async (): Promise<void> => {
    signedIn({ ...viewer, locale: "uk", displayPrefs: { motion: "reduce" } });
    vi.mocked(access.isAdmin).mockResolvedValue(true);
    vi.mocked(data.getOwnStreamer).mockResolvedValue({
      ...streamer,
      status: "suspended",
      statusReason: "moderation",
      statusChangedAt: now,
    });
    const result = await rootRoute.loader(args("/streamers", {}, { Cookie: "sb_locale=de", "Accept-Language": "ja" }));
    expect(result).toMatchObject({
      locale: "uk",
      prefs: { motion: "reduce" },
      admin: true,
      ownStreamer: {
        handle: "zed",
        name: "Zed",
        status: "suspended",
        statusReason: "moderation",
        statusChangedAt: now,
      },
    });
    expect(result.ownStreamer).not.toHaveProperty("ownerId");
  });
});

describe("route revalidation contracts", (): void => {
  function navigation(
    current: string,
    next: string,
    fallback: boolean,
    formMethod?: "POST",
  ): ShouldRevalidateFunctionArgs {
    return {
      currentUrl: new URL(`https://stream.example.test${current}`),
      nextUrl: new URL(`https://stream.example.test${next}`),
      currentParams: {},
      nextParams: {},
      defaultShouldRevalidate: fallback,
      formMethod,
    };
  }

  it.each([true, false])("preserves router fallback %s for submissions and explicit refreshes", (fallback): void => {
    for (const revalidate of [rootRoute.shouldRevalidate, streamerRoute.shouldRevalidate]) {
      expect(revalidate(navigation("/@zed", "/@zed?view=polls", fallback, "POST"))).toBe(fallback);
      expect(revalidate(navigation("/@zed", "/@zed", fallback))).toBe(fallback);
    }
  });

  it("retains shell data across navigation and ignores dialog-only streamer URL changes", (): void => {
    expect(rootRoute.shouldRevalidate(navigation("/streamers", "/@zed", true))).toBe(false);
    expect(
      streamerRoute.shouldRevalidate(
        navigation("/@zed?view=polls&discussion=a", "/@zed?view=polls&dialog=profile", true),
      ),
    ).toBe(false);
    expect(streamerRoute.shouldRevalidate(navigation("/@zed", "/@zed?view=polls", true))).toBe(true);
    expect(streamerRoute.shouldRevalidate(navigation("/@zed", "/@other", false))).toBe(false);
  });
});

describe("public route metadata", (): void => {
  async function streamerMetaArgs(
    loaded: Awaited<ReturnType<typeof streamerRoute.loader>>,
    origin: string = "https://stream.example.test",
  ): Promise<Parameters<typeof streamerRoute.meta>[0]> {
    const shell = await rootRoute.loader(args("/@zed"));
    return {
      loaderData: loaded,
      params: { handle: "@zed" },
      location: { pathname: "/@zed", search: "?dialog=profile", hash: "", key: "test", state: null },
      matches: [
        { id: "root", pathname: "/", params: {}, loaderData: { ...shell, origin }, meta: [] },
        { id: "routes/streamer", pathname: "/@zed", params: { handle: "@zed" }, loaderData: loaded, meta: [] },
      ],
    };
  }

  it("returns a neutral title on failed streamer loads and noindex for suspended pages", async (): Promise<void> => {
    const publicPage = await streamerRoute.loader(args("/@zed", { handle: "@zed" }));
    expect(streamerRoute.meta({ ...(await streamerMetaArgs(publicPage)), loaderData: undefined })).toEqual([
      { title: "StreamBullets" },
    ]);
    vi.mocked(data.getVisibleStreamer).mockResolvedValue({ ...streamer, status: "suspended" });
    const loaded = await streamerRoute.loader(args("/@zed", { handle: "@zed" }));
    expect(streamerRoute.meta(await streamerMetaArgs(loaded))).toEqual([
      { title: "Zed · StreamBullets" },
      { name: "robots", content: "noindex" },
    ]);
  });

  it("uses selected conversation identity for canonical links and structured postings", async (): Promise<void> => {
    vi.mocked(data.getEntry).mockResolvedValue(entry);
    const loaded = await streamerRoute.loader(args("/@zed?entry=topic&dialog=profile", { handle: "@zed" }));
    const metadata = streamerRoute.meta(await streamerMetaArgs(loaded));
    expect(metadata).toContainEqual({ title: "A public topic · Zed · StreamBullets" });
    expect(metadata).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://stream.example.test/@zed?entry=topic",
    });
    expect(metadata).toContainEqual({ name: "description", content: "Public page biography" });
    const expectedDiscussion: unknown = expect.objectContaining({
      "@type": "DiscussionForumPosting",
      headline: entry.title,
      url: "https://stream.example.test/@zed?view=topics&entry=topic",
    });
    expect(metadata).toContainEqual({
      "script:ld+json": expectedDiscussion,
    });
  });

  it("uses loaded and linked event identities for schedule canonicals", async (): Promise<void> => {
    vi.mocked(schedule.listEvents).mockResolvedValue([event]);
    let loaded = await streamerRoute.loader(args("/@zed?view=schedule&event=event", { handle: "@zed" }));
    expect(streamerRoute.meta(await streamerMetaArgs(loaded))).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://stream.example.test/@zed?view=schedule&event=event",
    });
    vi.mocked(schedule.listEvents).mockResolvedValue([]);
    vi.mocked(schedule.getEvent).mockResolvedValue(event);
    loaded = await streamerRoute.loader(args("/@zed?view=schedule&event=event", { handle: "@zed" }));
    expect(streamerRoute.meta(await streamerMetaArgs(loaded))).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://stream.example.test/@zed?view=schedule&event=event",
    });
    loaded = await streamerRoute.loader(args("/@zed?view=schedule", { handle: "@zed" }));
    expect(streamerRoute.meta(await streamerMetaArgs(loaded))).toContainEqual({
      tagName: "link",
      rel: "canonical",
      href: "https://stream.example.test/@zed?view=schedule",
    });
  });

  it("falls back to the public tagline and relative structured links without an origin", async (): Promise<void> => {
    vi.mocked(data.getVisibleStreamer).mockResolvedValue({ ...streamer, about: "" });
    const loaded = await streamerRoute.loader(args("/@zed", { handle: "@zed" }));
    const input = await streamerMetaArgs(loaded, "");
    const metadata = streamerRoute.meta(input);
    const expectedDescription: unknown = expect.stringContaining("Zed");
    expect(metadata).toContainEqual({ name: "description", content: expectedDescription });
    const expectedPerson: unknown = expect.objectContaining({ "@type": "Person", url: "/@zed" });
    expect(metadata).toContainEqual({ "script:ld+json": expectedPerson });
    expect(metadata.some((item) => "rel" in item && item.rel === "canonical")).toBe(false);
  });

  it("keeps public page canonicals independent of UI search parameters", async (): Promise<void> => {
    const shell = await rootRoute.loader(args("/streamers"));
    const input: MetaArgs = {
      loaderData: undefined,
      params: {},
      location: { pathname: "/streamers", search: "?query=private&dialog=profile", hash: "", key: "test", state: null },
      matches: [{ id: "root", pathname: "/", params: {}, loaderData: shell, meta: [] }],
    };
    for (const [meta, path] of [
      [homeRoute.meta, "/"],
      [directoryRoute.meta, "/streamers"],
      [aiRoute.meta, "/ai"],
      [commandsRoute.meta, "/commands"],
      [privacyRoute.meta, "/privacy"],
      [termsRoute.meta, "/terms"],
    ] as const) {
      expect(meta(input)).toContainEqual({
        tagName: "link",
        rel: "canonical",
        href: `https://stream.example.test${path}`,
      });
      expect(meta({ ...input, matches: [] }).some((item) => "rel" in item && item.rel === "canonical")).toBe(false);
    }
  });

  it("localizes private page titles and excludes them from indexing", async (): Promise<void> => {
    await loadCatalog("de");
    setLocaleSource(() => "de");
    for (const meta of [adminRoute.meta, signInRoute.meta, controlRoute.meta]) {
      expect(meta()).toContainEqual({ name: "robots", content: "noindex" });
      const expectedTitle: unknown = expect.stringContaining("StreamBullets");
      expect(meta()).toContainEqual({ title: expectedTitle });
    }
    expect(signInRoute.meta()[0]).toEqual({ title: "Anmelden oder registrieren · StreamBullets" });
  });
});
