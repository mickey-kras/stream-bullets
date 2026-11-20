import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import {
  decodeCursor,
  getEntry,
  getOverlaySnapshot,
  listEntries,
  mutateEntry,
  saveStreamer,
} from "../app/server/data.server";
import { LIVE_POLLS_SQL, livePolls, overlaySnapshot, type PollRow } from "../app/server/live-polls";
import { DEFAULT_LAYERS, mergeLayers } from "../app/lib/overlay-layers";
import { createMash, runMashAction } from "../app/server/mash.server";
import { DEFAULT_OVERLAY, overlayPublic } from "../app/server/overlay-state";
import { getOverlayData, updateOverlay } from "../app/server/overlay.server";
import type { BoardSnapshot, EntryStatus, LiveSnapshot, Streamer } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

// Viewer polls: who creates and changes them, what the overlay shows by itself, and the order of the Polls list.

let database: TestDatabase;
let env: AppEnv;
let streamer: Streamer;

interface SeedPoll {
  author?: string;
  createdAt?: number;
  revealed?: boolean;
  endsAt?: number | null;
  kind?: "choice" | "binary";
  status?: EntryStatus | null;
  title?: string;
}

function pollInsert(id: string, poll: SeedPoll): D1PreparedStatement {
  const kind = poll.kind ?? "choice";
  return env.DB.prepare(`INSERT INTO entries
      (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed,status)
    VALUES (?,?,?,?,?,'','',?,?,?,?,?)`).bind(
    id,
    streamer.id,
    poll.author ?? "owner",
    kind,
    poll.title ?? "A poll",
    JSON.stringify(kind === "binary" ? ["Yes", "No"] : ["One", "Two"]),
    poll.createdAt ?? Date.now(),
    poll.endsAt ?? null,
    poll.revealed ? 1 : 0,
    poll.status ?? null,
  );
}

async function seedPoll(poll: SeedPoll = {}): Promise<string> {
  const id = crypto.randomUUID();
  await pollInsert(id, poll).run();
  return id;
}

// Seeds many polls in one batch and returns their IDs in input order.
async function seedPolls(polls: readonly SeedPoll[]): Promise<string[]> {
  const ids: string[] = polls.map((): string => crypto.randomUUID());
  await env.DB.batch(polls.map((poll: SeedPoll, index: number): D1PreparedStatement => pollInsert(ids[index], poll)));
  return ids;
}

async function finishedBattle(id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO entry_mash (entry_id,duration_s,phase,starts_at,ends_at,winner) VALUES (?,30,'finished',1,2,0)",
  )
    .bind(id)
    .run();
}

async function resetQuota(): Promise<void> {
  await env.DB.prepare("DELETE FROM app_rate_limits").run();
}

async function autoPolls(): Promise<string[]> {
  return (await getOverlaySnapshot(env, streamer.id, null)).polls.map((poll): string => poll.id);
}

async function liveSnapshotPolls(): Promise<LiveSnapshot["polls"]> {
  const rows = await env.DB.prepare(LIVE_POLLS_SQL).bind(streamer.id, streamer.id).all<PollRow>();
  return livePolls(rows.results);
}

function createChoice(user: string, title: string = "Which one?"): Promise<{ id: string }> {
  return mutateEntry(env, user, streamer.id, { action: "create", kind: "choice", title, options: ["A", "B"] });
}

function createBattle(user: string): Promise<{ id: string }> {
  return createMash(env, user, streamer.id, {
    action: "create",
    kind: "mash",
    title: "Cats or dogs",
    options: ["Cats", "Dogs"],
    durationS: 30,
  });
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db } as AppEnv;
});

afterAll(async (): Promise<void> => database.dispose());

afterEach((): void => {
  vi.restoreAllMocks();
});

beforeEach(async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    ...["owner", "viewer", "other"].map(
      (id: string): D1PreparedStatement =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").bind(
          id,
          `Name ${id}`,
          `${id}@example.test`,
          Date.now(),
          Date.now(),
        ),
    ),
    env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
      VALUES (?,'owner','["https://example.test/channel"]','approved',1,1,1)`).bind(crypto.randomUUID()),
  ]);
  streamer = await saveStreamer(env, "owner", { handle: "misha", name: "Misha", about: "" });
});

describe("viewer polls", (): void => {
  it("lets a signed-in viewer create each poll kind", async (): Promise<void> => {
    const choice = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "choice",
      title: "Which game?",
      options: ["A", "B", "C"],
      duration: 60,
    });
    const binary = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "binary",
      title: "One more round?",
    });
    const battle = await createBattle("viewer");
    const created = await Promise.all(
      [choice.id, binary.id, battle.id].map((id: string) => getEntry(env, id, "viewer")),
    );
    expect(created).toMatchObject([
      { kind: "choice", authorId: "viewer", author: "Name viewer", options: ["A", "B", "C"], status: null },
      { kind: "binary", authorId: "viewer", options: ["Yes", "No"], endsAt: null, status: null },
      { kind: "mash", authorId: "viewer", options: ["Cats", "Dogs"], status: null, mash: { phase: "setup" } },
    ]);
    expect((created[0]?.endsAt ?? 0) - (created[0]?.createdAt ?? 0)).toBe(60_000);
    // The validation of polls does not depend on the author.
    await expect(
      mutateEntry(env, "viewer", streamer.id, { action: "create", kind: "choice", title: "Same", options: ["A", "a"] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("holds a viewer poll on the official page under review, like a topic, and keeps it off the overlay", async (): Promise<void> => {
    await env.DB.prepare("UPDATE streamers SET is_official=1 WHERE id=?").bind(streamer.id).run();
    const idea = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "topic",
      title: "An idea",
      body: "Details",
      category: "feature",
    });
    const held = await createChoice("viewer");
    const heldBattle = await createBattle("viewer");
    const own = await createChoice("owner", "Owner poll");
    const statusOf = async (id: string): Promise<EntryStatus | null | undefined> =>
      (await getEntry(env, id, null))?.status;
    expect(await statusOf(idea.id)).toBe("review");
    expect(await statusOf(held.id)).toBe("review");
    expect(await statusOf(heldBattle.id)).toBe("review");
    expect(await statusOf(own.id)).toBeNull();

    // Nothing shows a held poll: not automatic selection, not its ID, not the picker and not the live room.
    expect(await autoPolls()).toEqual([own.id]);
    expect((await getOverlaySnapshot(env, streamer.id, held.id)).polls).toEqual([]);
    expect((await getOverlayData(env, streamer.id, [])).polls.map((poll) => poll.id)).toEqual([own.id]);
    expect((await liveSnapshotPolls()).map((poll) => poll.id)).toEqual([own.id]);
    await expect(
      updateOverlay(env, "owner", streamer.id, { action: "preview", source: { type: "poll", ref: held.id } }),
    ).rejects.toMatchObject({ status: 404, message: "Poll not found." });

    // After review, the owner can pick the poll. Automatic selection still ignores it. A declined poll stays out.
    await env.DB.prepare("UPDATE entries SET status='planned' WHERE id=?").bind(held.id).run();
    expect((await getOverlaySnapshot(env, streamer.id, held.id)).polls).toMatchObject([
      { id: held.id, byOwner: false },
    ]);
    expect(await autoPolls()).toEqual([own.id]);
    await env.DB.prepare("UPDATE entries SET status='declined' WHERE id=?").bind(held.id).run();
    expect((await getOverlaySnapshot(env, streamer.id, held.id)).polls).toEqual([]);
  });

  it("refuses a viewer poll on a frozen or suspended page, over the quota and over the page limit", async (): Promise<void> => {
    const setStatus = (status: string): Promise<D1Result> =>
      env.DB.prepare("UPDATE streamers SET status=? WHERE id=?").bind(status, streamer.id).run();
    await setStatus("frozen");
    await expect(createChoice("viewer")).rejects.toMatchObject({ status: 423, code: "page_frozen" });
    await expect(createBattle("viewer")).rejects.toMatchObject({ status: 423 });
    // A suspended page does not exist for a viewer.
    await setStatus("suspended");
    await expect(createChoice("viewer")).rejects.toMatchObject({ status: 404 });
    await expect(createBattle("viewer")).rejects.toMatchObject({ status: 404 });
    await setStatus("active");

    // The content quota of topics also limits polls: six new items in one minute.
    await env.DB.prepare(
      "INSERT INTO app_rate_limits (key,count,window_start) VALUES ('content:viewer',6,CAST(strftime('%s','now') AS INTEGER)/60*60000)",
    ).run();
    await expect(createChoice("viewer")).rejects.toMatchObject({ status: 429 });
    await expect(createBattle("viewer")).rejects.toMatchObject({ status: 429 });
    await resetQuota();

    // The page limit counts topics and polls together.
    await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
      SELECT 'seed-'||i,?,'owner','topic','Topic','Details','Gaming','[]',i FROM n`)
      .bind(streamer.id)
      .run();
    const full = { status: 403, message: "Each page can contain up to 1000 topics and polls." };
    await expect(createChoice("viewer")).rejects.toMatchObject(full);
    await expect(createBattle("viewer")).rejects.toMatchObject(full);
    await resetQuota();
    await expect(createChoice("owner")).rejects.toMatchObject(full);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entries WHERE kind!='topic'").first()).toEqual({ n: 0 });
  });

  it("lets only the page owner reveal results or run a battle, and the author or the owner delete a poll", async (): Promise<void> => {
    const ownerPoll = await createChoice("owner", "Owner poll");
    const ownerBinary = await mutateEntry(env, "owner", streamer.id, {
      action: "create",
      kind: "binary",
      title: "Owner yes or no",
    });
    const viewerPoll = await createChoice("viewer", "Viewer poll");
    const viewerBattle = await createBattle("viewer");
    const refusedReveal = { status: 403, message: "Only the streamer can reveal poll results." };

    // A viewer cannot end, reveal or delete a poll of the owner.
    for (const id of [ownerPoll.id, ownerBinary.id])
      await expect(mutateEntry(env, "viewer", streamer.id, { action: "reveal", id })).rejects.toMatchObject(
        refusedReveal,
      );
    await expect(mutateEntry(env, "viewer", streamer.id, { action: "delete", id: ownerPoll.id })).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    // The author of a viewer poll cannot end it or run the battle. Another viewer cannot delete it.
    await expect(
      mutateEntry(env, "viewer", streamer.id, { action: "reveal", id: viewerPoll.id }),
    ).rejects.toMatchObject(refusedReveal);
    await expect(runMashAction(env, "viewer", viewerBattle.id, "start", { countdown: false })).rejects.toMatchObject({
      status: 403,
    });
    await expect(mutateEntry(env, "other", streamer.id, { action: "delete", id: viewerPoll.id })).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    expect(await getEntry(env, ownerPoll.id, null)).toMatchObject({ revealed: false });
    expect(await getEntry(env, viewerPoll.id, null)).toMatchObject({ revealed: false });

    // Voting rules do not depend on the author.
    await mutateEntry(env, "other", streamer.id, { action: "vote", id: viewerPoll.id, choice: 1 });
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id: ownerPoll.id, choice: 0 });

    // The owner ends a viewer poll and runs a viewer battle. The author deletes the own poll, like a topic.
    await mutateEntry(env, "owner", streamer.id, { action: "reveal", id: viewerPoll.id });
    expect(await getEntry(env, viewerPoll.id, null)).toMatchObject({ revealed: true, counts: [0, 1] });
    await runMashAction(env, "owner", viewerBattle.id, "start", { countdown: false });
    await mutateEntry(env, "viewer", streamer.id, { action: "delete", id: viewerPoll.id });
    expect(await getEntry(env, viewerPoll.id, null)).toBeNull();
    await mutateEntry(env, "owner", streamer.id, { action: "delete", id: viewerBattle.id });
    expect(await getEntry(env, viewerBattle.id, null)).toBeNull();
  });

  it("ignores viewer polls in automatic overlay selection and shows one that the owner picks", async (): Promise<void> => {
    // Only viewer polls: automatic selection shows nothing, also for a running viewer poll.
    const viewerOpen = await seedPoll({ author: "viewer", createdAt: 50, title: "Viewer open" });
    expect(await autoPolls()).toEqual([]);
    // A closed poll of the owner wins over a newer open viewer poll.
    const ownerClosed = await seedPoll({ createdAt: 10, revealed: true });
    expect(await autoPolls()).toEqual([ownerClosed]);
    const ownerOpen = await seedPoll({ createdAt: 20 });
    expect(await autoPolls()).toEqual([ownerOpen]);
    const snapshot = await getOverlaySnapshot(env, streamer.id, null);
    expect(snapshot.polls).toMatchObject([{ id: ownerOpen, byOwner: true }]);

    // "A specific poll": the owner picks the viewer poll by its ID.
    const picked = await getOverlaySnapshot(env, streamer.id, viewerOpen);
    expect(picked.polls).toMatchObject([{ id: viewerOpen, title: "Viewer open", byOwner: false }]);
    const { overlay } = await updateOverlay(env, "owner", streamer.id, {
      action: "preview",
      source: { type: "poll", ref: viewerOpen },
    });
    expect(overlay.preview).toEqual({ type: "poll", ref: viewerOpen });
    // The author of the poll cannot put it on the overlay.
    await expect(
      updateOverlay(env, "viewer", streamer.id, { action: "preview", source: { type: "poll", ref: viewerOpen } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps the owner's open poll in the live snapshot and marks the author of each poll", async (): Promise<void> => {
    const ownerOpen = await seedPoll({ createdAt: 1 });
    const viewerOldOpen = await seedPoll({ author: "viewer", createdAt: 2 });
    // 50 newer viewer polls fill the list of recent polls.
    const newer = await seedPolls(
      Array.from(
        { length: 50 },
        (_: unknown, index: number): SeedPoll => ({ author: "viewer", createdAt: 10 + index }),
      ),
    );
    const polls = await liveSnapshotPolls();
    const ids: string[] = polls.map((poll) => poll.id);
    expect(ids).toHaveLength(50);
    // The old open poll of the owner stays. The old open viewer poll gets no place: it is never the automatic poll.
    expect(ids).toContain(ownerOpen);
    expect(ids).not.toContain(viewerOldOpen);
    expect(polls.filter((poll) => poll.byOwner).map((poll) => poll.id)).toEqual([ownerOpen]);
    expect(polls.find((poll) => poll.id === newer[49])).toMatchObject({ byOwner: false });

    // The OBS overlay socket receives the polls of the owner, plus the poll that the owner put on air.
    const snapshot: LiveSnapshot = {
      type: "snapshot",
      revision: 1,
      serverNow: 1,
      polls,
      overlay: overlayPublic(DEFAULT_OVERLAY),
    };
    expect(overlaySnapshot(snapshot).polls.map((poll) => poll.id)).toEqual([ownerOpen]);
    expect(overlaySnapshot({ ...snapshot, overlay: undefined }).polls.map((poll) => poll.id)).toEqual([ownerOpen]);
    const onAir: LiveSnapshot = {
      ...snapshot,
      overlay: overlayPublic({ ...DEFAULT_OVERLAY, air: { type: "poll", ref: newer[49] } }),
    };
    expect(overlaySnapshot(onAir).polls.map((poll) => poll.id)).toEqual([newer[49], ownerOpen]);
    // A topic source with the same ID field shows no viewer poll.
    const topicOnAir: LiveSnapshot = {
      ...snapshot,
      overlay: overlayPublic({ ...DEFAULT_OVERLAY, air: { type: "topic", ref: newer[49] } }),
    };
    expect(overlaySnapshot(topicOnAir).polls.map((poll) => poll.id)).toEqual([ownerOpen]);
    // A poll layer on stream picks a viewer poll. A poll layer that is off, or not on the grid, picks none.
    const layerOn = (enabled: boolean, placed: boolean): LiveSnapshot => ({
      ...snapshot,
      overlay: overlayPublic({
        ...DEFAULT_OVERLAY,
        layers: mergeLayers(DEFAULT_LAYERS, {
          items: { poll: { ref: newer[49], enabled } },
          cells: { horizontal: { poll: placed ? { c: 6, r: 0, w: 4, h: 2 } : null } },
        }),
      }),
    });
    expect(overlaySnapshot(layerOn(true, true)).polls.map((poll) => poll.id)).toEqual([newer[49], ownerOpen]);
    expect(overlaySnapshot(layerOn(false, true)).polls.map((poll) => poll.id)).toEqual([ownerOpen]);
    expect(overlaySnapshot(layerOn(true, false)).polls.map((poll) => poll.id)).toEqual([ownerOpen]);
  });

  it("lists the owner's polls first in the overlay picker, and names the author of each viewer poll", async (): Promise<void> => {
    const ownerOld = await seedPoll({ createdAt: 1, title: "Owner old" });
    const viewerNew = await seedPoll({ author: "viewer", createdAt: 5, title: "Viewer new" });
    const otherNewest = await seedPoll({ author: "other", createdAt: 9, title: "Other newest" });
    expect((await getOverlayData(env, streamer.id, [])).polls).toEqual([
      { id: ownerOld, title: "Owner old", mash: false, author: "Name owner", byOwner: true },
      { id: otherNewest, title: "Other newest", mash: false, author: "Name other", byOwner: false },
      { id: viewerNew, title: "Viewer new", mash: false, author: "Name viewer", byOwner: false },
    ]);
    // Many viewer polls cannot push a poll of the owner out of the picker.
    await seedPolls(
      Array.from(
        { length: 60 },
        (_: unknown, index: number): SeedPoll => ({ author: "viewer", createdAt: 100 + index }),
      ),
    );
    const picker = (await getOverlayData(env, streamer.id, [])).polls;
    expect(picker).toHaveLength(51);
    expect(picker[0]).toMatchObject({ id: ownerOld, byOwner: true });
  });
});

describe("polls list order", (): void => {
  const T = 1_700_000_000_000;

  function listPolls(cursor: string | null, sort: "newest" | "top" = "newest"): Promise<BoardSnapshot> {
    return listEntries(env, streamer, null, { kind: "polls", sort, query: "", cursor });
  }

  // Reads each page until the list ends. A list that does not end fails the test.
  async function allPages(first: string | null = null): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | null = first;
    do {
      const page: BoardSnapshot = await listPolls(cursor);
      pages.push(page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
      expect(pages.length).toBeLessThanOrEqual(10);
    } while (cursor);
    return pages;
  }

  interface Listed extends SeedPoll {
    id: string;
    group: number;
    createdAt: number;
  }

  function expectedOrder(polls: readonly Listed[]): string[] {
    return [...polls]
      .sort((a: Listed, b: Listed): number => {
        if (a.group !== b.group) return a.group - b.group;
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return a.id < b.id ? 1 : -1;
      })
      .map((poll: Listed): string => poll.id);
  }

  it("lists active owner polls, active polls of other people, then all other polls, across pages", async (): Promise<void> => {
    vi.spyOn(Date, "now").mockReturnValue(T);
    const seeds: (SeedPoll & { group: number; createdAt: number })[] = [];
    for (let index = 0; index < 30; index += 1) {
      // Each second pair shares a creation time: the ID decides the order.
      const time: number = 1000 + Math.floor(index / 2) * 10;
      seeds.push(
        { group: 0, createdAt: time, endsAt: index % 3 === 0 ? T + 60_000 : null },
        { group: 1, createdAt: time + 1, author: index % 2 === 0 ? "viewer" : "other" },
        // Not active: revealed, voting time over, of the owner and of viewers. All in one group, newest first.
        {
          group: 2,
          createdAt: time + 2,
          revealed: index % 2 === 0,
          endsAt: index % 2 === 0 ? null : T - 1,
          author: index % 4 < 2 ? "owner" : "viewer",
        },
      );
    }
    const ids: string[] = await seedPolls(seeds);
    const polls: Listed[] = seeds.map((seed, index: number): Listed => ({ ...seed, id: ids[index] }));
    // A finished Mash Battle is not active. A battle that waits for its start is.
    const finished = await seedPoll({ createdAt: 5000 });
    await finishedBattle(finished);
    const waiting = await seedPoll({ author: "viewer", createdAt: 1 });
    await env.DB.prepare("INSERT INTO entry_mash (entry_id,duration_s) VALUES (?,30)").bind(waiting).run();
    polls.push({ id: finished, group: 2, createdAt: 5000 }, { id: waiting, group: 1, createdAt: 1 });

    const pages: string[][] = await allPages();
    expect(pages.map((page: string[]): number => page.length)).toEqual([50, 42]);
    expect(pages.flat()).toEqual(expectedOrder(polls));
    // Page 1 ends inside the group of other people's polls: both group borders lie on a page border or inside a page.
    const groupOf = new Map<string, number>(polls.map((poll: Listed): [string, number] => [poll.id, poll.group]));
    expect(pages[0].map((id: string) => groupOf.get(id))).toEqual([
      ...Array<number>(30).fill(0),
      ...Array<number>(20).fill(1),
    ]);
    expect(groupOf.get(pages[1][10])).toBe(1);
    expect(groupOf.get(pages[1][11])).toBe(2);
    // The page opens on the first poll of this order: the newest active poll of the owner.
    expect(pages[0][0]).toBe(expectedOrder(polls.filter((poll: Listed): boolean => poll.group === 0))[0]);
    // "My" polls are the polls of the page owner for each visitor, not the polls of the current viewer.
    const forViewer = await listEntries(env, streamer, "viewer", {
      kind: "polls",
      sort: "newest",
      query: "",
      cursor: null,
    });
    expect(forViewer.entries.map((entry) => entry.id)).toEqual(pages[0]);
  });

  it("puts group borders on page borders without a lost or repeated poll", async (): Promise<void> => {
    vi.spyOn(Date, "now").mockReturnValue(T);
    const seeds: (SeedPoll & { group: number; createdAt: number })[] = [
      ...Array.from({ length: 50 }, (_: unknown, index: number) => ({ group: 0, createdAt: 100 + index })),
      ...Array.from({ length: 50 }, (_: unknown, index: number) => ({
        group: 1,
        createdAt: 500 + index,
        author: "viewer",
      })),
      ...Array.from({ length: 3 }, (_: unknown, index: number) => ({
        group: 2,
        createdAt: 900 + index,
        revealed: true,
      })),
    ];
    const ids: string[] = await seedPolls(seeds);
    const pages: string[][] = await allPages();
    expect(pages.map((page: string[]): number => page.length)).toEqual([50, 50, 3]);
    expect(pages.flat()).toEqual(
      expectedOrder(seeds.map((seed, index: number): Listed => ({ ...seed, id: ids[index] }))),
    );
  });

  it("keeps each poll in its group when its voting time ends between two pages", async (): Promise<void> => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T);
    // 60 polls of the owner with one second of voting time left, then 10 viewer polls without a time limit.
    const timed: string[] = await seedPolls(
      Array.from(
        { length: 60 },
        (_: unknown, index: number): SeedPoll => ({ createdAt: 100 + index, endsAt: T + 1000 }),
      ),
    );
    const open: string[] = await seedPolls(
      Array.from(
        { length: 10 },
        (_: unknown, index: number): SeedPoll => ({ author: "viewer", createdAt: 10 + index }),
      ),
    );
    const first: BoardSnapshot = await listPolls(null);
    expect(first.entries.map((entry) => entry.id)).toEqual([...timed].reverse().slice(0, 50));
    expect(decodeCursor(first.nextCursor, `${streamer.id}:polls`, "newest")).toMatchObject({ group: 0, at: T });

    // The voting time of all 60 polls ends before the visitor loads the next page.
    clock.mockReturnValue(T + 5000);
    const rest: string[][] = await allPages(first.nextCursor);
    expect(rest.flat()).toEqual([...[...timed].reverse().slice(50), ...[...open].reverse()]);
    const all: string[] = [...first.entries.map((entry) => entry.id), ...rest.flat()];
    expect(new Set(all).size).toBe(70);
    // A new first page uses the new time: the viewer polls are the only active polls.
    expect((await listPolls(null)).entries.slice(0, 11).map((entry) => entry.id)).toEqual([
      ...[...open].reverse(),
      timed[59],
    ]);
  });

  it("ends the list when the owner ends a poll between two pages", async (): Promise<void> => {
    vi.spyOn(Date, "now").mockReturnValue(T);
    const ids: string[] = await seedPolls(
      Array.from({ length: 120 }, (_: unknown, index: number): SeedPoll => ({ createdAt: 100 + index })),
    );
    const first: BoardSnapshot = await listPolls(null);
    // The newest poll was on page 1. The owner ends it and all polls of page 2: they move to the last group.
    await env.DB.prepare("UPDATE entries SET revealed=1 WHERE created_at>=? OR created_at=?").bind(170, 219).run();
    const rest: string[][] = await allPages(first.nextCursor);
    const seen = new Set<string>([...first.entries.map((entry) => entry.id), ...rest.flat()]);
    // The list ends, and it shows each poll. A poll that changed its group can show two times: the page drops the copy.
    expect(seen.size).toBe(120);
    expect(ids.every((id: string): boolean => seen.has(id))).toBe(true);
    expect(rest.flat().length).toBeLessThanOrEqual(120);
  });

  it("leaves the Top order of polls and the order of topics unchanged", async (): Promise<void> => {
    const closedLiked = await seedPoll({ createdAt: 1, revealed: true, author: "viewer" });
    const ownerOpen = await seedPoll({ createdAt: 2 });
    const viewerOpen = await seedPoll({ createdAt: 3, author: "viewer" });
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: closedLiked, value: 1 });
    const top: BoardSnapshot = await listPolls(null, "top");
    expect(top.entries.map((entry) => entry.id)).toEqual([closedLiked, viewerOpen, ownerOpen]);
    expect((await listPolls(null)).entries.map((entry) => entry.id)).toEqual([ownerOpen, viewerOpen, closedLiked]);

    // Top pages by score, time and ID, without groups.
    const more: string[] = await seedPolls(
      Array.from({ length: 50 }, (_: unknown, index: number): SeedPoll => ({ createdAt: 10 + index })),
    );
    const topFirst: BoardSnapshot = await listPolls(null, "top");
    const cursor = decodeCursor(topFirst.nextCursor, `${streamer.id}:polls`, "top");
    expect(cursor).not.toHaveProperty("group");
    expect(cursor).not.toHaveProperty("at");
    const topRest: BoardSnapshot = await listPolls(topFirst.nextCursor, "top");
    expect(topFirst.entries[0].id).toBe(closedLiked);
    expect(topRest.entries.map((entry) => entry.id)).toEqual([more[0], viewerOpen, ownerOpen]);
    expect(topRest.nextCursor).toBeNull();

    // Topics list newest first, whoever wrote them.
    const topics: string[] = [];
    for (const [author, time] of [
      ["viewer", 1],
      ["owner", 2],
      ["viewer", 3],
    ] as const) {
      const id = crypto.randomUUID();
      topics.unshift(id);
      await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at)
        VALUES (?,?,?,'topic','Topic','Details','Gaming','[]',?)`)
        .bind(id, streamer.id, author, time)
        .run();
    }
    const listed = await listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "", cursor: null });
    expect(listed.entries.map((entry) => entry.id)).toEqual(topics);
  });

  it("refuses a polls cursor that has no group", async (): Promise<void> => {
    await seedPolls(Array.from({ length: 51 }, (_: unknown, index: number): SeedPoll => ({ createdAt: 10 + index })));
    // The Top cursor has no group. The default order cannot continue from it.
    const top: BoardSnapshot = await listPolls(null, "top");
    const plain = JSON.parse(atob((top.nextCursor ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as Record<
      string,
      unknown
    >;
    const forged: string = btoa(JSON.stringify({ ...plain, sort: "newest" })).replaceAll("=", "");
    await expect(listPolls(forged)).rejects.toMatchObject({ status: 400, message: "Invalid page cursor." });
  });
});
