import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayStage, overlayPoll, type OverlayPoll } from "../app/components/overlay/overlay-stage";
import type { AppEnv } from "../app/env";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { atMark } from "../app/lib/clock";
import { MASH_COUNTDOWN_MS } from "../app/lib/mash";
import { ALERT_REFUSALS, type AlertRefusal, type AlertsReply } from "../app/lib/alert-control";
import { DEFAULT_RULES } from "../app/lib/alerts";
import { CHAT_TEST_MS } from "../app/lib/chat-test";
import { legacyLayersText, parseStoredLayers } from "../app/lib/overlay-legacy";
import {
  DEFAULT_LAYERS,
  STORED_LAYERS_LENGTH,
  emptyCells,
  onAnyOutput,
  storedLayersSchema,
  storedLayersText,
  type CellRect,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import { EMPTY_LAYOUTS, LAYOUT_LIMIT, presetCells, type OverlayLayouts } from "../app/lib/overlay-layouts";
import { mashValue } from "../app/server/mash-sql";
import { runMashAction } from "../app/server/mash.server";
import { DEFAULT_OVERLAY, overlayPublic, overlayValue, type OverlayRow } from "../app/server/overlay-state";
import {
  getOverlayData,
  getOverlayState,
  nextOverlayState,
  storedWrites as parseStoredWrites,
  updateOverlay,
  type OverlayUpdate,
} from "../app/server/overlay.server";
import type { OverlayData, OverlayState, StreamEvent } from "../app/types";
import { controlLayouts, controlState } from "../app/components/overlay/overlay-control";
import { loader as controlLoader } from "../app/routes/tools";
import { apiCaller } from "./helpers/api";
import { startOfQuotaWindow } from "./helpers/quota";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

// D1 integration checks for battles, overlays, schedules, and Community.

const origin = "https://live.example.test";
const secret = "test-only-secret-5b1e0c9d8a7f6e5d4c3b2a1908f7e6d5";
const day = 86_400_000;
const page = "20000000-0000-4000-8000-000000000001";
const otherPage = "20000000-0000-4000-8000-000000000002";
const poll = "20000000-0000-4000-8000-000000000011";
const topic = "20000000-0000-4000-8000-000000000012";
const card = "20000000-0000-4000-8000-000000000013";
const foreignTopic = "20000000-0000-4000-8000-000000000014";

let database: TestDatabase;
let env: AppEnv;
// Record room API calls as path?streamerId plus JSON body.
let roomCalls: { path: string; body: string }[];
// Record ingest object calls the same way. A playground control and an alert control answer with `ingestReply`.
let ingestCalls: { path: string; body: string }[];
let ingestReply: () => Response;

const { call, cookie, context } = apiCaller(() => env, origin, secret);

async function body<T>(response: Response): Promise<T> {
  return await response.json();
}

async function seed(): Promise<void> {
  const now = Date.now();
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    env.DB.prepare(sql).bind(...values);
  const users = JSON.stringify(["owner", "viewer", "other"]);
  await env.DB.batch([
    run(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
      now,
      users,
    ),
    run(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
      now + day,
      now,
      users,
    ),
    run(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES
        (?1,'owner','live_page','Live','',0,'active'), (?2,'other','other_page','Other','',0,'active')`,
      page,
      otherPage,
    ),
    run(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES
        (?1,?3,'owner','choice','Pick one','["A","B"]',2),
        (?2,?3,'viewer','topic','A topic','[]',1),
        (?4,?5,'other','topic','Elsewhere','[]',1)`,
      poll,
      topic,
      page,
      foreignTopic,
      otherPage,
    ),
    run(
      "INSERT INTO community_cards (id,streamer_id,position,icon,title,body) VALUES (?,?,0,'heart','Card','Body')",
      card,
      page,
    ),
  ]);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    CHANNEL_INGEST: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init: RequestInit): Promise<Response> => {
          const target = new URL(url);
          ingestCalls.push({ path: `${target.pathname}${target.search}`, body: await new Response(init.body).text() });
          const control: boolean = target.pathname === "/playground" || target.pathname === "/alerts";
          return Promise.resolve(control ? ingestReply() : new Response(null, { status: 204 }));
        },
      }),
    } as unknown as DurableObjectNamespace,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (url: string, init: RequestInit): Promise<Response> => {
          const target = new URL(url);
          roomCalls.push({ path: `${target.pathname}${target.search}`, body: await new Response(init.body).text() });
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      }),
    } as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  };
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  roomCalls = [];
  ingestCalls = [];
  ingestReply = (): Response => Response.json({ paused: false, testEndsAt: null });
  await env.DB.batch([env.DB.prepare("DELETE FROM user"), env.DB.prepare("DELETE FROM app_rate_limits")]);
  await seed();
});

/** Saves an overlay of this version with no layer on the grid, at revision 0. */
async function emptyOverlay(streamerId: string = page): Promise<void> {
  await env.DB.prepare("INSERT INTO overlay_state (streamer_id,layers,revision,updated_at) VALUES (?,'{\"v\":2}',0,1)")
    .bind(streamerId)
    .run();
}

describe("stored overlay and battle values", (): void => {
  const chatCell: CellRect = { c: 0, r: 0, w: 10, h: 14 };
  /** Stored by this version: the chat on stream, and no other layer on the grid. */
  const layers: OverlayLayers = {
    ...DEFAULT_LAYERS,
    chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    cells: { horizontal: { ...emptyCells(), chat: chatCell }, vertical: emptyCells() },
  };
  const row: OverlayRow = {
    air: '{"type":"message","ref":null}',
    position: "top",
    size: "l",
    show_results: 0,
    message: "Back soon",
    message_style: "hype",
    layers: storedLayersText(layers),
    chat_test_until: 1_000,
    revision: 4,
  };
  const messageCell: CellRect = { c: 12, r: 0, w: 8, h: 4 };
  const withMessage: OverlayLayers = {
    ...layers,
    cells: { ...layers.cells, horizontal: { ...layers.cells.horizontal, message: messageCell } },
  };

  it("shows the latest active poll for a page with no row and parses a stored row", (): void => {
    expect(overlayValue(null)).toBe(DEFAULT_OVERLAY);
    expect(overlayValue(undefined)).toBe(DEFAULT_OVERLAY);
    expect(DEFAULT_OVERLAY).toEqual({
      showResults: true,
      message: "",
      messageStyle: "info",
      layers: {
        ...DEFAULT_LAYERS,
        cells: {
          horizontal: { ...emptyCells(), poll: { c: 10, r: 0, w: 22, h: 14 } },
          vertical: { ...emptyCells(), poll: { c: 0, r: 0, w: 18, h: 16 } },
        },
      },
      chatTestUntil: 0,
      revision: 0,
    });
    // The row has the current layers version: the old source in `air` does not show.
    expect(overlayValue(row)).toEqual({
      showResults: false,
      message: "Back soon",
      messageStyle: "hype",
      layers,
      chatTestUntil: 1_000,
      revision: 4,
    });
    expect(overlayValue({ ...row, layers: '{"v":2}' }).layers).toEqual(DEFAULT_LAYERS);
  });

  it("reads the chat commands setting of a stored row as it is, and a row without it as on", (): void => {
    const stored = (chat: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(row.layers), chat });
    expect(overlayValue({ ...row, layers: stored({ enabled: true }) }).layers.chat).toEqual({
      enabled: true,
      hideCommands: true,
      backgroundOpacity: 100,
    });
    for (const hideCommands of [true, false]) {
      const state = overlayValue({ ...row, layers: stored({ enabled: true, hideCommands }) });
      expect(state.layers.chat.hideCommands).toBe(hideCommands);
      // The overlay and the pages of the owner get the same value from the live room.
      expect(overlayPublic(state).layers.chat.hideCommands).toBe(hideCommands);
    }
  });

  it("converts a row from before the overlay studio: the old source on air becomes a layer", (): void => {
    const old: OverlayRow = { ...row, layers: '{"chat":{"enabled":true}}' };
    expect(legacyLayersText(old.layers)).toBe(true);
    const converted: OverlayLayers = overlayValue(old).layers;
    expect(converted).toEqual(
      parseStoredLayers(old.layers, { air: { type: "message", ref: null }, position: "top", size: "l" }),
    );
    // The top bar at size L touches the old default chat cell: the layer goes to the free space beside it.
    expect(converted.cells.horizontal).toEqual({
      ...emptyCells(),
      chat: chatCell,
      message: { c: 10, r: 0, w: 22, h: 6 },
    });
    expect(overlayValue({ ...old, layers: "{}" }).layers.cells.horizontal).toEqual({
      ...emptyCells(),
      message: { c: 0, r: 0, w: 32, h: 6 },
    });
    expect(overlayValue({ ...old, layers: "{}", air: '{"type":"hidden","ref":null}' }).layers).toEqual(DEFAULT_LAYERS);
  });

  it("throws on a malformed row so it never reaches a client", (): void => {
    expect(() => overlayValue({ ...row, position: "left" })).toThrow();
    expect(() => overlayValue({ ...row, size: "xl" })).toThrow();
    expect(() => overlayValue({ ...row, air: '{"type":"poll"}' })).toThrow();
    expect(() => overlayValue({ ...row, air: "not json" })).toThrow();
    expect(() => overlayValue({ ...row, chat_test_until: -1 })).toThrow();
  });

  it("reads a bad layers value as its defaults and keeps the rest of the overlay", (): void => {
    const hidden: OverlayRow = { ...row, air: '{"type":"hidden","ref":null}' };
    const rest = { ...overlayValue(row), layers: DEFAULT_LAYERS };
    for (const layers of [
      "not json",
      "null",
      '"chat"',
      '{"chat":"on","characters":[]}',
      '{"v":2,"chat":{"enabled":"yes","hideCommands":1},"cells":{"horizontal":{"chat":{"c":0,"r":0,"w":1,"h":1}}}}',
    ])
      expect(overlayValue({ ...hidden, layers })).toEqual(rest);
    // Only the bad field takes its default.
    const stored: string = JSON.stringify({ ...JSON.parse(row.layers), chat: { enabled: true, theme: "neon" } });
    expect(overlayValue({ ...row, layers: stored }).layers).toEqual(layers);
  });

  it("keeps the message private unless the message layer is on stream", (): void => {
    const state = overlayValue(row);
    expect(overlayPublic(state)).toEqual({ ...state, message: "" });
    expect(overlayPublic({ ...state, layers: withMessage })).toEqual({ ...state, layers: withMessage });
    for (const key of ["air", "preview", "position", "size", "instant"])
      expect(overlayPublic(state)).not.toHaveProperty(key);
  });

  it("shows the message while the message layer is on stream", (): void => {
    const state: OverlayState = overlayValue(row);
    expect(overlayPublic({ ...state, layers: withMessage }).message).toBe("Back soon");
    // The two outputs are on stream at the same time. The output that the editor shows does not matter.
    expect(overlayPublic({ ...state, layers: { ...withMessage, orientation: "vertical" } }).message).toBe("Back soon");
    const verticalOnly: OverlayLayers = {
      ...layers,
      cells: { ...layers.cells, vertical: { ...emptyCells(), message: messageCell } },
    };
    expect(overlayPublic({ ...state, layers: verticalOnly }).message).toBe("Back soon");
    // Not on the grid of an output, and not while the layer is off.
    expect(overlayPublic({ ...state, layers }).message).toBe("");
    const off: OverlayLayers = {
      ...withMessage,
      items: { ...withMessage.items, message: { ...withMessage.items.message, enabled: false } },
    };
    expect(overlayPublic({ ...state, layers: off }).message).toBe("");
  });

  it("parses the mash column and fills sides with no taps", (): void => {
    expect(mashValue(null, 2)).toBeNull();
    expect(mashValue(undefined, 2)).toBeNull();
    const raw = JSON.stringify({
      durationS: 30,
      phase: "live",
      startsAt: 1,
      endsAt: 30_001,
      winner: null,
      totals: [{ side: 2, taps: 9 }],
      players: 3,
      assisted: 1,
    });
    expect(mashValue(raw, 3)).toMatchObject({ phase: "live", totals: [0, 0, 9], players: 3, assisted: 1 });
    expect(() => mashValue(JSON.stringify({ ...JSON.parse(raw), phase: "paused" }), 2)).toThrow();
    expect(() => mashValue(JSON.stringify({ ...JSON.parse(raw), totals: [{ side: 4, taps: 1 }] }), 2)).toThrow();
  });
});

describe("overlay control state", (): void => {
  const saved: OverlayState = { ...DEFAULT_OVERLAY, message: "Mine", revision: 4 };
  const messageOn: OverlayLayers = {
    ...DEFAULT_LAYERS,
    cells: { horizontal: { ...emptyCells(), message: { c: 0, r: 0, w: 8, h: 4 } }, vertical: emptyCells() },
  };

  it("shows the newer of the saved and the loaded state", (): void => {
    const loaded: OverlayState = { ...DEFAULT_OVERLAY, showResults: false, revision: 5 };
    expect(controlState(saved, loaded, null)).toBe(loaded);
    expect(controlState(saved, { ...loaded, revision: 3 }, undefined)).toBe(saved);
    expect(controlState(saved, saved, overlayPublic({ ...saved, showResults: false }))).toBe(saved);
  });

  it("shows the newer of the layouts of this tab and the loaded layouts", (): void => {
    const mine: OverlayLayouts = { ...EMPTY_LAYOUTS, horizontal: { active: "preset:chatting", saved: [] } };
    const other: OverlayLayouts = { ...EMPTY_LAYOUTS, horizontal: { active: "preset:gameplay", saved: [] } };
    // Another tab selected a layout: the page loaded again with a newer revision.
    expect(controlLayouts({ layouts: mine, revision: 4 }, { layouts: other, revision: 5 })).toBe(other);
    // A load that is not newer than the layout action of this tab does not replace its answer.
    expect(controlLayouts({ layouts: mine, revision: 4 }, { layouts: other, revision: 4 })).toBe(mine);
    expect(controlLayouts({ layouts: mine, revision: 4 }, { layouts: other, revision: 3 })).toBe(mine);
  });

  it("takes a newer live overlay from another tab and keeps the message draft", (): void => {
    const other: OverlayState = {
      ...saved,
      showResults: false,
      message: "Back soon",
      messageStyle: "hype",
      layers: messageOn,
      chatTestUntil: 9,
      revision: 6,
    };
    // The message layer is on stream: the live message is the saved message, also an empty one.
    expect(controlState(saved, saved, overlayPublic(other))).toEqual(other);
    expect(controlState(saved, saved, overlayPublic({ ...other, message: "" })).message).toBe("");
    // Off stream the live state has no message: the draft stays.
    const draft: OverlayState = { ...other, layers: DEFAULT_LAYERS, message: "Draft", revision: 7 };
    expect(controlState(saved, saved, overlayPublic(draft))).toEqual({ ...draft, message: "Mine" });
  });
});

describe("Auto on the overlay", (): void => {
  it("shows an open poll over a newer finished Mash Battle, and a running battle over the poll", (): void => {
    const now = 100_000;
    const open: OverlayPoll = {
      id: "open",
      title: "Pick one",
      kind: "choice",
      options: ["A", "B"],
      endsAt: null,
      revealed: false,
      counts: [0, 0],
      total: 0,
      mash: null,
      byOwner: true,
    };
    const stats = { durationS: 30, winner: null, totals: [], players: 0, assisted: 0 };
    const battle = (phase: "countdown" | "live" | "finished", startsAt: number): OverlayPoll => ({
      ...open,
      id: `battle-${phase}`,
      mash: { ...stats, phase, startsAt, endsAt: startsAt + 30_000 },
    });
    const auto = (newest: OverlayPoll): string | undefined =>
      overlayPoll({ type: "auto", ref: null }, [newest, open], now)?.id;
    expect(auto(battle("finished", now - 60_000))).toBe("open");
    // Stored as live, but already past its end.
    expect(auto(battle("live", now - 60_000))).toBe("open");
    expect(auto(battle("live", now - 5_000))).toBe("battle-live");
    expect(auto(battle("countdown", now + 3_000))).toBe("battle-countdown");
  });

  it("never shows a viewer poll, also when it is the only open poll or the only poll", (): void => {
    const poll = (id: string, byOwner: boolean, revealed: boolean): OverlayPoll => ({
      id,
      title: id,
      kind: "choice",
      options: ["A", "B"],
      endsAt: null,
      revealed,
      counts: [0, 0],
      total: 0,
      mash: null,
      byOwner,
    });
    const auto = (polls: OverlayPoll[]): string | undefined =>
      overlayPoll({ type: "auto", ref: null }, polls, 1_000)?.id;
    const viewerOpen: OverlayPoll = poll("viewer-open", false, false);
    expect(auto([viewerOpen, poll("owner-open", true, false)])).toBe("owner-open");
    // A closed poll of the owner wins over an open viewer poll.
    expect(auto([viewerOpen, poll("owner-closed", true, true)])).toBe("owner-closed");
    expect(auto([viewerOpen, poll("viewer-closed", false, true)])).toBeUndefined();
    // The owner still shows a viewer poll with "A specific poll".
    expect(overlayPoll({ type: "poll", ref: "viewer-open" }, [viewerOpen], 1_000)).toBe(viewerOpen);
  });
});

describe("Up next on the overlay", (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("reloads the overlay once, when the shown stream starts", (): void => {
    vi.useFakeTimers();
    // The local clock is 3 s ahead; reload must use server time.
    vi.setSystemTime(1_000_000 + 3_000);
    const serverNow = 1_000_000;
    const reload = vi.fn();
    atMark(serverNow, serverNow + 600_000, reload);
    vi.advanceTimersByTime(599_999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(86_400_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for nothing when the stream already started or the wait is stopped", (): void => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const stop = atMark(Date.now(), Date.now() + 60_000, reload);
    stop();
    atMark(Date.now(), Date.now() - 1, reload);
    vi.advanceTimersByTime(120_000);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("overlay poll card", (): void => {
  afterEach((): void => {
    setLocaleSource((): Locale => DEFAULT_LOCALE);
  });

  it("counts votes with the language's plural rules", async (): Promise<void> => {
    await loadCatalog("ru");
    setLocaleSource((): Locale => "ru");
    const card = (total: number): string =>
      renderToStaticMarkup(
        createElement(OverlayStage, {
          qr: false,
          source: { type: "poll", ref: poll },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            origin: "https://streambullets.com",
            overlay: { showResults: true, message: "", messageStyle: "info" },
            polls: [
              {
                id: poll,
                title: "Pick one",
                kind: "choice",
                options: ["A", "B"],
                endsAt: null,
                revealed: true,
                counts: [total, 0],
                total,
                mash: null,
                byOwner: true,
              },
            ],
            data: { polls: [], topics: [], cards: [], next: null, support: null },
            now: 0,
          },
        }),
      );
    const total = (count: number): string | undefined => /class="overlay-total">([^<]*)</.exec(card(count))?.[1];
    expect([total(3), total(5), total(21)]).toEqual(["3 голоса", "5 голосов", "21 голос"]);
  });

  it("hides a Mash Battle's totals and winner when results are hidden", (): void => {
    const battle = (phase: "live" | "finished", showResults: boolean): string =>
      renderToStaticMarkup(
        createElement(OverlayStage, {
          qr: false,
          source: { type: "poll", ref: poll },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            origin: "https://streambullets.com",
            overlay: { showResults, message: "", messageStyle: "info" },
            polls: [
              {
                id: poll,
                title: "Cats or dogs",
                kind: "mash",
                options: ["Cats", "Dogs"],
                endsAt: null,
                revealed: phase === "finished",
                counts: [0, 0],
                total: 0,
                mash: {
                  durationS: 30,
                  phase,
                  startsAt: 1_000,
                  endsAt: 31_000,
                  winner: phase === "finished" ? 1 : null,
                  totals: [120, 340],
                  players: 9,
                  assisted: 0,
                },
                byOwner: true,
              },
            ],
            data: { polls: [], topics: [], cards: [], next: null, support: null },
            now: phase === "live" ? 11_000 : 40_000,
          },
        }),
      );
    expect(battle("live", true)).toContain("data-mash-bars");
    expect(battle("finished", true)).toContain("mash-winner");
    for (const phase of ["live", "finished"] as const) {
      const hidden = battle(phase, false);
      // Keep sides, phase, and clock; hide bar, totals, and winner.
      expect(hidden).toContain(`data-overlay-mash="${phase}"`);
      expect(hidden).toContain("Cats");
      expect(hidden).toContain("Dogs");
      expect(hidden).toContain("data-mash-ring");
      expect(hidden).toContain("Results hidden");
      expect(hidden).not.toContain("data-mash-bars");
      expect(hidden).not.toContain("data-mash-total");
      expect(hidden).not.toContain("340");
      expect(hidden).not.toContain("mash-winner");
    }
  });

  it("shows the card a ref names, the first card for no ref, and nothing for a removed card", (): void => {
    const shown = (ref: string | null): string =>
      renderToStaticMarkup(
        createElement(OverlayStage, {
          qr: false,
          source: { type: "card", ref },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            origin: "https://streambullets.com",
            overlay: { showResults: true, message: "", messageStyle: "info" },
            polls: [],
            data: {
              polls: [],
              topics: [],
              cards: [
                { id: "c1", icon: null, title: "First", body: "One", label: null, target: null },
                { id: "c2", icon: null, title: "Second", body: "Two", label: null, target: null },
              ],
              next: null,
              support: null,
            },
            now: 0,
          },
        }),
      );
    expect(shown("c2")).toContain("Second");
    expect(shown(null)).toContain("First");
    expect(shown("gone")).not.toContain('data-overlay-source="card"');
  });
});

describe("Mash Battle owner controls", (): void => {
  let clock: number;

  beforeEach((): void => {
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation((): number => clock);
  });

  async function create(user: string = "owner"): Promise<Response> {
    return call("POST", "streamers/live_page", {
      user,
      body: { action: "create", kind: "mash", title: "Cats or dogs", options: ["Cats", "Dogs"], durationS: 30 },
    });
  }

  async function act(id: string, action: string, payload: unknown = {}, user: string = "owner"): Promise<Response> {
    return call("POST", `mash/${id}/${action}`, { user, body: payload });
  }

  async function phase(id: string): Promise<{ phase: string; starts_at: number | null; ends_at: number | null }> {
    return (await env.DB.prepare("SELECT phase,starts_at,ends_at FROM entry_mash WHERE entry_id=?")
      .bind(id)
      .first<{ phase: string; starts_at: number | null; ends_at: number | null }>())!;
  }

  it("creates a battle as a choice entry with its side table", async (): Promise<void> => {
    const created = await create();
    expect(created.status).toBe(200);
    const { id } = await body<{ id: string }>(created);
    expect(
      await env.DB.prepare(
        "SELECT e.kind,e.options,m.duration_s,m.phase FROM entries e JOIN entry_mash m ON m.entry_id=e.id WHERE e.id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ kind: "choice", options: '["Cats","Dogs"]', duration_s: 30, phase: "setup" });
    expect(roomCalls.map((value) => value.path)).toEqual([`/refresh?streamerId=${page}`]);
  });

  it("lets a viewer create a battle that only the page owner runs", async (): Promise<void> => {
    const created = await create("viewer");
    expect(created.status).toBe(200);
    const { id } = await body<{ id: string }>(created);
    expect(await env.DB.prepare("SELECT author_id,status FROM entries WHERE id=?").bind(id).first()).toEqual({
      author_id: "viewer",
      status: null,
    });
    for (const action of ["start", "end", "restart"]) expect((await act(id, action, {}, "viewer")).status).toBe(403);
    expect(await phase(id)).toEqual({ phase: "setup", starts_at: null, ends_at: null });
    expect((await act(id, "start", { countdown: false })).status).toBe(200);
  });

  it("creates a battle only with distinct sides and a known length", async (): Promise<void> => {
    const bad = { action: "create", kind: "mash", title: "Same", options: ["A", "a"], durationS: 30 };
    expect((await call("POST", "streamers/live_page", { user: "owner", body: bad })).status).toBe(400);
    expect(
      (
        await call("POST", "streamers/live_page", {
          user: "owner",
          body: { ...bad, options: ["A", "B"], durationS: 20 },
        })
      ).status,
    ).toBe(400);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entry_mash").first()).toEqual({ n: 0 });
  });

  it("starts live, ends and restarts, and tells the live room each time", async (): Promise<void> => {
    const { id } = await body<{ id: string }>(await create());
    roomCalls = [];
    expect((await act(id, "end")).status).toBe(409);
    expect((await act(id, "restart")).status).toBe(409);

    expect(await body(await act(id, "start", { countdown: false }))).toEqual({ ok: true });
    expect(await phase(id)).toEqual({ phase: "live", starts_at: clock, ends_at: clock + 30_000 });
    expect((await act(id, "start", { countdown: false })).status).toBe(409);
    expect((await act(id, "restart")).status).toBe(409);

    clock += 5_000;
    expect((await act(id, "end")).status).toBe(200);
    expect((await phase(id)).ends_at).toBe(clock);
    clock += 1;
    expect((await act(id, "end")).status).toBe(409);

    expect((await act(id, "restart")).status).toBe(200);
    expect(await phase(id)).toEqual({ phase: "setup", starts_at: null, ends_at: null });
    expect(roomCalls).toEqual(
      Array.from({ length: 3 }, () => ({ path: `/mash?streamerId=${page}`, body: JSON.stringify({ id }) })),
    );
  });

  it("starts with a countdown by default, and ending in the countdown cancels to setup", async (): Promise<void> => {
    const { id } = await body<{ id: string }>(await create());
    expect((await act(id, "start")).status).toBe(200);
    expect(await phase(id)).toEqual({
      phase: "countdown",
      starts_at: clock + MASH_COUNTDOWN_MS,
      ends_at: clock + MASH_COUNTDOWN_MS + 30_000,
    });
    expect((await act(id, "end")).status).toBe(200);
    expect(await phase(id)).toEqual({ phase: "setup", starts_at: null, ends_at: null });
  });

  it("refuses unknown battles, other users, bad input and lost races", async (): Promise<void> => {
    const { id } = await body<{ id: string }>(await create());
    expect((await act(crypto.randomUUID(), "start")).status).toBe(404);
    expect((await act(id, "start", {}, "viewer")).status).toBe(403);
    expect((await act(id, "start", { countdown: "yes" })).status).toBe(400);
    expect((await act(id, "pause")).status).toBe(404);
    // Simulate a concurrent battle change between read and write.
    const raced: AppEnv = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: () => Promise.resolve([{ meta: { changes: 0 } }, { meta: { changes: 1 } }]),
      } as unknown as D1Database,
    };
    await expect(runMashAction(raced, "owner", id, "start", { countdown: false })).rejects.toMatchObject({
      status: 409,
      message: "The battle changed. Refresh and try again.",
    });
    expect((await phase(id)).phase).toBe("setup");
  });
});

describe("overlay control", (): void => {
  async function send(action: Record<string, unknown>, user: string = "owner"): Promise<Response> {
    return call("POST", "overlay", { user, body: action });
  }

  async function overlay(response: Response): Promise<OverlayState> {
    expect(response.status).toBe(200);
    return (await body<{ overlay: OverlayState }>(response)).overlay;
  }

  async function storedRow(): Promise<Record<string, unknown> | null> {
    return env.DB.prepare(
      "SELECT air,preview,position,size,instant,layers,revision FROM overlay_state WHERE streamer_id=?",
    )
      .bind(page)
      .first<Record<string, unknown>>();
  }

  it("reads the default state and the sources for the owner only", async (): Promise<void> => {
    expect((await call("GET", "overlay")).status).toBe(401);
    expect((await call("GET", "overlay", { user: "viewer" })).status).toBe(404);
    const result = await body<{ overlay: OverlayState; data: OverlayData; handle: string }>(
      await call("GET", "overlay", { user: "owner" }),
    );
    expect(result.overlay).toEqual(DEFAULT_OVERLAY);
    expect(result.handle).toBe("live_page");
    expect(result.data.polls).toEqual([
      { id: poll, title: "Pick one", mash: false, author: "Name owner", byOwner: true },
    ]);
    expect(result.data.topics.map((value) => value.id)).toEqual([topic]);
    expect(result.data.cards).toEqual([
      { id: card, icon: "heart", title: "Card", body: "Body", label: null, target: null },
    ]);
    expect(result.data).toMatchObject({ next: null, support: null });
    // A page without a row gets no row from a read.
    expect(await storedRow()).toBeNull();
  });

  it("shows and hides the results, saves the message, and tells the live room each time", async (): Promise<void> => {
    const hidden = await overlay(await send({ action: "showResults", on: false }));
    expect(hidden).toEqual({ ...DEFAULT_OVERLAY, showResults: false, revision: 1 });
    const message = await overlay(await send({ action: "message", text: "  Be right back ", style: "hype" }));
    expect(message).toMatchObject({ message: "Be right back", messageStyle: "hype", showResults: false, revision: 2 });
    expect((await overlay(await send({ action: "showResults", on: true }))).showResults).toBe(true);
    expect(roomCalls).toEqual(Array.from({ length: 3 }, () => ({ path: `/overlay?streamerId=${page}`, body: "" })));
    // The first save of a page stores its layers at the current version. The old columns keep their defaults.
    const row = await storedRow();
    expect(row).toMatchObject({
      air: '{"type":"auto","ref":null}',
      preview: '{"type":"auto","ref":null}',
      position: "lower",
      size: "m",
      instant: 0,
      revision: 3,
    });
    expect(row?.layers).toBe(storedLayersText(DEFAULT_OVERLAY.layers));
  });

  it("refuses the actions from before the overlay studio", async (): Promise<void> => {
    for (const action of [
      { action: "preview", source: { type: "poll", ref: poll } },
      { action: "take" },
      { action: "layout", position: "top" },
      { action: "layout", showResults: false },
      { action: "showResults" },
      { action: "showResults", on: "yes" },
      { action: "showResults", on: true, instant: true },
    ])
      expect((await send(action)).status, JSON.stringify(action)).toBe(400);
    expect(await storedRow()).toBeNull();
    expect(roomCalls).toEqual([]);
  });

  it("refuses bad actions, pages the user does not own, and frozen pages", async (): Promise<void> => {
    expect((await send({ action: "message", text: "two\nlines", style: "info" })).status).toBe(400);
    expect((await send({ action: "message", text: "x".repeat(121), style: "info" })).status).toBe(400);
    expect((await send({ action: "showResults", on: false }, "viewer")).status).toBe(404);
    await expect(updateOverlay(env, "viewer", page, { action: "showResults", on: false })).rejects.toMatchObject({
      status: 403,
    });
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
    expect((await send({ action: "showResults", on: false })).status).toBe(423);
    expect(roomCalls).toEqual([]);
  });

  describe("state from before the overlay studio", (): void => {
    /** A row as the old version saved it: a source on air, and layers without a version. */
    async function oldRow(air: Record<string, unknown>, layers: Record<string, unknown> = {}): Promise<void> {
      await env.DB.prepare(
        `INSERT INTO overlay_state (streamer_id,air,preview,position,size,instant,message,layers,revision,updated_at)
          VALUES (?,?,'{"type":"card","ref":null}','corner','s',1,'Back soon',?,5,1)`,
      )
        .bind(page, JSON.stringify(air), JSON.stringify(layers))
        .run();
    }

    it("converts the source on air to a layer on the first read and stores the result once", async (): Promise<void> => {
      await oldRow({ type: "topic", ref: topic });
      const state = await getOverlayState(env, page);
      expect(state.revision).toBe(5);
      expect(state.layers.items.topic).toEqual({ ...DEFAULT_LAYERS.items.topic, ref: topic });
      // The corner at size S, in both orientations.
      expect(state.layers.cells).toEqual({
        horizontal: { ...emptyCells(), topic: { c: 22, r: 14, w: 10, h: 4 } },
        vertical: { ...emptyCells(), topic: { c: 10, r: 28, w: 8, h: 4 } },
      });
      // The read stored the layers at the current version. The revision and the old columns stay.
      const row = await storedRow();
      expect(row).toMatchObject({
        air: JSON.stringify({ type: "topic", ref: topic }),
        preview: '{"type":"card","ref":null}',
        position: "corner",
        size: "s",
        instant: 1,
        revision: 5,
      });
      expect(row?.layers).toBe(storedLayersText(state.layers));
      expect(legacyLayersText(String(row?.layers))).toBe(false);
      expect(await getOverlayState(env, page)).toEqual(state);
      expect(roomCalls).toEqual([]);
    });

    it("does not bring the old source back after the owner takes its layer off the grid", async (): Promise<void> => {
      await oldRow({ type: "message", ref: null });
      const read = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
      expect(read.overlay.layers.cells.horizontal.message).toEqual({ c: 22, r: 14, w: 10, h: 4 });
      // The message layer is on stream, so the message is public.
      expect(overlayPublic(read.overlay).message).toBe("Back soon");
      const cells = { horizontal: { message: null }, vertical: { message: null } };
      const removed = await overlay(await send({ action: "layers", cells }));
      expect(removed.layers.cells).toEqual({ horizontal: emptyCells(), vertical: emptyCells() });
      expect((await getOverlayState(env, page)).layers).toEqual(removed.layers);
      expect(overlayPublic(removed).message).toBe("");
      expect((await storedRow())?.air).toBe('{"type":"message","ref":null}');
    });

    it("converts the same way without a read first, when an action saves", async (): Promise<void> => {
      await oldRow({ type: "support", ref: null }, { chat: { enabled: true } });
      const saved = await overlay(await send({ action: "showResults", on: false }));
      // The old default chat cell (5 x 7 old cells at the top left) stays. The corner is free.
      expect(saved.layers.cells.horizontal).toEqual({
        ...emptyCells(),
        chat: { c: 0, r: 0, w: 10, h: 14 },
        support: { c: 22, r: 14, w: 10, h: 4 },
      });
      expect((await storedRow())?.layers).toBe(storedLayersText(saved.layers));
      expect((await getOverlayState(env, page)).layers).toEqual(saved.layers);
    });

    it("leaves Hidden without a layer, and takes a chat layer that was off away from the grid", async (): Promise<void> => {
      const chat = { c: 0, r: 0, w: 5, h: 7 };
      await oldRow({ type: "hidden", ref: null }, { chat: { enabled: false }, cells: { horizontal: { chat } } });
      const state = await getOverlayState(env, page);
      expect(state.layers).toEqual(DEFAULT_LAYERS);
      expect((await storedRow())?.layers).toBe(storedLayersText(DEFAULT_LAYERS));
    });

    it("does not store the conversion when a save came first", async (): Promise<void> => {
      await oldRow({ type: "next", ref: null });
      // Another tab saves between the read of the row and the write of the conversion.
      const raced = racingEnv(() => updateOverlay(env, "owner", page, { action: "showResults", on: false }), 1);
      const state = await getOverlayState(raced, page);
      expect(state.revision).toBe(5);
      const row = await storedRow();
      expect(row?.revision).toBe(6);
      // The save stored the same layers.
      expect(row?.layers).toBe(storedLayersText(state.layers));
    });
  });

  // Run `race` after the first `times` overlay reads to simulate a second tab.
  function racingEnv(race: () => Promise<unknown>, times: number): AppEnv {
    let left = times;
    const db = env.DB;
    const prepare = (sql: string): D1PreparedStatement => {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT air,")) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            first: async <T>(): Promise<T | null> => {
              const row = await bound.first<T>();
              if (left-- > 0) await race();
              return row;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    return { ...env, DB: { prepare, batch: db.batch.bind(db) } as unknown as D1Database };
  }

  it("re-applies an action when another tab saved in between, so neither change is lost", async (): Promise<void> => {
    await updateOverlay(env, "owner", page, { action: "message", text: "Hi", style: "info" });
    const other = (): Promise<OverlayUpdate> => updateOverlay(env, "owner", page, { action: "showResults", on: false });
    const raced = racingEnv(other, 1);
    const { overlay: state } = await updateOverlay(raced, "owner", page, {
      action: "message",
      text: "Be right back",
      style: "hype",
    });
    expect(state).toMatchObject({ showResults: false, message: "Be right back", messageStyle: "hype", revision: 3 });
    const stored = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
    expect(stored.overlay).toEqual(state);
  });

  it("answers 409 when other tabs keep saving first", async (): Promise<void> => {
    let saves = 0;
    const other = (): Promise<OverlayUpdate> =>
      updateOverlay(env, "owner", page, { action: "message", text: `Save ${++saves}`, style: "info" });
    await expect(
      updateOverlay(racingEnv(other, 3), "owner", page, { action: "showResults", on: false }),
    ).rejects.toMatchObject({ status: 409 });
    const stored = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
    expect(stored.overlay).toMatchObject({ showResults: true, message: "Save 3", revision: 3 });
  });

  it("changes only the results switch", async (): Promise<void> => {
    const current: OverlayState = { ...DEFAULT_OVERLAY, message: "Hi", showResults: false, chatTestUntil: 0 };
    expect(await nextOverlayState(env, page, current, { action: "showResults", on: false })).toEqual({
      ...current,
      revision: 1,
    });
    expect(await nextOverlayState(env, page, current, { action: "showResults", on: true })).toEqual({
      ...current,
      showResults: true,
      revision: 1,
    });
  });

  describe("layers", (): void => {
    const chatCell: CellRect = { c: 20, r: 0, w: 12, h: 10 };
    const horizontal = (patch: Partial<OverlayLayers["cells"]["horizontal"]>): OverlayLayers["cells"] => ({
      ...DEFAULT_LAYERS.cells,
      horizontal: { ...DEFAULT_LAYERS.cells.horizontal, ...patch },
    });

    // Each test starts with no layer on the grid.
    beforeEach(async (): Promise<void> => emptyOverlay());

    async function storedLayers(streamerId: string): Promise<unknown> {
      const row = await env.DB.prepare("SELECT layers FROM overlay_state WHERE streamer_id=?")
        .bind(streamerId)
        .first<{ layers: string }>();
      return row ? JSON.parse(row.layers) : null;
    }

    it("saves each layer change, sends it to the live room and reads it back", async (): Promise<void> => {
      const first = await overlay(
        await send({ action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: chatCell } } }),
      );
      expect(first).toMatchObject({ revision: 1, showResults: true, message: "" });
      expect(first.layers).toEqual({
        ...DEFAULT_LAYERS,
        chat: { enabled: true, hideCommands: true, backgroundOpacity: 100 },
        cells: horizontal({ chat: chatCell }),
      });
      const second = await overlay(
        await send({
          action: "layers",
          orientation: "vertical",
          chat: { hideCommands: false, backgroundOpacity: 45 },
          characters: { enabled: true },
          cells: { horizontal: { poll: { c: 0, r: 0, w: 12, h: 8 } } },
          twitchOnly: { vertical: true },
        }),
      );
      expect(second.layers).toEqual({
        orientation: "vertical",
        chat: { enabled: true, hideCommands: false, backgroundOpacity: 45 },
        characters: { enabled: true, pushEnabled: true, timeout: 60, max: 40 },
        camera: { enabled: false },
        alerts: DEFAULT_LAYERS.alerts,
        goal: DEFAULT_LAYERS.goal,
        twitchOnly: { horizontal: false, vertical: true },
        items: DEFAULT_LAYERS.items,
        cells: horizontal({ chat: chatCell, poll: { c: 0, r: 0, w: 12, h: 8 } }),
      });
      expect(second.revision).toBe(2);
      expect(storedLayersSchema.parse(await storedLayers(page))).toEqual(second.layers);
      const read = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
      expect(read.overlay).toEqual(second);
      // Other actions keep the layers.
      expect((await overlay(await send({ action: "showResults", on: false }))).layers).toEqual(second.layers);
      // Null takes a layer off the grid, also the chat.
      const third = await overlay(await send({ action: "layers", cells: { horizontal: { poll: null, chat: null } } }));
      expect(third.layers.cells).toEqual(DEFAULT_LAYERS.cells);
      expect(third.layers.chat.enabled).toBe(true);
      expect(roomCalls).toEqual(Array.from({ length: 4 }, () => ({ path: `/overlay?streamerId=${page}`, body: "" })));
      // The character playground reads the saved layers again after each layers change, not after other actions.
      expect(ingestCalls).toEqual(
        Array.from({ length: 3 }, () => ({ path: `/playground-config?streamerId=${page}`, body: "" })),
      );
    });

    it("saves the characters timeout, and does not tell the playground while channels are off", async (): Promise<void> => {
      const saved = await overlay(await send({ action: "layers", characters: { enabled: true, pushEnabled: true, timeout: 120 } }));
      expect(saved.layers.characters).toEqual({ enabled: true, pushEnabled: true, timeout: 120, max: 40 });
      expect(ingestCalls).toEqual([{ path: `/playground-config?streamerId=${page}`, body: "" }]);
      for (const timeout of [9, 601, 30.5, "60"])
        expect((await send({ action: "layers", characters: { timeout } })).status).toBe(400);
      env.CHANNELS_OFF = "1";
      try {
        expect(
          (await overlay(await send({ action: "layers", characters: { timeout: 10 } }))).layers.characters.timeout,
        ).toBe(10);
      } finally {
        env.CHANNELS_OFF = undefined;
      }
      expect(ingestCalls).toHaveLength(1);
      expect(roomCalls).toHaveLength(2);
      // A deployment without the activity feed (the test environment) has no playground to tell.
      const binding: DurableObjectNamespace = env.CHANNEL_INGEST;
      Reflect.deleteProperty(env, "CHANNEL_INGEST");
      try {
        expect((await send({ action: "layers", characters: { timeout: 20 } })).status).toBe(200);
      } finally {
        env.CHANNEL_INGEST = binding;
      }
      expect(ingestCalls).toHaveLength(1);
    });

    it("saves the characters maximum, tells the playground and refuses a value outside 5 to 40", async (): Promise<void> => {
      const saved = await overlay(await send({ action: "layers", characters: { enabled: true, max: 12 } }));
      expect(saved.layers.characters).toEqual({ enabled: true, pushEnabled: true, timeout: 60, max: 12 });
      expect(storedLayersSchema.parse(await storedLayers(page)).characters.max).toBe(12);
      expect(ingestCalls).toEqual([{ path: `/playground-config?streamerId=${page}`, body: "" }]);
      for (const max of [4, 41, 12.5, "12", null])
        expect((await send({ action: "layers", characters: { max } })).status).toBe(400);
      expect(ingestCalls).toHaveLength(1);
      // A patch without the maximum keeps it.
      const kept = await overlay(await send({ action: "layers", characters: { timeout: 30 } }));
      expect(kept.layers.characters).toEqual({ enabled: true, pushEnabled: true, timeout: 30, max: 12 });
      expect(ingestCalls).toHaveLength(2);
    });

    it("saves the alerts and the goal, stores only what is not a default, and reads them back", async (): Promise<void> => {
      const bannerCell: CellRect = { c: 8, r: 0, w: 16, h: 3 };
      const goalCell: CellRect = { c: 24, r: 0, w: 8, h: 2 };
      const saved = await overlay(
        await send({
          action: "layers",
          alerts: { enabled: true, rules: { bits: { min: 250 }, follow: { banner: true } } },
          goal: { enabled: true, title: "New subscribers", target: 100 },
          cells: { horizontal: { alerts: bannerCell, goal: goalCell } },
        }),
      );
      expect(saved.layers.alerts).toEqual({
        enabled: true,
        rules: {
          ...DEFAULT_RULES,
          bits: { ...DEFAULT_RULES.bits, min: 250 },
          follow: { ...DEFAULT_RULES.follow, banner: true },
        },
      });
      expect(saved.layers.goal).toEqual({ enabled: true, title: "New subscribers", counts: "subs", target: 100 });
      expect(saved.layers.cells).toEqual(horizontal({ alerts: bannerCell, goal: goalCell }));
      expect(onAnyOutput(saved.layers, "alerts")).toBe(true);
      expect(onAnyOutput(saved.layers, "goal")).toBe(true);
      expect(await storedLayers(page)).toMatchObject({
        alerts: { enabled: true, rules: { bits: { min: 250 }, follow: { banner: true } } },
        goal: { enabled: true, title: "New subscribers", target: 100 },
        cells: { horizontal: { alerts: bannerCell, goal: goalCell } },
      });
      expect(storedLayersSchema.parse(await storedLayers(page))).toEqual(saved.layers);
      const read = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
      expect(read.overlay).toEqual(saved);
      // A patch with one field of one rule keeps each other field.
      const next = await overlay(
        await send({ action: "layers", alerts: { rules: { bits: { chat: false } } }, goal: { counts: "bits" } }),
      );
      expect(next.layers.alerts.rules.bits).toEqual({ min: 250, banner: true, chat: false, character: true });
      expect(next.layers.alerts.rules.follow.banner).toBe(true);
      expect(next.layers.goal).toEqual({ enabled: true, title: "New subscribers", counts: "bits", target: 100 });
      // With each setting at its default again, the stored text has no alerts and no goal.
      const usual = await overlay(
        await send({
          action: "layers",
          alerts: { enabled: false, rules: { bits: { min: 100, chat: true }, follow: { banner: false } } },
          goal: { enabled: false, title: "", counts: "subs", target: 25 },
        }),
      );
      expect(usual.layers.alerts).toEqual(DEFAULT_LAYERS.alerts);
      expect(usual.layers.goal).toEqual(DEFAULT_LAYERS.goal);
      const stored = await storedLayers(page);
      expect(stored).not.toHaveProperty("alerts");
      expect(stored).not.toHaveProperty("goal");
      expect(stored).toMatchObject({ cells: { horizontal: { alerts: bannerCell, goal: goalCell } } });
      // Each change goes to the live room, and the object of the page reads the saved layers again.
      expect(roomCalls).toHaveLength(3);
      expect(ingestCalls).toHaveLength(3);
    });

    it("refuses a wrong rule, a wrong goal, and a cell of the alerts or the goal that is not valid", async (): Promise<void> => {
      const refused: Record<string, unknown>[] = [
        { alerts: { rules: { follow: { min: 5 } } } },
        { alerts: { rules: { bits: { min: 0 } } } },
        { alerts: { rules: { bits: { min: 1_000_001 } } } },
        { alerts: { rules: { tip: { banner: true } } } },
        { alerts: { rules: { bits: { sound: true } } } },
        { alerts: { volume: 3 } },
        { goal: { target: 0 } },
        { goal: { target: 10_000_001 } },
        { goal: { counts: "likes" } },
        { goal: { title: "x".repeat(61) } },
        { goal: { title: "two\nlines" } },
        { goal: { value: 17 } },
        { cells: { horizontal: { alerts: { c: 0, r: 0, w: 7, h: 3 } } } },
        { cells: { horizontal: { goal: { c: 0, r: 0, w: 8, h: 1 } } } },
        { cells: { horizontal: { alerts: { c: 8, r: 0, w: 16, h: 3 }, goal: { c: 20, r: 2, w: 8, h: 2 } } } },
      ];
      for (const patch of refused)
        expect((await send({ action: "layers", ...patch })).status, JSON.stringify(patch)).toBe(400);
      expect(roomCalls).toEqual([]);
      // A cell over the saved cell of the other layer.
      await send({ action: "layers", cells: { horizontal: { alerts: { c: 8, r: 0, w: 16, h: 3 } } } });
      const over = await send({ action: "layers", cells: { horizontal: { goal: { c: 20, r: 2, w: 8, h: 2 } } } });
      expect(over.status).toBe(400);
      expect(await body(over)).toEqual({ error: "Layers must not overlap." });
    });

    it("refuses cells outside the grid, below the minimum or over each other, and unknown fields", async (): Promise<void> => {
      const refused: Record<string, unknown>[] = [
        { cells: { horizontal: { chat: { c: 27, r: 0, w: 6, h: 4 } } } },
        { cells: { vertical: { chat: { c: 0, r: 29, w: 6, h: 4 } } } },
        { cells: { horizontal: { chat: { c: -1, r: 0, w: 6, h: 4 } } } },
        { cells: { horizontal: { chat: { c: 0, r: 0, w: 5, h: 4 } } } },
        { cells: { horizontal: { chat: { c: 0, r: 0, w: 6, h: 3 } } } },
        { cells: { horizontal: { characters: { c: 0, r: 0, w: 11, h: 4 } } } },
        { cells: { horizontal: { content: { c: 12, r: 0, w: 8, h: 4 } } } },
        { cells: { horizontal: { content: null } } },
        { cells: { horizontal: { chat: { c: 0.5, r: 0, w: 6, h: 4 } } } },
        { cells: { horizontal: { chat: { c: 0, r: 0, w: 6 } } } },
        { cells: { horizontal: { chat: { ...chatCell, z: 1 } } } },
        // Over each other in the same patch.
        { cells: { horizontal: { chat: chatCell, characters: { c: 20, r: 8, w: 12, h: 4 } } } },
        // A content layer over the chat cell, below the minimum, and over another content layer.
        { cells: { horizontal: { chat: chatCell, poll: { c: 13, r: 0, w: 8, h: 4 } } } },
        { cells: { horizontal: { card: { c: 12, r: 0, w: 7, h: 4 } } } },
        { cells: { horizontal: { poll: { c: 12, r: 0, w: 8, h: 4 }, topic: { c: 18, r: 2, w: 8, h: 4 } } } },
        { items: { next: { ref: "n1" } } },
        { items: { poll: { ref: "" } } },
        { items: { poll: { backgroundOpacity: 3 } } },
        { items: { auto: { enabled: true } } },
        { chat: { rect: { x: 0, y: 0, w: 280, h: 160 } } },
        { chat: { enabled: true, color: "#f00" } },
        { characters: { hideCommands: false } },
        { content: { enabled: false } },
        { orientation: "square" },
        { chat: { enabled: "yes" } },
        { chat: { hideCommands: "true" } },
        { chat: { hideCommands: 1 } },
        { chat: { hideCommands: null } },
        { chat: { backgroundOpacity: 3 } },
        { chat: { backgroundOpacity: "50" } },
        { layers: { chat: { enabled: true } } },
        { write: { writer: "short", seq: 1 } },
        { write: { writer: "editor-1234", seq: 0 } },
        { write: { writer: "editor-1234", seq: 1, extra: true } },
      ];
      for (const patch of refused) expect((await send({ action: "layers", ...patch })).status).toBe(400);
      expect(await storedLayers(page)).toEqual({ v: 2 });
      expect(roomCalls).toEqual([]);
    });

    it("refuses a cell over the saved cell of another layer, also of a layer that is off stream", async (): Promise<void> => {
      // The chat is on the grid and off stream.
      await send({ action: "layers", cells: { horizontal: { chat: chatCell } } });
      const before = await storedLayers(page);
      for (const cells of [{ poll: { c: 18, r: 0, w: 8, h: 4 } }, { characters: { c: 20, r: 8, w: 12, h: 4 } }]) {
        const response = await send({ action: "layers", cells: { horizontal: cells } });
        expect(response.status).toBe(400);
        expect(await body(response)).toEqual({ error: "Layers must not overlap." });
      }
      expect(await storedLayers(page)).toEqual(before);
      // The other orientation has its own cells.
      expect((await send({ action: "layers", cells: { vertical: { poll: { c: 0, r: 0, w: 8, h: 4 } } } })).status).toBe(
        200,
      );
    });

    it("saves the settings and the cells of the content layers and stores only what differs", async (): Promise<void> => {
      const pollCell: CellRect = { c: 12, r: 0, w: 8, h: 6 };
      const topicCell: CellRect = { c: 20, r: 0, w: 12, h: 4 };
      const saved = await overlay(
        await send({
          action: "layers",
          items: {
            poll: { ref: poll, qr: false },
            topic: { ref: topic, backgroundOpacity: 40 },
            card: { ref: card, enabled: false },
            message: { backgroundOpacity: 0 },
          },
          cells: { horizontal: { poll: pollCell, topic: topicCell }, vertical: { card: { c: 0, r: 0, w: 18, h: 4 } } },
        }),
      );
      const items: OverlayLayers["items"] = {
        ...DEFAULT_LAYERS.items,
        poll: { enabled: true, ref: poll, backgroundOpacity: 100, qr: false },
        topic: { enabled: true, ref: topic, backgroundOpacity: 40, qr: false },
        card: { enabled: false, ref: card, backgroundOpacity: 100, qr: false },
        message: { enabled: true, ref: null, backgroundOpacity: 0, qr: false },
      };
      expect(saved.layers).toEqual({
        ...DEFAULT_LAYERS,
        items,
        cells: {
          horizontal: { ...DEFAULT_LAYERS.cells.horizontal, poll: pollCell, topic: topicCell },
          vertical: { ...DEFAULT_LAYERS.cells.vertical, card: { c: 0, r: 0, w: 18, h: 4 } },
        },
      });
      expect(await storedLayers(page)).toMatchObject({
        v: 3,
        items: {
          poll: { ref: poll, qr: false },
          topic: { ref: topic, backgroundOpacity: 40 },
          card: { ref: card, enabled: false },
          message: { backgroundOpacity: 0 },
        },
        cells: { horizontal: { poll: pollCell, topic: topicCell } },
      });
      expect(await storedLayers(page)).not.toHaveProperty("cells.horizontal.card");
      const read = await body<{ overlay: OverlayState; data: OverlayData }>(
        await call("GET", "overlay", { user: "owner" }),
      );
      expect(read.overlay).toEqual(saved);
      // A patch keeps the other content layers. Null takes a ref and a cell away.
      const next = await overlay(
        await send({ action: "layers", items: { poll: { ref: null } }, cells: { horizontal: { topic: null } } }),
      );
      expect(next.layers.items).toEqual({ ...items, poll: { ...items.poll, ref: null } });
      expect(next.layers.cells.horizontal).toEqual({ ...DEFAULT_LAYERS.cells.horizontal, poll: pollCell });
      // A cell must stay clear of the saved cell of another content layer.
      expect((await send({ action: "layers", cells: { horizontal: { support: pollCell } } })).status).toBe(400);
      expect((await getOverlayState(env, page)).layers).toEqual(next.layers);
    });

    it("loads the topic of a topic layer on stream, also outside the newest list", async (): Promise<void> => {
      const newer: string[] = Array.from({ length: 50 }, (): string => crypto.randomUUID());
      await env.DB.batch(
        newer.map((id: string, index: number) =>
          env.DB.prepare(
            "INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES (?,?,'viewer','topic',?,'[]',?)",
          ).bind(id, page, `Newer ${index}`, 10 + index),
        ),
      );
      const topics = async (): Promise<string[]> =>
        (await body<{ data: OverlayData }>(await call("GET", "overlay", { user: "owner" }))).data.topics.map(
          (value) => value.id,
        );
      expect(await topics()).not.toContain(topic);
      // A topic layer without a cell is not on stream.
      await send({ action: "layers", items: { topic: { ref: topic } } });
      expect(await topics()).not.toContain(topic);
      await send({ action: "layers", cells: { horizontal: { topic: { c: 12, r: 0, w: 8, h: 4 } } } });
      expect(await topics()).toContain(topic);
      await send({ action: "layers", items: { topic: { enabled: false } } });
      expect(await topics()).not.toContain(topic);
      // The control page loads the topic of the layer also while the layer is off stream, for its picker.
      const url = `${origin}/tools`;
      const request = new Request(url, { headers: { cookie: await cookie("owner") } });
      const loaded = await controlLoader({ request, params: {}, context: context(), url: new URL(url), pattern: "" });
      expect(loaded.state.layers.items.topic).toMatchObject({ enabled: false, ref: topic });
      expect(loaded.data.topics.map((value) => value.id)).toContain(topic);
    });

    it("checks that the ref of a content layer is on this page", async (): Promise<void> => {
      const refused = async (items: Record<string, unknown>): Promise<{ status: number; error: string }> => {
        const response = await send({ action: "layers", items });
        return { status: response.status, error: (await body<{ error: string }>(response)).error };
      };
      expect(await refused({ poll: { ref: topic } })).toEqual({ status: 404, error: "Poll not found." });
      expect(await refused({ topic: { ref: poll } })).toEqual({ status: 404, error: "Topic not found." });
      expect(await refused({ topic: { ref: foreignTopic } })).toEqual({ status: 404, error: "Topic not found." });
      expect(await refused({ card: { ref: "missing" } })).toEqual({
        status: 404,
        error: "Community card not found.",
      });
      // One bad ref refuses the whole patch.
      expect((await refused({ poll: { ref: poll }, card: { ref: "missing" } })).status).toBe(404);
      expect(await storedLayers(page)).toEqual({ v: 2 });
      expect(roomCalls).toEqual([]);
      // A null ref needs no check: a topic layer can wait for its topic.
      const saved = await overlay(
        await send({ action: "layers", items: { topic: { ref: null }, poll: { ref: poll }, card: { ref: card } } }),
      );
      expect(saved.layers.items).toMatchObject({ topic: { ref: null }, poll: { ref: poll }, card: { ref: card } });
    });

    it("keeps the largest layers below the limit of the stored column", async (): Promise<void> => {
      // Each layer on the grid of both orientations, each ref set and each setting changed.
      const other = { backgroundOpacity: 55, enabled: false, qr: true };
      const items = {
        poll: { ...other, ref: poll, qr: false },
        topic: { ...other, ref: topic },
        card: { ...other, ref: card },
        next: other,
        message: other,
        support: other,
      };
      const cells = (rows: number): Record<string, CellRect> => {
        const names = ["chat", "characters", "poll", "topic", "next", "message", "card", "support"];
        return Object.fromEntries(
          names.map((name: string, index: number): [string, CellRect] => [
            name,
            { c: 0, r: index * rows, w: 18, h: 4 },
          ]),
        );
      };
      const horizontal = Object.fromEntries(
        Object.keys(cells(1)).map((name: string, index: number): [string, CellRect] => [
          name,
          { c: (index % 2) * 16, r: Math.floor(index / 2) * 4, w: 16, h: 4 },
        ]),
      );
      const placed = await overlay(
        await send({
          action: "layers",
          chat: { enabled: true, hideCommands: false, backgroundOpacity: 0 },
          characters: { enabled: true, pushEnabled: true, timeout: 600 },
          items,
          cells: { horizontal, vertical: cells(4) },
        }),
      );
      const text: string = storedLayersText(placed.layers);
      expect(text.length).toBeLessThan(STORED_LAYERS_LENGTH / 2);
      expect((await storedRow())?.layers).toBe(text);
      // Layers above the limit get a clear refusal. The API cannot make such layers: only a stored ref can be long.
      const long: OverlayLayers = {
        ...placed.layers,
        items: { ...placed.layers.items, poll: { ...placed.layers.items.poll, ref: "x".repeat(STORED_LAYERS_LENGTH) } },
      };
      await expect(
        nextOverlayState(env, page, { ...placed, layers: long }, { action: "layers", orientation: "vertical" }),
      ).rejects.toMatchObject({ status: 400, message: "The layers are too large to save. Take a layer off the grid." });
      // The column refuses a longer text, so the server checks the length first.
      await expect(
        env.DB.prepare("UPDATE overlay_state SET layers=? WHERE streamer_id=?")
          .bind(JSON.stringify({ v: 2, note: "x".repeat(STORED_LAYERS_LENGTH) }), page)
          .run(),
      ).rejects.toThrow(/constraint failed/);
    });

    it("counts layer edits against the write quota and answers 429 when it runs out", async (): Promise<void> => {
      await startOfQuotaWindow(env.DB);
      // One write left in this minute's window.
      await env.DB.prepare(
        `INSERT INTO app_rate_limits (key,count,window_start)
          VALUES ('write:owner',59,CAST(strftime('%s','now') AS INTEGER)/60*60000)`,
      ).run();
      expect((await send({ action: "layers", chat: { enabled: true } })).status).toBe(200);
      const limited = await send({ action: "layers", chat: { enabled: false } });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(((await storedLayers(page)) as OverlayLayers).chat.enabled).toBe(true);
      expect((await send({ action: "chatTest", on: true })).status).toBe(429);
      // Stopping a chat test and other overlay actions do not use the quota.
      expect((await send({ action: "chatTest", on: false })).status).toBe(200);
      expect((await send({ action: "showResults", on: false })).status).toBe(200);
    });

    it("lets only the owner of an active or hidden page change layers", async (): Promise<void> => {
      expect((await call("POST", "overlay", { body: { action: "layers", chat: { enabled: true } } })).status).toBe(401);
      expect((await send({ action: "layers", chat: { enabled: true } }, "viewer")).status).toBe(404);
      await expect(
        updateOverlay(env, "viewer", page, { action: "layers", chat: { enabled: true } }),
      ).rejects.toMatchObject({ status: 403 });
      await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
      expect((await send({ action: "layers", chat: { enabled: true } })).status).toBe(423);
      expect((await send({ action: "chatTest", on: true })).status).toBe(423);
      expect(await storedLayers(page)).toEqual({ v: 2 });
      expect(roomCalls).toEqual([]);
    });

    it("changes only the page of the signed-in owner", async (): Promise<void> => {
      await emptyOverlay(otherPage);
      await send({ action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: chatCell } } });
      const other = await overlay(await send({ action: "layers", characters: { enabled: true } }, "other"));
      expect(other.layers).toEqual({ ...DEFAULT_LAYERS, characters: { enabled: true, pushEnabled: true, timeout: 60, max: 40 } });
      expect((await getOverlayState(env, page)).layers).toEqual({
        ...DEFAULT_LAYERS,
        chat: { enabled: true, hideCommands: true, backgroundOpacity: 100 },
        cells: horizontal({ chat: chatCell }),
      });
      await expect(
        updateOverlay(env, "owner", otherPage, { action: "layers", chat: { enabled: false } }),
      ).rejects.toMatchObject({ status: 403 });
      expect(roomCalls.map((value) => value.path)).toEqual([
        `/overlay?streamerId=${page}`,
        `/overlay?streamerId=${otherPage}`,
      ]);
    });

    it("merges a layer patch without touching the other overlay values", async (): Promise<void> => {
      const current: OverlayState = {
        ...DEFAULT_OVERLAY,
        layers: DEFAULT_LAYERS,
        showResults: false,
        message: "Hi",
        revision: 7,
      };
      expect(await nextOverlayState(env, page, current, { action: "layers" })).toEqual({ ...current, revision: 8 });
      const layers: OverlayLayers = { ...DEFAULT_LAYERS, cells: horizontal({ chat: chatCell }) };
      expect(
        await nextOverlayState(env, page, current, { action: "layers", cells: { horizontal: { chat: chatCell } } }),
      ).toEqual({ ...current, layers, revision: 8 });
    });

    describe("write order of one editor", (): void => {
      const writer = "editor-0000-1111";
      const moveChat = async (c: number, seq: number, by: string = writer): Promise<OverlayUpdate> =>
        updateOverlay(env, "owner", page, {
          action: "layers",
          write: { writer: by, seq },
          cells: { horizontal: { chat: { c, r: 0, w: 6, h: 4 } } },
        });
      const chatColumn = async (): Promise<number | undefined> =>
        (await getOverlayState(env, page)).layers.cells.horizontal.chat?.c;
      const storedWrites = async (): Promise<unknown> =>
        JSON.parse(
          (
            await env.DB.prepare("SELECT layers_writes FROM overlay_state WHERE streamer_id=?")
              .bind(page)
              .first<{ layers_writes: string }>()
          )?.layers_writes ?? "null",
        );

      it("ignores an older write of the same editor that arrives after a newer one", async (): Promise<void> => {
        // The pagehide request (seq 2) commits first; the earlier save (seq 1) arrives late.
        const newer = await moveChat(9, 2);
        const older = await moveChat(5, 1);
        expect(await chatColumn()).toBe(9);
        // The late write succeeds with the current state, changes nothing and reports that.
        expect(older).toEqual({ overlay: newer.overlay, changed: false });
        expect(older.overlay.revision).toBe(1);
        // The same number again is also old.
        expect(await moveChat(6, 2)).toEqual({ overlay: newer.overlay, changed: false });
        expect(await chatColumn()).toBe(9);
      });

      it("ignores a late write of an editor also when another editor saved in between", async (): Promise<void> => {
        // Editor A: N+1 (pagehide) lands, then tab B saves, then A's late write N arrives.
        await moveChat(9, 2);
        await moveChat(12, 1, "editor-2222-3333");
        expect((await moveChat(5, 1)).changed).toBe(false);
        expect(await chatColumn()).toBe(12);
        expect(await storedWrites()).toEqual([
          ["editor-2222-3333", 1],
          [writer, 2],
        ]);
      });

      it("keeps the last write of the 8 most recent editors", async (): Promise<void> => {
        for (let index = 0; index < 9; index++) await moveChat(index, 5, `editor-${index}-abcd`);
        const writes = (await storedWrites()) as [string, number][];
        expect(writes.map(([by]) => by)).toEqual(
          Array.from({ length: 8 }, (_, index: number) => `editor-${8 - index}-abcd`),
        );
        // The oldest editor dropped out, so its next write applies again.
        expect((await moveChat(13, 1, "editor-0-abcd")).changed).toBe(true);
        expect((await storedWrites()) as [string, number][]).toHaveLength(8);
      });

      it("applies writes in order, and writes of another editor or without an order", async (): Promise<void> => {
        await moveChat(5, 1);
        await moveChat(6, 2);
        expect(await chatColumn()).toBe(6);
        // Another editor starts its own numbers.
        await moveChat(7, 1, "editor-2222-3333");
        expect(await chatColumn()).toBe(7);
        await updateOverlay(env, "owner", page, { action: "layers", cells: { horizontal: { chat: chatCell } } });
        expect(await chatColumn()).toBe(20);
        // Other actions keep the last writes.
        await updateOverlay(env, "owner", page, { action: "showResults", on: false });
        expect((await moveChat(8, 1, "editor-2222-3333")).overlay.layers.cells.horizontal.chat?.c).toBe(20);
        expect(await storedWrites()).toEqual([
          ["editor-2222-3333", 1],
          [writer, 2],
        ]);
      });

      it("checks the order again when a concurrent save makes it retry", async (): Promise<void> => {
        // The newer write lands between the read and the save of the older one.
        const raced = racingEnv(() => moveChat(9, 2), 1);
        const { overlay: state } = await updateOverlay(raced, "owner", page, {
          action: "layers",
          write: { writer, seq: 1 },
          cells: { horizontal: { chat: { c: 10, r: 0, w: 6, h: 4 } } },
        });
        expect(state.layers.cells.horizontal.chat?.c).toBe(9);
        expect(await chatColumn()).toBe(9);
      });

      it("reads a malformed stored write order as no writes, so overlay actions keep working", async (): Promise<void> => {
        const warn = vi.spyOn(console, "warn").mockImplementation((): void => {});
        expect(parseStoredWrites('[["editor-a",3]]')).toEqual([["editor-a", 3]]);
        for (const raw of ["{", "null", '[["editor-a",0]]', "[1]"]) expect(parseStoredWrites(raw)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(4);
        expect(warn).toHaveBeenCalledWith("overlay_layers_writes_invalid");
        await moveChat(9, 2);
        // The column check allows only a JSON array, so a bad entry is the malformed value that can reach the read.
        await env.DB.prepare("UPDATE overlay_state SET layers_writes=? WHERE streamer_id=?")
          .bind('[["editor-0000-1111",0]]', page)
          .run();
        expect((await send({ action: "showResults", on: false })).status).toBe(200);
        expect((await moveChat(5, 1)).changed).toBe(true);
        expect(await storedWrites()).toEqual([[writer, 1]]);
        warn.mockRestore();
      });

      it("does not notify the overlay pages for an ignored write", async (): Promise<void> => {
        const cells = { horizontal: { chat: { c: 8, r: 0, w: 6, h: 4 } } };
        expect((await send({ action: "layers", write: { writer, seq: 2 }, cells })).status).toBe(200);
        const late = await send({ action: "layers", write: { writer, seq: 1 }, cells });
        expect(late.status).toBe(200);
        expect(roomCalls).toEqual([{ path: `/overlay?streamerId=${page}`, body: "" }]);
      });
    });
  });

  describe("layouts", (): void => {
    const chatCell: CellRect = { c: 0, r: 0, w: 10, h: 14 };
    const layout = (action: Record<string, unknown>, user: string = "owner"): Promise<Response> =>
      call("POST", "overlay/layouts", { user, body: action });
    const state = async (response: Response): Promise<{ overlay: OverlayState; layouts: OverlayLayouts }> => {
      expect(response.status).toBe(200);
      return body<{ overlay: OverlayState; layouts: OverlayLayouts }>(response);
    };
    const select = { action: "select", output: "horizontal", keep: "My layout" };

    beforeEach(async (): Promise<void> => {
      await emptyOverlay();
      await send({ action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: chatCell } } });
      roomCalls = [];
      ingestCalls = [];
    });

    it("puts a preset on stream in one write, keeps the old layout, and tells OBS and the playground", async (): Promise<void> => {
      const picked = await state(await layout({ ...select, id: "preset:gameplay" }));
      expect(picked.overlay.layers.cells.horizontal).toEqual(presetCells("gameplay"));
      expect(picked.overlay.revision).toBe(2);
      expect(picked.layouts.horizontal.active).toBe("preset:gameplay");
      const [kept, preset] = picked.layouts.horizontal.saved;
      expect(kept).toMatchObject({ name: "My layout", cells: { ...emptyCells(), chat: chatCell } });
      expect(kept.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(preset.id).toBe("preset:gameplay");
      // The layers that the preset adds go on stream: OBS shows the layout at once.
      expect(picked.overlay.layers.camera.enabled).toBe(true);
      expect(roomCalls).toEqual([{ path: `/overlay?streamerId=${page}`, body: "" }]);
      expect(ingestCalls.map((value) => value.path)).toEqual([`/playground-config?streamerId=${page}`]);
      // The page and the API read the same layouts back.
      const read = await body<{ overlay: OverlayState; layouts: OverlayLayouts }>(
        await call("GET", "overlay", { user: "owner" }),
      );
      expect(read.layouts).toEqual(picked.layouts);
      expect(read.overlay).toEqual(picked.overlay);
      // Back to the first layout: its cells are on stream again.
      const back = await state(await layout({ ...select, id: kept.id }));
      expect(back.overlay.layers.cells.horizontal).toEqual({ ...emptyCells(), chat: chatCell });
      expect(back.layouts.horizontal.saved).toHaveLength(2);
    });

    it("makes, renames and deletes a layout of the streamer", async (): Promise<void> => {
      const made = await state(
        await layout({ action: "create", output: "horizontal", name: " Raid night ", from: "current", keep: "My layout" }),
      );
      const [kept, mine] = made.layouts.horizontal.saved;
      expect(mine.name).toBe("Raid night");
      expect(made.layouts.horizontal.active).toBe(mine.id);
      expect(made.overlay.layers.cells.horizontal).toEqual({ ...emptyCells(), chat: chatCell });
      roomCalls = [];
      ingestCalls = [];
      // A new name and a deleted layout do not change the picture. The room still gets a message for each, because
      // the other tabs of the owner load the list of layouts again from it.
      const renamed = await state(await layout({ action: "rename", output: "horizontal", id: kept.id, name: "Cozy" }));
      expect(renamed.layouts.horizontal.saved[0].name).toBe("Cozy");
      const deleted = await state(await layout({ action: "delete", output: "horizontal", id: kept.id }));
      expect(deleted.layouts.horizontal.saved.map((item) => item.id)).toEqual([mine.id]);
      expect(roomCalls).toEqual(Array.from({ length: 2 }, () => ({ path: `/overlay?streamerId=${page}`, body: "" })));
      expect(ingestCalls).toEqual([]);
      // The layout on stream cannot go.
      expect((await layout({ action: "delete", output: "horizontal", id: mine.id })).status).toBe(400);
      expect((await layout({ action: "rename", output: "horizontal", id: "preset:gameplay", name: "Mine" })).status).toBe(400);
      expect((await layout({ ...select, id: "nothing" })).status).toBe(404);
      expect((await layout({ action: "reset", output: "horizontal" })).status).toBe(400);
    });

    it("brings a changed preset back", async (): Promise<void> => {
      await state(await layout({ ...select, id: "preset:chatting" }));
      await send({ action: "layers", cells: { horizontal: { poll: null } } });
      const reset = await state(await layout({ action: "reset", output: "horizontal" }));
      expect(reset.overlay.layers.cells.horizontal).toEqual(presetCells("chatting"));
    });

    it("stops at the limit with a reason that the page can translate", async (): Promise<void> => {
      for (let index = 0; index < LAYOUT_LIMIT; index += 1) {
        const made = await layout({ action: "create", output: "horizontal", name: `L${index}`, from: "empty", keep: "My layout" });
        // The first one also keeps the layout on stream, so the limit comes one step earlier.
        expect(made.status, String(index)).toBe(index < LAYOUT_LIMIT - 1 ? 200 : 400);
      }
      const refused = await layout({ action: "create", output: "horizontal", name: "More", from: "empty", keep: "My layout" });
      expect(await body<{ code: string }>(refused)).toMatchObject({ code: "layout_limit" });
    });

    it("ends a running chat test when the new layout has no chat on stream", async (): Promise<void> => {
      expect((await send({ action: "chatTest", on: true })).status).toBe(200);
      const empty = await state(
        await layout({ action: "create", output: "horizontal", name: "Empty", from: "empty", keep: "My layout" }),
      );
      expect(empty.overlay.chatTestUntil).toBe(0);
    });

    it("takes only the owner and only valid actions", async (): Promise<void> => {
      expect((await layout({ ...select, id: "preset:gameplay" }, "viewer")).status).toBe(404);
      expect((await call("POST", "overlay/layouts", { body: { ...select, id: "preset:gameplay" } })).status).toBe(401);
      for (const action of [
        { ...select },
        { ...select, id: "preset:gameplay", keep: "" },
        { ...select, id: "preset:gameplay", output: "square" },
        { ...select, id: "preset:gameplay", extra: true },
        { action: "create", output: "horizontal", name: "N".repeat(41), from: "empty", keep: "My layout" },
        { action: "create", output: "horizontal", name: "Name", from: "other", keep: "My layout" },
        { action: "unknown", output: "horizontal" },
      ])
        expect((await layout(action)).status, JSON.stringify(action)).toBe(400);
      // A page without saved state gets its first row.
      await env.DB.prepare("DELETE FROM overlay_state WHERE streamer_id=?").bind(page).run();
      const first = await state(await layout({ ...select, output: "vertical", id: "preset:vertical" }));
      expect(first.overlay.layers.cells.vertical).toEqual(presetCells("vertical"));
      expect(first.layouts.vertical.active).toBe("preset:vertical");
    });
  });

  describe("character playground controls", (): void => {
    function characters(control: unknown, user: string = "owner"): Promise<Response> {
      return call("POST", "overlay/characters", { user, body: control });
    }

    const charactersCell: CellRect = { c: 0, r: 14, w: 32, h: 4 };

    // Each test starts with no layer on the grid.
    beforeEach(async (): Promise<void> => emptyOverlay());

    async function charactersOn(): Promise<void> {
      const cells = { horizontal: { characters: charactersCell } };
      expect((await send({ action: "layers", characters: { enabled: true }, cells })).status).toBe(200);
      ingestCalls = [];
    }

    it("forwards each control to the page's playground and answers its status", async (): Promise<void> => {
      await charactersOn();
      ingestReply = (): Response => Response.json({ paused: false, testEndsAt: 123 });
      for (const control of [
        { op: "status" },
        { op: "test" },
        { op: "stopTest" },
        { op: "pause" },
        { op: "resume" },
        { op: "reset" },
        { op: "remove", id: 7 },
      ]) {
        const response = await characters(control);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ paused: false, testEndsAt: 123 });
      }
      expect(ingestCalls.map((entry) => entry.path)).toEqual(
        Array.from({ length: 7 }, () => `/playground?streamerId=${page}`),
      );
      expect(JSON.parse(ingestCalls[6].body)).toEqual({ op: "remove", id: 7 });
    });

    it("starts a test only with the characters layer saved on stream", async (): Promise<void> => {
      const refused = await characters({ op: "test" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "Put the characters layer on stream first." });
      // On and off the grid, or on the grid and off, the layer is not on stream.
      await send({ action: "layers", characters: { enabled: true } });
      expect((await characters({ op: "test" })).status).toBe(400);
      const cells = { horizontal: { characters: charactersCell } };
      await send({ action: "layers", characters: { enabled: false }, cells });
      expect((await characters({ op: "test" })).status).toBe(400);
      // On stream in the horizontal output: the test starts, also while the editor shows the vertical output.
      await send({ action: "layers", characters: { enabled: true }, orientation: "vertical" });
      expect((await characters({ op: "test" })).status).toBe(200);
      await send({ action: "layers", characters: { enabled: false } });
      ingestCalls = [];
      // The other controls work with the layer off.
      expect((await characters({ op: "pause" })).status).toBe(200);
      expect(ingestCalls.map((entry): unknown => JSON.parse(entry.body))).toEqual([{ op: "pause" }]);
    });

    it("uses the write quota to start a test, reset and remove, never to read, stop or pause", async (): Promise<void> => {
      await charactersOn();
      await startOfQuotaWindow(env.DB);
      await env.DB.prepare(
        `INSERT INTO app_rate_limits (key,count,window_start)
          VALUES ('write:owner',60,CAST(strftime('%s','now') AS INTEGER)/60*60000)
          ON CONFLICT(key) DO UPDATE SET count=60, window_start=excluded.window_start`,
      ).run();
      for (const control of [{ op: "test" }, { op: "reset" }, { op: "remove", id: 1 }])
        expect((await characters(control)).status).toBe(429);
      for (const control of [{ op: "status" }, { op: "stopTest" }, { op: "pause" }, { op: "resume" }])
        expect((await characters(control)).status).toBe(200);
      expect(ingestCalls).toHaveLength(4);
    });

    it("lets only the owner of a writable page control it", async (): Promise<void> => {
      expect((await call("POST", "overlay/characters", { body: { op: "pause" } })).status).toBe(401);
      expect((await characters({ op: "pause" }, "viewer")).status).toBe(404);
      await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
      expect((await characters({ op: "pause" })).status).toBe(423);
      expect(ingestCalls).toEqual([]);
    });

    it("refuses a malformed control, and answers 503 while channels are off", async (): Promise<void> => {
      for (const control of [{}, { op: "jump" }, { op: "remove" }, { op: "remove", id: 1.5 }, { op: "pause", id: 1 }])
        expect((await characters(control)).status).toBe(400);
      env.CHANNELS_OFF = "1";
      try {
        expect((await characters({ op: "pause" })).status).toBe(503);
      } finally {
        env.CHANNELS_OFF = undefined;
      }
      // Without the activity feed binding there is no playground either.
      const binding: DurableObjectNamespace = env.CHANNEL_INGEST;
      Reflect.deleteProperty(env, "CHANNEL_INGEST");
      try {
        const off = await characters({ op: "status" });
        expect(off.status).toBe(503);
        expect(await off.json()).toMatchObject({ error: "Characters are off on this server." });
      } finally {
        env.CHANNEL_INGEST = binding;
      }
      expect(ingestCalls).toEqual([]);
    });

    it("passes on a character that is gone and a playground that failed", async (): Promise<void> => {
      ingestReply = (): Response => Response.json({ error: "Character not found" }, { status: 404 });
      const gone = await characters({ op: "remove", id: 3 });
      expect(gone.status).toBe(404);
      expect(await gone.json()).toMatchObject({ error: "That character is not on the playground." });
      ingestReply = (): Response => new Response("boom", { status: 500 });
      expect((await characters({ op: "pause" })).status).toBe(503);
      // An answer that breaks the status contract is a server error, not passed on.
      const log = vi.spyOn(console, "error").mockImplementation((): void => undefined);
      ingestReply = (): Response => Response.json({ paused: "no", testEndsAt: null });
      expect((await characters({ op: "status" })).status).toBe(500);
      ingestReply = (): Response => new Response("not json");
      expect((await characters({ op: "status" })).status).toBe(500);
      log.mockRestore();
    });
  });

  describe("alert controls", (): void => {
    function alerts(control: unknown, user: string = "owner"): Promise<Response> {
      return call("POST", "overlay/alerts", { user, body: control });
    }

    const reply: AlertsReply = {
      at: 1_800_000_000_000,
      muted: false,
      current: {
        id: "twitch:g1~r2",
        origin: "replay",
        kind: "gift",
        platform: "twitch",
        name: "Supporter",
        anonymous: false,
        amount: 5,
        currency: null,
        banner: true,
        chat: true,
        startsAt: 1_800_000_000_000,
        endsAt: 1_800_000_006_000,
      },
      waiting: 2,
      goal: null,
    };
    const controls: Record<string, unknown>[] = [
      { op: "status" },
      { op: "test" },
      { op: "test", kind: "anonymous" },
      { op: "mute", on: true },
      { op: "mute", on: false },
      { op: "skip" },
      { op: "replay", id: "twitch:g1" },
      { op: "goalReset" },
    ];

    beforeEach((): void => {
      ingestReply = (): Response => Response.json(reply);
    });

    it("forwards each control to the alert host of the page and answers its state", async (): Promise<void> => {
      for (const control of controls) {
        const response = await alerts(control);
        expect(response.status, JSON.stringify(control)).toBe(200);
        expect(await response.json()).toEqual(reply);
      }
      expect(ingestCalls.map((entry) => entry.path)).toEqual(controls.map(() => `/alerts?streamerId=${page}`));
      expect(ingestCalls.map((entry): unknown => JSON.parse(entry.body))).toEqual(controls);
      // The answer has only the fields of the state.
      ingestReply = (): Response => Response.json({ ...reply, current: { ...reply.current, subject: "viewer-id-1" } });
      expect(await (await alerts({ op: "status" })).json()).toEqual(reply);
    });

    it("answers the count of the goal with the state", async (): Promise<void> => {
      const goal = { counts: "subs", value: 12, startedAt: 1_800_000_000_000 };
      ingestReply = (): Response => Response.json({ ...reply, goal });
      expect(await (await alerts({ op: "goalReset" })).json()).toEqual({ ...reply, goal });
      // A count that breaks the contract is a server error.
      const log = vi.spyOn(console, "error").mockImplementation((): void => undefined);
      ingestReply = (): Response => Response.json({ ...reply, goal: { ...goal, counts: "money" } });
      expect((await alerts({ op: "status" })).status).toBe(500);
      log.mockRestore();
    });

    it("uses the write quota for a test, a replay and a new count, never to read, mute or skip", async (): Promise<void> => {
      await startOfQuotaWindow(env.DB);
      await env.DB.prepare(
        `INSERT INTO app_rate_limits (key,count,window_start)
          VALUES ('write:owner',60,CAST(strftime('%s','now') AS INTEGER)/60*60000)
          ON CONFLICT(key) DO UPDATE SET count=60, window_start=excluded.window_start`,
      ).run();
      for (const control of [{ op: "test" }, { op: "replay", id: "twitch:g1" }, { op: "goalReset" }])
        expect((await alerts(control)).status).toBe(429);
      for (const control of [{ op: "status" }, { op: "mute", on: true }, { op: "mute", on: false }, { op: "skip" }])
        expect((await alerts(control)).status).toBe(200);
      expect(ingestCalls).toHaveLength(4);
    });

    it("lets only the owner of a writable page control the alerts", async (): Promise<void> => {
      expect((await call("POST", "overlay/alerts", { body: { op: "mute", on: true } })).status).toBe(401);
      expect((await alerts({ op: "mute", on: true }, "viewer")).status).toBe(404);
      await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
      expect((await alerts({ op: "mute", on: true })).status).toBe(423);
      expect(ingestCalls).toEqual([]);
    });

    it("refuses a malformed control, and answers 503 while channels are off", async (): Promise<void> => {
      for (const control of [
        {},
        { op: "play" },
        { op: "test", kind: "tip" },
        { op: "mute" },
        { op: "mute", on: 1 },
        { op: "replay" },
        { op: "replay", id: "" },
        { op: "replay", id: "x".repeat(161) },
        { op: "skip", id: "twitch:g1" },
        { op: "status", extra: true },
        { op: "goalReset", value: 0 },
      ])
        expect((await alerts(control)).status, JSON.stringify(control)).toBe(400);
      env.CHANNELS_OFF = "1";
      try {
        expect((await alerts({ op: "status" })).status).toBe(503);
      } finally {
        env.CHANNELS_OFF = undefined;
      }
      // Without the activity feed binding there are no alerts either.
      const binding: DurableObjectNamespace = env.CHANNEL_INGEST;
      Reflect.deleteProperty(env, "CHANNEL_INGEST");
      try {
        const off = await alerts({ op: "mute", on: true });
        expect(off.status).toBe(503);
        expect(await off.json()).toMatchObject({ error: "Alerts are off on this server." });
      } finally {
        env.CHANNEL_INGEST = binding;
      }
      expect(ingestCalls).toEqual([]);
    });

    it("passes on each refusal of the alert host with its status, its code and a reason", async (): Promise<void> => {
      const texts = new Set<string>();
      for (const [code, status] of Object.entries(ALERT_REFUSALS) as [AlertRefusal, number][]) {
        ingestReply = (): Response => Response.json({ error: code }, { status });
        const response = await alerts({ op: "replay", id: "twitch:g1" });
        expect(response.status, code).toBe(status);
        const answer = await body<{ error: string; code: string }>(response);
        expect(answer.code).toBe(code);
        texts.add(answer.error);
      }
      expect(texts.size).toBe(Object.keys(ALERT_REFUSALS).length);
      expect(texts).toContain("Put the alerts layer on stream first.");
      expect(texts).toContain("Put the goal layer on the grid first.");
      expect(texts).toContain("Alerts are muted. Turn the mute off first.");
      expect(texts).toContain("This event is too old for a replay.");
      // A failure that the API does not know is not passed on.
      for (const failure of [
        (): Response => new Response("boom", { status: 500 }),
        (): Response => Response.json({ error: "Invalid control" }, { status: 400 }),
        (): Response => Response.json({ error: 7 }, { status: 409 }),
      ]) {
        ingestReply = failure;
        const response = await alerts({ op: "test" });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: "alerts_unavailable" });
      }
      // An answer that breaks the state contract is a server error.
      const log = vi.spyOn(console, "error").mockImplementation((): void => undefined);
      ingestReply = (): Response => Response.json({ ...reply, waiting: -1 });
      expect((await alerts({ op: "status" })).status).toBe(500);
      ingestReply = (): Response => new Response("not json");
      expect((await alerts({ op: "status" })).status).toBe(500);
      log.mockRestore();
    });
  });

  describe("chat test", (): void => {
    const chatCell: CellRect = { c: 0, r: 0, w: 10, h: 14 };
    /** The chat on stream. */
    const layers: OverlayLayers = {
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
      cells: { ...DEFAULT_LAYERS.cells, horizontal: { ...emptyCells(), chat: chatCell } },
    };

    // Each test starts with no layer on the grid.
    beforeEach(async (): Promise<void> => emptyOverlay());

    it("stores the end time, broadcasts it and stops at once", async (): Promise<void> => {
      await updateOverlay(env, "owner", page, {
        action: "layers",
        chat: { enabled: true },
        cells: { horizontal: { chat: chatCell } },
      });
      const before: number = Date.now();
      const started = await overlay(await send({ action: "chatTest", on: true }));
      expect(started.chatTestUntil).toBeGreaterThanOrEqual(before + CHAT_TEST_MS);
      expect(started.chatTestUntil).toBeLessThanOrEqual(Date.now() + CHAT_TEST_MS);
      expect(overlayPublic(started).chatTestUntil).toBe(started.chatTestUntil);
      expect((await getOverlayState(env, page)).chatTestUntil).toBe(started.chatTestUntil);
      const stopped = await overlay(await send({ action: "chatTest", on: false }));
      expect(stopped.chatTestUntil).toBe(0);
      expect(stopped.revision).toBe(started.revision + 1);
      expect(roomCalls).toHaveLength(2);
    });

    it("uses the server time of the action and keeps the other values", async (): Promise<void> => {
      const current: OverlayState = { ...DEFAULT_OVERLAY, message: "Hi", layers, revision: 3 };
      expect(await nextOverlayState(env, page, current, { action: "chatTest", on: true }, 5_000)).toEqual({
        ...current,
        chatTestUntil: 5_000 + CHAT_TEST_MS,
        revision: 4,
      });
      expect(
        await nextOverlayState(env, page, { ...current, chatTestUntil: 9 }, { action: "chatTest", on: false }, 1),
      ).toEqual({ ...current, revision: 4 });
    });

    it("ends a running test when the chat layer goes off stream", async (): Promise<void> => {
      const running: OverlayState = { ...DEFAULT_OVERLAY, layers, chatTestUntil: 9_000, revision: 3 };
      const off = await nextOverlayState(env, page, running, { action: "layers", chat: { enabled: false } });
      expect(off).toMatchObject({ chatTestUntil: 0, revision: 4 });
      expect(off.layers.chat.enabled).toBe(false);
      // Off the grid of the two outputs.
      const gone = await nextOverlayState(env, page, running, {
        action: "layers",
        cells: { horizontal: { chat: null } },
      });
      expect(gone.chatTestUntil).toBe(0);
      // The chat stays on stream in the horizontal output when the editor shows the vertical output.
      const other = await nextOverlayState(env, page, running, { action: "layers", orientation: "vertical" });
      expect(other.chatTestUntil).toBe(9_000);
      // With a cell in each output, the test runs until the chat leaves the two grids.
      const both: OverlayState = {
        ...running,
        layers: {
          ...layers,
          cells: { ...layers.cells, vertical: { ...emptyCells(), chat: { c: 0, r: 0, w: 10, h: 14 } } },
        },
      };
      const one = await nextOverlayState(env, page, both, { action: "layers", cells: { horizontal: { chat: null } } });
      expect(one.chatTestUntil).toBe(9_000);
      expect(
        (await nextOverlayState(env, page, one, { action: "layers", cells: { vertical: { chat: null } } }))
          .chatTestUntil,
      ).toBe(0);
      // Other layer edits keep the test running.
      const moved = await nextOverlayState(env, page, running, { action: "layers", chat: { hideCommands: false } });
      expect(moved.chatTestUntil).toBe(9_000);
    });

    it("refuses to start while the chat layer is off stream, but stops", async (): Promise<void> => {
      const refused = await send({ action: "chatTest", on: true });
      expect(refused.status).toBe(400);
      expect(await body<{ error: string }>(refused)).toEqual({ error: "Put the chat layer on stream first." });
      // On without a cell is not on stream.
      const onOnly: OverlayState = { ...DEFAULT_OVERLAY, layers: { ...layers, cells: DEFAULT_LAYERS.cells } };
      await expect(nextOverlayState(env, page, onOnly, { action: "chatTest", on: true })).rejects.toMatchObject({
        status: 400,
      });
      expect((await getOverlayState(env, page)).chatTestUntil).toBe(0);
      expect((await overlay(await send({ action: "chatTest", on: false }))).chatTestUntil).toBe(0);
      expect(roomCalls).toHaveLength(1);
    });

    it("starts while the chat layer is on stream only in the output that the editor does not show", async (): Promise<void> => {
      const verticalOnly: OverlayState = {
        ...DEFAULT_OVERLAY,
        layers: { ...layers, cells: { horizontal: emptyCells(), vertical: { ...emptyCells(), chat: chatCell } } },
      };
      expect(verticalOnly.layers.orientation).toBe("horizontal");
      const started = await nextOverlayState(env, page, verticalOnly, { action: "chatTest", on: true }, 5_000);
      expect(started.chatTestUntil).toBe(5_000 + CHAT_TEST_MS);
    });

    it("refuses a bad body and a viewer", async (): Promise<void> => {
      for (const action of [
        { action: "chatTest" },
        { action: "chatTest", on: "yes" },
        { action: "chatTest", on: true, ms: 1 },
      ])
        expect((await send(action)).status).toBe(400);
      expect((await send({ action: "chatTest", on: true }, "viewer")).status).toBe(404);
      expect(roomCalls).toEqual([]);
    });
  });

  it("lists battles, topic authors, the next stream and the first support link", async (): Promise<void> => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO entry_mash (entry_id,duration_s) VALUES (?,30)").bind(poll),
      env.DB.prepare("UPDATE user SET image=? WHERE id='viewer'").bind("/images/avatar/viewer"),
      env.DB.prepare(
        `INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at)
          VALUES (?1,?3,'Past',?4,60,'twitch','https://twitch.tv/live','UTC',?6,?6),
            (?2,?3,'Soon',?5,60,'twitch','https://twitch.tv/live','UTC',?6,?6)`,
      ).bind(crypto.randomUUID(), crypto.randomUUID(), page, now - day, now + day, now),
      env.DB.prepare(
        "INSERT INTO streamer_links (id,streamer_id,position,kind,label,url) VALUES (?,?,0,'kofi',NULL,'https://ko-fi.com/live')",
      ).bind(crypto.randomUUID(), page),
    ]);
    const data = await getOverlayData(env, page, []);
    expect(data.polls).toEqual([{ id: poll, title: "Pick one", mash: true, author: "Name owner", byOwner: true }]);
    expect(data.topics).toEqual([
      {
        id: topic,
        title: "A topic",
        category: "",
        author: "Name viewer",
        avatar: "/images/avatar/viewer",
        avatarPreset: null,
        likes: 0,
      },
    ]);
    expect(data.next).toEqual({ title: "Soon", startsAt: now + day });
    expect(data.support).toEqual({ kind: "kofi", label: null, url: "https://ko-fi.com/live" });
    await env.DB.prepare("UPDATE user SET image='https://cdn.example/a.png' WHERE id='viewer'").run();
    expect((await getOverlayData(env, page, [topic])).topics[0].avatar).toBeNull();
  });
});

describe("schedule and Community routes", (): void => {
  function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Variety night",
      date: new Date(Date.now() + 2 * day).toISOString().slice(0, 10),
      time: "18:00",
      tz: "UTC",
      durationMin: 90,
      platform: "twitch",
      url: "https://twitch.tv/live",
      ...extra,
    };
  }

  it("creates, lists, edits and deletes a stream through the API", async (): Promise<void> => {
    const created = await call("POST", "events", { user: "owner", body: event() });
    expect(created.status).toBe(200);
    const { event: stream } = await body<{ event: StreamEvent }>(created);
    expect(stream).toMatchObject({ title: "Variety night", status: "scheduled" });

    const range = `from=${Date.now()}&to=${Date.now() + 7 * day}`;
    const listed = await body<{ events: StreamEvent[]; serverNow: number }>(
      await call("GET", `streamers/live_page/events?${range}`),
    );
    expect(listed.events.map((value) => value.id)).toEqual([stream.id]);
    expect(typeof listed.serverNow).toBe("number");
    expect((await call("GET", `streamers/no_such_page/events?${range}`)).status).toBe(404);
    expect((await call("GET", "streamers/live_page/events?from=x")).status).toBe(400);

    const cancelled = await call("PATCH", `events/${stream.id}`, { user: "owner", body: { action: "cancel" } });
    expect((await body<{ event: StreamEvent }>(cancelled)).event.status).toBe("cancelled");
    expect((await call("PATCH", `events/${stream.id}`, { user: "viewer", body: { action: "cancel" } })).status).toBe(
      404,
    );
    expect((await call("DELETE", `events/${stream.id}`, { user: "owner" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stream_events").first()).toEqual({ n: 0 });
  });

  // Each test starts with no layer on the grid.
  beforeEach(async (): Promise<void> => emptyOverlay());

  it("reloads an overlay showing Support after the links are saved, and only then", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const reloads = (): number => roomCalls.filter((value) => value.path === `/overlay?streamerId=${page}`).length;
    const save = async (url: string): Promise<void> => {
      const support = { links: [{ kind: "kofi", label: null, url }], visible: true, card: true };
      const response = await call("PUT", "support-links", { user: "owner", body: support });
      expect(response.status).toBe(200);
    };
    const cell: CellRect = { c: 0, r: 0, w: 8, h: 4 };
    await updateOverlay(env, "owner", page, {
      action: "layers",
      items: { topic: { ref: topic } },
      cells: { horizontal: { topic: cell } },
    });
    let before = await revision();
    await save("https://ko-fi.com/first");
    expect(await revision()).toBe(before);
    expect(reloads()).toBe(0);
    await updateOverlay(env, "owner", page, {
      action: "layers",
      cells: { horizontal: { support: { ...cell, c: 8 } } },
    });
    before = await revision();
    await save("https://ko-fi.com/second");
    expect(await revision()).toBe(before + 1);
    expect(reloads()).toBe(1);
  });

  it("does not reload an overlay from before the overlay studio that nobody opened since", async (): Promise<void> => {
    // The old source on air is Support, and the layers have no version: no page read and converted the row.
    await env.DB.prepare(
      `UPDATE overlay_state SET air='{"type":"support","ref":null}', layers='{}' WHERE streamer_id=?`,
    )
      .bind(page)
      .run();
    const support = {
      links: [{ kind: "kofi", label: null, url: "https://ko-fi.com/first" }],
      visible: true,
      card: true,
    };
    expect((await call("PUT", "support-links", { user: "owner", body: support })).status).toBe(200);
    expect(roomCalls).toEqual([]);
    // The first read converts the row. Then a change of the links reloads the overlay.
    expect((await getOverlayState(env, page)).layers.cells.horizontal.support).not.toBeNull();
    expect((await call("PUT", "support-links", { user: "owner", body: support })).status).toBe(200);
    expect(roomCalls).toEqual([{ path: `/overlay?streamerId=${page}`, body: "" }]);
  });

  it("reloads an overlay with the Support layer on the grid of an output after the links are saved", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const save = async (url: string): Promise<void> => {
      const support = { links: [{ kind: "kofi", label: null, url }], visible: true, card: true };
      expect((await call("PUT", "support-links", { user: "owner", body: support })).status).toBe(200);
    };
    const cell: CellRect = { c: 0, r: 0, w: 8, h: 4 };
    let before = await revision();
    await save("https://ko-fi.com/none");
    expect(await revision()).toBe(before);
    // The layer is on the grid of the vertical output. The editor shows the horizontal output, and the two outputs
    // are on stream at the same time.
    await updateOverlay(env, "owner", page, { action: "layers", cells: { vertical: { support: cell, next: null } } });
    before = await revision();
    await save("https://ko-fi.com/first");
    expect(await revision()).toBe(before + 1);
    await updateOverlay(env, "owner", page, { action: "layers", orientation: "vertical" });
    before = await revision();
    await save("https://ko-fi.com/second");
    expect(await revision()).toBe(before + 1);
    await updateOverlay(env, "owner", page, {
      action: "layers",
      cells: { vertical: { support: null }, horizontal: { support: cell } },
    });
    before = await revision();
    await save("https://ko-fi.com/horizontal");
    expect(await revision()).toBe(before + 1);
    // Another content layer on the grid does not reload for the links.
    await updateOverlay(env, "owner", page, {
      action: "layers",
      orientation: "horizontal",
      cells: { horizontal: { support: null, next: { c: 12, r: 0, w: 8, h: 4 } } },
    });
    before = await revision();
    await save("https://ko-fi.com/third");
    expect(await revision()).toBe(before);
    expect((await call("POST", "events", { user: "owner", body: event() })).status).toBe(200);
    expect(await revision()).toBe(before + 1);
  });

  it("reloads an overlay with the card layer on the grid after the cards are saved", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const save = async (): Promise<void> => {
      const cards = [{ icon: "star", title: "New", body: "Text", buttonLabel: null, buttonTarget: null }];
      expect((await call("PUT", "community-cards", { user: "owner", body: { cards } })).status).toBe(200);
    };
    const chat: CellRect = { c: 0, r: 0, w: 10, h: 14 };
    await updateOverlay(env, "owner", page, {
      action: "layers",
      chat: { enabled: true },
      cells: { horizontal: { chat } },
    });
    let before = await revision();
    await save();
    expect(await revision()).toBe(before);
    await updateOverlay(env, "owner", page, {
      action: "layers",
      cells: { horizontal: { card: { c: 12, r: 0, w: 8, h: 4 } } },
    });
    before = await revision();
    await save();
    expect(await revision()).toBe(before + 1);
    // The card layer on the grid of the vertical output only, while the editor shows the horizontal output.
    await updateOverlay(env, "owner", page, {
      action: "layers",
      cells: { horizontal: { card: null }, vertical: { card: { c: 0, r: 0, w: 8, h: 4 } } },
    });
    before = await revision();
    await save();
    expect(await revision()).toBe(before + 1);
    await updateOverlay(env, "owner", page, { action: "layers", cells: { vertical: { card: null } } });
    before = await revision();
    await save();
    expect(await revision()).toBe(before);
  });

  it("reloads an overlay showing Up next after each schedule change, and only then", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const reloads = (): number => roomCalls.filter((value) => value.path === `/overlay?streamerId=${page}`).length;
    // A schedule edit does not reload an overlay that shows another layer.
    const cell: CellRect = { c: 0, r: 0, w: 8, h: 4 };
    await updateOverlay(env, "owner", page, {
      action: "layers",
      items: { topic: { ref: topic } },
      cells: { horizontal: { topic: cell } },
    });
    let before = await revision();
    const first = await call("POST", "events", { user: "owner", body: event() });
    const { event: stream } = await body<{ event: StreamEvent }>(first);
    expect(await revision()).toBe(before);
    expect(reloads()).toBe(0);
    // Up next must reload on event creation, edits, cancellation, and deletion.
    await updateOverlay(env, "owner", page, { action: "layers", cells: { horizontal: { next: { ...cell, c: 8 } } } });
    const steps: [string, string, Record<string, unknown> | undefined][] = [
      ["POST", "events", event({ title: "Second" })],
      ["PATCH", `events/${stream.id}`, { action: "edit", scope: "one", ...event({ time: "20:00" }) }],
      ["PATCH", `events/${stream.id}`, { action: "cancel" }],
      ["DELETE", `events/${stream.id}`, undefined],
    ];
    for (const [method, path, payload] of steps) {
      before = await revision();
      const calls = reloads();
      const response = await call(method, path, { user: "owner", ...(payload ? { body: payload } : {}) });
      expect(response.status).toBe(200);
      expect(await revision()).toBe(before + 1);
      expect(reloads()).toBe(calls + 1);
    }
  });

  it("deletes the following streams of a series when the body asks for it", async (): Promise<void> => {
    await call("POST", "events", { user: "owner", body: event({ repeatDays: 127 }) });
    const all = await env.DB.prepare("SELECT id FROM stream_events ORDER BY starts_at").all<{ id: string }>();
    expect(all.results.length).toBeGreaterThan(3);
    const third = all.results[2].id;
    const deleted = await call("DELETE", `events/${third}`, { user: "owner", body: { scope: "following" } });
    expect(await body(deleted)).toEqual({ deleted: true });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stream_events").first()).toEqual({ n: 2 });
  });

  it("refuses ids that are not UUIDs and writes by users without a page", async (): Promise<void> => {
    const notUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect((await call("DELETE", `events/${notUuid}`, { user: "owner" })).status).toBe(404);
    expect((await call("PATCH", `events/${notUuid}`, { user: "owner", body: { action: "cancel" } })).status).toBe(404);
    expect((await call("POST", "events", { user: "viewer", body: event() })).status).toBe(403);
    expect((await call("POST", "events", { user: "owner", body: event({ url: "http://twitch.tv/x" }) })).status).toBe(
      400,
    );
  });

  it("replaces the Community cards and support links of the owner's page", async (): Promise<void> => {
    const cards = await call("PUT", "community-cards", {
      user: "owner",
      body: { cards: [{ icon: "star", title: "New", body: "Text", buttonLabel: null, buttonTarget: null }] },
    });
    expect((await body<{ cards: { title: string }[] }>(cards)).cards.map((value) => value.title)).toEqual(["New"]);
    expect((await call("PUT", "community-cards", { user: "viewer", body: { cards: [] } })).status).toBe(403);

    const support = await call("PUT", "support-links", {
      user: "owner",
      body: { links: [{ kind: "kofi", label: null, url: "https://ko-fi.com/live" }], visible: false, card: true },
    });
    // Hide the support card when its About links are hidden.
    expect(await body(support)).toMatchObject({ visible: false, card: false, links: [{ kind: "kofi" }] });
    expect(
      (await call("PUT", "support-links", { user: "owner", body: { links: [{ kind: "kofi", url: "x" }] } })).status,
    ).toBe(400);
  });
});
