import type { SecurityKey } from "../../admin-types";
import { t } from "../../i18n";
import { ApiError, apiError } from "../api";

/**
 * Browser side of the admin security-key ceremonies. The server sends WebAuthn options as JSON with base64url
 * fields; these helpers turn them into bytes for `navigator.credentials` and send the response back the same way.
 */

export { ApiError as AdminRequestError, needsStepUp } from "../api";

export async function adminRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response: Response = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiError(response.status, value, t("admin.requestFailed"));
  return value as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : t("admin.requestFailed");
}

function fromBase64Url(value: string): ArrayBuffer {
  const base64: string = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary: string = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes.buffer;
}

function toBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

interface Descriptor {
  type: "public-key";
  id: string;
  transports: string[];
}

interface RequestJson {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials: Descriptor[];
}

interface CreationJson {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: Descriptor[];
}

function descriptors(list: Descriptor[]): PublicKeyCredentialDescriptor[] {
  return list.map((item) => ({
    type: item.type,
    id: fromBase64Url(item.id),
    transports: item.transports as AuthenticatorTransport[],
  }));
}

/** Why a ceremony failed, as the gate says it. Cancelling and timing out look the same to the browser. */
export function ceremonyError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return t("keys.cancelled");
    if (error.name === "InvalidStateError") return t("keys.alreadyRegistered");
    if (error.name === "SecurityError") return t("keys.wrongSite");
  }
  return t("keys.failed");
}

export function webAuthnAvailable(): boolean {
  return globalThis.window !== undefined && typeof globalThis.PublicKeyCredential === "function";
}

/** Asks the key for an assertion and stamps this session. Throws on failure. */
export async function confirmWithKey(): Promise<void> {
  const options = await adminRequest<RequestJson>("/api/admin/stepup/options", "POST", {});
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: descriptors(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error(t("keys.cancelled"));
  const response = credential.response as AuthenticatorAssertionResponse;
  await adminRequest<unknown>("/api/admin/stepup/verify", "POST", {
    id: credential.id,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
  });
}

/** Registers a new key under `name`. Throws on failure. */
export async function registerKey(name: string): Promise<SecurityKey> {
  const options = await adminRequest<CreationJson>("/api/admin/keys/options", "POST", {});
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rp: options.rp,
      user: { ...options.user, id: fromBase64Url(options.user.id) },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: descriptors(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error(t("keys.cancelled"));
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports: string[] = typeof response.getTransports === "function" ? response.getTransports() : [];
  const result = await adminRequest<{ key: SecurityKey }>("/api/admin/keys", "POST", {
    name,
    credential: {
      id: credential.id,
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports: transports.filter((item: string) => /^[a-z-]{1,20}$/u.test(item)).slice(0, 8),
      },
    },
  });
  return result.key;
}
