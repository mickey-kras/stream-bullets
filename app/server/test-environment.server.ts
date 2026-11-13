import { timingSafeEqual } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import type { AppEnv } from "../env";
import { OFFICIAL_BOARD_ID } from "../lib/system";
import { HttpError, queryParams, readBody, requireSameOrigin } from "./http.server";
import { deleteImageObjects } from "./images.server";

import { validateTestEnvironment } from "./test-environment-config";
export { TEST_ORIGIN, validateTestEnvironment } from "./test-environment-config";
export const TEST_ACCOUNTS = [
  "viewer",
  "other_viewer",
  "owner",
  "other_owner",
  "admin",
  "pending",
  "approved",
  "rejected",
  "frozen_owner",
  "suspended_owner",
] as const;
export type TestAccount = (typeof TEST_ACCOUNTS)[number];
export function testAccountId(account: TestAccount): string {
  return `67500000-0000-4000-8000-${String(TEST_ACCOUNTS.indexOf(account) + 1).padStart(12, "0")}`;
}

export async function requireTestDatabase(env: AppEnv): Promise<void> {
  validateTestEnvironment(env);
  if (env.APP_ENV !== "test") throw new HttpError(404, "Not found.");
  let identity: { id: string } | null;
  try {
    identity = await env.DB.prepare("SELECT id FROM test_environment_identity LIMIT 1").first<{ id: string }>();
  } catch {
    throw new HttpError(503, "Test database identity is not configured.");
  }
  if (identity?.id !== env.TEST_DATABASE_ID) throw new HttpError(503, "Test database identity does not match.");
}

const fixtureId = (index: number): string => `67500000-0000-4000-8001-${String(index).padStart(12, "0")}`;
const ACCESS_COOKIE = "__Host-sb-test-access";

async function accessCookie(env: AppEnv): Promise<string> {
  const expires: string = String(Date.now() + 3_600_000);
  const signature: string = await makeSignature(expires, env.TEST_ACCESS_SECRET!);
  return `${ACCESS_COOKIE}=${encodeURIComponent(`${expires}.${signature}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;
}

export async function requireTestAccess(request: Request, env: AppEnv): Promise<void> {
  validateTestEnvironment(env);
  if (env.APP_ENV !== "test") return;
  await requireTestDatabase(env);
  const raw: string | undefined = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part: string): string => part.trim())
    .find((part: string): boolean => part.startsWith(`${ACCESS_COOKIE}=`));
  let value: string;
  try {
    value = raw ? decodeURIComponent(raw.slice(ACCESS_COOKIE.length + 1)) : "";
  } catch {
    throw new HttpError(403, "Use /__test to unlock test access.");
  }
  const match = /^([0-9]{13})\.([A-Za-z0-9+/=]+)$/u.exec(value);
  if (!match || Number(match[1]) <= Date.now() || Number(match[1]) > Date.now() + 3_600_000)
    throw new HttpError(403, "Use /__test to unlock test access.");
  await checkSecret(match[2], await makeSignature(match[1], env.TEST_ACCESS_SECRET!));
}

function communityFixtures(env: AppEnv, now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const community of [1, 2, 3, 4]) {
    const topic: string = fixtureId(community * 10);
    const owner: TestAccount =
      community === 1
        ? "owner"
        : community === 2
          ? "other_owner"
          : community === 3
            ? "frozen_owner"
            : "suspended_owner";
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        topic,
        fixtureId(community),
        testAccountId("viewer"),
        "topic",
        "What should we discuss next?",
        "Long discussion content. ".repeat(60),
        "Just chatting",
        "[]",
        now,
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO entries(id,streamer_id,author_id,kind,title,options,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        fixtureId(community * 10 + 1),
        fixtureId(community),
        testAccountId(owner),
        "choice",
        "Choose the next stream",
        '["Games","Music","Tech"]',
        now,
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES(?,?,?,?,?)",
      ).bind(fixtureId(community * 10 + 2), topic, testAccountId("viewer"), "A viewer question.", now),
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES(?,?,?,?,?,?)",
      ).bind(
        fixtureId(community * 10 + 3),
        topic,
        testAccountId(owner),
        "The owner's reply.",
        now + 1,
        fixtureId(community * 10 + 2),
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES(?,?,?,?,?,?)",
      ).bind(
        fixtureId(community * 10 + 4),
        topic,
        testAccountId("other_viewer"),
        "A nested follow-up.",
        now + 2,
        fixtureId(community * 10 + 3),
      ),
    );
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO entry_votes(entry_id,user_id,choice) VALUES(?,?,?)").bind(
        fixtureId(community * 10 + 1),
        testAccountId("viewer"),
        0,
      ),
    );
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO entry_reactions(entry_id,user_id,value) VALUES(?,?,?)").bind(
        topic,
        testAccountId("other_viewer"),
        1,
      ),
    );
    if (community > 2) {
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO moderation_actions(id,target_kind,target_id,streamer_id,action,reason,note,notify_owner,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          fixtureId(community * 10 + 5),
          "streamer",
          fixtureId(community),
          fixtureId(community),
          community === 3 ? "freeze" : "suspend",
          "Synthetic moderation notice.",
          "Test fixture.",
          1,
          testAccountId("admin"),
          now,
        ),
      );
    }
  }
  return statements;
}

async function resetTestRooms(env: AppEnv, ids: string[]): Promise<void> {
  for (const id of ids) {
    const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(id));
    const response = await room.fetch(`https://poll-room.internal/test-reset?streamerId=${id}`, { method: "POST" });
    if (!response.ok) throw new HttpError(503, "Test live state reset failed.");
  }
}

export async function seedTestEnvironment(env: AppEnv, reset: boolean): Promise<void> {
  await requireTestDatabase(env);
  const now: number = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS test_fixture_revisions (streamer_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0), overlay_revision INTEGER NOT NULL CHECK(overlay_revision >= 0))",
    ),
    env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS test_fixture_revision_delete BEFORE DELETE ON streamers
      WHEN OLD.id IN (${[1, 2, 3, 4].map((index: number): string => `'${fixtureId(index)}'`).join(",")})
      BEGIN
        INSERT INTO test_fixture_revisions(streamer_id,revision,overlay_revision)
        VALUES(OLD.id,OLD.revision+1,COALESCE((SELECT revision FROM overlay_state WHERE streamer_id=OLD.id),0)+1)
        ON CONFLICT(streamer_id) DO UPDATE SET revision=MAX(test_fixture_revisions.revision,excluded.revision),
          overlay_revision=MAX(test_fixture_revisions.overlay_revision,excluded.overlay_revision);
      END`),
  ];
  const users: string[] = TEST_ACCOUNTS.map(testAccountId);
  let roomIds: string[] = [];
  if (reset) {
    const { results: pages } = await env.DB.prepare(
      "SELECT id FROM streamers WHERE owner_id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(users))
      .all<{ id: string }>();
    roomIds = [
      ...new Set([
        OFFICIAL_BOARD_ID,
        ...[1, 2, 3, 4].map(fixtureId),
        ...pages.map((page: { id: string }): string => page.id),
      ]),
    ];
    await resetTestRooms(env, roomIds);
    for (const user of users) {
      for (const kind of ["avatar", "background", "logo"] as const) await deleteImageObjects(env, user, kind);
    }
    statements.push(
      env.DB.prepare(`DELETE FROM moderation_actions WHERE actor_id IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(users),
      ),
    );
    statements.push(
      env.DB.prepare(
        "DELETE FROM content_reports WHERE reporter_id IN (SELECT value FROM json_each(?)) OR target_author_id IN (SELECT value FROM json_each(?))",
      ).bind(JSON.stringify(users), JSON.stringify(users)),
    );
    statements.push(
      env.DB.prepare(
        "DELETE FROM app_rate_limits WHERE key IN (SELECT 'write:' || value FROM json_each(?)) OR key IN (SELECT 'content:' || value FROM json_each(?))",
      ).bind(JSON.stringify(users), JSON.stringify(users)),
    );
    statements.push(
      env.DB.prepare(`INSERT INTO test_fixture_revisions(streamer_id,revision,overlay_revision)
        SELECT s.id,s.revision+1,COALESCE(o.revision,0)+1 FROM streamers s
        LEFT JOIN overlay_state o ON o.streamer_id=s.id WHERE s.owner_id IN (SELECT value FROM json_each(?))
        ON CONFLICT(streamer_id) DO UPDATE SET revision=MAX(test_fixture_revisions.revision,excluded.revision),
          overlay_revision=MAX(test_fixture_revisions.overlay_revision,excluded.overlay_revision)`).bind(
        JSON.stringify(users),
      ),
      env.DB.prepare("DELETE FROM user WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(users)),
      env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(OFFICIAL_BOARD_ID),
    );
  }
  for (const account of TEST_ACCOUNTS) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ).bind(testAccountId(account), account.replaceAll("_", " "), `${account}@example.test`, 1, now, now),
    );
  }
  for (const [index, account, handle, status] of [
    [1, "owner", "test_host", "active"],
    [2, "other_owner", "other_host", "active"],
    [3, "frozen_owner", "frozen_host", "frozen"],
    [4, "suspended_owner", "suspended_host", "suspended"],
  ] as const) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO streamers(id,owner_id,handle,name,about,status,revision) VALUES(?,?,?,?,?,?,COALESCE((SELECT revision FROM test_fixture_revisions WHERE streamer_id=?),0))",
      ).bind(
        fixtureId(index),
        testAccountId(account),
        handle,
        handle.replaceAll("_", " "),
        "Synthetic test community.",
        status,
        fixtureId(index),
      ),
    );
  }
  statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO overlay_state(streamer_id,revision,updated_at)
      SELECT streamer_id,overlay_revision,? FROM test_fixture_revisions
      WHERE streamer_id IN (SELECT value FROM json_each(?))`).bind(now, JSON.stringify([1, 2, 3, 4].map(fixtureId))),
  );
  for (const account of ["pending", "approved", "rejected", "owner", "other_owner"] as const) {
    const status: string = account.endsWith("owner") ? "approved" : account;
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO streamer_applications(id,user_id,links,note,status,created_at,updated_at,reviewed_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        testAccountId(account),
        testAccountId(account),
        '["https://example.test/channel"]',
        "Synthetic application.",
        status,
        now,
        now,
        status === "pending" ? null : now,
        status === "pending" ? null : testAccountId("admin"),
      ),
    );
  }
  statements.push(...communityFixtures(env, now));
  statements.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      fixtureId(90),
      OFFICIAL_BOARD_ID,
      testAccountId("viewer"),
      "topic",
      "Improve overlay text sizing",
      "A synthetic suggestion.",
      "design",
      "[]",
      now,
      "planned",
    ),
  );
  await env.DB.batch(statements);
  if (reset) await resetTestRooms(env, roomIds);
}

async function checkSecret(value: string, expected: string): Promise<void> {
  const hash = async (input: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  const [given, actual] = await Promise.all([hash(value), hash(expected)]);
  if (!timingSafeEqual(given, actual)) throw new HttpError(403, "Test access denied.");
}

export async function testEnvironmentResponse(request: Request, env: AppEnv): Promise<Response> {
  await requireTestDatabase(env);
  queryParams(request, []);
  if (request.method === "GET") {
    const commit: string = /^[a-f0-9]{40}$/u.test(env.DEPLOYED_COMMIT ?? "") ? env.DEPLOYED_COMMIT! : "undeployed";
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>StreamBullets test access</title><h1>Test environment</h1><p>Commit: ${commit}</p><p>Use the shared test access secret from approved secret storage.</p><form method="post"><label>Access secret <input type="password" name="secret" required autocomplete="off"></label><label>Account <select name="account"><option>signedout</option>${TEST_ACCOUNTS.map((account: TestAccount): string => `<option>${account}</option>`).join("")}</select></label><button name="action" value="login">Sign in</button><button name="action" value="seed">Seed missing fixtures</button><button name="action" value="reset">Reset synthetic data</button></form></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
  requireSameOrigin(request, env);
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded")
    throw new HttpError(415, "Use the test access form.");
  const fields = new URLSearchParams(new TextDecoder().decode(await readBody(request, 4096)));
  if (
    [...fields.keys()].some(
      (key: string): boolean => !["secret", "account", "action"].includes(key) || fields.getAll(key).length !== 1,
    )
  )
    throw new HttpError(400, "Invalid test access form.");
  await checkSecret(fields.get("secret") ?? "", env.TEST_ACCESS_SECRET!);
  const access: string = await accessCookie(env);
  const action: string | null = fields.get("action");
  if (action === "seed" || action === "reset") {
    await seedTestEnvironment(env, action === "reset");
    return new Response(null, {
      status: 303,
      headers: { Location: "/__test", "Cache-Control": "no-store", "Set-Cookie": access },
    });
  }
  const account: string | null = fields.get("account");
  if (action === "login" && account === "signedout") {
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store", "Set-Cookie": access });
    headers.append(
      "Set-Cookie",
      "__Host-stream-bullets.session_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
    return new Response(null, { status: 303, headers });
  }
  if (action !== "login" || !TEST_ACCOUNTS.some((allowed: TestAccount): boolean => allowed === account))
    throw new HttpError(400, "Choose a test account.");
  if (env.BETTER_AUTH_SECRET.length < 32) throw new HttpError(503, "Authentication secret is not configured.");
  const userId: string = testAccountId(account as TestAccount);
  const user = await env.DB.prepare("SELECT email,email_verified FROM user WHERE id=?")
    .bind(userId)
    .first<{ email: string; email_verified: number }>();
  if (user?.email !== `${account}@example.test` || user.email_verified !== 1)
    throw new HttpError(409, "Seed the test accounts first.");
  const now: number = Date.now();
  const token: string = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), token, userId, now + 3_600_000, now, now)
    .run();
  const cookie: string = encodeURIComponent(`${token}.${await makeSignature(token, env.BETTER_AUTH_SECRET)}`);
  const headers = new Headers({
    Location: "/",
    "Cache-Control": "no-store",
    "Set-Cookie": `__Host-stream-bullets.session_token=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
  });
  headers.append("Set-Cookie", access);
  return new Response(null, { status: 303, headers });
}
