import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPageList, ReportGroup, ReportItemList, SecurityKey, StepUpStatus } from "../app/admin-types";
import type { AppEnv } from "../app/env";
import type { CreationOptions, RequestOptions } from "../app/server/stepup.server";
import { auditStatement } from "../app/server/audit.server";
import {
  adminPerson,
  adminPicture,
  listModerationPages,
  moderatePage,
  setEntryStatus,
  validPreset,
} from "../app/server/moderation.server";
import { listReportGroups, listReportItems } from "../app/server/report-groups.server";
import { apiRoutes } from "../app/server/api";
import type { ApiRoute } from "../app/server/api/router";
import {
  CHALLENGE_TTL_MS,
  stepUpMode,
  stepUpOptions,
  verifyStepUp,
  type AdminSession,
} from "../app/server/stepup.server";
import { fromBase64Url, toBase64Url } from "../app/server/webauthn.server";
import type { StreamerDirectory, Viewer } from "../app/types";
import { apiCaller, type CallOptions } from "./helpers/api";
import { AT, SoftKey, UP, UV } from "./helpers/authenticator";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const minute = 60_000;
const ids = {
  page: "20000000-0000-4000-8000-000000000001",
  official: "20000000-0000-4000-8000-000000000002",
  topic: "20000000-0000-4000-8000-000000000003",
  idea: "20000000-0000-4000-8000-000000000004",
  comment: "20000000-0000-4000-8000-000000000005",
  missing: "20000000-0000-4000-8000-0000000000ff",
};

let database: TestDatabase;
let env: AppEnv;

const { call } = apiCaller(() => env, origin, secret);

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Signs in as `admin` unless another user is named. */
function asAdmin(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  return call(method, path, { user: "admin", ...options });
}

async function seed(): Promise<void> {
  const now = Date.now();
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    env.DB.prepare(sql).bind(...values);
  await env.DB.batch([
    run(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, 'Name '||value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
      now,
      JSON.stringify(["owner", "viewer", "admin", "reporter", "official"]),
    ),
    // `admin` and `admin2` are two sessions of the same administrator.
    run(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||key, key||'-session-token', value, ?1, ?2, ?2
        FROM json_each('{"owner":"owner","viewer":"viewer","admin":"admin","admin2":"admin","reporter":"reporter"}')`,
      now + 86_400_000,
      now,
    ),
    run(
      `INSERT INTO streamers (id,owner_id,handle,name,about,is_official,status) VALUES
        (?1,'owner','zed_page','Zed','About zed',0,'active'),
        (?2,'official','streambullets','StreamBullets','Ideas',1,'active')`,
      ids.page,
      ids.official,
    ),
    run(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES
        (?1,?3,'viewer','topic','Spam topic','Body','Gaming',1),
        (?2,?4,'viewer','topic','Dark mode','Please','Feature',1)`,
      ids.topic,
      ids.idea,
      ids.page,
      ids.official,
    ),
    run(
      "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'viewer','Rude comment',2)",
      ids.comment,
      ids.topic,
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  env.ADMIN_STEP_UP = undefined;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare("DELETE FROM moderation_actions"),
    env.DB.prepare("DELETE FROM verification"),
  ]);
  await seed();
});

/* ---------- Security-key ceremonies through the API ---------- */

async function addKey(key: SoftKey, name: string, user = "admin"): Promise<Response> {
  const options = await call("POST", "admin/keys/options", { user, body: {} });
  if (!options.ok) return options;
  const creation = await body<CreationOptions>(options);
  const credential = await key.register(creation, origin);
  return call("POST", "admin/keys", { user, body: { name, credential } });
}

async function stepUp(key: SoftKey, user = "admin", assertOrigin = origin): Promise<Response> {
  const options = await call("POST", "admin/stepup/options", { user, body: {} });
  if (!options.ok) return options;
  const request = await body<RequestOptions>(options);
  return call("POST", "admin/stepup/verify", { user, body: await key.assert(request, assertOrigin) });
}

async function twoKeys(): Promise<[SoftKey, SoftKey]> {
  const first = await SoftKey.create();
  const second = await SoftKey.create();
  expect((await addKey(first, "Key one")).status).toBe(201);
  expect((await addKey(second, "Key two")).status).toBe(201);
  return [first, second];
}

/** Moves the step-up stamp and the step-up audit rows back in time, as if `ms` had passed. */
async function age(ms: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE session SET admin_verified_at=admin_verified_at-? WHERE admin_verified_at IS NOT NULL").bind(
      ms,
    ),
    env.DB.prepare("UPDATE session SET created_at=created_at-?").bind(ms),
    env.DB.prepare("UPDATE moderation_actions SET created_at=created_at-?").bind(ms),
  ]);
}

async function seedReport(targetKind: "entry" | "comment", targetId: string, reporter: string): Promise<void> {
  const response = await call("POST", "reports", { user: reporter, body: { targetKind, targetId, reason: "spam" } });
  expect(response.status).toBe(200);
}

/* Every admin endpoint, with a body that would pass validation. */
const endpoints: [string, string, unknown?][] = [
  ["GET", "admin/stepup"],
  ["POST", "admin/stepup/options", {}],
  [
    "POST",
    "admin/stepup/verify",
    { id: "abc", response: { clientDataJSON: "a", authenticatorData: "a", signature: "a" } },
  ],
  ["GET", "admin/keys"],
  ["POST", "admin/keys/options", {}],
  [
    "POST",
    "admin/keys",
    { name: "Key", credential: { id: "abc", response: { clientDataJSON: "a", attestationObject: "a" } } },
  ],
  ["PATCH", `admin/keys/${ids.missing}`, { name: "Key" }],
  ["DELETE", `admin/keys/${ids.missing}`],
  ["GET", "admin/streamers"],
  ["POST", `admin/streamers/${ids.page}`, { action: "freeze", reason: "spam" }],
  ["GET", "admin/report-groups"],
  ["GET", `admin/report-groups/${ids.page}`],
  ["POST", "admin/reports/resolve", { streamerId: ids.page, action: "dismiss" }],
  ["POST", `admin/entries/${ids.topic}/remove`, { reason: "spam" }],
  ["POST", `admin/entries/${ids.idea}/status`, { status: "planned" }],
  ["GET", "admin/applications"],
  ["POST", "admin/applications", { id: ids.missing, decision: "approved" }],
  ["GET", "admin/reports"],
  ["POST", "admin/reports", { id: ids.missing, action: "dismiss" }],
];

describe("admin authorisation", (): void => {
  it.each(["off", "report", "enforce"])(
    "refuses signed-out callers and non-admins on every admin endpoint (%s)",
    async (mode: string): Promise<void> => {
      env.ADMIN_STEP_UP = mode;
      for (const [method, path, payload] of endpoints) {
        const anonymous = await call(method, path, { body: payload });
        expect([path, anonymous.status]).toEqual([path, 401]);
        for (const user of ["viewer", "owner"]) {
          const response = await call(method, path, { user, body: payload });
          expect([path, user, response.status]).toEqual([path, user, 403]);
        }
      }
      const { total } = (await env.DB.prepare("SELECT count(*) AS total FROM moderation_actions").first<{
        total: number;
      }>()) ?? { total: -1 };
      expect(total).toBe(0);
      expect(
        await env.DB.prepare("SELECT status FROM streamers WHERE id=?").bind(ids.page).first<{ status: string }>(),
      ).toEqual({ status: "active" });
    },
  );

  it("reads the step-up mode and fails closed on unknown values", (): void => {
    const mode = (value: string | undefined): string => stepUpMode({ ...env, ADMIN_STEP_UP: value });
    expect(mode(undefined)).toBe("report");
    expect(mode("")).toBe("report");
    expect(mode(" Report ")).toBe("report");
    expect(mode("off")).toBe("off");
    expect(mode("enforce")).toBe("enforce");
    expect(mode("enforced")).toBe("enforce");
    expect(mode("yes")).toBe("enforce");
  });

  it("lets the owner in before any key exists in the default mode, and logs the missing step-up", async (): Promise<void> => {
    const status = await body<StepUpStatus>(await asAdmin("GET", "admin/stepup"));
    expect(status).toMatchObject({ mode: "report", keys: 0, need: "none", canRegister: true, verifiedAt: null });
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "admin_step_up_missing", route: "GET /api/admin/streamers", need: "keys" }),
    );
    const frozen = await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "freeze", reason: "spam" } });
    expect(frozen.status).toBe(200);
    const audit = await env.DB.prepare("SELECT action, metadata FROM moderation_actions WHERE action='freeze'").first<{
      action: string;
      metadata: string;
    }>();
    expect(audit).toEqual({ action: "freeze", metadata: JSON.stringify({ stepUp: "missing" }) });
  });

  it("writes an audit row with the actor and the route when report mode lets an admin through (security review finding 7)", async (): Promise<void> => {
    const missing = async (): Promise<{ target_id: string; actor_id: string; metadata: string }[]> =>
      (
        await env.DB.prepare(
          "SELECT target_id, actor_id, metadata FROM moderation_actions WHERE target_kind='admin_session' AND action='step_up_missing' ORDER BY created_at, metadata",
        ).all<{ target_id: string; actor_id: string; metadata: string }>()
      ).results;
    // No keys yet: enforce would ask for keys.
    expect((await asAdmin("GET", "admin/report-groups?status=open")).status).toBe(200);
    expect(
      (await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "freeze", reason: "spam" } })).status,
    ).toBe(200);
    const rows = await missing();
    expect(rows.map((row) => [row.actor_id, JSON.parse(row.metadata)])).toEqual([
      ["admin", { route: "GET /api/admin/report-groups", need: "keys", sensitive: false }],
      ["admin", { route: `POST /api/admin/streamers/${ids.page}`, need: "keys", sensitive: true }],
    ]);
    // The session is a hash, never the raw id.
    expect(rows[0].target_id).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0].target_id).not.toContain("s-admin");
    // With two keys and a stale step-up, enforce would ask for a key check.
    const [first] = await twoKeys();
    await age(16 * minute);
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    expect(JSON.parse((await missing()).at(-1)?.metadata ?? "{}")).toMatchObject({ need: "step_up" });
    // A fresh step-up, the off mode, and a refused non-admin write nothing.
    expect((await stepUp(first)).status).toBe(200);
    const before = (await missing()).length;
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    env.ADMIN_STEP_UP = "off";
    await age(16 * minute);
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    env.ADMIN_STEP_UP = undefined;
    expect((await call("GET", "admin/streamers", { user: "viewer" })).status).toBe(403);
    expect(await missing()).toHaveLength(before);
  });

  it("skips the step-up check entirely when it is off", async (): Promise<void> => {
    env.ADMIN_STEP_UP = "off";
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("enforced step-up", (): void => {
  beforeEach((): void => {
    env.ADMIN_STEP_UP = "enforce";
  });

  it("asks for two keys, then for a fresh step-up, then opens", async (): Promise<void> => {
    const refused = await asAdmin("GET", "admin/streamers");
    expect(refused.status).toBe(403);
    expect(await body<{ code: string }>(refused)).toMatchObject({ code: "keys_required" });
    expect(await body<StepUpStatus>(await asAdmin("GET", "admin/stepup"))).toMatchObject({ need: "keys", keys: 0 });

    const [first] = await twoKeys();
    // Adding a key stamps the session, so age the stamp to see the gate.
    await age(16 * minute);
    const stale = await asAdmin("GET", "admin/report-groups");
    expect(stale.status).toBe(403);
    expect(await body<{ code: string }>(stale)).toMatchObject({ code: "step_up_required" });
    expect(await body<StepUpStatus>(await asAdmin("GET", "admin/stepup"))).toMatchObject({
      need: "step_up",
      keys: 2,
      freshUntil: null,
    });

    const verified = await stepUp(first);
    expect(verified.status).toBe(200);
    const stamp = await body<{ verifiedAt: number; freshUntil: number }>(verified);
    expect(stamp.freshUntil - stamp.verifiedAt).toBe(15 * minute);
    expect((await asAdmin("GET", "admin/report-groups")).status).toBe(200);
    expect(await body<StepUpStatus>(await asAdmin("GET", "admin/stepup"))).toMatchObject({ need: "none" });
  });

  it("refuses every gated endpoint without a fresh step-up", async (): Promise<void> => {
    await twoKeys();
    await age(16 * minute);
    const gated = endpoints.filter(
      ([method, path]) => !path.startsWith("admin/stepup") && !(method === "POST" && path.startsWith("admin/keys")),
    );
    for (const [method, path, payload] of gated) {
      const response = await asAdmin(method, path, { body: payload });
      expect([method, path, response.status]).toEqual([method, path, 403]);
    }
    expect(
      await env.DB.prepare("SELECT status FROM streamers WHERE id=?").bind(ids.page).first<{ status: string }>(),
    ).toEqual({ status: "active" });
  });

  it("ends the step-up after 15 minutes", async (): Promise<void> => {
    const [first] = await twoKeys();
    await age(16 * minute);
    expect((await stepUp(first)).status).toBe(200);
    await age(14 * minute);
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    await age(minute + 1);
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(403);
  });

  it("keeps the step-up on the session that made it", async (): Promise<void> => {
    const [first] = await twoKeys();
    await age(16 * minute);
    expect((await stepUp(first, "admin")).status).toBe(200);
    expect((await asAdmin("GET", "admin/streamers")).status).toBe(200);
    expect((await call("GET", "admin/streamers", { user: "admin2" })).status).toBe(403);
  });

  it("asks for a step-up from the last 2 minutes before a freeze or a suspension", async (): Promise<void> => {
    const [first] = await twoKeys();
    await age(16 * minute);
    expect((await stepUp(first)).status).toBe(200);
    await age(3 * minute);
    const suspend = { body: { action: "suspend", reason: "illegal", note: "Court order", notify: true } };
    const late = await asAdmin("POST", `admin/streamers/${ids.page}`, suspend);
    expect(late.status).toBe(403);
    expect(await body<{ error: string }>(late)).toMatchObject({ code: "step_up_required" });
    expect((await stepUp(first)).status).toBe(200);
    expect((await asAdmin("POST", `admin/streamers/${ids.page}`, suspend)).status).toBe(200);
    // Lifting a suspension needs only the 15-minute window.
    await age(3 * minute);
    const lifted = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "unsuspend", reason: "other" },
    });
    expect(lifted.status).toBe(200);
  });

  it("gates admin removals on the page endpoints, audits them, and leaves authors and owners alone", async (): Promise<void> => {
    const [first] = await twoKeys();
    await age(16 * minute);
    const own = "20000000-0000-4000-8000-000000000006";
    await env.DB.prepare(
      "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'viewer','My comment',3)",
    )
      .bind(own, ids.topic)
      .run();
    // The author and the page owner need no key.
    expect((await call("POST", "comments", { user: "viewer", body: { action: "delete", id: own } })).status).toBe(200);
    const removeTopic = { body: { action: "delete", id: ids.topic } };
    const removeComment = { body: { action: "delete", id: ids.comment } };
    for (const [path, options] of [
      ["streamers/zed_page", removeTopic],
      ["comments", removeComment],
    ] as const) {
      const refused = await asAdmin("POST", path, options);
      expect([path, refused.status]).toEqual([path, 403]);
      expect(await body<{ code: string }>(refused)).toMatchObject({ code: "step_up_required" });
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entry_comments").first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entries WHERE id=?").bind(ids.topic).first("n")).toBe(1);

    expect((await stepUp(first)).status).toBe(200);
    expect((await asAdmin("POST", "comments", removeComment)).status).toBe(200);
    expect((await asAdmin("POST", "streamers/zed_page", removeTopic)).status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT action, target_id, actor_id, streamer_id, metadata FROM moderation_actions WHERE target_kind='entry' ORDER BY action",
    ).all();
    expect(results).toEqual([
      {
        action: "comment_removed",
        target_id: ids.topic,
        actor_id: "admin",
        streamer_id: ids.page,
        metadata: JSON.stringify({ commentId: ids.comment, via: "page", stepUp: "fresh" }),
      },
      {
        action: "entry_removed",
        target_id: ids.topic,
        actor_id: "admin",
        streamer_id: ids.page,
        metadata: JSON.stringify({ title: "Spam topic", via: "page", stepUp: "fresh" }),
      },
    ]);
  });
});

describe("security-key ceremonies", (): void => {
  it("adds the first key only soon after sign-in, and later keys only after a step-up", async (): Promise<void> => {
    await age(6 * minute);
    const late = await addKey(await SoftKey.create(), "Late");
    expect(late.status).toBe(403);
    expect(await body<{ code: string }>(late)).toMatchObject({ code: "sign_in_again" });

    await env.DB.prepare("UPDATE session SET created_at=? WHERE id='s-admin'").bind(Date.now()).run();
    const first = await SoftKey.create();
    expect((await addKey(first, "Key one")).status).toBe(201);
    await age(3 * minute);
    const second = await addKey(await SoftKey.create(), "Key two");
    expect(second.status).toBe(403);
    expect(await body<{ code: string }>(second)).toMatchObject({ code: "step_up_required" });
    expect((await stepUp(first)).status).toBe(200);
    expect((await addKey(await SoftKey.create(), "Key two")).status).toBe(201);

    const { keys } = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    expect(keys.map((key) => key.name)).toEqual(["Key one", "Key two"]);
    expect(keys[0]).toMatchObject({ transports: ["usb", "nfc"], backedUp: false });
    expect(keys[0].lastUsedAt).toEqual(expect.any(Number));
    const actions = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_kind IN ('passkey','admin_session') ORDER BY created_at",
    ).all<{ action: string }>();
    expect(actions.results.map((row) => row.action)).toEqual(["key_added", "step_up", "key_added"]);
  });

  it("refuses to register the same key twice or a response for another challenge", async (): Promise<void> => {
    const key = await SoftKey.create();
    expect((await addKey(key, "Key one")).status).toBe(201);
    const again = await addKey(key, "Same key");
    expect(again.status).toBe(409);
    const options = await body<CreationOptions>(await asAdmin("POST", "admin/keys/options", { body: {} }));
    const credential = await (await SoftKey.create()).register({ ...options, challenge: "AAAA" }, origin);
    const wrong = await asAdmin("POST", "admin/keys", { body: { name: "Wrong", credential } });
    expect(wrong.status).toBe(400);
    expect(options.excludeCredentials.map((item) => item.id)).toEqual([key.id]);
    expect(options).toMatchObject({
      rp: { id: "stream.example.test" },
      attestation: "none",
      authenticatorSelection: { authenticatorAttachment: "cross-platform", userVerification: "required" },
    });
  });

  it("never accepts the same assertion twice", async (): Promise<void> => {
    const [first] = await twoKeys();
    const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    expect(request).toMatchObject({ rpId: "stream.example.test", userVerification: "required" });
    const assertion = await first.assert(request, origin);
    expect((await asAdmin("POST", "admin/stepup/verify", { body: assertion })).status).toBe(200);
    const replay = await asAdmin("POST", "admin/stepup/verify", { body: assertion });
    expect(replay.status).toBe(400);
    expect(await body<{ code: string }>(replay)).toMatchObject({ code: "challenge_expired" });
  });

  it("refuses an assertion from another origin, another account, or with an old counter", async (): Promise<void> => {
    const [first] = await twoKeys();
    const phished = await stepUp(first, "admin", "https://stream-example.test");
    expect(await body<{ code: string }>(phished)).toMatchObject({ code: "key_failed" });

    const stranger = await SoftKey.create();
    expect(await body<{ code: string }>(await stepUp(stranger))).toMatchObject({ code: "key_unknown" });

    expect((await stepUp(first)).status).toBe(200);
    first.counter -= 1;
    const cloned = await stepUp(first);
    expect(await body<{ code: string }>(cloned)).toMatchObject({ code: "key_failed" });
    const failures = await env.DB.prepare(
      "SELECT count(*) AS total FROM moderation_actions WHERE action='step_up_failed'",
    ).first<{ total: number }>();
    expect(failures?.total).toBe(3);
  });

  it("audits a malformed assertion as a failed check instead of answering 500", async (): Promise<void> => {
    const [first] = await twoKeys();
    const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    const assertion = await first.assert(request, origin);
    // Extension data holding a CBOR text string that is not valid UTF-8.
    const bytes = fromBase64Url(assertion.response.authenticatorData);
    const tampered = new Uint8Array(bytes.length + 2);
    tampered.set(bytes);
    tampered[32] |= 0x80;
    tampered.set([0x61, 0xff], bytes.length);
    const response = await asAdmin("POST", "admin/stepup/verify", {
      body: { ...assertion, response: { ...assertion.response, authenticatorData: toBase64Url(tampered) } },
    });
    expect(response.status).toBe(400);
    expect(await body<{ code: string }>(response)).toMatchObject({ code: "key_failed" });
    const failed = await env.DB.prepare(
      "SELECT count(*) AS total FROM moderation_actions WHERE action='step_up_failed'",
    ).first<{ total: number }>();
    expect(failed?.total).toBe(1);
  });

  it("asks for a challenge that has not expired", async (): Promise<void> => {
    const [first] = await twoKeys();
    const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    await env.DB.prepare("UPDATE verification SET expires_at=?")
      .bind(Date.now() - 1)
      .run();
    const response = await asAdmin("POST", "admin/stepup/verify", { body: await first.assert(request, origin) });
    expect(await body<{ code: string }>(response)).toMatchObject({ code: "challenge_expired" });
  });

  it("removes a key only after a step-up with another key, and never the last one", async (): Promise<void> => {
    const [first, second] = await twoKeys();
    const { keys } = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    const [firstId, secondId] = keys.map((key) => key.id);
    await age(3 * minute);
    expect((await asAdmin("DELETE", `admin/keys/${firstId}`)).status).toBe(403);

    expect((await stepUp(first)).status).toBe(200);
    const same = await asAdmin("DELETE", `admin/keys/${firstId}`);
    expect(await body<{ code: string }>(same)).toMatchObject({ code: "other_key_required" });
    expect((await asAdmin("DELETE", `admin/keys/${secondId}`)).status).toBe(200);

    expect((await stepUp(second)).status).toBe(400);
    const last = await asAdmin("DELETE", `admin/keys/${firstId}`);
    expect(last.status).toBe(403);
    expect((await asAdmin("PATCH", `admin/keys/${firstId}`, { body: { name: "Blue key" } })).status).toBe(200);
    expect((await asAdmin("PATCH", `admin/keys/${ids.missing}`, { body: { name: "Gone" } })).status).toBe(404);
    const remaining = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    expect(remaining.keys.map((key) => key.name)).toEqual(["Blue key"]);
  });

  it("refuses to remove the only key even after a step-up", async (): Promise<void> => {
    const only = await SoftKey.create();
    expect((await addKey(only, "Only")).status).toBe(201);
    const { keys } = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    expect((await stepUp(only)).status).toBe(200);
    const response = await asAdmin("DELETE", `admin/keys/${keys[0].id}`);
    expect(response.status).toBe(403);
    expect(await body<{ code: string }>(response)).toMatchObject({ code: "other_key_required" });
    expect((await asAdmin("GET", "admin/keys")).status).toBe(200);
  });
});

describe("step-up binding (test review gaps)", (): void => {
  const adminSession = (sessionId = "s-admin"): { viewer: Viewer; sessionId: string } => ({
    viewer: { id: "admin", name: "Name admin" } as Viewer,
    sessionId,
  });

  async function stamp(session = "s-admin"): Promise<number | null> {
    const row = await env.DB.prepare("SELECT admin_verified_at FROM session WHERE id=?")
      .bind(session)
      .first<{ admin_verified_at: number | null }>();
    return row?.admin_verified_at ?? null;
  }

  it("refuses an assertion signed over another challenge", async (): Promise<void> => {
    const [first] = await twoKeys();
    const before = await stamp();
    const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    const other = { ...request, challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    const response = await asAdmin("POST", "admin/stepup/verify", { body: await first.assert(other, origin) });
    expect(response.status).toBe(400);
    expect(await body<{ code: string }>(response)).toMatchObject({ code: "key_failed" });
    expect(await stamp()).toBe(before);
  });

  it("refuses a key that another admin registered", async (): Promise<void> => {
    const now = Date.now();
    env.ADMIN_EMAILS = "admin@example.test, deputy@example.test";
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('deputy','Deputy','deputy@example.test',1,?1,?1)",
        ).bind(now),
        env.DB.prepare(
          "INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s-deputy','deputy-session-token','deputy',?1,?2,?2)",
        ).bind(now + 86_400_000, now),
      ]);
      const deputyKey = await SoftKey.create();
      expect((await addKey(deputyKey, "Deputy key", "deputy")).status).toBe(201);
      await twoKeys();
      const before = await stamp();
      const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
      const response = await asAdmin("POST", "admin/stepup/verify", { body: await deputyKey.assert(request, origin) });
      expect(response.status).toBe(400);
      expect(await body<{ code: string }>(response)).toMatchObject({ code: "key_unknown" });
      expect(await stamp()).toBe(before);
    } finally {
      env.ADMIN_EMAILS = "admin@example.test";
    }
  });

  it("binds each challenge to its session and to its purpose", async (): Promise<void> => {
    const [first] = await twoKeys();
    const other = await body<RequestOptions>(await call("POST", "admin/stepup/options", { user: "admin2", body: {} }));
    const stolen = await asAdmin("POST", "admin/stepup/verify", { body: await first.assert(other, origin) });
    expect(await body<{ code: string }>(stolen)).toMatchObject({ code: "challenge_expired" });
    // The other session's challenge is still there for that session.
    const own = await call("POST", "admin/stepup/verify", { user: "admin2", body: await first.assert(other, origin) });
    expect(own.status).toBe(200);
    const register = await body<CreationOptions>(await asAdmin("POST", "admin/keys/options", { body: {} }));
    const assertion = await first.assert({ challenge: register.challenge, rpId: register.rp.id }, origin);
    const wrongPurpose = await asAdmin("POST", "admin/stepup/verify", { body: assertion });
    expect(await body<{ code: string }>(wrongPurpose)).toMatchObject({ code: "challenge_expired" });
  });

  it("lets exactly one of two racing uses of one assertion through", async (): Promise<void> => {
    const [first] = await twoKeys();
    const options = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    expect((await call("POST", "admin/stepup/options", { user: "admin2", body: {} })).status).toBe(200);
    // Both sessions hold the same challenge, so only the counter's compare-and-set can stop the second use.
    await env.DB.prepare("UPDATE verification SET value=? WHERE identifier LIKE 'admin-webauthn:stepup:%'")
      .bind(options.challenge)
      .run();
    const assertion = await first.assert(options, origin);
    // Hold the first batch until the second arrives, so both have read the key before either writes.
    let release: (() => void) | null = null;
    const raced = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target: D1Database, key: string | symbol): unknown {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
              if (release) release();
              else
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              return target.batch(statements);
            };
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as AppEnv;
    const results = await Promise.allSettled([
      verifyStepUp(raced, adminSession("s-admin"), assertion),
      verifyStepUp(raced, adminSession("s-admin2"), assertion),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(refused?.reason).toMatchObject({ code: "key_failed" });
    const key = await env.DB.prepare("SELECT counter FROM passkey WHERE credential_id=?")
      .bind(first.id)
      .first<{ counter: number }>();
    expect(key?.counter).toBe(first.counter);
  });

  it("never removes the last key, even when two sessions each remove the other's key", async (): Promise<void> => {
    const [first, second] = await twoKeys();
    const { keys } = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    const [firstId, secondId] = keys.map((key) => key.id);
    expect((await stepUp(first, "admin")).status).toBe(200);
    expect((await stepUp(second, "admin2")).status).toBe(200);
    expect((await asAdmin("DELETE", `admin/keys/${secondId}`)).status).toBe(200);
    const last = await call("DELETE", `admin/keys/${firstId}`, { user: "admin2" });
    expect(last.status).toBe(409);
    expect(await body<{ code: string }>(last)).toMatchObject({ code: "last_key" });
    expect((await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"))).keys).toHaveLength(1);
  });

  it("accepts a challenge up to the moment it expires and not after", async (): Promise<void> => {
    const [first] = await twoKeys();
    const issued = Date.now();
    const onTime = await stepUpOptions(env, adminSession(), issued);
    const deadline = issued + CHALLENGE_TTL_MS;
    await expect(
      verifyStepUp(env, adminSession(), await first.assert(onTime, origin), deadline),
    ).resolves.toMatchObject({ verifiedAt: deadline });
    const late = await stepUpOptions(env, adminSession(), issued);
    await expect(
      verifyStepUp(env, adminSession(), await first.assert(late, origin), deadline + 1),
    ).rejects.toMatchObject({ code: "challenge_expired" });
  });

  it("lists every registered admin route in the authorization matrix", (): void => {
    const listed = (route: ApiRoute): boolean =>
      endpoints.some(([method, path]) => {
        const match = route.path.exec(path);
        return method === route.method && match?.index === 0 && match[0].length === path.length;
      });
    const admin = apiRoutes.filter((route: ApiRoute): boolean => route.path.source.startsWith("admin"));
    expect(admin.length).toBeGreaterThanOrEqual(19);
    for (const route of admin)
      expect([route.method, route.path.source, listed(route)]).toEqual([route.method, route.path.source, true]);
  });
});

describe("page moderation and the reports queue", (): void => {
  it("freezes, suspends and restores a page with an audit trail", async (): Promise<void> => {
    const freeze = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "freeze", reason: "spam", note: "Bot wave", notify: true },
    });
    expect(await body<{ page: unknown }>(freeze)).toEqual({
      page: { id: ids.page, handle: "zed_page", status: "frozen" },
      emailed: false,
    });
    const write = await call("POST", "streamers/zed_page", {
      user: "owner",
      body: { action: "create", kind: "topic", title: "New", body: "Details", category: "Gaming" },
    });
    expect(write.status).toBe(423);

    const again = await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "freeze", reason: "spam" } });
    expect(again.status).toBe(409);
    const suspend = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "suspend", reason: "illegal" },
    });
    expect(suspend.status).toBe(200);
    const directory = await body<StreamerDirectory>(await call("GET", "streamers"));
    expect(directory.streamers.map((streamer) => streamer.handle)).not.toContain("zed_page");
    expect((await call("GET", "streamers/zed_page", { user: "viewer" })).status).toBe(404);
    expect((await call("GET", "streamers/zed_page", { user: "owner" })).status).toBe(200);

    const list = await body<AdminPageList>(await asAdmin("GET", "admin/streamers?status=suspended"));
    expect(list.pages).toHaveLength(1);
    expect(list.pages[0]).toMatchObject({ handle: "zed_page", status: "suspended", statusReason: "illegal" });
    expect(list.pages[0].history.map((event) => event.action)).toEqual(["suspend", "freeze"]);
    expect(list.pages[0].history[1]).toMatchObject({ note: "Bot wave", notifyOwner: true, actor: "Name admin" });

    expect(
      (await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "unsuspend", reason: "other" } })).status,
    ).toBe(200);
    expect((await call("GET", "streamers/zed_page", { user: "viewer" })).status).toBe(200);
    expect(
      (await asAdmin("POST", `admin/streamers/${ids.missing}`, { body: { action: "freeze", reason: "spam" } })).status,
    ).toBe(404);
    expect(
      (await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "ban", reason: "spam" } })).status,
    ).toBe(400);
    const search = await body<AdminPageList>(await asAdmin("GET", "admin/streamers?query=zed"));
    expect(search.pages.map((page) => page.handle)).toEqual(["zed_page"]);
  });

  it("groups reports by page, de-duplicates them by item, and resolves them together", async (): Promise<void> => {
    await seedReport("entry", ids.topic, "reporter");
    await seedReport("entry", ids.topic, "owner");
    await seedReport("comment", ids.comment, "reporter");

    const { groups } = await body<{ groups: ReportGroup[] }>(await asAdmin("GET", "admin/report-groups"));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ streamerId: ids.page, reports: 3, items: 2, open: 3 });
    expect(groups[0].reasons).toEqual([{ reason: "spam", count: 3 }]);

    const drill = await body<ReportItemList>(await asAdmin("GET", `admin/report-groups/${ids.page}`));
    const topic = drill.items.find((item) => item.targetId === ids.topic);
    expect(topic?.reports).toHaveLength(2);
    expect(topic?.author).toMatchObject({ id: "viewer", name: "Name viewer" });

    const removed = await asAdmin("POST", "admin/reports/resolve", {
      body: { targetKind: "entry", targetId: ids.topic, action: "remove" },
    });
    expect(await body<unknown>(removed)).toEqual({ status: "actioned", resolved: 2 });
    const dismissed = await asAdmin("POST", "admin/reports/resolve", {
      body: { streamerId: ids.page, action: "dismiss" },
    });
    expect(await body<{ resolved: number }>(dismissed)).toMatchObject({ resolved: 1 });
    const open = await body<{ groups: ReportGroup[] }>(await asAdmin("GET", "admin/report-groups"));
    expect(open.groups).toEqual([]);
    const resolved = await body<{ groups: ReportGroup[] }>(await asAdmin("GET", "admin/report-groups?status=resolved"));
    expect(resolved.groups[0]).toMatchObject({ reports: 3, open: 0 });
    const audit = await env.DB.prepare(
      "SELECT action FROM moderation_actions WHERE target_kind='report' ORDER BY created_at",
    ).all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(["report_removed", "reports_dismissed"]);
  });

  it("removes a topic and closes its reports, and sets Ideas status only on the official page", async (): Promise<void> => {
    await seedReport("entry", ids.topic, "reporter");
    const removed = await asAdmin("POST", `admin/entries/${ids.topic}/remove`, {
      body: { reason: "spam", note: "Link farm" },
    });
    expect(await body<unknown>(removed)).toEqual({ removed: ids.topic, resolved: 1 });
    expect(await env.DB.prepare("SELECT id FROM entries WHERE id=?").bind(ids.topic).first()).toBeNull();
    const row = await env.DB.prepare(
      "SELECT reason, note, metadata FROM moderation_actions WHERE action='entry_removed'",
    ).first<{ reason: string; note: string; metadata: string }>();
    expect(row).toMatchObject({ reason: "spam", note: "Link farm" });
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({ title: "Spam topic" });

    const declined = await asAdmin("POST", `admin/entries/${ids.idea}/status`, {
      body: { status: "declined", reason: "Out of scope" },
    });
    expect(await body<unknown>(declined)).toEqual({ id: ids.idea, status: "declined", statusReason: "Out of scope" });
    const cleared = await asAdmin("POST", `admin/entries/${ids.idea}/status`, { body: { status: null } });
    expect(await body<unknown>(cleared)).toEqual({ id: ids.idea, status: null, statusReason: null });
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES (?,?,'viewer','topic','T','B','Gaming',1)",
    )
      .bind(ids.topic, ids.page)
      .run();
    expect((await asAdmin("POST", `admin/entries/${ids.topic}/status`, { body: { status: "planned" } })).status).toBe(
      409,
    );
    expect((await asAdmin("POST", `admin/entries/${ids.missing}/remove`, { body: { reason: "spam" } })).status).toBe(
      404,
    );
  });
});

describe("admin edge cases", (): void => {
  const admin: AdminSession = {
    viewer: { id: "admin", name: "Name admin" } as AdminSession["viewer"],
    sessionId: "s-admin",
    stepUp: "off",
  };

  async function insertKey(id: string, name: string | null, transports: string | null): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO passkey (id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at)
        VALUES (?,?,'AA','admin',?,0,'singleDevice',0,?,1)`,
    )
      .bind(id, name, `cred-${id}`, transports)
      .run();
  }

  it("shapes people and pictures only from values it trusts", (): void => {
    expect(adminPicture(null, "/images/avatar/x")).toBeNull();
    expect(adminPicture("x", "https://cdn.example/x.png")).toBeNull();
    expect(adminPicture("x", "/images/avatar/x")).toBe("/images/avatar/x");
    expect([validPreset(null), validPreset(-1), validPreset(18), validPreset(4)]).toEqual([null, null, null, 4]);
    expect(adminPerson(null, "A", null, null)).toBeNull();
    expect(adminPerson("a", null, null, null)).toBeNull();
    expect(adminPerson("a", "A", null, 99)).toEqual({ id: "a", name: "A", avatar: null, avatarPreset: null });
  });

  it("writes audit rows with defaults", async (): Promise<void> => {
    await auditStatement(env, { targetKind: "streamer", targetId: ids.page, action: "test", actorId: "admin" }).run();
    const row = await env.DB.prepare(
      "SELECT reason, note, notify_owner, metadata, streamer_id FROM moderation_actions",
    ).first<Record<string, unknown>>();
    expect(row).toEqual({ reason: "", note: "", notify_owner: 0, metadata: null, streamer_id: null });
  });

  it("validates moderation input and pages through many streamer pages", async (): Promise<void> => {
    await expect(
      moderatePage(env, admin, ids.page, { action: "freeze", reason: "nope" as "spam" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(moderatePage(env, admin, "not-a-uuid", { action: "freeze", reason: "spam" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(setEntryStatus(env, admin, ids.missing, { status: "planned" })).rejects.toMatchObject({ status: 404 });
    expect((await listModerationPages(env, "admin", { status: "frozen" })).pages).toEqual([]);

    const statements = Array.from({ length: 31 }, (_, index) => {
      const owner = `owner_${index}`;
      return [
        env.DB.prepare(
          "INSERT INTO user (id,name,email,email_verified,image,created_at,updated_at) VALUES (?,?,?,0,?,1,1)",
        ).bind(owner, `Owner ${index}`, `${index}@tiktok.invalid`, `/images/avatar/${owner}`),
        env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name,about,logo) VALUES (?,?,?,?,'',?)").bind(
          crypto.randomUUID(),
          owner,
          `page_${String(index).padStart(2, "0")}`,
          `Page ${index}`,
          `/images/logo/${owner}`,
        ),
      ];
    });
    await env.DB.batch(statements.flat());
    const first = await listModerationPages(env, "admin", { query: "page_" });
    expect(first.pages).toHaveLength(30);
    expect(first.nextCursor).toBe("page_29");
    expect(first.pages[0]).toMatchObject({
      logo: "/images/logo/owner_0",
      owner: { email: "", avatar: "/images/avatar/owner_0" },
    });
    const second = await listModerationPages(env, "admin", { query: "page_", cursor: first.nextCursor });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.pages.map((page) => page.handle)).toEqual(["page_30"]);
  });

  it("groups reports of deleted pages and resolved items", async (): Promise<void> => {
    const gone = crypto.randomUUID();
    const insert = (status: string, resolvedAt: number | null, streamer: string, target: string): D1PreparedStatement =>
      env.DB.prepare(
        `INSERT INTO content_reports (id,target_kind,target_id,streamer_id,reporter_id,reason,snapshot,status,created_at,resolved_at)
          VALUES (?, 'entry', ?, ?, 'reporter', 'spam', 'Snapshot', ?, ?, ?)`,
      ).bind(crypto.randomUUID(), target, streamer, status, Date.now(), resolvedAt);
    await env.DB.batch([
      insert("dismissed", 5, gone, ids.missing),
      insert("actioned", 9, ids.page, ids.topic),
      insert("dismissed", 3, ids.page, ids.topic),
      env.DB.prepare("UPDATE streamers SET logo='/images/logo/owner' WHERE id=?").bind(ids.page),
    ]);
    const resolved = await listReportGroups(env, "admin", { group: "streamer", status: "resolved" });
    expect(resolved.map((group) => group.streamer?.handle ?? null).sort()).toEqual([null, "zed_page"].sort());
    expect(resolved.find((group) => group.streamerId === ids.page)?.streamer?.logo).toBe("/images/logo/owner");
    expect(await listReportGroups(env, "admin", { group: "streamer", status: "all" })).toHaveLength(2);
    await expect(
      listReportGroups(env, "admin", { group: "streamer", status: "closed" as "open" }),
    ).rejects.toMatchObject({ status: 400 });
    const items = await listReportItems(env, "admin", { streamer: ids.page, status: "resolved" });
    expect(items.items[0]).toMatchObject({ status: "actioned", resolvedAt: expect.any(Number) });
    expect((await listReportItems(env, "admin", { streamer: gone, status: "all" })).streamer).toBeNull();
  });

  it("covers key limits, stored rows without names or transports, and a missing key", async (): Promise<void> => {
    const refused = await asAdmin("POST", "admin/stepup/options", { body: {} });
    expect(await body<{ code: string }>(refused)).toMatchObject({ code: "keys_required" });
    for (let index = 0; index < 10; index++) await insertKey(`k${index}`, index === 0 ? null : `Key ${index}`, null);
    expect(await body<StepUpStatus>(await asAdmin("GET", "admin/stepup"))).toMatchObject({ registerBlock: "limit" });
    const limit = await asAdmin("POST", "admin/keys/options", { body: {} });
    expect(await body<{ code: string }>(limit)).toMatchObject({ code: "key_limit" });
    const { keys } = await body<{ keys: SecurityKey[] }>(await asAdmin("GET", "admin/keys"));
    expect(keys[0]).toMatchObject({ name: "Security key", transports: [] });
    await env.DB.prepare("DELETE FROM passkey").run();

    const first = await SoftKey.create();
    expect((await addKey(first, "One")).status).toBe(201);
    expect((await stepUp(first)).status).toBe(200);
    expect((await asAdmin("DELETE", `admin/keys/${ids.missing}`)).status).toBe(404);
  });

  it("stores backup flags and refuses a credential id that does not match", async (): Promise<void> => {
    const key = await SoftKey.create();
    const options = await body<CreationOptions>(await asAdmin("POST", "admin/keys/options", { body: {} }));
    const credential = await key.register(options, origin, { flags: UP | UV | AT | 0x08 | 0x10 });
    const swapped = await asAdmin("POST", "admin/keys", {
      body: { name: "Swapped", credential: { ...credential, id: "AAAA" } },
    });
    expect(swapped.status).toBe(400);
    const again = await body<CreationOptions>(await asAdmin("POST", "admin/keys/options", { body: {} }));
    const synced = await key.register(again, origin, { flags: UP | UV | AT | 0x08 | 0x10 });
    const response = {
      clientDataJSON: synced.response.clientDataJSON,
      attestationObject: synced.response.attestationObject,
    };
    const added = await asAdmin("POST", "admin/keys", {
      body: { name: "Synced", credential: { ...synced, response } },
    });
    expect(await body<{ key: SecurityKey }>(added)).toMatchObject({ key: { backedUp: true, transports: [] } });
  });

  it("dismisses a single report through the older endpoint", async (): Promise<void> => {
    await seedReport("entry", ids.topic, "reporter");
    const { reports } = await body<{ reports: { id: string }[] }>(await asAdmin("GET", "admin/reports"));
    const dismissed = await asAdmin("POST", "admin/reports", { body: { id: reports[0].id, action: "dismiss" } });
    expect(await body<unknown>(dismissed)).toEqual({ status: "dismissed", resolved: 1 });
  });
});

describe("owner notice email (R13)", (): void => {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder): Promise<EmailSendResult> => {
      sent.push(message);
      return { messageId: "test" } as EmailSendResult;
    },
  } as unknown as SendEmail;
  const freeze = { body: { action: "freeze", reason: "spam", note: "Bot wave", notify: true } };

  beforeEach((): void => {
    sent.length = 0;
    env.NOTIFY_EMAIL = binding;
    env.NOTIFY_FROM = "notices@streambullets.example";
  });

  afterAll((): void => {
    env.NOTIFY_EMAIL = undefined;
    env.NOTIFY_FROM = undefined;
  });

  it("emails the owner in their language when the admin asks and email is configured", async (): Promise<void> => {
    await env.DB.prepare("UPDATE user SET locale='de' WHERE id='owner'").run();
    const response = await asAdmin("POST", `admin/streamers/${ids.page}`, freeze);
    expect(await body<{ emailed: boolean }>(response)).toMatchObject({ emailed: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "notices@streambullets.example",
      to: "owner@example.test",
      subject: "Deine StreamBullets-Seite @zed_page ist eingefroren",
    });
    expect(sent[0].text).toContain("Grund: Spam");
    expect(sent[0].text).toContain(`${origin}/@zed_page`);
    expect(sent[0].text).toContain("support@streambullets.com");
  });

  it("tells the owner when a suspension is lifted", async (): Promise<void> => {
    await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "suspend", reason: "illegal" } });
    const lifted = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "unsuspend", reason: "other", notify: true },
    });
    expect(await body<{ emailed: boolean }>(lifted)).toMatchObject({ emailed: true });
    expect(sent.map((message) => message.subject)).toEqual(["Your StreamBullets page @zed_page is active again"]);
  });

  it("sends nothing unless the admin ticks Notify the owner", async (): Promise<void> => {
    const response = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "freeze", reason: "spam" },
    });
    expect(await body<{ emailed: boolean }>(response)).toMatchObject({ emailed: false });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["the binding", "NOTIFY_EMAIL"],
    ["the sender address", "NOTIFY_FROM"],
  ] as const)("shows only the in-app notice without %s", async (_name, key): Promise<void> => {
    env[key] = undefined;
    const response = await asAdmin("POST", `admin/streamers/${ids.page}`, freeze);
    expect(response.status).toBe(200);
    expect(await body<{ emailed: boolean }>(response)).toMatchObject({ emailed: false });
    expect(sent).toHaveLength(0);
    const own = await body<{ streamer: { status: string } }>(
      await call("GET", "streamers/zed_page", { user: "owner" }),
    );
    expect(own.streamer.status).toBe("frozen");
  });

  it("never writes to a placeholder address from TikTok or Instagram", async (): Promise<void> => {
    await env.DB.prepare("UPDATE user SET email='123@tiktok.invalid' WHERE id='owner'").run();
    const response = await asAdmin("POST", `admin/streamers/${ids.page}`, freeze);
    expect(await body<{ emailed: boolean }>(response)).toMatchObject({ emailed: false });
    expect(sent).toHaveLength(0);
  });

  it("keeps the freeze when the email fails", async (): Promise<void> => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.NOTIFY_EMAIL = {
      send: async (): Promise<never> => Promise.reject(new Error("mail relay down")),
    } as unknown as SendEmail;
    const response = await asAdmin("POST", `admin/streamers/${ids.page}`, freeze);
    expect(response.status).toBe(200);
    expect(await body<{ page: { status: string }; emailed: boolean }>(response)).toMatchObject({
      page: { status: "frozen" },
      emailed: false,
    });
    expect(logged).toHaveBeenCalledWith("owner_notify_failed", { action: "freeze", cause: "Error" });
  });
});
