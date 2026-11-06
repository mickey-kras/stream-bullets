import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPageList, ReportGroup, ReportItemList, SecurityKey, StepUpStatus } from "../app/admin-types";
import type { AppEnv } from "../app/env";
import type { CreationOptions, RequestOptions } from "../app/server/stepup.server";
import { stepUpMode } from "../app/server/stepup.server";
import type { StreamerDirectory } from "../app/types";
import { apiCaller, type CallOptions } from "./helpers/api";
import { SoftKey } from "./helpers/authenticator";
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
  ["POST", "admin/stepup/verify", { id: "abc", response: { clientDataJSON: "a", authenticatorData: "a", signature: "a" } }],
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
    expect(console.warn).toHaveBeenCalledWith("admin_step_up_missing");
    const frozen = await asAdmin("POST", `admin/streamers/${ids.page}`, { body: { action: "freeze", reason: "spam" } });
    expect(frozen.status).toBe(200);
    const audit = await env.DB.prepare("SELECT action, metadata FROM moderation_actions").first<{
      action: string;
      metadata: string;
    }>();
    expect(audit).toEqual({ action: "freeze", metadata: JSON.stringify({ stepUp: "missing" }) });
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

  it("asks for a challenge that has not expired", async (): Promise<void> => {
    const [first] = await twoKeys();
    const request = await body<RequestOptions>(await asAdmin("POST", "admin/stepup/options", { body: {} }));
    await env.DB.prepare("UPDATE verification SET expires_at=?").bind(Date.now() - 1).run();
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

describe("page moderation and the reports queue", (): void => {
  it("freezes, suspends and restores a page with an audit trail", async (): Promise<void> => {
    const freeze = await asAdmin("POST", `admin/streamers/${ids.page}`, {
      body: { action: "freeze", reason: "spam", note: "Bot wave", notify: true },
    });
    expect(await body<{ page: unknown }>(freeze)).toEqual({ page: { id: ids.page, handle: "zed_page", status: "frozen" } });
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
    const row = await env.DB.prepare("SELECT reason, note, metadata FROM moderation_actions WHERE action='entry_removed'")
      .first<{ reason: string; note: string; metadata: string }>();
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
