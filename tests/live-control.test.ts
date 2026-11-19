import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayStage, overlayPoll, upNextStart, type OverlayPoll } from "../app/components/overlay/overlay-stage";
import type { AppEnv } from "../app/env";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { atMark } from "../app/lib/clock";
import { MASH_COUNTDOWN_MS } from "../app/lib/mash";
import { CHAT_TEST_MS } from "../app/lib/chat-test";
import { DEFAULT_LAYERS, type CellRect, type OverlayLayers } from "../app/lib/overlay-layers";
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
import { controlState } from "../app/components/overlay/overlay-control";
import { loader as controlLoader } from "../app/routes/overlay-control";
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
// Record ingest object calls the same way. The playground control answers with `ingestReply`.
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
          return Promise.resolve(target.pathname === "/playground" ? ingestReply() : new Response(null, { status: 204 }));
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

describe("stored overlay and battle values", (): void => {
  const row: OverlayRow = {
    air: '{"type":"message","ref":null}',
    preview: '{"type":"poll","ref":"p1"}',
    position: "top",
    size: "l",
    instant: 1,
    show_results: 0,
    message: "Back soon",
    message_style: "hype",
    layers: '{"chat":{"enabled":true}}',
    chat_test_until: 1_000,
    revision: 4,
  };
  const layers: OverlayLayers = { ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } };

  it("shows Auto for a page with no row and parses a stored row", (): void => {
    expect(overlayValue(null)).toBe(DEFAULT_OVERLAY);
    expect(overlayValue(undefined)).toBe(DEFAULT_OVERLAY);
    expect(overlayValue(row)).toEqual({
      air: { type: "message", ref: null },
      preview: { type: "poll", ref: "p1" },
      position: "top",
      size: "l",
      instant: true,
      showResults: false,
      message: "Back soon",
      messageStyle: "hype",
      layers,
      chatTestUntil: 1_000,
      revision: 4,
    });
    expect(overlayValue({ ...row, layers: "{}" }).layers).toEqual(DEFAULT_LAYERS);
  });

  it("throws on a malformed row so it never reaches a client", (): void => {
    expect(() => overlayValue({ ...row, position: "left" })).toThrow();
    expect(() => overlayValue({ ...row, air: '{"type":"poll"}' })).toThrow();
    expect(() => overlayValue({ ...row, preview: "not json" })).toThrow();
    expect(() => overlayValue({ ...row, chat_test_until: -1 })).toThrow();
  });

  it("reads a bad layers value as the default layers and keeps the rest of the overlay", (): void => {
    const rest = { ...overlayValue(row), layers: DEFAULT_LAYERS };
    for (const layers of [
      "not json",
      "null",
      '"chat"',
      '{"chat":"on","characters":[]}',
      '{"chat":{"enabled":"yes","hideCommands":1},"cells":{"horizontal":{"chat":{"c":0,"r":0,"w":1,"h":1}}}}',
    ])
      expect(overlayValue({ ...row, layers })).toEqual(rest);
    // Only the bad field takes its default.
    expect(
      overlayValue({ ...row, layers: '{"chat":{"enabled":true,"rect":{"x":0,"y":0,"w":10,"h":10},"theme":"neon"}}' })
        .layers,
    ).toEqual(layers);
  });

  it("hides the preview, and the message unless the message is on air", (): void => {
    const state = overlayValue(row);
    expect(overlayPublic(state)).toEqual({
      air: { type: "message", ref: null },
      position: "top",
      size: "l",
      showResults: false,
      message: "Back soon",
      messageStyle: "hype",
      layers,
      chatTestUntil: 1_000,
      revision: 4,
    });
    expect(overlayPublic({ ...state, air: { type: "auto", ref: null } }).message).toBe("");
    expect(overlayPublic(state)).not.toHaveProperty("preview");
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
  const saved: OverlayState = { ...DEFAULT_OVERLAY, preview: { type: "topic", ref: "t" }, instant: true, revision: 4 };

  it("shows the newer of the saved and the loaded state", (): void => {
    const loaded: OverlayState = { ...DEFAULT_OVERLAY, size: "l", revision: 5 };
    expect(controlState(saved, loaded, null)).toBe(loaded);
    expect(controlState(saved, { ...loaded, revision: 3 }, undefined)).toBe(saved);
    expect(controlState(saved, saved, overlayPublic({ ...saved, size: "s" }))).toBe(saved);
  });

  it("takes a newer live overlay from another tab and keeps the private fields", (): void => {
    const other: OverlayState = {
      ...saved,
      air: { type: "message", ref: null },
      position: "top",
      size: "l",
      showResults: false,
      message: "Back soon",
      messageStyle: "hype",
      preview: { type: "auto", ref: null },
      revision: 6,
    };
    expect(controlState(saved, saved, overlayPublic(other))).toEqual({ ...other, preview: saved.preview });
    const air: OverlayState = { ...other, air: { type: "auto", ref: null }, message: "Draft", revision: 7 };
    expect(controlState({ ...saved, message: "Mine" }, saved, overlayPublic(air))).toMatchObject({
      air: { type: "auto" },
      message: "Mine",
      instant: true,
      revision: 7,
    });
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
    const data: Pick<OverlayData, "next"> = { next: { title: "Boss rush", startsAt: serverNow + 600_000 } };
    const at = upNextStart({ type: "next", ref: null }, data);
    expect(at).toBe(serverNow + 600_000);
    const reload = vi.fn();
    atMark(serverNow, at!, reload);
    vi.advanceTimersByTime(599_999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(86_400_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for nothing when Up next is off air, has no stream, already started or is stopped", (): void => {
    vi.useFakeTimers();
    const data: Pick<OverlayData, "next"> = { next: { title: "Boss rush", startsAt: Date.now() + 60_000 } };
    expect(upNextStart({ type: "topic", ref: "t" }, data)).toBeNull();
    expect(upNextStart({ type: "next", ref: null }, { next: null })).toBeNull();
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
          source: { type: "poll", ref: poll },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            overlay: { position: "lower", size: "m", showResults: true, message: "", messageStyle: "info" },
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
          source: { type: "poll", ref: poll },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            overlay: { position: "lower", size: "m", showResults, message: "", messageStyle: "info" },
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
          source: { type: "card", ref },
          scene: {
            name: "Nova",
            handle: "nova",
            host: "streambullets.com",
            overlay: { position: "lower", size: "m", showResults: true, message: "", messageStyle: "info" },
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

  it("lets only the page owner create a battle, with distinct sides and a known length", async (): Promise<void> => {
    expect((await create("viewer")).status).toBe(403);
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

  it("reads the default state and the sources for the owner only", async (): Promise<void> => {
    expect((await call("GET", "overlay")).status).toBe(401);
    expect((await call("GET", "overlay", { user: "viewer" })).status).toBe(404);
    const result = await body<{ overlay: OverlayState; data: OverlayData; handle: string }>(
      await call("GET", "overlay", { user: "owner" }),
    );
    expect(result.overlay).toEqual(DEFAULT_OVERLAY);
    expect(result.handle).toBe("live_page");
    expect(result.data.polls).toEqual([{ id: poll, title: "Pick one", mash: false }]);
    expect(result.data.topics.map((value) => value.id)).toEqual([topic]);
    expect(result.data.cards).toEqual([
      { id: card, icon: "heart", title: "Card", body: "Body", label: null, target: null },
    ]);
    expect(result.data).toMatchObject({ next: null, support: null });
  });

  it("previews, takes and lays out, and tells the live room each time", async (): Promise<void> => {
    const previewed = await overlay(await send({ action: "preview", source: { type: "poll", ref: poll } }));
    expect(previewed).toMatchObject({ preview: { type: "poll", ref: poll }, air: { type: "auto" }, revision: 1 });
    const taken = await overlay(await send({ action: "take" }));
    expect(taken).toMatchObject({ air: { type: "poll", ref: poll }, revision: 2 });
    const layout = await overlay(await send({ action: "layout", position: "corner", showResults: false }));
    expect(layout).toMatchObject({ position: "corner", size: "m", instant: false, showResults: false, revision: 3 });
    const message = await overlay(await send({ action: "message", text: "  Be right back ", style: "hype" }));
    expect(message).toMatchObject({ message: "Be right back", messageStyle: "hype", air: { type: "poll" } });
    expect(roomCalls).toEqual(Array.from({ length: 4 }, () => ({ path: `/overlay?streamerId=${page}`, body: "" })));
  });

  it("puts the preview on air at once in instant mode", async (): Promise<void> => {
    await send({ action: "layout", instant: true, size: "s" });
    const state = await overlay(await send({ action: "preview", source: { type: "topic", ref: topic } }));
    expect(state).toMatchObject({ air: { type: "topic", ref: topic }, preview: { type: "topic", ref: topic } });
    // GET must return the on-air topic outside the newest list.
    const read = await body<{ data: OverlayData }>(await call("GET", "overlay", { user: "owner" }));
    expect(read.data.topics.map((value) => value.id)).toContain(topic);
  });

  it("checks that the source is on this page and drops refs a source does not use", async (): Promise<void> => {
    const refused = async (source: Record<string, unknown>): Promise<{ status: number; error: string }> => {
      const response = await send({ action: "preview", source });
      return { status: response.status, error: (await body<{ error: string }>(response)).error };
    };
    expect(await refused({ type: "poll", ref: null })).toEqual({ status: 400, error: "Pick a poll or topic." });
    expect(await refused({ type: "poll", ref: topic })).toEqual({ status: 404, error: "Poll not found." });
    expect(await refused({ type: "topic", ref: poll })).toEqual({ status: 404, error: "Topic not found." });
    expect(await refused({ type: "topic", ref: foreignTopic })).toEqual({ status: 404, error: "Topic not found." });
    expect(await refused({ type: "card", ref: "missing" })).toEqual({
      status: 404,
      error: "Community card not found.",
    });
    expect((await overlay(await send({ action: "preview", source: { type: "card", ref: card } }))).preview).toEqual({
      type: "card",
      ref: card,
    });
    expect((await overlay(await send({ action: "preview", source: { type: "card", ref: null } }))).preview).toEqual({
      type: "card",
      ref: null,
    });
    expect(
      (await overlay(await send({ action: "preview", source: { type: "support", ref: "anything" } }))).preview,
    ).toEqual({ type: "support", ref: null });
  });

  it("refuses bad actions, pages the user does not own, and frozen pages", async (): Promise<void> => {
    expect((await send({ action: "take", extra: 1 })).status).toBe(400);
    expect((await send({ action: "message", text: "two\nlines", style: "info" })).status).toBe(400);
    expect((await send({ action: "message", text: "x".repeat(121), style: "info" })).status).toBe(400);
    expect((await send({ action: "take" }, "viewer")).status).toBe(404);
    await expect(updateOverlay(env, "viewer", page, { action: "take" })).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
    expect((await send({ action: "take" })).status).toBe(423);
    expect(roomCalls).toEqual([]);
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
    const other = (): Promise<OverlayUpdate> =>
      updateOverlay(env, "owner", page, { action: "layout", position: "top" });
    const raced = racingEnv(other, 1);
    const { overlay: state } = await updateOverlay(raced, "owner", page, {
      action: "message",
      text: "Be right back",
      style: "hype",
    });
    expect(state).toMatchObject({ position: "top", message: "Be right back", messageStyle: "hype", revision: 3 });
    const stored = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
    expect(stored.overlay).toEqual(state);
  });

  it("answers 409 when other tabs keep saving first", async (): Promise<void> => {
    let size = 0;
    const sizes = ["s", "m", "l"] as const;
    const other = (): Promise<OverlayUpdate> =>
      updateOverlay(env, "owner", page, { action: "layout", size: sizes[size++ % 3] });
    await expect(
      updateOverlay(racingEnv(other, 3), "owner", page, { action: "layout", position: "center" }),
    ).rejects.toMatchObject({ status: 409 });
    const stored = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
    expect(stored.overlay).toMatchObject({ position: "lower", size: "l", revision: 3 });
  });

  it("keeps each layout value the action leaves out", async (): Promise<void> => {
    const current: OverlayState = {
      ...DEFAULT_OVERLAY,
      position: "top",
      size: "l",
      instant: false,
      showResults: false,
    };
    expect(await nextOverlayState(env, page, current, { action: "layout" })).toEqual({ ...current, revision: 1 });
    expect(
      await nextOverlayState(env, page, current, { action: "layout", size: "s", instant: false, showResults: true }),
    ).toEqual({ ...current, size: "s", showResults: true, revision: 1 });
  });

  describe("layers", (): void => {
    const chatCell: CellRect = { c: 10, r: 0, w: 6, h: 5 };
    const horizontal = (patch: Partial<OverlayLayers["cells"]["horizontal"]>): OverlayLayers["cells"] => ({
      ...DEFAULT_LAYERS.cells,
      horizontal: { ...DEFAULT_LAYERS.cells.horizontal, ...patch },
    });

    async function storedLayers(streamerId: string): Promise<unknown> {
      const row = await env.DB.prepare("SELECT layers FROM overlay_state WHERE streamer_id=?")
        .bind(streamerId)
        .first<{ layers: string }>();
      return row ? JSON.parse(row.layers) : null;
    }

    it("saves each layer change, sends it to the live room and reads it back", async (): Promise<void> => {
      expect(DEFAULT_OVERLAY.layers).toEqual(DEFAULT_LAYERS);
      const first = await overlay(
        await send({ action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: chatCell } } }),
      );
      expect(first).toMatchObject({ revision: 1, position: "lower", air: { type: "auto" } });
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
          cells: { horizontal: { content: { c: 0, r: 0, w: 6, h: 4 } } },
        }),
      );
      expect(second.layers).toEqual({
        orientation: "vertical",
        chat: { enabled: true, hideCommands: false, backgroundOpacity: 45 },
        characters: { enabled: true, timeout: 60 },
        cells: horizontal({ chat: chatCell, content: { c: 0, r: 0, w: 6, h: 4 } }),
      });
      expect(second.revision).toBe(2);
      expect(await storedLayers(page)).toEqual(second.layers);
      const read = await body<{ overlay: OverlayState }>(await call("GET", "overlay", { user: "owner" }));
      expect(read.overlay).toEqual(second);
      // Other actions keep the layers.
      expect((await overlay(await send({ action: "layout", size: "l" }))).layers).toEqual(second.layers);
      // Null removes the content cell.
      const third = await overlay(await send({ action: "layers", cells: { horizontal: { content: null } } }));
      expect(third.layers.cells.horizontal.content).toBeNull();
      expect(roomCalls).toEqual(Array.from({ length: 4 }, () => ({ path: `/overlay?streamerId=${page}`, body: "" })));
      // The character playground reads the saved layers again after each layers change, not after other actions.
      expect(ingestCalls).toEqual(
        Array.from({ length: 3 }, () => ({ path: `/playground-config?streamerId=${page}`, body: "" })),
      );
    });

    it("saves the characters timeout, and does not tell the playground while channels are off", async (): Promise<void> => {
      const saved = await overlay(await send({ action: "layers", characters: { enabled: true, timeout: 120 } }));
      expect(saved.layers.characters).toEqual({ enabled: true, timeout: 120 });
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

    it("reads a row saved before layers existed as the default layers", async (): Promise<void> => {
      await env.DB.prepare("INSERT INTO overlay_state (streamer_id,position,revision,updated_at) VALUES (?,'top',5,1)")
        .bind(page)
        .run();
      expect(await storedLayers(page)).toEqual({});
      const state = await getOverlayState(env, page);
      expect(state).toMatchObject({ position: "top", revision: 5, layers: DEFAULT_LAYERS, chatTestUntil: 0 });
      expect(overlayPublic(state).layers).toEqual(DEFAULT_LAYERS);
      const next = await overlay(await send({ action: "layers", characters: { enabled: true } }));
      expect(next.layers.characters.enabled).toBe(true);
      expect(await storedLayers(page)).toEqual(next.layers);
    });

    it("refuses cells outside the grid, below the minimum or over each other, and unknown fields", async (): Promise<void> => {
      const refused: Record<string, unknown>[] = [
        { cells: { horizontal: { chat: { c: 14, r: 0, w: 3, h: 2 } } } },
        { cells: { vertical: { chat: { c: 0, r: 15, w: 3, h: 2 } } } },
        { cells: { horizontal: { chat: { c: -1, r: 0, w: 3, h: 2 } } } },
        { cells: { horizontal: { chat: { c: 0, r: 0, w: 2, h: 2 } } } },
        { cells: { horizontal: { characters: { c: 0, r: 0, w: 5, h: 2 } } } },
        { cells: { horizontal: { content: { c: 6, r: 0, w: 3, h: 2 } } } },
        { cells: { horizontal: { chat: { c: 0.5, r: 0, w: 3, h: 2 } } } },
        { cells: { horizontal: { chat: { c: 0, r: 0, w: 3 } } } },
        { cells: { horizontal: { chat: { ...chatCell, z: 1 } } } },
        { cells: { horizontal: { chat: null } } },
        // Over a saved cell: the chat default covers columns 0 to 4, rows 0 to 6.
        { cells: { horizontal: { content: { c: 4, r: 0, w: 4, h: 2 } } } },
        // Over each other in the same patch.
        { cells: { horizontal: { chat: chatCell, content: { c: 10, r: 4, w: 4, h: 2 } } } },
        { chat: { rect: { x: 0, y: 0, w: 280, h: 160 } } },
        { chat: { enabled: true, color: "#f00" } },
        { characters: { hideCommands: false } },
        { content: { enabled: false } },
        { orientation: "square" },
        { chat: { enabled: "yes" } },
        { chat: { backgroundOpacity: 3 } },
        { chat: { backgroundOpacity: "50" } },
        { layers: { chat: { enabled: true } } },
        { write: { writer: "short", seq: 1 } },
        { write: { writer: "editor-1234", seq: 0 } },
        { write: { writer: "editor-1234", seq: 1, extra: true } },
      ];
      for (const patch of refused) expect((await send({ action: "layers", ...patch })).status).toBe(400);
      expect(await storedLayers(page)).toBeNull();
      expect(roomCalls).toEqual([]);
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
      expect((await send({ action: "take" })).status).toBe(200);
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
      expect(await storedLayers(page)).toBeNull();
      expect(roomCalls).toEqual([]);
    });

    it("changes only the page of the signed-in owner", async (): Promise<void> => {
      await send({ action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: chatCell } } });
      const other = await overlay(await send({ action: "layers", characters: { enabled: true } }, "other"));
      expect(other.layers).toEqual({ ...DEFAULT_LAYERS, characters: { enabled: true, timeout: 60 } });
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
      const current: OverlayState = { ...DEFAULT_OVERLAY, position: "top", message: "Hi", revision: 7 };
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
          cells: { horizontal: { chat: { c, r: 0, w: 3, h: 2 } } },
        });
      const chatColumn = async (): Promise<number> => (await getOverlayState(env, page)).layers.cells.horizontal.chat.c;
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
        expect(await chatColumn()).toBe(10);
        // Other actions keep the last writes.
        await updateOverlay(env, "owner", page, { action: "layout", size: "s" });
        expect((await moveChat(8, 1, "editor-2222-3333")).overlay.layers.cells.horizontal.chat.c).toBe(10);
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
          cells: { horizontal: { chat: { c: 5, r: 0, w: 3, h: 2 } } },
        });
        expect(state.layers.cells.horizontal.chat.c).toBe(9);
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
        expect((await send({ action: "take" })).status).toBe(200);
        expect((await moveChat(5, 1)).changed).toBe(true);
        expect(await storedWrites()).toEqual([[writer, 1]]);
        warn.mockRestore();
      });

      it("does not notify the overlay pages for an ignored write", async (): Promise<void> => {
        const cells = { horizontal: { chat: { c: 4, r: 0, w: 3, h: 2 } } };
        expect((await send({ action: "layers", write: { writer, seq: 2 }, cells })).status).toBe(200);
        const late = await send({ action: "layers", write: { writer, seq: 1 }, cells });
        expect(late.status).toBe(200);
        expect(roomCalls).toEqual([{ path: `/overlay?streamerId=${page}`, body: "" }]);
      });
    });
  });

  describe("character playground controls", (): void => {
    function characters(control: unknown, user: string = "owner"): Promise<Response> {
      return call("POST", "overlay/characters", { user, body: control });
    }

    async function charactersOn(): Promise<void> {
      expect((await send({ action: "layers", characters: { enabled: true } })).status).toBe(200);
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

    it("starts a test only with the characters layer saved on", async (): Promise<void> => {
      const refused = await characters({ op: "test" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "Turn on the characters layer first." });
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

  describe("chat test", (): void => {
    it("stores the end time, broadcasts it and stops at once", async (): Promise<void> => {
      await updateOverlay(env, "owner", page, { action: "layers", chat: { enabled: true } });
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
      const layers: OverlayLayers = { ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } };
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

    it("ends a running test when the chat layer turns off", async (): Promise<void> => {
      const layers: OverlayLayers = { ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } };
      const running: OverlayState = { ...DEFAULT_OVERLAY, layers, chatTestUntil: 9_000, revision: 3 };
      const off = await nextOverlayState(env, page, running, { action: "layers", chat: { enabled: false } });
      expect(off).toMatchObject({ chatTestUntil: 0, revision: 4 });
      expect(off.layers.chat.enabled).toBe(false);
      // Other layer edits keep the test running.
      const moved = await nextOverlayState(env, page, running, { action: "layers", chat: { hideCommands: false } });
      expect(moved.chatTestUntil).toBe(9_000);
    });

    it("refuses to start while the chat layer is off, but stops", async (): Promise<void> => {
      const refused = await send({ action: "chatTest", on: true });
      expect(refused.status).toBe(400);
      expect(await body<{ error: string }>(refused)).toEqual({ error: "Turn on the chat layer first." });
      expect((await getOverlayState(env, page)).chatTestUntil).toBe(0);
      expect((await overlay(await send({ action: "chatTest", on: false }))).chatTestUntil).toBe(0);
      expect(roomCalls).toHaveLength(1);
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

  it("keeps an old topic on air and in preview in the monitors' data", async (): Promise<void> => {
    // 55 newer topics displace the seed from the newest 50.
    const newer: string[] = Array.from({ length: 55 }, (): string => crypto.randomUUID());
    await env.DB.batch(
      newer.map((id: string, index: number) =>
        env.DB.prepare(
          "INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES (?,?,'viewer','topic',?,'[]',?)",
        ).bind(id, page, `Newer ${index}`, 10 + index),
      ),
    );
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "topic", ref: topic } });
    await updateOverlay(env, "owner", page, { action: "take" });
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "card", ref: card } });
    const url = `${origin}/overlay-control`;
    const request = new Request(url, { headers: { cookie: await cookie("owner") } });
    const loaded = await controlLoader({ request, params: {}, context: context(), url: new URL(url), pattern: "" });
    expect(loaded.state.air).toEqual({ type: "topic", ref: topic });
    expect(loaded.data.topics.map((value) => value.id)).toContain(topic);
    // Overlay reload retains the topic on air or in preview.
    const api = async (): Promise<string[]> =>
      (await body<{ data: OverlayData }>(await call("GET", "overlay", { user: "owner" }))).data.topics.map(
        (value) => value.id,
      );
    expect(await api()).toContain(topic);
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "topic", ref: topic } });
    await updateOverlay(env, "owner", page, { action: "take" });
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "topic", ref: newer[0] } });
    expect(await api()).toEqual(expect.arrayContaining([topic, newer[0]]));
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
    expect(data.polls).toEqual([{ id: poll, title: "Pick one", mash: true }]);
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

  it("reloads an overlay showing Support after the links are saved, and only then", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const reloads = (): number => roomCalls.filter((value) => value.path === `/overlay?streamerId=${page}`).length;
    const save = async (url: string): Promise<void> => {
      const support = { links: [{ kind: "kofi", label: null, url }], visible: true, card: true };
      const response = await call("PUT", "support-links", { user: "owner", body: support });
      expect(response.status).toBe(200);
    };
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "topic", ref: topic } });
    await updateOverlay(env, "owner", page, { action: "take" });
    let before = await revision();
    await save("https://ko-fi.com/first");
    expect(await revision()).toBe(before);
    expect(reloads()).toBe(0);
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "support", ref: null } });
    await updateOverlay(env, "owner", page, { action: "take" });
    before = await revision();
    await save("https://ko-fi.com/second");
    expect(await revision()).toBe(before + 1);
    expect(reloads()).toBe(1);
  });

  it("reloads an overlay showing Up next after each schedule change, and only then", async (): Promise<void> => {
    const revision = async (): Promise<number> => (await getOverlayState(env, page)).revision;
    const reloads = (): number => roomCalls.filter((value) => value.path === `/overlay?streamerId=${page}`).length;
    // Schedule edits must preserve other on-air sources.
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "topic", ref: topic } });
    await updateOverlay(env, "owner", page, { action: "take" });
    let before = await revision();
    const first = await call("POST", "events", { user: "owner", body: event() });
    const { event: stream } = await body<{ event: StreamEvent }>(first);
    expect(await revision()).toBe(before);
    expect(reloads()).toBe(0);
    // Up next must reload on event creation, edits, cancellation, and deletion.
    await updateOverlay(env, "owner", page, { action: "preview", source: { type: "next", ref: null } });
    await updateOverlay(env, "owner", page, { action: "take" });
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
