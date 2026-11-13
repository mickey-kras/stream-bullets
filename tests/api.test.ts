import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getFeaturedStreamer } from "../app/server/featured-streamer.server";
import type { AppEnv } from "../app/env";
import { action } from "../app/routes/api";
import { apiRoutes } from "../app/server/api";
import { loadShell } from "../app/lib/shell.server";
import { preferenceCookies } from "../app/server/api/cookies";
import { readDisplayPrefs } from "../app/server/validation";
import { serveImage } from "../app/server/images.server";
import type { CommentThread, Streamer, StreamerDirectory, ThreadSnapshot, Viewer } from "../app/types";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const day = 86_400_000;
const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
);
const ids = {
  page: "10000000-0000-4000-8000-000000000001",
  official: "10000000-0000-4000-8000-000000000002",
  topic: "10000000-0000-4000-8000-000000000003",
};

let database: TestDatabase;
let env: AppEnv;

const { call, cookie, context } = apiCaller(() => env, origin, secret);

async function seed(): Promise<void> {
  const now = Date.now();
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    env.DB.prepare(sql).bind(...values);
  await env.DB.batch([
    run(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
      now,
      JSON.stringify(["owner", "viewer", "official", "hidden", "admin", "applicant"]),
    ),
    run(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
      now + day,
      now,
      JSON.stringify(["owner", "viewer", "official", "hidden", "admin", "applicant"]),
    ),
    run(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES
        (?1,'owner','zed_page','Zed','About zed',0,'active'),
        (?2,'official','streambullets','StreamBullets','Ideas',1,'active'),
        ('10000000-0000-4000-8000-000000000009','hidden','hidden_page','Hidden','',0,'suspended')`,
      ids.page,
      ids.official,
    ),
    run(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES (?,?,'viewer','topic','Topic','Body','Gaming',1)",
      ids.topic,
      ids.page,
    ),
  ]);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (): Promise<Response> => new Response(null, { status: 204 }) }),
    } as unknown as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
    ADMIN_EMAILS: "admin@example.test",
  };
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare("DELETE FROM user"), env.DB.prepare("DELETE FROM app_rate_limits")]);
  await env.IMAGES.delete(["logo/owner"]);
  await seed();
});

describe("handler table", (): void => {
  it("matches whole paths and answers 404 for unknown paths and 405 for other methods", async (): Promise<void> => {
    expect(apiRoutes.length).toBeGreaterThan(10);
    expect((await call("GET", "nowhere")).status).toBe(404);
    expect((await call("GET", "mex")).status).toBe(404);
    expect((await call("POST", "nowhere", { user: "viewer", body: {} })).status).toBe(404);
    expect((await call("POST", "nowhere", { body: {} })).status).toBe(404);
    expect((await call("DELETE", "nowhere")).status).toBe(404);
    expect((await call("GET", "profile")).status).toBe(405);
    expect((await call("DELETE", "profile", { user: "viewer" })).status).toBe(405);
    expect((await call("POST", "images/avatar", { user: "viewer", body: {} })).status).toBe(405);
    expect((await call("HEAD", "me")).status).toBe(200);
  });

  it("refuses writes that are signed out, cross-site, or carry a query string", async (): Promise<void> => {
    expect((await call("PATCH", "profile", { body: { name: "X" } })).status).toBe(401);
    const crossSite = await action({
      request: new Request(`${origin}/api/profile`, {
        method: "PATCH",
        headers: { cookie: await cookie("viewer"), Origin: "https://evil.example", "Content-Type": "application/json" },
        body: "{}",
      }),
      params: { "*": "profile" },
      context: context(),
      url: new URL(`${origin}/api/profile`),
      pattern: "/api/*",
    });
    expect(crossSite.status).toBe(403);
    expect((await call("PATCH", "profile?x=1", { user: "viewer", body: { name: "X" } })).status).toBe(400);
  });
});

describe("profile, language and preferences", (): void => {
  it("saves the name and preset avatar and shows them on the viewer", async (): Promise<void> => {
    const saved = await call("PATCH", "profile", { user: "viewer", body: { name: "  New name ", avatarPreset: 17 } });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { viewer: Viewer }).viewer).toMatchObject({ name: "New name", avatarPreset: 17 });
    const cleared = await call("PATCH", "profile", { user: "viewer", body: { avatarPreset: null } });
    expect(((await cleared.json()) as { viewer: Viewer }).viewer).toMatchObject({
      name: "New name",
      avatarPreset: null,
    });
    for (const body of [{}, { avatarPreset: 18 }, { avatarPreset: 1.5 }, { name: "" }, { image: "/x" }]) {
      expect((await call("PATCH", "profile", { user: "viewer", body })).status).toBe(400);
    }
    // Account dialogs replace the retired settings endpoints.
    expect((await call("POST", "account", { user: "viewer", body: { name: "Legacy" } })).status).toBe(404);
    expect((await call("POST", "profile", { user: "viewer", body: { handle: "x_page", name: "X" } })).status).toBe(405);
    // Deleting an absent avatar is idempotent.
    expect(await (await call("DELETE", "images/avatar", { user: "viewer" })).json()).toEqual({ avatar: null });
  });

  it("saves the language and display preferences, which the session then reads", async (): Promise<void> => {
    expect(await (await call("PATCH", "me/locale", { user: "viewer", body: { locale: "pt-BR" } })).json()).toEqual({
      locale: "pt-BR",
    });
    expect((await call("PATCH", "me/locale", { user: "viewer", body: { locale: "xx" } })).status).toBe(400);
    const preferences = { contrast: "high", text: "130", underline: true, srInterval: "off" };
    expect(await (await call("PATCH", "me/preferences", { user: "viewer", body: preferences })).json()).toEqual({
      preferences,
    });
    expect((await call("PATCH", "me/preferences", { user: "viewer", body: { theme: "dark" } })).status).toBe(400);
    expect((await call("PATCH", "me/preferences", { user: "viewer", body: { text: "200" } })).status).toBe(400);
    await call("PATCH", "profile", { user: "viewer", body: { avatarPreset: 4 } });
    const me = (await (await call("GET", "me", { user: "viewer" })).json()) as { viewer: Viewer };
    expect(me.viewer).toEqual({
      id: "viewer",
      name: "Name viewer",
      avatar: null,
      avatarPreset: 4,
      locale: "pt-BR",
      displayPrefs: preferences,
    });
    expect((await call("PATCH", "me/locale", { user: "viewer", body: { locale: null } })).status).toBe(200);
    const after = (await (await call("GET", "me", { user: "viewer" })).json()) as { viewer: Viewer };
    expect(after.viewer.locale).toBeNull();
  });

  it("reads saved preferences leniently", (): void => {
    expect(readDisplayPrefs(null)).toBeNull();
    expect(readDisplayPrefs("not json")).toBeNull();
    expect(readDisplayPrefs("[1]")).toBeNull();
    expect(readDisplayPrefs('{"contrast":"high","text":"999","removed":true}')).toEqual({ contrast: "high" });
  });

  it("sets the language and preference cookies for browsers without the Cookie Store API", async (): Promise<void> => {
    const prefs = { contrast: "high", text: "130" };
    const response = await call("POST", "preference-cookies", { body: { locale: "pt-BR", prefs } });
    expect(response.status).toBe(204);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual([
      "sb_locale=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
      `sb_prefs=${encodeURIComponent(JSON.stringify(prefs))}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    ]);
    // Read back the exact Cookie Store API format.
    expect(readDisplayPrefs(decodeURIComponent(cookies[1].split(";")[0].split("=")[1]))).toEqual(prefs);
    expect(preferenceCookies({ locale: "de" }, false)).toEqual([
      "sb_locale=de; Path=/; Max-Age=31536000; SameSite=Lax",
    ]);
    expect((await call("POST", "preference-cookies", { body: { locale: "xx" } })).status).toBe(400);
    expect((await call("POST", "preference-cookies", { body: { prefs: { text: "999" } } })).status).toBe(400);
    expect((await call("POST", "preference-cookies", { body: { theme: "dark" } })).status).toBe(400);
  });

  it("skips prototype keys in a crafted prefs cookie instead of failing the page (security review finding 5)", async (): Promise<void> => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])
      expect([key, readDisplayPrefs(`{"${key}":1,"contrast":"high"}`)]).toEqual([key, { contrast: "high" }]);
    expect(readDisplayPrefs('{"__proto__":{"contrast":"high"}}')).toEqual({});
    const crafted = encodeURIComponent('{"constructor":1,"toString":"x","contrast":"high"}');
    const request = new Request(`${origin}/`, { headers: { Cookie: `sb_prefs=${crafted}` } });
    const shell = await loadShell(request, { env, nonce: "nonce", responseHeaders: new Headers() });
    expect(shell.prefs).toEqual({ contrast: "high" });
  });

  it("gives the shell the signed-in viewer's role, own page and language", async (): Promise<void> => {
    const shellOf = async (user: string): Promise<Awaited<ReturnType<typeof loadShell>>> => {
      const app = { env, nonce: "nonce", responseHeaders: new Headers() } as Parameters<typeof loadShell>[1];
      const request = new Request(`${origin}/`, { headers: { Cookie: await cookie(user), "Accept-Language": "de" } });
      const shell = await loadShell(request, app);
      expect(app.locale).toBe(shell.locale);
      return shell;
    };
    expect(await shellOf("owner")).toMatchObject({
      viewer: { id: "owner" },
      admin: false,
      ownStreamer: { handle: "zed_page",
      name: "Zed", status: "active", statusReason: null },
      locale: "de",
      origin,
    });
    expect(await shellOf("admin")).toMatchObject({ viewer: { id: "admin" }, admin: true, ownStreamer: null });
    expect((await shellOf("hidden")).ownStreamer).toMatchObject({ handle: "hidden_page", status: "suspended" });
  });
});

describe("directory", (): void => {
  it("pins official pages first, hides suspended pages, and searches names and handles", async (): Promise<void> => {
    const page = (await (await call("GET", "streamers")).json()) as StreamerDirectory;
    expect(page.streamers.map((streamer: Streamer) => [streamer.handle, streamer.isOfficial, streamer.status])).toEqual(
      [
        ["streambullets", true, "active"],
        ["zed_page", false, "active"],
      ],
    );
    expect(page.streamers[1]).toMatchObject({ logo: null, statusReason: null, handleChangedAt: null });
    const search = (await (await call("GET", "streamers?query=ZED")).json()) as StreamerDirectory;
    expect(search.streamers.map((streamer: Streamer) => streamer.handle)).toEqual(["zed_page"]);
    const literal = (await (await call("GET", "streamers?query=%25")).json()) as StreamerDirectory;
    expect(literal.streamers).toEqual([]);
    expect((await call("GET", "streamers?cursor=Bad")).status).toBe(400);
    expect((await call("GET", "streamers/hidden_page")).status).toBe(404);
    expect((await call("GET", "streamers/hidden_page", { user: "hidden" })).status).toBe(200);
  });

  it("pages through the official group and then everyone else", async (): Promise<void> => {
    const values = Array.from({ length: 51 }, (_: unknown, index: number) => `p${String(index).padStart(2, "0")}`);
    await env.DB.prepare(
      `INSERT INTO user (id,name,email,created_at,updated_at) SELECT value, value, value||'@example.test', 1, 1 FROM json_each(?)`,
    )
      .bind(JSON.stringify(values))
      .run();
    await env.DB.prepare(
      `INSERT INTO streamers (id,owner_id,handle,name,is_official) SELECT 'id-'||value, value, 'page_'||value, value,
        CASE WHEN value < 'p02' THEN 1 ELSE 0 END FROM json_each(?)`,
    )
      .bind(JSON.stringify(values))
      .run();
    const handles: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const result = (await (await call("GET", `streamers${query}`)).json()) as StreamerDirectory;
      handles.push(...result.streamers.map((streamer: Streamer) => streamer.handle));
      cursor = result.nextCursor;
    } while (cursor);
    expect(handles.slice(0, 3)).toEqual(["page_p00", "page_p01", "streambullets"]);
    expect(handles).toHaveLength(53);
    expect(new Set(handles).size).toBe(53);
    expect(handles.at(-1)).toBe("zed_page");
    // Legacy cursors still start after the official-page group.
    const legacy = (await (await call("GET", "streamers?cursor=page_p50")).json()) as StreamerDirectory;
    expect(legacy.streamers.map((streamer: Streamer) => streamer.handle)).toEqual(["zed_page"]);
  });
});

describe("edit your page", (): void => {
  it("changes only the fields sent and limits handle changes to once every 30 days", async (): Promise<void> => {
    const edited = await call("PATCH", "streamer", { user: "owner", body: { name: "Zed TV", about: "New about" } });
    expect(((await edited.json()) as { streamer: Streamer }).streamer).toMatchObject({
      handle: "zed_page",
      name: "Zed TV",
      about: "New about",
      handleChangedAt: null,
    });
    const renamed = await call("PATCH", "streamer", { user: "owner", body: { handle: "zed_tv" } });
    const streamer = ((await renamed.json()) as { streamer: Streamer }).streamer;
    expect(streamer.handle).toBe("zed_tv");
    expect(streamer.handleChangedAt).toEqual(expect.any(Number));
    expect((await call("PATCH", "streamer", { user: "owner", body: { handle: "zed_tv" } })).status).toBe(200);
    const tooSoon = await call("PATCH", "streamer", { user: "owner", body: { handle: "zed_again" } });
    expect(tooSoon.status).toBe(409);
    expect(((await tooSoon.json()) as { error: string }).error).toMatch(/once every 30 days/u);
    vi.spyOn(Date, "now").mockReturnValue((streamer.handleChangedAt ?? 0) + 31 * day);
    expect((await call("PATCH", "streamer", { user: "owner", body: { handle: "streambullets" } })).status).toBe(409);
    expect((await call("PATCH", "streamer", { user: "owner", body: { handle: "zed_again" } })).status).toBe(200);
  });

  it("validates input and needs a page", async (): Promise<void> => {
    for (const body of [{}, { handle: "No" }, { logoMode: "other" }, { name: "x".repeat(41) }, { status: "active" }]) {
      expect((await call("PATCH", "streamer", { user: "owner", body })).status).toBe(400);
    }
    expect((await call("PATCH", "streamer", { user: "viewer", body: { name: "Mine" } })).status).toBe(404);
    expect((await call("PATCH", "streamer", { user: "owner", body: { logoMode: "logo" } })).status).toBe(400);
    expect((await call("PATCH", "streamer", { user: "hidden", body: { name: "Back" } })).status).toBe(423);
  });

  it("uploads a page logo, serves it, and falls back to the profile picture", async (): Promise<void> => {
    const upload = await call("PUT", "images/logo", { user: "owner", raw: png, type: "image/png" });
    expect(await upload.json()).toEqual({ url: "/images/logo/owner" });
    const me = (await (await call("GET", "me", { user: "owner" })).json()) as { streamer: Streamer };
    expect(me.streamer.logo).toBe("/images/logo/owner");
    expect((await serveImage(env, "logo/owner", "GET")).headers.get("Content-Type")).toBe("image/png");
    expect((await call("PATCH", "streamer", { user: "owner", body: { logoMode: "logo" } })).status).toBe(200);
    expect((await call("PATCH", "streamer", { user: "owner", body: { logoMode: "profile" } })).status).toBe(200);
    expect(await env.IMAGES.head("logo/owner")).toBeNull();
    await expect(serveImage(env, "logo/owner", "GET")).rejects.toMatchObject({ status: 404 });

    await call("PUT", "images/logo", { user: "owner", raw: png, type: "image/png" });
    expect(await (await call("DELETE", "images/logo", { user: "owner" })).json()).toEqual({ logo: null });
    expect(await env.IMAGES.head("logo/owner")).toBeNull();
    const after = (await (await call("GET", "me", { user: "owner" })).json()) as { streamer: Streamer };
    expect(after.streamer.logo).toBeNull();

    expect((await call("PUT", "images/logo", { user: "viewer", raw: png, type: "image/png" })).status).toBe(403);
    expect((await call("DELETE", "images/logo", { user: "viewer" })).status).toBe(403);
    expect((await call("PUT", "images/logo", { user: "hidden", raw: png, type: "image/png" })).status).toBe(423);
  });
});

describe("threads", (): void => {
  it("pages top-level comments with their replies oldest first, keeping removed parents", async (): Promise<void> => {
    const post = async (user: string, text: string, parentId?: string): Promise<string> => {
      const response = await call("POST", "streamers/zed_page", {
        user,
        body: { action: "comment", id: ids.topic, text, ...(parentId ? { parentId } : {}) },
      });
      return ((await response.json()) as { id: string }).id;
    };
    const first = await post("viewer", "First");
    const reply = await post("owner", "Reply", first);
    const deeper = await post("viewer", "Deeper", reply);
    const second = await post("owner", "Second");
    expect((await call("POST", "comments", { user: "viewer", body: { action: "delete", id: first } })).status).toBe(
      200,
    );
    const response = await call("GET", `entries/${ids.topic}/comments?view=thread`);
    const { comments, nextCursor } = (await response.json()) as ThreadSnapshot;
    expect(nextCursor).toBeNull();
    expect(
      comments.map((thread: CommentThread) => [thread.id, thread.removed, thread.replies.map((item) => item.id)]),
    ).toEqual([
      [second, false, []],
      [first, true, [reply, deeper]],
    ]);
    expect(comments[1].replies[1]).toMatchObject({ parentId: reply, text: "Deeper", author: "Name viewer" });
    await call("POST", "comments", { user: "owner", body: { action: "like", id: first, liked: true } });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM comment_likes").first("n")).toBe(0);
    expect((await call("GET", `entries/${ids.topic}/comments?view=tree`)).status).toBe(400);
    expect((await call("GET", `entries/${ids.topic}`)).status).toBe(200);
    expect((await call("GET", "entries/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).status).toBe(404);
    expect((await call("GET", "entries/10000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });
});

describe("waitlist and reports through the handler table", (): void => {
  it("runs the applicant, reporter and admin flows", async (): Promise<void> => {
    const applied = await call("POST", "application", {
      user: "applicant",
      body: { links: ["https://twitch.tv/applicant"] },
    });
    const { application } = (await applied.json()) as { application: { id: string; status: string } };
    expect(application.status).toBe("pending");
    expect((await call("GET", "admin/applications")).status).toBe(401);
    expect((await call("GET", "admin/applications", { user: "viewer" })).status).toBe(403);
    const queue = (await (await call("GET", "admin/applications?status=pending", { user: "admin" })).json()) as {
      applications: { id: string }[];
    };
    expect(queue.applications.map((item) => item.id)).toEqual([application.id]);
    const reviewed = await call("POST", "admin/applications", {
      user: "admin",
      body: { id: application.id, decision: "approved" },
    });
    expect(((await reviewed.json()) as { application: { status: string } }).application.status).toBe("approved");
    const created = await call("POST", "streamer", {
      user: "applicant",
      body: { handle: "applicant_page", name: "Applicant", about: "" },
    });
    expect(((await created.json()) as { streamer: Streamer }).streamer).toMatchObject({
      handle: "applicant_page",
      logo: null,
      ownerAvatarPreset: null,
    });
    const again = await call("POST", "streamer", {
      user: "applicant",
      body: { handle: "applicant_two", name: "Applicant", about: "" },
    });
    expect(again.status).toBe(409);

    const reported = await call("POST", "reports", {
      user: "owner",
      body: { targetKind: "entry", targetId: ids.topic, reason: "spam" },
    });
    const { report } = (await reported.json()) as { report: { id: string } };
    expect((await call("GET", "admin/reports")).status).toBe(401);
    const reports = (await (await call("GET", "admin/reports", { user: "admin" })).json()) as {
      reports: { id: string }[];
    };
    expect(reports.reports.map((item) => item.id)).toEqual([report.id]);
    const resolved = await call("POST", "admin/reports", { user: "admin", body: { id: report.id, action: "remove" } });
    expect(await resolved.json()).toEqual({ status: "actioned", resolved: 1 });
    const dismissed = await call("POST", "reports", {
      user: "viewer",
      body: { targetKind: "entry", targetId: ids.topic, reason: "spam" },
    });
    expect(dismissed.status).toBe(404);
  });
});

describe("first visitor destination", () => {
  it("features a public community with real content before an empty page", async (): Promise<void> => {
    expect(await getFeaturedStreamer(env)).toEqual({
      handle: "zed_page",
      name: "Zed",
      isOfficial: false,
      entries: [{ id: ids.topic, title: "Topic", kind: "topic" }],
    });
  });

  it("excludes frozen and suspended communities and falls back to an active page", async (): Promise<void> => {
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(ids.page).run();
    expect(await getFeaturedStreamer(env)).toEqual({ handle: "streambullets", name: "StreamBullets", isOfficial: true, entries: [] });
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(ids.official).run();
    expect(await getFeaturedStreamer(env)).toBeNull();
  });

  it("bounds links to the three latest entries, including polls", async (): Promise<void> => {
    for (let index: number = 0; index < 4; index++) {
      await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at)
        VALUES (?,?,'viewer','binary',?,'["Yes","No"]',?)`)
        .bind(`poll-${index}`, ids.page, `Poll ${index}`, index + 2).run();
    }
    const featured = await getFeaturedStreamer(env);
    expect(featured?.entries.map((entry) => entry.title)).toEqual(["Poll 3", "Poll 2", "Poll 1"]);
    expect(featured?.entries.every((entry) => entry.kind === "binary")).toBe(true);
  });
});
