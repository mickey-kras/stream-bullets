/**
 * The WebAuthn checks for admin security keys (item 29), on Web Crypto only.
 *
 * The plan names `@better-auth/passkey` (and its `@simplewebauthn/server` dependency), but neither is a
 * dependency of this app. This module does the small subset that the admin step-up needs, following the
 * relying-party steps of WebAuthn Level 2 (sections 7.1 and 7.2):
 * - registration: attestation "none" is requested, so the attestation statement is not used as a trust anchor
 *   (the trust anchor is the admin's fresh session); only the authenticator data and the credential key count.
 * - authentication: client data type, one-time challenge, exact origin, RP ID hash, user presence and user
 *   verification flags, the signature, and the signature counter.
 * Keys use ES256 (-7), EdDSA (-8) or RS256 (-257).
 */

const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
export const SUPPORTED_ALGORITHMS: readonly number[] = [ES256, EDDSA, RS256];

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

const MAX_CREDENTIAL_ID = 1023;
const MAX_CBOR_DEPTH = 8;

export class WebAuthnError extends Error {}

function fail(message: string): never {
  throw new WebAuthnError(message);
}

/** Callers write the failure audit row only for a WebAuthnError, so no other error may leave a ceremony. */
async function asWebAuthnError<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error: unknown) {
    if (error instanceof WebAuthnError) throw error;
    throw new WebAuthnError("The key response could not be read.", { cause: error });
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) fail("Invalid base64url value.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  let text: string;
  try {
    text = atob(padded);
  } catch {
    fail("Invalid base64url value.");
  }
  return Uint8Array.from(text, (character: string): number => character.codePointAt(0)!);
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return btoa(text);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character: string): number => character.codePointAt(0)!);
}

/* ---------- CBOR: the definite-length subset that authenticators send (RFC 8949, CTAP2 canonical) ---------- */

export type CborValue =
  | number
  | bigint
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

class CborReader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) fail("Truncated CBOR data.");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private argument(info: number): number {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4 }[info];
    if (size === undefined) fail("Unsupported CBOR length.");
    let value = 0;
    for (const byte of this.take(size)) value = value * 256 + byte;
    return value;
  }

  read(depth = 0): CborValue {
    if (depth > MAX_CBOR_DEPTH) fail("CBOR data is nested too deeply.");
    const [initial] = this.take(1);
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      fail("Unsupported CBOR value.");
    }
    const value = this.argument(info);
    switch (major) {
      case 0:
        return value;
      case 1:
        return -1 - value;
      case 2:
        return this.take(value).slice();
      case 3: {
        const text = this.take(value);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(text);
        } catch {
          return fail("Invalid CBOR text.");
        }
      }
      case 4:
        return Array.from({ length: value }, (): CborValue => this.read(depth + 1));
      case 5: {
        const map = new Map<CborValue, CborValue>();
        for (let index = 0; index < value; index += 1) {
          const key = this.read(depth + 1);
          if (map.has(key)) fail("Duplicate CBOR map key.");
          map.set(key, this.read(depth + 1));
        }
        return map;
      }
      default:
        return fail("Unsupported CBOR value.");
    }
  }
}

/** Decodes one CBOR item and says how many bytes it used. */
export function decodeCbor(bytes: Uint8Array): { value: CborValue; length: number } {
  const reader = new CborReader(bytes);
  const value = reader.read();
  return { value, length: reader.offset };
}

/* ---------- Authenticator data ---------- */

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  credential: { aaguid: string; id: Uint8Array; publicKey: Uint8Array } | null;
}

function aaguidText(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) fail("Authenticator data is too short.");
  const flags = bytes[32];
  const counter = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0);
  let offset = 37;
  let credential: AuthenticatorData["credential"] = null;
  if (flags & FLAG_AT) {
    if (bytes.length < offset + 18) fail("Authenticator data is too short.");
    const aaguid = aaguidText(bytes.subarray(offset, offset + 16));
    const idLength = (bytes[offset + 16] << 8) | bytes[offset + 17];
    offset += 18;
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID || bytes.length < offset + idLength)
      fail("Invalid credential ID.");
    const id = bytes.slice(offset, offset + idLength);
    offset += idLength;
    const key = decodeCbor(bytes.subarray(offset));
    const publicKey = bytes.slice(offset, offset + key.length);
    offset += key.length;
    credential = { aaguid, id, publicKey };
  }
  if (flags & FLAG_ED) offset += decodeCbor(bytes.subarray(offset)).length;
  if (offset !== bytes.length) fail("Unexpected bytes after the authenticator data.");
  return { rpIdHash: bytes.slice(0, 32), flags, counter, credential };
}

/* ---------- COSE keys ---------- */

function coseBytes(key: Map<CborValue, CborValue>, label: number, length?: number): Uint8Array<ArrayBuffer> {
  const value = key.get(label);
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) fail("Invalid COSE key.");
  return Uint8Array.from(value);
}

function coseMap(publicKey: Uint8Array): Map<CborValue, CborValue> {
  const { value, length } = decodeCbor(publicKey);
  if (!(value instanceof Map) || length !== publicKey.length) fail("Invalid COSE key.");
  return value;
}

/** The COSE algorithm of a stored key. */
export function coseAlgorithm(publicKey: Uint8Array): number {
  const alg = coseMap(publicKey).get(3);
  if (typeof alg !== "number" || !SUPPORTED_ALGORITHMS.includes(alg)) fail("Unsupported key algorithm.");
  return alg;
}

interface VerifyKey {
  key: CryptoKey;
  params: AlgorithmIdentifier | EcdsaParams;
  der: boolean;
}

async function importCoseKey(publicKey: Uint8Array): Promise<VerifyKey> {
  const key = coseMap(publicKey);
  const alg = coseAlgorithm(publicKey);
  const kty = key.get(1);
  if (alg === ES256) {
    if (kty !== 2 || key.get(-1) !== 1) fail("Invalid COSE key.");
    const point = new Uint8Array(65);
    point[0] = 4;
    point.set(coseBytes(key, -2, 32), 1);
    point.set(coseBytes(key, -3, 32), 33);
    const imported = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return { key: imported, params: { name: "ECDSA", hash: "SHA-256" }, der: true };
  }
  if (alg === EDDSA) {
    if (kty !== 1 || key.get(-1) !== 6) fail("Invalid COSE key.");
    const imported = await crypto.subtle.importKey("raw", coseBytes(key, -2, 32), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return { key: imported, params: { name: "Ed25519" }, der: false };
  }
  if (kty !== 3) fail("Invalid COSE key.");
  const modulus = coseBytes(key, -1);
  if (modulus.length < 256) fail("The RSA key is too short.");
  const imported = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: toBase64Url(modulus), e: toBase64Url(coseBytes(key, -2)), alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return { key: imported, params: { name: "RSASSA-PKCS1-v1_5" }, der: false };
}

/** ECDSA signatures come DER-encoded; Web Crypto wants the raw r||s form. */
export function derToRaw(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (offset: number): { value: Uint8Array; next: number } => {
    if (signature[offset] !== 0x02) fail("Invalid signature.");
    const length = signature[offset + 1];
    if (length === undefined || length < 1 || length > 33 || offset + 2 + length > signature.length)
      fail("Invalid signature.");
    let value = signature.subarray(offset + 2, offset + 2 + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) fail("Invalid signature.");
    return { value, next: offset + 2 + length };
  };
  if (signature[0] !== 0x30 || signature[1] !== signature.length - 2) fail("Invalid signature.");
  const r = integer(2);
  const s = integer(r.next);
  if (s.next !== signature.length) fail("Invalid signature.");
  const raw = new Uint8Array(64);
  raw.set(r.value, 32 - r.value.length);
  raw.set(s.value, 64 - s.value.length);
  return raw;
}

/* ---------- Ceremonies ---------- */

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export interface Expected {
  /** The one-time challenge the server issued, base64url. */
  challenge: string;
  /** The exact page origin, for example https://streambullets.com. */
  origin: string;
  /** The relying-party ID: the origin's host name. */
  rpId: string;
}

function checkClientData(bytes: Uint8Array, type: "webauthn.create" | "webauthn.get", expected: Expected): void {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("Invalid client data.");
  }
  if (typeof data !== "object" || data === null) fail("Invalid client data.");
  const value = data as Record<string, unknown>;
  if (value.type !== type) fail("Wrong ceremony type.");
  if (
    typeof value.challenge !== "string" ||
    !equalBytes(fromBase64Url(value.challenge), fromBase64Url(expected.challenge))
  )
    fail("The challenge does not match.");
  if (value.origin !== expected.origin) fail("The origin does not match.");
  if (value.crossOrigin === true) fail("Cross-origin requests are not allowed.");
  const binding = value.tokenBinding as { status?: unknown } | undefined;
  if (binding?.status === "present") fail("Token binding is not supported.");
}

async function checkAuthenticatorData(data: AuthenticatorData, rpId: string): Promise<void> {
  if (!equalBytes(data.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) fail("The RP ID does not match.");
  if (!(data.flags & FLAG_UP)) fail("The key was not touched.");
  if (!(data.flags & FLAG_UV)) fail("The key did not verify its PIN or fingerprint.");
}

export interface RegistrationResponse {
  clientDataJSON: string;
  attestationObject: string;
}

export interface VerifiedRegistration {
  credentialId: string;
  /** The COSE public key, base64 (the passkey plugin's storage format). */
  publicKey: string;
  counter: number;
  aaguid: string;
  backedUp: boolean;
  deviceType: "singleDevice" | "multiDevice";
}

export async function verifyRegistration(
  response: RegistrationResponse,
  expected: Expected,
): Promise<VerifiedRegistration> {
  return asWebAuthnError(() => registrationOf(response, expected));
}

async function registrationOf(response: RegistrationResponse, expected: Expected): Promise<VerifiedRegistration> {
  checkClientData(fromBase64Url(response.clientDataJSON), "webauthn.create", expected);
  const { value, length } = decodeCbor(fromBase64Url(response.attestationObject));
  const attestationBytes = fromBase64Url(response.attestationObject);
  if (!(value instanceof Map) || length !== attestationBytes.length) fail("Invalid attestation object.");
  const authData = value.get("authData");
  if (!(authData instanceof Uint8Array) || typeof value.get("fmt") !== "string") fail("Invalid attestation object.");
  const data = parseAuthenticatorData(authData);
  await checkAuthenticatorData(data, expected.rpId);
  if (!data.credential) fail("The key sent no credential.");
  coseAlgorithm(data.credential.publicKey);
  await importCoseKey(data.credential.publicKey);
  return {
    credentialId: toBase64Url(data.credential.id),
    publicKey: toBase64(data.credential.publicKey),
    counter: data.counter,
    aaguid: data.credential.aaguid,
    backedUp: Boolean(data.flags & FLAG_BS),
    deviceType: data.flags & FLAG_BE ? "multiDevice" : "singleDevice",
  };
}

export interface AuthenticationResponse {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/**
 * Verifies an assertion against a stored key and returns the new signature counter. A counter that does not
 * grow (while either value is non-zero) means a cloned key or a replay, so the assertion is refused.
 */
export async function verifyAuthentication(
  response: AuthenticationResponse,
  expected: Expected,
  stored: { publicKey: string; counter: number },
): Promise<{ counter: number }> {
  return asWebAuthnError(() => authenticationOf(response, expected, stored));
}

async function authenticationOf(
  response: AuthenticationResponse,
  expected: Expected,
  stored: { publicKey: string; counter: number },
): Promise<{ counter: number }> {
  const clientData = fromBase64Url(response.clientDataJSON);
  checkClientData(clientData, "webauthn.get", expected);
  const authData = fromBase64Url(response.authenticatorData);
  const data = parseAuthenticatorData(authData);
  await checkAuthenticatorData(data, expected.rpId);
  const verifier = await importCoseKey(fromBase64(stored.publicKey));
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256(clientData), authData.length);
  const signature = fromBase64Url(response.signature);
  const valid = await crypto.subtle.verify(
    verifier.params,
    verifier.key,
    verifier.der ? derToRaw(signature) : signature,
    signed,
  );
  if (!valid) fail("The signature is not valid.");
  if ((data.counter !== 0 || stored.counter !== 0) && data.counter <= stored.counter)
    fail("The key's signature counter did not increase.");
  return { counter: data.counter };
}
