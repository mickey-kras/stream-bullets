import { makeSignature } from "better-auth/crypto";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appContext, type AppEnv } from "../app/env";
import { DEFAULT_LAYERS } from "../app/lib/overlay-layers";
import { action, loader } from "../app/routes/api";
import { DELETED_AUTHOR_SNAPSHOT, deleteAccount, EXPORT_PAGE_SIZE, exportAccount } from "../app/server/account.server";
import { mutateEntry } from "../app/server/data.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const sessionToken = "leaver-session-token-private";
const now = Date.now();
const day = 86_400_000;

const ids = {
  leaverPage: "11111111-1111-4111-8111-111111111111",
  hostPage: "22222222-2222-4222-8222-222222222222",
  onLeaverPage: "33333333-3333-4333-8333-333333333333",
  hostPoll: "44444444-4444-4444-8444-444444444444",
  hostTopic: "55555555-5555-4555-8555-555555555555",
  leaverTopic: "66666666-6666-4666-8666-666666666666",
};

let database: TestDatabase;
let env: AppEnv;
let rooms: string[];

// Seed users and all owned row types in one batch.
async function seed(): Promise<void> {
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    env.DB.prepare(sql).bind(...values);
  await env.DB.batch([
    run(
      `INSERT INTO user (id,name,email,email_verified,image,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, '/images/avatar/'||value, ?, ? FROM json_each(?)`,
      now - day,
      now,
      JSON.stringify(["leaver", "other", "host", "admin"]),
    ),
    run(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at,ip_address,user_agent) VALUES
        ('s1',?,'leaver',?,?,?,'192.0.2.7','leaver-agent'),
        ('s2','leaver-expired-token','leaver',?,?,?,'192.0.2.8','old-agent'),
        ('s3','other-session-token','other',?,?,?,NULL,NULL)`,
      sessionToken,
      now + day,
      now - 1000,
      now,
      now - 1000,
      now - day,
      now - day,
      now + day,
      now,
      now,
    ),
    run(
      `INSERT INTO account (id,account_id,provider_id,user_id,access_token,refresh_token,id_token,scope,password,created_at,updated_at)
        VALUES ('a1','twitch-123','twitch','leaver','secret-access-token','secret-refresh-token','secret-id-token','openid','secret-password',?,?),
               ('a2','google-456','google','other','other-access-token',NULL,NULL,NULL,NULL,?,?)`,
      now,
      now,
      now,
      now,
    ),
    run(
      `INSERT INTO streamers (id,owner_id,handle,name,about,avatar,background,revision) VALUES
        (?,'leaver','leaver_page','Leaver','Leaving soon','/images/avatar/leaver','/images/background/leaver',3),
        (?,'host','host_page','Host','Staying',NULL,NULL,5)`,
      ids.leaverPage,
      ids.hostPage,
    ),
    run(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed) VALUES
        (?,?,'other','topic','Other on leaver page','','','[]',?,NULL,0),
        (?,?,'host','choice','Host poll','','','["Red","Blue"]',?,?,1),
        (?,?,'host','topic','Host topic','Body','Gaming','[]',?,NULL,0),
        (?,?,'leaver','topic','Leaver topic','Mine','Chat','[]',?,NULL,0)`,
      ids.onLeaverPage,
      ids.leaverPage,
      now,
      ids.hostPoll,
      ids.hostPage,
      now,
      now + day,
      ids.hostTopic,
      ids.hostPage,
      now,
      ids.leaverTopic,
      ids.hostPage,
      now,
    ),
    run(
      `INSERT INTO entry_votes (entry_id,user_id,choice) VALUES (?,'leaver',1),(?,'other',0),(?,'other',0)`,
      ids.hostPoll,
      ids.hostPoll,
      ids.onLeaverPage,
    ),
    run(
      `INSERT INTO entry_reactions (entry_id,user_id,value) VALUES (?,'leaver',-1),(?,'other',1),(?,'other',1)`,
      ids.hostTopic,
      ids.leaverTopic,
      ids.hostTopic,
    ),
    // Reply chain: leaver -> other -> leaver -> other, plus unrelated comments.
    run(
      `INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES
        ('c-leaver',?,'leaver','Leaver says hi',?,NULL),
        ('c-reply',?,'other','Other replies',?,'c-leaver'),
        ('c-leaver-2',?,'leaver','Leaver again',?,'c-reply'),
        ('c-reply-2',?,'other','Other again',?,'c-leaver-2'),
        ('c-other',?,'other','Unrelated',?,NULL),
        ('c-on-leaver-topic',?,'other','On leaver topic',?,NULL),
        ('c-on-leaver-page',?,'other','On leaver page',?,NULL)`,
      ids.hostTopic,
      now,
      ids.hostTopic,
      now + 1,
      ids.hostTopic,
      now + 2,
      ids.hostTopic,
      now + 3,
      ids.hostTopic,
      now,
      ids.leaverTopic,
      now,
      ids.onLeaverPage,
      now,
    ),
    run(
      `INSERT INTO comment_likes (comment_id,user_id) VALUES ('c-other','leaver'),('c-leaver','other'),('c-reply','host')`,
    ),
    run(
      `INSERT INTO streamer_applications (id,user_id,links,note,status,created_at,updated_at,reviewed_at,reviewed_by) VALUES
        ('app-leaver','leaver','["https://www.twitch.tv/leaver"]','Please','approved',?,?,?,'admin'),
        ('app-other','other','["https://www.twitch.tv/other"]','','rejected',?,?,?,'leaver')`,
      now,
      now,
      now,
      now,
      now,
      now,
    ),
    run(
      `INSERT INTO app_rate_limits (key,count,window_start) VALUES ('write:leaver',1,?),('content:leaver',1,?),('write:other',1,?)`,
      now,
      now,
      now,
    ),
    run(
      `INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES
        ('v1','leaver@example.test','code',?,?,?),
        ('v2','oauth-state','{"link":{"userId":"leaver"}}',?,?,?),
        ('v3','other-state','{"link":{"userId":"other"}}',?,?,?)`,
      now + day,
      now,
      now,
      now + day,
      now,
      now,
      now + day,
      now,
      now,
    ),
    run(`INSERT INTO rate_limit (id,key,count,last_request) VALUES ('r1','192.0.2.7|/sign-in/social',1,?)`, now),
    run(`INSERT INTO polls (id,question,kind,options,created_at,ends_at) VALUES ('p1','Old','choice','[]',1,2)`),
    run(`INSERT INTO poll_votes (poll_id,user_id,choice) VALUES ('p1','leaver',0),('p1','other',1)`),
    run(`INSERT INTO poll_reactions (poll_id,user_id,value) VALUES ('p1','leaver',1)`),
    run(`INSERT INTO poll_comments (id,poll_id,user_id,text,created_at) VALUES ('pc1','p1','leaver','Legacy',?)`, now),
  ]);
  for (const key of ["avatar/leaver", "background/leaver", "avatar/other"]) {
    await env.IMAGES.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
  }
}

// Seed 0006-0012 data for the leaver and surviving accounts.
async function seedNewTables(): Promise<void> {
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    env.DB.prepare(sql).bind(...values);
  await env.DB.batch([
    run(`UPDATE user SET avatar_preset=3, locale='de', display_prefs='{"contrast":"high"}' WHERE id='leaver'`),
    run("UPDATE session SET admin_verified_at=? WHERE id='s1'", now),
    run(
      `UPDATE streamers SET logo='/images/logo/leaver', is_official=1, handle_changed_at=?1, status='frozen',
        status_reason='Spam links', status_changed_at=?1, status_changed_by='admin', support_card=1 WHERE id=?2`,
      now,
      ids.leaverPage,
    ),
    // The audit record must clear its deleted admin actor.
    run("UPDATE streamers SET status_changed_by='leaver' WHERE id=?", ids.hostPage),
    run(
      `INSERT INTO passkey (id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at,aaguid)
        VALUES ('pk1','YubiKey A','PUBLIC-KEY-SECRET','leaver','CREDENTIAL-ID-SECRET',4,'singleDevice',0,'usb,nfc',?1,'aaguid-1'),
               ('pk2','Other key','other-public-key','other','other-credential',0,'singleDevice',0,NULL,?1,NULL)`,
      now,
    ),
    run(
      `INSERT INTO stream_events (id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,vod_url,repeat_days,repeat_until,tz,created_at,updated_at)
        VALUES ('ev1',?1,'series-1','Variety night','Bring games',?2,120,'twitch','https://twitch.tv/leaver','ended','https://twitch.tv/videos/1',20,?3,'Europe/Berlin',?2,?2),
               ('ev2',?4,NULL,'Host show','',?2,60,'youtube','https://youtube.com/@host','scheduled',NULL,0,NULL,'UTC',?2,?2)`,
      ids.leaverPage,
      now,
      now + day * 84,
      ids.hostPage,
    ),
    run("INSERT INTO stream_event_topics (event_id,entry_id) VALUES ('ev1',?)", ids.onLeaverPage),
    run(
      `INSERT INTO community_cards (id,streamer_id,position,icon,title,body,button_label,button_target) VALUES
        ('card1',?1,0,'discord','Join the Discord','Come say hi.','Join','https://discord.gg/leaver'),
        ('card2',?1,1,NULL,'Bring an idea','Suggest a topic.',NULL,NULL),
        ('card3',?2,0,NULL,'Host card','Stays.','Topics','tab:topics')`,
      ids.leaverPage,
      ids.hostPage,
    ),
    run(
      `INSERT INTO streamer_links (id,streamer_id,position,kind,label,url) VALUES
        ('link1',?1,0,'kofi',NULL,'https://ko-fi.com/leaver'),('link2',?2,0,'other','Merch','https://merch.example.test')`,
      ids.leaverPage,
      ids.hostPage,
    ),
    run(
      `INSERT INTO overlay_state (streamer_id,air,preview,position,size,instant,show_results,message,message_style,layers,revision,updated_at)
        VALUES (?1,'{"type":"message","ref":null}','{"type":"auto","ref":null}','top','l',1,0,'BRB 5 min','hype',
                '{"chat":{"enabled":true,"rect":{"x":40,"y":60,"w":280,"h":160},"theme":"neon"}}',3,?2),
               (?3,'{"type":"auto","ref":null}','{"type":"hidden","ref":null}','lower','m',0,1,'',  'info','{}',0,?2)`,
      ids.leaverPage,
      now,
      ids.hostPage,
    ),
    run(
      "INSERT INTO entry_mash (entry_id,duration_s,phase,starts_at,ends_at,winner) VALUES (?,30,'finished',?,?,1)",
      ids.hostPoll,
      now,
      now + 30_000,
    ),
    run(
      "INSERT INTO mash_taps (entry_id,user_id,side,taps,assisted_taps) VALUES (?1,'leaver',1,42,6),(?1,'other',0,10,0)",
      ids.hostPoll,
    ),
    run(
      `INSERT INTO moderation_actions (id,target_kind,target_id,streamer_id,action,reason,note,notify_owner,actor_id,metadata,created_at) VALUES
        ('ma1','streamer',?1,?1,'freeze','Spam links','INTERNAL-ADMIN-NOTE',1,'admin',NULL,?2),
        ('ma2','report','r-x',?3,'dismiss','','',0,'leaver','{"count":2}',?2)`,
      ids.leaverPage,
      now,
      ids.hostPage,
    ),
  ]);
  await env.IMAGES.put("logo/leaver", new Uint8Array([1, 2]), { httpMetadata: { contentType: "image/webp" } });
}

const ownPage = "JOIN streamers s ON s.id=x.streamer_id WHERE s.owner_id=?1";

// Count all rows linked to a user.
async function linkedRows(userId: string): Promise<Record<string, number>> {
  const queries: Record<string, string> = {
    user: "SELECT count(*) AS n FROM user WHERE id=?1",
    session: "SELECT count(*) AS n FROM session WHERE user_id=?1",
    account: "SELECT count(*) AS n FROM account WHERE user_id=?1",
    streamers: "SELECT count(*) AS n FROM streamers WHERE owner_id=?1",
    entries: "SELECT count(*) AS n FROM entries WHERE author_id=?1",
    entry_votes: "SELECT count(*) AS n FROM entry_votes WHERE user_id=?1",
    entry_reactions: "SELECT count(*) AS n FROM entry_reactions WHERE user_id=?1",
    entry_comments: "SELECT count(*) AS n FROM entry_comments WHERE author_id=?1",
    comment_likes: "SELECT count(*) AS n FROM comment_likes WHERE user_id=?1",
    streamer_applications: "SELECT count(*) AS n FROM streamer_applications WHERE user_id=?1 OR reviewed_by=?1",
    app_rate_limits: "SELECT count(*) AS n FROM app_rate_limits WHERE key LIKE '%:'||?1",
    verification: `SELECT count(*) AS n FROM verification WHERE identifier=?1||'@example.test' OR value LIKE '%"'||?1||'"%'`,
    poll_votes: "SELECT count(*) AS n FROM poll_votes WHERE user_id=?1",
    poll_reactions: "SELECT count(*) AS n FROM poll_reactions WHERE user_id=?1",
    poll_comments: "SELECT count(*) AS n FROM poll_comments WHERE user_id=?1",
    passkey: "SELECT count(*) AS n FROM passkey WHERE user_id=?1",
    mash_taps: "SELECT count(*) AS n FROM mash_taps WHERE user_id=?1",
    stream_events: `SELECT count(*) AS n FROM stream_events x ${ownPage}`,
    community_cards: `SELECT count(*) AS n FROM community_cards x ${ownPage}`,
    streamer_links: `SELECT count(*) AS n FROM streamer_links x ${ownPage}`,
    overlay_state: `SELECT count(*) AS n FROM overlay_state x ${ownPage}`,
    moderation_actions: "SELECT count(*) AS n FROM moderation_actions WHERE actor_id=?1",
    status_changed_by: "SELECT count(*) AS n FROM streamers WHERE status_changed_by=?1",
  };
  const names = Object.keys(queries);
  const results = await env.DB.batch(names.map((name: string) => env.DB.prepare(queries[name]).bind(userId)));
  return Object.fromEntries(
    names.map((name: string, index: number) => [name, (results[index].results[0] as { n: number }).n]),
  );
}

function zeroes(): Record<string, number> {
  return {
    user: 0,
    session: 0,
    account: 0,
    streamers: 0,
    entries: 0,
    entry_votes: 0,
    entry_reactions: 0,
    entry_comments: 0,
    comment_likes: 0,
    streamer_applications: 0,
    app_rate_limits: 0,
    verification: 0,
    poll_votes: 0,
    poll_reactions: 0,
    poll_comments: 0,
    passkey: 0,
    mash_taps: 0,
    stream_events: 0,
    community_cards: 0,
    streamer_links: 0,
    overlay_state: 0,
    moderation_actions: 0,
    status_changed_by: 0,
  };
}

async function cookie(): Promise<string> {
  return `__Host-stream-bullets.session_token=${encodeURIComponent(`${sessionToken}.${await makeSignature(sessionToken, secret)}`)}`;
}

function routeContext(): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, { env, nonce: "nonce", responseHeaders: new Headers() });
  return context;
}

async function callExport(headers: Record<string, string> = {}): Promise<Response> {
  const url = `${origin}/api/account/export`;
  return loader({
    request: new Request(url, { headers: { cookie: await cookie(), ...headers } }),
    params: { "*": "account/export" },
    context: routeContext(),
    url: new URL(url),
    pattern: "/api/*",
  });
}

async function callDelete(body: unknown): Promise<{ response: Response; cookies: string[] }> {
  const url = `${origin}/api/account/delete`;
  const context = routeContext();
  const response = await action({
    request: new Request(url, {
      method: "POST",
      headers: { cookie: await cookie(), Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: { "*": "account/delete" },
    context,
    url: new URL(url),
    pattern: "/api/*",
  });
  return { response, cookies: context.get(appContext).responseHeaders.getSetCookie() };
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    CHANNEL_INGEST: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 204 }) }),
    } as unknown as DurableObjectNamespace,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (): Promise<Response> => {
          rooms.push(name);
          return new Response(null, { status: 204 });
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
  rooms = [];
  await env.DB.batch(
    [
      "DELETE FROM user",
      "DELETE FROM app_rate_limits",
      "DELETE FROM verification",
      "DELETE FROM rate_limit",
      "DELETE FROM poll_votes",
      "DELETE FROM poll_reactions",
      "DELETE FROM poll_comments",
      "DELETE FROM polls",
      "DELETE FROM moderation_actions",
    ].map((sql: string) => env.DB.prepare(sql)),
  );
  await env.IMAGES.delete(["avatar/leaver", "background/leaver", "logo/leaver", "avatar/other"]);
  await seed();
});

describe("account export", (): void => {
  it("includes everything held about the account", async (): Promise<void> => {
    const data = await exportAccount(env, "leaver");
    expect(Date.parse(data.exportedAt)).toBeGreaterThanOrEqual(now);
    expect(data.notes).toContain("not included");
    expect(data.account).toEqual({
      id: "leaver",
      name: "Name leaver",
      email: "leaver@example.test",
      emailVerified: true,
      emailLinkVerified: false,
      image: "/images/avatar/leaver",
      createdAt: new Date(now - day).toISOString(),
      updatedAt: new Date(now).toISOString(),
      avatarPreset: null,
      locale: null,
      displayPreferences: null,
      conversionMilestones: { firstVote: true, firstTopic: true },
    });
    expect(data.signInMethods).toEqual([
      {
        providerId: "twitch",
        accountId: "twitch-123",
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ]);
    expect(data.activeSessions).toEqual([
      {
        createdAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + day).toISOString(),
        ipAddress: "192.0.2.7",
        userAgent: "leaver-agent",
        adminVerifiedAt: null,
      },
    ]);
    expect(data.streamerPage).toEqual({
      handle: "leaver_page",
      name: "Leaver",
      about: "Leaving soon",
      url: `${origin}/@leaver_page`,
      logo: null,
      background: `${origin}/images/background/leaver`,
      isOfficial: false,
      handleChangedAt: null,
      status: "active",
      statusReason: null,
      statusChangedAt: null,
      showSupportLinks: true,
      supportCard: false,
      moderation: [],
      scheduledStreams: [],
      communityCards: [],
      supportLinks: [],
      overlay: null,
    });
    expect(data.streamerApplication).toMatchObject({
      links: ["https://www.twitch.tv/leaver"],
      note: "Please",
      status: "approved",
      reviewedAt: new Date(now).toISOString(),
    });
    expect(data.entries).toEqual([
      {
        id: ids.leaverTopic,
        streamerHandle: "host_page",
        kind: "topic",
        title: "Leaver topic",
        body: "Mine",
        category: "Chat",
        options: [],
        createdAt: new Date(now).toISOString(),
        endsAt: null,
        revealed: false,
        url: `${origin}/@host_page`,
      },
    ]);
    expect(data.comments.map((comment) => [comment.id, comment.parentId, comment.entryTitle])).toEqual([
      ["c-leaver", null, "Host topic"],
      ["c-leaver-2", "c-reply", "Host topic"],
    ]);
    expect(data.reactions).toEqual([
      { entryId: ids.hostTopic, entryTitle: "Host topic", streamerHandle: "host_page", reaction: "dislike" },
    ]);
    expect(data.votes).toEqual([
      { entryId: ids.hostPoll, entryTitle: "Host poll", streamerHandle: "host_page", choice: 1, option: "Blue" },
    ]);
    expect(data.commentLikes).toEqual([
      { commentId: "c-other", entryId: ids.hostTopic, entryTitle: "Host topic", streamerHandle: "host_page" },
    ]);
    expect(data.images.map((image) => [image.kind, image.url, image.contentType, image.bytes])).toEqual([
      ["avatar", `${origin}/images/avatar/leaver`, "image/png", 3],
      ["background", `${origin}/images/background/leaver`, "image/png", 3],
    ]);
    expect(data.legacyPolls).toEqual({
      votes: [{ pollId: "p1", choice: 0 }],
      reactions: [{ pollId: "p1", value: 1 }],
      comments: [{ id: "pc1", pollId: "p1", text: "Legacy", createdAt: new Date(now).toISOString() }],
    });
  });

  it("never includes credentials or other people's private data", async (): Promise<void> => {
    const text = JSON.stringify(await exportAccount(env, "leaver"));
    for (const secretValue of [
      sessionToken,
      "leaver-expired-token",
      "secret-access-token",
      "secret-refresh-token",
      "secret-id-token",
      "secret-password",
      "other@example.test",
      "other-access-token",
      "Other replies",
    ]) {
      expect(text).not.toContain(secretValue);
    }
  });

  it("reads large histories in bounded pages", async (): Promise<void> => {
    const count = EXPORT_PAGE_SIZE * 2 + 3;
    await env.DB.prepare(
      `INSERT INTO entry_comments (id,entry_id,author_id,text,created_at)
        SELECT 'bulk-'||value, ?, 'leaver', 'Bulk '||value, ? FROM json_each(?)`,
    )
      .bind(
        ids.hostTopic,
        now,
        JSON.stringify(Array.from({ length: count }, (_value: unknown, index: number) => index)),
      )
      .run();
    const queries: string[] = [];
    const recording = {
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      prepare: (sql: string): D1PreparedStatement => {
        queries.push(sql);
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
    const data = await exportAccount({ ...env, DB: recording }, "leaver");
    expect(data.comments).toHaveLength(count + 2);
    expect(new Set(data.comments.map((comment) => comment.id)).size).toBe(count + 2);
    expect(queries.filter((sql: string) => sql.includes("FROM entry_comments x"))).toHaveLength(3);
  });

  it("exports likes and images stored without a content type", async (): Promise<void> => {
    await env.IMAGES.put("avatar/other", new Uint8Array([1]));
    const data = await exportAccount(env, "other");
    expect(data.reactions.map((reaction) => [reaction.entryId, reaction.reaction])).toEqual([
      [ids.leaverTopic, "like"],
      [ids.hostTopic, "like"],
    ]);
    expect(data.images).toMatchObject([{ kind: "avatar", contentType: null, bytes: 1 }]);
    expect(data.activeSessions).toEqual([
      {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + day).toISOString(),
        ipAddress: null,
        userAgent: null,
        adminVerifiedAt: null,
      },
    ]);
  });

  it("handles accounts without optional data and missing accounts", async (): Promise<void> => {
    await env.IMAGES.delete("avatar/other");
    const data = await exportAccount(env, "admin");
    expect(data).toMatchObject({
      channelConnections: [],
      streamerPage: null,
      streamerApplication: null,
      signInMethods: [],
      activeSessions: [],
      entries: [],
      images: [],
    });
    await expect(exportAccount(env, "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("serves the export as a dated attachment that is never cached", async (): Promise<void> => {
    const response = await callExport();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="streambullets-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = (await response.json()) as { account: { email: string } };
    expect(body.account.email).toBe("leaver@example.test");
    expect((await callExport({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });
});

describe("channel connections in the export", (): void => {
  it("lists the page's connected channels without their tokens", async (): Promise<void> => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,status,created_at,updated_at,last_event_at)
          VALUES ('cc1',?,'kick','333','Leaver Kick','user:read events:subscribe','active',?,?,NULL),
                 ('cc2',?,'kick','444','Host Kick','user:read','active',?,?,NULL)`,
      ).bind(ids.leaverPage, now, now, ids.hostPage, now, now),
      env.DB.prepare(
        "INSERT INTO channel_tokens (connection_id,key_id,access_token,refresh_token,updated_at) VALUES ('cc1','k','sealed-access','sealed-refresh',1)",
      ),
    ]);
    const data = await exportAccount(env, "leaver");
    expect(data.channelConnections).toEqual([
      {
        platform: "kick",
        channelId: "333",
        displayName: "Leaver Kick",
        scopes: ["user:read", "events:subscribe"],
        status: "active",
        connectedAt: new Date(now).toISOString(),
        lastEventAt: null,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("sealed-");
  });
});

describe("tables added by migrations 0006–0012", (): void => {
  it("are part of the export, without credentials or admin notes", async (): Promise<void> => {
    await seedNewTables();
    const data = await exportAccount(env, "leaver");
    expect(data.account).toMatchObject({ avatarPreset: 3, locale: "de", displayPreferences: { contrast: "high" } });
    expect(data.activeSessions[0].adminVerifiedAt).toBe(new Date(now).toISOString());
    expect(data.securityKeys).toEqual([
      {
        name: "YubiKey A",
        deviceType: "singleDevice",
        backedUp: false,
        transports: "usb,nfc",
        aaguid: "aaguid-1",
        createdAt: new Date(now).toISOString(),
      },
    ]);
    expect(data.streamerPage).toMatchObject({
      logo: `${origin}/images/logo/leaver`,
      isOfficial: true,
      handleChangedAt: new Date(now).toISOString(),
      status: "frozen",
      statusReason: "Spam links",
      statusChangedAt: new Date(now).toISOString(),
      showSupportLinks: true,
      supportCard: true,
      moderation: [{ action: "freeze", reason: "Spam links", createdAt: new Date(now).toISOString() }],
      scheduledStreams: [
        {
          id: "ev1",
          seriesId: "series-1",
          title: "Variety night",
          notes: "Bring games",
          startsAt: new Date(now).toISOString(),
          durationMinutes: 120,
          platform: "twitch",
          url: "https://twitch.tv/leaver",
          status: "ended",
          replayUrl: "https://twitch.tv/videos/1",
          repeatDays: 20,
          repeatUntil: new Date(now + day * 84).toISOString(),
          timeZone: "Europe/Berlin",
          linkedTopicIds: [ids.onLeaverPage],
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
      ],
      communityCards: [
        {
          position: 0,
          icon: "discord",
          title: "Join the Discord",
          body: "Come say hi.",
          buttonLabel: "Join",
          buttonTarget: "https://discord.gg/leaver",
        },
        {
          position: 1,
          icon: null,
          title: "Bring an idea",
          body: "Suggest a topic.",
          buttonLabel: null,
          buttonTarget: null,
        },
      ],
      supportLinks: [{ position: 0, kind: "kofi", label: null, url: "https://ko-fi.com/leaver" }],
      overlay: {
        onAir: { type: "message", ref: null },
        preview: { type: "auto", ref: null },
        position: "top",
        size: "l",
        instant: true,
        showResults: false,
        message: "BRB 5 min",
        messageStyle: "hype",
        // Read leniently: the unknown key is dropped and missing layers take their defaults.
        layers: {
          ...DEFAULT_LAYERS,
          chat: { enabled: true, rect: { x: 40, y: 60, w: 280, h: 160 }, hideCommands: true },
        },
        updatedAt: new Date(now).toISOString(),
      },
    });
    expect(data.mashBattleTaps).toEqual([
      {
        entryId: ids.hostPoll,
        entryTitle: "Host poll",
        streamerHandle: "host_page",
        side: 1,
        option: "Blue",
        taps: 42,
        assistedTaps: 6,
      },
    ]);
    expect(data.moderationActions).toEqual([
      { targetKind: "report", targetId: "r-x", action: "dismiss", reason: "", createdAt: new Date(now).toISOString() },
    ]);
    expect(data.images.map((image) => [image.kind, image.contentType, image.bytes])).toEqual([
      ["avatar", "image/png", 3],
      ["background", "image/png", 3],
      ["logo", "image/webp", 2],
    ]);
    const text = JSON.stringify(data);
    for (const hidden of [
      "PUBLIC-KEY-SECRET",
      "CREDENTIAL-ID-SECRET",
      "INTERNAL-ADMIN-NOTE",
      "other-public-key",
      "Host show",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("are erased with the account, while other people's rows and the audit trail stay", async (): Promise<void> => {
    await seedNewTables();
    const otherBefore = await linkedRows("other");
    const hostBefore = await linkedRows("host");
    await deleteAccount(env, "leaver");
    expect(await linkedRows("leaver")).toEqual(zeroes());
    expect(await linkedRows("other")).toMatchObject({ passkey: 1, mash_taps: otherBefore.mash_taps });
    expect(await linkedRows("host")).toMatchObject({
      stream_events: hostBefore.stream_events,
      community_cards: 1,
      streamer_links: 1,
      overlay_state: 1,
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stream_event_topics").first()).toEqual({ n: 0 });
    expect(
      await env.DB.prepare("SELECT status_changed_by FROM streamers WHERE id=?").bind(ids.hostPage).first(),
    ).toEqual({ status_changed_by: null });
    // Keep the page ID; clear the deleted admin actor.
    const actions = await env.DB.prepare("SELECT id,streamer_id,actor_id FROM moderation_actions ORDER BY id").all();
    expect(actions.results).toEqual([
      { id: "ma1", streamer_id: ids.leaverPage, actor_id: "admin" },
      { id: "ma2", streamer_id: ids.hostPage, actor_id: null },
    ]);
    expect(await env.IMAGES.head("logo/leaver")).toBeNull();
    // Refresh the host room after deleting taps that affected its battle totals.
    expect(rooms.sort()).toEqual([ids.leaverPage, ids.hostPage].sort());
  });
});

describe("account deletion", (): void => {
  it("removes every row linked to the account and keeps other people's data", async (): Promise<void> => {
    const otherBefore = await linkedRows("other");
    await deleteAccount(env, "leaver");
    expect(await linkedRows("leaver")).toEqual(zeroes());
    const comments = await env.DB.prepare("SELECT id,parent_id FROM entry_comments ORDER BY id").all<{
      id: string;
      parent_id: string | null;
    }>();
    // Keep replies to deleted comments as roots; delete discussions under removed entries.
    expect(comments.results).toEqual([
      { id: "c-other", parent_id: null },
      { id: "c-reply", parent_id: null },
      { id: "c-reply-2", parent_id: null },
    ]);
    expect(await linkedRows("other")).toEqual({
      ...otherBefore,
      entries: 0,
      entry_votes: otherBefore.entry_votes - 1,
      entry_reactions: otherBefore.entry_reactions - 1,
      entry_comments: otherBefore.entry_comments - 2,
      comment_likes: 0,
      streamer_applications: 1,
    });
    const application = await env.DB.prepare(
      "SELECT status,reviewed_by FROM streamer_applications WHERE user_id='other'",
    ).first<{ status: string; reviewed_by: string | null }>();
    expect(application).toEqual({ status: "rejected", reviewed_by: null });
    expect(await env.DB.prepare("SELECT key FROM rate_limit").all()).toMatchObject({
      results: [{ key: "192.0.2.7|/sign-in/social" }],
    });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM comment_likes WHERE user_id='host'").first()).toEqual({
      n: 1,
    });
    expect(await linkedRows("host")).toMatchObject({ user: 1, streamers: 1, entries: 2 });
  });

  it("deletes the user's reports and strips copied text from reports about their content", async (): Promise<void> => {
    const report = (
      id: string,
      kind: string,
      target: string,
      reporter: string,
      author: string,
      snapshot: string,
    ): D1PreparedStatement =>
      env.DB.prepare(
        `INSERT INTO content_reports (id,target_kind,target_id,streamer_id,reporter_id,target_author_id,reason,details,snapshot,status,created_at)
          VALUES (?,?,?,'page',?,?,'spam','',?,'open',1)`,
      ).bind(id, kind, target, reporter, author, snapshot);
    await env.DB.batch([
      report("r-by-leaver", "comment", "c-other", "leaver", "other", "Other's comment"),
      report("r-about-leaver-topic", "entry", ids.leaverTopic, "other", "leaver", "Leaver topic text"),
      report("r-about-leaver-comment", "comment", "c-leaver", "other", "leaver", "Leaver comment text"),
      report("r-unrelated", "comment", "c-other", "host", "other", "Other's comment"),
    ]);
    const exported = await exportAccount(env, "leaver");
    expect(exported.reports).toEqual([
      expect.objectContaining({ targetKind: "comment", targetId: "c-other", reason: "spam", status: "open" }),
    ]);
    await deleteAccount(env, "leaver");
    const rows = await env.DB.prepare("SELECT id,snapshot FROM content_reports ORDER BY id").all<{
      id: string;
      snapshot: string;
    }>();
    expect(rows.results).toEqual([
      { id: "r-about-leaver-comment", snapshot: DELETED_AUTHOR_SNAPSHOT },
      { id: "r-about-leaver-topic", snapshot: DELETED_AUTHOR_SNAPSHOT },
      { id: "r-unrelated", snapshot: "Other's comment" },
    ]);
  });

  it("strips copied text from reports about the user's content even after that content was removed", async (): Promise<void> => {
    // Remove the reported topic before deleting its author.
    await env.DB.prepare(
      `INSERT INTO content_reports (id,target_kind,target_id,streamer_id,reporter_id,target_author_id,reason,details,snapshot,status,created_at,resolved_at)
        VALUES ('r-removed','entry','00000000-0000-4000-8000-00000000dead','page','other','leaver','spam','','Removed topic text','actioned',1,2)`,
    ).run();
    await deleteAccount(env, "leaver");
    expect(
      await env.DB.prepare("SELECT snapshot,target_author_id FROM content_reports WHERE id='r-removed'").first(),
    ).toEqual({ snapshot: DELETED_AUTHOR_SNAPSHOT, target_author_id: null });
  });

  it("keeps no copy of a removed topic's title in the moderation records", async (): Promise<void> => {
    const admins: AppEnv = { ...env, ADMIN_EMAILS: "admin@example.test" };
    const gate = async (): Promise<{ stepUp: string }> => ({ stepUp: "fresh" });
    await mutateEntry(admins, "admin", ids.hostPage, { action: "delete", id: ids.leaverTopic }, gate);
    await deleteAccount(env, "leaver");
    const rows = await env.DB.prepare(
      "SELECT target_id,metadata FROM moderation_actions WHERE action='entry_removed'",
    ).all<{ target_id: string; metadata: string }>();
    expect(rows.results).toEqual([
      { target_id: ids.leaverTopic, metadata: JSON.stringify({ via: "page", stepUp: "fresh" }) },
    ]);
    const all = await env.DB.prepare("SELECT metadata FROM moderation_actions").all<{ metadata: string | null }>();
    for (const row of all.results) expect(row.metadata ?? "").not.toContain("Leaver topic");
  });

  it("cascades the streamer page, removes images, and refreshes affected live rooms", async (): Promise<void> => {
    await deleteAccount(env, "leaver");
    const pages = await env.DB.prepare("SELECT id,revision FROM streamers ORDER BY handle").all();
    expect(pages.results).toEqual([{ id: ids.hostPage, revision: 6 }]);
    expect(await env.DB.prepare("SELECT id FROM entries ORDER BY title").all()).toMatchObject({
      results: [{ id: ids.hostPoll }, { id: ids.hostTopic }],
    });
    expect(await env.IMAGES.head("avatar/leaver")).toBeNull();
    expect(await env.IMAGES.head("background/leaver")).toBeNull();
    expect(await env.IMAGES.head("avatar/other")).not.toBeNull();
    expect(rooms.sort()).toEqual([ids.leaverPage, ids.hostPage].sort());
  });

  it("exports the published immutable image and deletes current and failed versions with the account", async (): Promise<void> => {
    const current = "avatar/leaver/published";
    const failed = "avatar/leaver/unpublished";
    await env.IMAGES.put(current, new Uint8Array([1, 2, 3, 4, 5]), { httpMetadata: { contentType: "image/webp" } });
    await env.IMAGES.put(failed, new Uint8Array([6, 7]));
    await env.IMAGES.put("avatar/other/unpublished", new Uint8Array([8]));
    await env.DB.prepare(
      "INSERT INTO image_versions (owner_id,kind,version) VALUES ('leaver','avatar','published')",
    ).run();
    const data = await exportAccount(env, "leaver");
    expect(data.images.find((image) => image.kind === "avatar")).toMatchObject({
      url: `${origin}/images/avatar/leaver`,
      contentType: "image/webp",
      bytes: 5,
    });
    await deleteAccount(env, "leaver");
    expect(await env.IMAGES.head(current)).toBeNull();
    expect(await env.IMAGES.head(failed)).toBeNull();
    expect(await env.IMAGES.head("avatar/leaver")).toBeNull();
    expect(await env.IMAGES.head("avatar/other/unpublished")).not.toBeNull();
    await env.IMAGES.delete("avatar/other/unpublished");
  });

  it("commits the deletion when image cleanup fails", async (): Promise<void> => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { delete: () => Promise.reject(new Error("bucket secret")) } as unknown as R2Bucket;
    await deleteAccount({ ...env, IMAGES: failing }, "admin");
    expect(await linkedRows("admin")).toEqual(zeroes());
    expect(log.mock.calls).toEqual([["account_image_delete_failed", { cause: "Error" }]]);
    expect(rooms).toEqual([]);
  });

  it("rejects an account that does not exist", async (): Promise<void> => {
    await expect(deleteAccount(env, "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a session that did not sign in recently, and deletes nothing", async (): Promise<void> => {
    await env.DB.prepare("UPDATE session SET created_at=? WHERE user_id='leaver'")
      .bind(Date.now() - 11 * 60 * 1000)
      .run();
    const { response } = await callDelete({ confirm: "DELETE" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Sign in again to delete your account.", code: "reauth_required" });
    expect((await linkedRows("leaver")).user).toBe(1);
  });

  it("requires the exact confirmation, then signs the browser out", async (): Promise<void> => {
    for (const body of [{}, { confirm: "delete" }, { confirm: "DELETE ", extra: true }, { confirm: "DELETE", x: 1 }]) {
      const { response } = await callDelete(body);
      expect(response.status).toBe(400);
    }
    const rejected = await callDelete({ confirm: "yes" });
    expect(await rejected.response.json()).toEqual({ error: "Type DELETE to confirm." });
    expect((await linkedRows("leaver")).user).toBe(1);

    const { response, cookies } = await callDelete({ confirm: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(await linkedRows("leaver")).toEqual(zeroes());
    const expired = cookies.find((value: string) => value.startsWith("__Host-stream-bullets.session_token="));
    expect(expired).toMatch(/Max-Age=0/i);

    const me = await loader({
      request: new Request(`${origin}/api/me`, { headers: { cookie: await cookie() } }),
      params: { "*": "me" },
      context: routeContext(),
      url: new URL(`${origin}/api/me`),
      pattern: "/api/*",
    });
    expect(((await me.json()) as { viewer: unknown }).viewer).toBeNull();
    expect((await callExport()).status).toBe(401);
  });
});
