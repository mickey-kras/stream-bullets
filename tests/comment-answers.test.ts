import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { Comment, CommentAnswer, DiscussionSnapshot } from "../app/types";
import { answerLink, answerOffset } from "../app/server/comment-answers.server";
import { deleteComment, mutateComment } from "../app/server/comments.server";
import { sha256 } from "../app/server/translation.server";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const page = "30000000-0000-4000-8000-000000000001";
const otherPage = "30000000-0000-4000-8000-000000000002";
const topic = "30000000-0000-4000-8000-000000000003";
const otherTopic = "30000000-0000-4000-8000-000000000004";
const users = ["owner", "author", "viewer", "rival", "admin"];
const minute = 60_000;

let database: TestDatabase;
let env: AppEnv;
const { call } = apiCaller(() => env, origin, secret);

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
    ADMIN_EMAILS: "admin@example.test",
  } as AppEnv;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(now, JSON.stringify(users)),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(now + 86_400_000, now, JSON.stringify(users)),
    env.DB.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','owner_page','Owner'),(?,'rival','rival_page','Rival')",
    ).bind(page, otherPage),
    env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES (?,?,'owner','topic','Topic',1),(?,?,'rival','topic','Rival topic',1)",
    ).bind(topic, page, otherTopic, otherPage),
  ]);
});

async function seedComment(entryId = topic): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'author','When is the next stream?',1000)",
  )
    .bind(id, entryId)
    .run();
  return id;
}

async function seedLiveEvent(
  options: { title?: string; notes?: string; url?: string; startedAgo?: number; streamerId?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO stream_events (id,streamer_id,title,notes,starts_at,duration_min,platform,url,tz,created_at,updated_at)
      VALUES (?,?,?,?,?,120,'youtube',?,'UTC',1,1)`,
  )
    .bind(
      id,
      options.streamerId ?? page,
      options.title ?? "Friday stream",
      options.notes ?? "",
      Date.now() - (options.startedAgo ?? 30 * minute),
      options.url ?? "https://www.youtube.com/watch?v=abc123",
    )
    .run();
  return id;
}

async function answer(id: string, body: unknown, user = "owner"): Promise<Response> {
  return call("POST", `comments/${id}/answer`, { user, body });
}

async function mark(id: string): Promise<CommentAnswer> {
  const response = await answer(id, { action: "mark" });
  expect(response.status).toBe(200);
  return (await response.json<{ answer: CommentAnswer }>()).answer;
}

async function listed(id: string, headers: { user?: string } = {}): Promise<Comment | undefined> {
  const response = await call("GET", `entries/${topic}/comments?view=flat`, headers);
  const page_ = await response.json<DiscussionSnapshot>();
  return page_.comments.find((comment: Comment) => comment.id === id);
}

function twitchEnv(): void {
  env = {
    ...env,
    CHANNEL_INGEST: {} as AppEnv["CHANNEL_INGEST"],
    TWITCH_CLIENT_ID: "twitch-client",
    TWITCH_CLIENT_SECRET: "twitch-secret",
    TWITCH_EVENTSUB_SECRET: "x".repeat(32),
  };
}

async function connectTwitch(status = "active"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at)
      VALUES ('conn-twitch',?,'twitch','4242','Owner','',?,1,1)`,
  )
    .bind(page, status)
    .run();
}

/** Twitch answers for Get Streams and Get Videos. `streams` null: every Twitch call fails with 500. */
function stubTwitch(streams: unknown[] | null, videos: unknown[] = []): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request): Response => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.host}${url.pathname}`);
    if (url.pathname === "/oauth2/token") return Response.json({ access_token: "app-token", expires_in: 3600 });
    if (streams === null) return Response.json({ message: "down" }, { status: 500 });
    if (url.pathname === "/helix/streams") return Response.json({ data: streams });
    if (url.pathname === "/helix/videos") return Response.json({ data: videos });
    return Response.json({}, { status: 404 });
  });
  return calls;
}

function liveTwitch(startedAgo: number, title = "Twitch title"): unknown {
  return {
    id: "9001",
    user_login: "OwnerTV",
    title,
    type: "live",
    started_at: new Date(Date.now() - startedAgo).toISOString(),
  };
}

describe("marking a comment as answered", (): void => {
  it("shows only 'Answered' when the page is not live, to every reader", async (): Promise<void> => {
    const id = await seedComment();
    const result = await mark(id);
    expect(result.stream).toBeNull();
    for (const user of [undefined, "viewer"])
      expect((await listed(id, user ? { user } : {}))?.answer?.stream).toBeNull();
  });

  it("lets only the owner of the page set, change or remove the mark", async (): Promise<void> => {
    const id = await seedComment();
    for (const user of ["author", "viewer", "rival", "admin"]) {
      expect((await answer(id, { action: "mark" }, user)).status).toBe(404);
      expect((await answer(id, { action: "unmark" }, user)).status).toBe(404);
    }
    const signedOut = await call("POST", `comments/${id}/answer`, { body: { action: "mark" } });
    expect(signedOut.status).toBe(401);
    expect((await listed(id))?.answer).toBeUndefined();
  });

  it("keeps pages apart: an owner cannot mark a comment of another page", async (): Promise<void> => {
    const theirs = await seedComment(otherTopic);
    expect((await answer(theirs, { action: "mark" })).status).toBe(404);
    expect((await answer(theirs, { action: "mark" }, "rival")).status).toBe(200);
    const mine = await seedComment();
    expect((await listed(mine))?.answer).toBeUndefined();
  });

  it("links a live scheduled stream with a time code 5 minutes before the mark", async (): Promise<void> => {
    await seedLiveEvent();
    const id = await seedComment();
    const result = await mark(id);
    expect(result.stream).toMatchObject({ platform: "youtube", title: "Friday stream" });
    // 30 minutes after the start, less the default lead of 5 minutes.
    expect(result.stream?.offsetSeconds).toBeGreaterThanOrEqual(1499);
    expect(result.stream?.offsetSeconds).toBeLessThanOrEqual(1501);
    expect(result.stream?.link).toBe(`https://www.youtube.com/watch?v=abc123&t=${result.stream?.offsetSeconds}s`);
  });

  it("uses the lead of the page that its owner chose", async (): Promise<void> => {
    expect(await (await call("GET", "streamer/answer-lead", { user: "owner" })).json()).toEqual({ leadMinutes: 5 });
    const saved = await call("PUT", "streamer/answer-lead", { user: "owner", body: { leadMinutes: 10 } });
    expect(await saved.json()).toEqual({ leadMinutes: 10 });
    expect(await (await call("GET", "streamer/answer-lead", { user: "owner" })).json()).toEqual({ leadMinutes: 10 });
    for (const leadMinutes of [-1, 61, 1.5, "5"])
      expect((await call("PUT", "streamer/answer-lead", { user: "owner", body: { leadMinutes } })).status).toBe(400);
    expect((await call("GET", "streamer/answer-lead", { user: "viewer" })).status).toBe(404);
    expect((await call("GET", "streamer/answer-lead")).status).toBe(401);
    await seedLiveEvent();
    const result = await mark(await seedComment());
    expect(result.stream?.offsetSeconds).toBeGreaterThanOrEqual(1199);
    expect(result.stream?.offsetSeconds).toBeLessThanOrEqual(1201);
  });

  it("never sets a time code before the start of the stream", async (): Promise<void> => {
    await seedLiveEvent({ startedAgo: minute });
    expect((await mark(await seedComment())).stream?.offsetSeconds).toBe(0);
    expect(answerOffset(1000, 5000, 300)).toBe(0);
    expect(answerOffset(10 ** 12, 0, 0)).toBe(172_800);
  });

  it("lets the owner change the time code of one mark, within bounds", async (): Promise<void> => {
    await seedLiveEvent();
    const id = await seedComment();
    await mark(id);
    const changed = await answer(id, { action: "offset", offsetSeconds: 42 });
    expect((await changed.json<{ answer: CommentAnswer }>()).answer.stream?.link).toBe(
      "https://www.youtube.com/watch?v=abc123&t=42s",
    );
    for (const offsetSeconds of [-1, 1.5, 172_801, "42"])
      expect((await answer(id, { action: "offset", offsetSeconds })).status).toBe(400);
    expect((await answer(id, { action: "offset", offsetSeconds: 1 }, "rival")).status).toBe(404);
    expect((await listed(id))?.answer?.stream?.offsetSeconds).toBe(42);
  });

  it("refuses a time code for a mark without a stream", async (): Promise<void> => {
    const id = await seedComment();
    await mark(id);
    expect((await answer(id, { action: "offset", offsetSeconds: 10 })).status).toBe(409);
    expect((await answer(crypto.randomUUID(), { action: "offset", offsetSeconds: 10 })).status).toBe(404);
  });

  it("removes the mark on request", async (): Promise<void> => {
    const id = await seedComment();
    await mark(id);
    const removed = await answer(id, { action: "unmark" });
    expect(await removed.json()).toEqual({ answer: null });
    expect((await listed(id))?.answer).toBeUndefined();
  });

  it("keeps the mark of an edited comment and drops the mark of a removed one", async (): Promise<void> => {
    const id = await seedComment();
    await mark(id);
    await mutateComment(env, "author", { action: "edit", id, text: "Edited question" });
    expect((await listed(id))?.answer).toBeDefined();
    // A removed comment with a reply stays as a placeholder without its mark.
    const reply = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,'viewer','Reply',2000,?)",
    )
      .bind(reply, topic, id)
      .run();
    await deleteComment(env, "author", id);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM comment_answers").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect((await answer(id, { action: "mark" })).status).toBe(404);
  });

  it("shows the stored translation of the title of the scheduled stream", async (): Promise<void> => {
    await seedLiveEvent({ title: "Friday stream", notes: "Q&A" });
    const hash = await sha256(JSON.stringify(["event", "Friday stream", "Q&A", []]));
    await env.DB.prepare(
      "INSERT INTO page_translations (streamer_id,source_hash,locale,value,created_at) VALUES (?,?,'de',?,1)",
    )
      .bind(page, hash, JSON.stringify({ title: "Freitags-Stream", body: "Fragen", options: [] }))
      .run();
    const id = await seedComment();
    await mark(id);
    const response = await call("GET", `entries/${topic}/comments?view=thread`, { user: "viewer" });
    expect(response.status).toBe(200);
    await env.DB.prepare("UPDATE user SET locale='de' WHERE id='viewer'").run();
    const german = await (
      await call("GET", `entries/${topic}/comments?view=flat`, { user: "viewer" })
    ).json<DiscussionSnapshot>();
    expect(german.comments[0].answer?.stream).toMatchObject({
      title: "Friday stream",
      titleTranslation: "Freitags-Stream",
    });
    const single = await (await call("GET", `comments/${id}`, { user: "viewer" })).json<{ comment: Comment }>();
    expect(single.comment.answer?.stream?.titleTranslation).toBe("Freitags-Stream");
  });
});

describe("a live Twitch channel", (): void => {
  it("links the VOD of the live stream with a Twitch time code", async (): Promise<void> => {
    twitchEnv();
    await connectTwitch();
    stubTwitch([liveTwitch(30 * minute)], [{ id: "777", stream_id: "9001" }]);
    const result = await mark(await seedComment());
    expect(result.stream?.platform).toBe("twitch");
    expect(result.stream?.title).toBe("Twitch title");
    expect(result.stream?.link).toMatch(/^https:\/\/www\.twitch\.tv\/videos\/777\?t=0h2[45]m\d+s$/);
  });

  it("links the channel without a time code when the stream has no VOD yet", async (): Promise<void> => {
    twitchEnv();
    await connectTwitch();
    stubTwitch([liveTwitch(30 * minute)], [{ id: "776", stream_id: "8000" }]);
    const result = await mark(await seedComment());
    expect(result.stream?.link).toBe("https://www.twitch.tv/ownertv");
  });

  it("takes the title of the live scheduled stream", async (): Promise<void> => {
    twitchEnv();
    await connectTwitch();
    await seedLiveEvent({ title: "Friday stream" });
    stubTwitch([liveTwitch(20 * minute)]);
    const result = await mark(await seedComment());
    expect(result.stream).toMatchObject({ platform: "twitch", title: "Friday stream" });
  });

  it("falls back to the schedule when the Twitch read fails, or the channel is offline", async (): Promise<void> => {
    twitchEnv();
    await connectTwitch();
    await seedLiveEvent();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubTwitch(null);
    expect((await mark(await seedComment())).stream?.platform).toBe("youtube");
    expect(warn).toHaveBeenCalledWith("answer_live_read_failed", { platform: "twitch", cause: "Error" });
    stubTwitch([]);
    expect((await mark(await seedComment())).stream?.platform).toBe("youtube");
  });

  it("reads no platform in the test deployment or for a connection that needs a new sign-in", async (): Promise<void> => {
    twitchEnv();
    await connectTwitch("needs_reauth");
    const calls = stubTwitch([liveTwitch(minute)]);
    expect((await mark(await seedComment())).stream).toBeNull();
    env.APP_ENV = "test";
    await env.DB.prepare("UPDATE channel_connections SET status='active'").run();
    expect((await mark(await seedComment())).stream).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the link of a mark", (): void => {
  it("adds a time code only to addresses that accept one", (): void => {
    expect(answerLink("https://youtu.be/abc", 5)).toBe("https://youtu.be/abc?t=5s");
    expect(answerLink("https://www.youtube.com/live/abc", 5)).toBe("https://www.youtube.com/live/abc?t=5s");
    expect(answerLink("https://m.youtube.com/watch?v=abc&t=1", 5)).toBe("https://m.youtube.com/watch?v=abc&t=5s");
    expect(answerLink("https://twitch.tv/videos/12", 3723)).toBe("https://twitch.tv/videos/12?t=1h2m3s");
    expect(answerLink("https://www.twitch.tv/ownertv", 5)).toBe("https://www.twitch.tv/ownertv");
    expect(answerLink("https://kick.com/owner", 5)).toBe("https://kick.com/owner");
    expect(answerLink("https://youtube.com.evil.test/watch?v=abc", 5)).toBe(
      "https://youtube.com.evil.test/watch?v=abc",
    );
    expect(answerLink("http://www.youtube.com/watch?v=abc", 5)).toBe("http://www.youtube.com/watch?v=abc");
    expect(answerLink("not a url", 5)).toBe("not a url");
  });
});
