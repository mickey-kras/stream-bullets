import type { SecurityKey } from "../../types";
import { t } from "../../i18n";
import { ApiError, requestJson, errorMessage } from "../api";

// Convert WebAuthn base64url JSON to navigator.credentials bytes and encode responses back.

export { ApiError as AdminRequestError, needsStepUp } from "../api";

export async function adminRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return requestJson<T>(url, init, t("admin.requestFailed"));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? errorMessage(error) : t("admin.requestFailed");
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

// Browser cannot distinguish cancellation from timeout.
export function ceremonyError(error: unknown): string {
  if (error instanceof ApiError) return errorMessage(error);
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

// Verify a key and stamp this session; throw on failure.
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

// Register a named key; throw on failure.
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
