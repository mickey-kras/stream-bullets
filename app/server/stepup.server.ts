import { z } from "zod";
import type { SecurityKey, StepUpMode, StepUpNeed, StepUpStatus } from "../admin-types";
import type { AppContext, AppEnv } from "../env";
import { requestSession } from "../lib/shell.server";
import type { Viewer } from "../types";
import { isAdmin } from "./access.server";
import { recordAudit, sessionLabel } from "./audit.server";
import { getOrigin, HttpError } from "./http.server";
import {
  SUPPORTED_ALGORITHMS,
  toBase64Url,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "./webauthn.server";

/**
 * Admin step-up with FIDO2 security keys (item 29, risk R17).
 *
 * Better Auth has no step-up API, and a passkey sign-in would make a new session. So the step-up is a
 * verify-only WebAuthn ceremony that stamps `session.admin_verified_at` on the current session. Admin endpoints
 * then read that stamp:
 * - 15 minutes for admin data and ordinary actions,
 * - 2 minutes for sensitive actions (freeze, suspend, and adding or removing a key).
 *
 * `ADMIN_STEP_UP` picks the policy. Unset means `report`, so the owner is never locked out before they register
 * keys. `enforce` blocks admin work without two keys and a fresh step-up. A value that is set but not known
 * fails closed (`enforce`).
 */

export const STEP_UP_WINDOW_MS = 15 * 60_000;
export const SENSITIVE_WINDOW_MS = 2 * 60_000;
/** A first key may be registered only this soon after sign-in. */
export const ONBOARDING_WINDOW_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const CEREMONY_TIMEOUT_MS = 60_000;
export const REQUIRED_KEYS = 2;
export const MAX_KEYS = 10;

interface CredentialDescriptor {
  type: "public-key";
  id: string;
  transports: string[];
}

/** The JSON forms of WebAuthn options; the browser turns the base64url fields into bytes. */
export interface RequestOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: "required";
  allowCredentials: CredentialDescriptor[];
}

export interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none";
  authenticatorSelection: {
    authenticatorAttachment: "cross-platform";
    residentKey: "discouraged";
    requireResidentKey: false;
    userVerification: "required";
  };
  excludeCredentials: CredentialDescriptor[];
}

export function stepUpMode(env: AppEnv): StepUpMode {
  const value = (env.ADMIN_STEP_UP ?? "").trim().toLowerCase();
  if (value === "" || value === "report") return "report";
  if (value === "off") return "off";
  return "enforce";
}

/** The relying party: the app origin and its host name. WebAuthn ties every key to this RP ID. */
export function relyingParty(env: AppEnv): { origin: string; rpId: string } {
  const origin = getOrigin(env);
  return { origin, rpId: new URL(origin).hostname };
}

export interface AdminSession {
  viewer: Viewer;
  sessionId: string;
  /** How this request met the step-up policy, for the audit log. */
  stepUp: "fresh" | "missing" | "off";
}

interface SessionRow {
  created_at: number;
  admin_verified_at: number | null;
}

interface KeyRow {
  id: string;
  name: string | null;
  public_key: string;
  credential_id: string;
  counter: number;
  backed_up: number;
  transports: string | null;
  created_at: number | null;
  last_used_at: number | null;
}

async function sessionRow(env: AppEnv, sessionId: string): Promise<SessionRow> {
  const row = await env.DB.prepare("SELECT created_at, admin_verified_at FROM session WHERE id=?")
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) throw new HttpError(401, "Sign in to continue.");
  return row;
}

async function keyCount(env: AppEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS total FROM passkey WHERE user_id=?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

function isFresh(verifiedAt: number | null, window: number, now: number): boolean {
  return verifiedAt !== null && verifiedAt <= now && now - verifiedAt < window;
}

function registerBlock(keys: number, session: SessionRow, now: number): StepUpStatus["registerBlock"] {
  if (keys >= MAX_KEYS) return "limit";
  if (keys === 0) return now - session.created_at < ONBOARDING_WINDOW_MS ? "none" : "sign_in_again";
  return isFresh(session.admin_verified_at, SENSITIVE_WINDOW_MS, now) ? "none" : "step_up";
}

function need(mode: StepUpMode, keys: number, verifiedAt: number | null, now: number): StepUpNeed {
  if (mode !== "enforce") return "none";
  if (keys < REQUIRED_KEYS) return "keys";
  return isFresh(verifiedAt, STEP_UP_WINDOW_MS, now) ? "none" : "step_up";
}

async function status(env: AppEnv, userId: string, sessionId: string, now: number): Promise<StepUpStatus> {
  const [session, keys] = await Promise.all([sessionRow(env, sessionId), keyCount(env, userId)]);
  const verifiedAt = session.admin_verified_at;
  const block = registerBlock(keys, session, now);
  return {
    mode: stepUpMode(env),
    keys,
    requiredKeys: REQUIRED_KEYS,
    verifiedAt,
    freshUntil:
      isFresh(verifiedAt, STEP_UP_WINDOW_MS, now) && verifiedAt !== null ? verifiedAt + STEP_UP_WINDOW_MS : null,
    canRegister: block === "none",
    registerBlock: block,
    need: need(stepUpMode(env), keys, verifiedAt, now),
    serverNow: now,
  };
}

/** The signed-in admin and their session. Throws 401 for anonymous requests and 403 for everyone but admins. */
export async function requireAdminViewer(
  request: Request,
  app: AppContext,
): Promise<{ viewer: Viewer; sessionId: string }> {
  const session = await requestSession(request, app);
  if (!session) throw new HttpError(401, "Sign in to continue.");
  if (!(await isAdmin(app.env, session.viewer.id))) throw new HttpError(403, "Only administrators can do this.");
  return session;
}

export async function getStepUpStatus(request: Request, app: AppContext, now = Date.now()): Promise<StepUpStatus> {
  const { viewer, sessionId } = await requireAdminViewer(request, app);
  return status(app.env, viewer.id, sessionId, now);
}

/**
 * The gate in front of every admin endpoint and the admin page loader. `sensitive` asks for a step-up from the last
 * 2 minutes instead of 15. In `report` mode a missing step-up is allowed and logged; in `off` mode it is skipped.
 */
export async function requireAdminSession(
  request: Request,
  app: AppContext,
  options: { sensitive?: boolean; now?: number } = {},
): Promise<AdminSession> {
  const now = options.now ?? Date.now();
  const { viewer, sessionId } = await requireAdminViewer(request, app);
  const mode = stepUpMode(app.env);
  if (mode === "off") return { viewer, sessionId, stepUp: "off" };
  const current = await status(app.env, viewer.id, sessionId, now);
  const window = options.sensitive ? SENSITIVE_WINDOW_MS : STEP_UP_WINDOW_MS;
  const fresh = isFresh(current.verifiedAt, window, now);
  if (mode === "enforce") {
    if (current.keys < REQUIRED_KEYS)
      throw new HttpError(403, "Register two security keys before you use Admin.", "keys_required");
    if (!fresh)
      throw new HttpError(
        403,
        options.sensitive
          ? "This is a sensitive action. Confirm with your security key again."
          : "Confirm with your security key to continue.",
        "step_up_required",
      );
  }
  if (!fresh) console.warn("admin_step_up_missing");
  return { viewer, sessionId, stepUp: fresh ? "fresh" : "missing" };
}

/* ---------- Challenges: one per session and purpose, single use, 2 minutes ---------- */

type Purpose = "stepup" | "register";

function challengeId(purpose: Purpose, sessionId: string): string {
  return `admin-webauthn:${purpose}:${sessionId}`;
}

async function issueChallenge(env: AppEnv, purpose: Purpose, sessionId: string, now: number): Promise<string> {
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const identifier = challengeId(purpose, sessionId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM verification WHERE identifier=? OR expires_at < ?").bind(identifier, now),
    env.DB.prepare(
      "INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), identifier, challenge, now + CHALLENGE_TTL_MS, now, now),
  ]);
  return challenge;
}

/** Takes the challenge out of storage, so a second use of the same response fails. */
async function consumeChallenge(env: AppEnv, purpose: Purpose, sessionId: string, now: number): Promise<string> {
  const row = await env.DB.prepare("DELETE FROM verification WHERE identifier=? RETURNING value, expires_at")
    .bind(challengeId(purpose, sessionId))
    .first<{ value: string; expires_at: number }>();
  if (!row || row.expires_at < now)
    throw new HttpError(400, "The confirmation expired. Try again.", "challenge_expired");
  return row.value;
}

function expected(env: AppEnv, challenge: string): Expected {
  return { challenge, ...relyingParty(env) };
}

/* ---------- Step-up ---------- */

const base64url = z
  .string()
  .regex(/^[\w-]+$/u)
  .max(8192);

export const assertionSchema = z
  .object({
    id: base64url.max(1400),
    response: z
      .object({
        clientDataJSON: base64url,
        authenticatorData: base64url,
        signature: base64url,
        userHandle: base64url.nullish(),
      })
      .strip(),
  })
  .strip();
export type AssertionInput = z.infer<typeof assertionSchema>;

export const registrationSchema = z
  .object({
    name: z.string().trim().min(1, "Name the key.").max(40, "Use 40 characters or fewer."),
    credential: z
      .object({
        id: base64url.max(1400),
        response: z
          .object({
            clientDataJSON: base64url,
            attestationObject: base64url,
            transports: z
              .array(z.string().regex(/^[a-z-]{1,20}$/u))
              .max(8)
              .optional(),
          })
          .strip(),
      })
      .strip(),
  })
  .strict();
export type RegistrationInput = z.infer<typeof registrationSchema>;

export const keyNameSchema = z.object({ name: registrationSchema.shape.name }).strict();

async function keyRows(env: AppEnv, userId: string): Promise<KeyRow[]> {
  const { results } = await env.DB.prepare(`
    SELECT p.*, (
      SELECT max(m.created_at) FROM moderation_actions m
      WHERE m.target_kind='admin_session' AND m.action='step_up' AND m.actor_id=p.user_id
        AND json_extract(m.metadata, '$.keyId')=p.id
    ) AS last_used_at
    FROM passkey p WHERE p.user_id=? ORDER BY p.created_at, p.id
  `)
    .bind(userId)
    .all<KeyRow>();
  return results;
}

function transports(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

export async function stepUpOptions(
  env: AppEnv,
  admin: { viewer: Viewer; sessionId: string },
  now = Date.now(),
): Promise<RequestOptions> {
  const keys = await keyRows(env, admin.viewer.id);
  if (keys.length === 0) throw new HttpError(409, "Register a security key first.", "keys_required");
  return {
    challenge: await issueChallenge(env, "stepup", admin.sessionId, now),
    rpId: relyingParty(env).rpId,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: keys.map((key) => ({
      type: "public-key",
      id: key.credential_id,
      transports: transports(key.transports),
    })),
  };
}

/**
 * Checks an assertion from one of the admin's own keys and stamps this session. Each failure writes an audit row;
 * the challenge is gone either way, so a response can never be replayed.
 */
export async function verifyStepUp(
  env: AppEnv,
  admin: { viewer: Viewer; sessionId: string },
  input: AssertionInput,
  now = Date.now(),
): Promise<{ verifiedAt: number; freshUntil: number; keyId: string }> {
  const challenge = await consumeChallenge(env, "stepup", admin.sessionId, now);
  const label = await sessionLabel(admin.sessionId);
  const key = await env.DB.prepare("SELECT * FROM passkey WHERE credential_id=? AND user_id=?")
    .bind(input.id, admin.viewer.id)
    .first<KeyRow>();
  const failed = async (message: string, code: string, keyId: string | null): Promise<never> => {
    await recordAudit(env, {
      targetKind: "admin_session",
      targetId: label,
      action: "step_up_failed",
      actorId: admin.viewer.id,
      metadata: { keyId, code },
      createdAt: now,
    });
    throw new HttpError(400, message, code);
  };
  if (!key) return failed("That key isn't registered for this account.", "key_unknown", null);
  let counter: number;
  try {
    ({ counter } = await verifyAuthentication(input.response, expected(env, challenge), {
      publicKey: key.public_key,
      counter: key.counter,
    }));
  } catch (error: unknown) {
    if (error instanceof WebAuthnError)
      return failed("The security key check failed. Try again.", "key_failed", key.id);
    throw error;
  }
  const [updated] = await env.DB.batch([
    // Compare-and-set on the counter, so two racing uses of one assertion cannot both pass. The next two
    // statements run only when this one changed a row (`changes()` is the previous statement's count).
    env.DB.prepare("UPDATE passkey SET counter=? WHERE id=? AND counter=?").bind(counter, key.id, key.counter),
    env.DB.prepare("UPDATE session SET admin_verified_at=? WHERE id=? AND user_id=? AND changes()=1").bind(
      now,
      admin.sessionId,
      admin.viewer.id,
    ),
    env.DB.prepare(`
      INSERT INTO moderation_actions (id, target_kind, target_id, action, actor_id, metadata, created_at)
      SELECT ?, 'admin_session', ?, 'step_up', ?, ?, ? WHERE changes()=1
    `).bind(crypto.randomUUID(), label, admin.viewer.id, JSON.stringify({ keyId: key.id }), now),
  ]);
  if (updated.meta.changes !== 1) return failed("The security key check failed. Try again.", "key_failed", key.id);
  return { verifiedAt: now, freshUntil: now + STEP_UP_WINDOW_MS, keyId: key.id };
}

/* ---------- Key registration and management ---------- */

function registrationRefused(block: StepUpStatus["registerBlock"]): HttpError {
  if (block === "limit") return new HttpError(409, `You can register up to ${MAX_KEYS} keys.`, "key_limit");
  if (block === "sign_in_again")
    return new HttpError(403, "Sign out, sign in again, and add your first key within 5 minutes.", "sign_in_again");
  return new HttpError(403, "Confirm with a key you already registered, then add the new key.", "step_up_required");
}

/** User handle for WebAuthn: random per account would be better, but the account id is not secret and is stable. */
function userHandle(userId: string): string {
  return toBase64Url(new TextEncoder().encode(userId));
}

export async function registrationOptions(
  env: AppEnv,
  admin: { viewer: Viewer; sessionId: string },
  now = Date.now(),
): Promise<CreationOptions> {
  const current = await status(env, admin.viewer.id, admin.sessionId, now);
  if (!current.canRegister) throw registrationRefused(current.registerBlock);
  const keys = await keyRows(env, admin.viewer.id);
  return {
    challenge: await issueChallenge(env, "register", admin.sessionId, now),
    rp: { id: relyingParty(env).rpId, name: "StreamBullets" },
    user: { id: userHandle(admin.viewer.id), name: admin.viewer.name, displayName: admin.viewer.name },
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg: number) => ({ type: "public-key", alg })),
    timeout: CEREMONY_TIMEOUT_MS,
    attestation: "none",
    authenticatorSelection: {
      authenticatorAttachment: "cross-platform",
      residentKey: "discouraged",
      requireResidentKey: false,
      userVerification: "required",
    },
    excludeCredentials: keys.map((key) => ({
      type: "public-key",
      id: key.credential_id,
      transports: transports(key.transports),
    })),
  };
}

/**
 * Stores a new key. The admin needs no keys and a sign-in from the last 5 minutes, or a key check from the last
 * 2 minutes. Adding the key counts as a key check for this session.
 */
export async function registerKey(
  env: AppEnv,
  admin: { viewer: Viewer; sessionId: string },
  input: RegistrationInput,
  now = Date.now(),
): Promise<SecurityKey> {
  const current = await status(env, admin.viewer.id, admin.sessionId, now);
  if (!current.canRegister) throw registrationRefused(current.registerBlock);
  const challenge = await consumeChallenge(env, "register", admin.sessionId, now);
  let key;
  try {
    key = await verifyRegistration(input.credential.response, expected(env, challenge));
  } catch (error: unknown) {
    if (error instanceof WebAuthnError) throw new HttpError(400, "That key couldn't be registered.", "key_failed");
    throw error;
  }
  if (key.credentialId !== input.credential.id)
    throw new HttpError(400, "That key couldn't be registered.", "key_failed");
  const id = crypto.randomUUID();
  const keyTransports = (input.credential.response.transports ?? []).join(",") || null;
  const label = await sessionLabel(admin.sessionId);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at, aaguid)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM passkey WHERE user_id=?) = ?
      ON CONFLICT(credential_id) DO NOTHING
    `).bind(
      id,
      input.name,
      key.publicKey,
      admin.viewer.id,
      key.credentialId,
      key.counter,
      key.deviceType,
      key.backedUp ? 1 : 0,
      keyTransports,
      now,
      key.aaguid,
      admin.viewer.id,
      current.keys,
    ),
    env.DB.prepare(`
      UPDATE session SET admin_verified_at=?
      WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM passkey WHERE id=?)
    `).bind(now, admin.sessionId, admin.viewer.id, id),
    env.DB.prepare(`
      INSERT INTO moderation_actions (id, target_kind, target_id, action, actor_id, metadata, created_at)
      SELECT ?, 'passkey', ?, 'key_added', ?, ?, ? WHERE EXISTS (SELECT 1 FROM passkey WHERE id=?)
    `).bind(crypto.randomUUID(), id, admin.viewer.id, JSON.stringify({ session: label, name: input.name }), now, id),
  ]);
  if (inserted.meta.changes !== 1)
    throw new HttpError(
      409,
      "That key is already registered, or your keys changed. Reload and try again.",
      "key_conflict",
    );
  return {
    id,
    name: input.name,
    createdAt: now,
    lastUsedAt: null,
    backedUp: key.backedUp,
    transports: transports(keyTransports),
  };
}

export async function listKeys(env: AppEnv, userId: string): Promise<SecurityKey[]> {
  return (await keyRows(env, userId)).map((row) => ({
    id: row.id,
    name: row.name ?? "Security key",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    backedUp: row.backed_up === 1,
    transports: transports(row.transports),
  }));
}

export async function renameKey(env: AppEnv, admin: AdminSession, id: string, name: string): Promise<void> {
  const [updated] = await env.DB.batch([
    env.DB.prepare("UPDATE passkey SET name=? WHERE id=? AND user_id=?").bind(name, id, admin.viewer.id),
    env.DB.prepare(`
      INSERT INTO moderation_actions (id, target_kind, target_id, action, actor_id, metadata, created_at)
      SELECT ?, 'passkey', ?, 'key_renamed', ?, ?, ? WHERE EXISTS (SELECT 1 FROM passkey WHERE id=? AND user_id=?)
    `).bind(
      crypto.randomUUID(),
      id,
      admin.viewer.id,
      JSON.stringify({ name, stepUp: admin.stepUp }),
      Date.now(),
      id,
      admin.viewer.id,
    ),
  ]);
  if (updated.meta.changes !== 1) throw new HttpError(404, "Key not found.");
}

/**
 * Removes a key. Needs a step-up from the last 2 minutes made with another key (in every mode: key management never
 * depends on ADMIN_STEP_UP), and never removes the last key. Recovery from lost keys is operator-only (SECURITY.md).
 */
export async function removeKey(
  env: AppEnv,
  admin: { viewer: Viewer; sessionId: string },
  id: string,
  now = Date.now(),
): Promise<void> {
  const label = await sessionLabel(admin.sessionId);
  const last = await env.DB.prepare(`
    SELECT json_extract(metadata, '$.keyId') AS key_id, created_at FROM moderation_actions
    WHERE target_kind='admin_session' AND target_id=? AND action='step_up' AND actor_id=?
    ORDER BY created_at DESC LIMIT 1
  `)
    .bind(label, admin.viewer.id)
    .first<{ key_id: string | null; created_at: number }>();
  const session = await sessionRow(env, admin.sessionId);
  if (
    !last ||
    !isFresh(session.admin_verified_at, SENSITIVE_WINDOW_MS, now) ||
    now - last.created_at >= SENSITIVE_WINDOW_MS
  )
    throw new HttpError(403, "Confirm with another registered key to remove this one.", "step_up_required");
  if (last.key_id === id)
    throw new HttpError(403, "Confirm with a different key than the one you remove.", "other_key_required");
  const [removed] = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM passkey WHERE id=? AND user_id=? AND (SELECT count(*) FROM passkey WHERE user_id=?) > 1
    `).bind(id, admin.viewer.id, admin.viewer.id),
    env.DB.prepare(`
      INSERT INTO moderation_actions (id, target_kind, target_id, action, actor_id, metadata, created_at)
      SELECT ?, 'passkey', ?, 'key_removed', ?, ?, ? WHERE changes() = 1
    `).bind(crypto.randomUUID(), id, admin.viewer.id, JSON.stringify({ session: label }), now),
  ]);
  if (removed.meta.changes !== 1) {
    const exists = await env.DB.prepare("SELECT 1 AS found FROM passkey WHERE id=? AND user_id=?")
      .bind(id, admin.viewer.id)
      .first<{ found: number }>();
    if (!exists) throw new HttpError(404, "Key not found.");
    throw new HttpError(409, "You can't remove your only key. Add another key first.", "last_key");
  }
}
