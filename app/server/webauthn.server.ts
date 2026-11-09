import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

/**
 * The WebAuthn checks for admin security keys (item 29), delegated to `@simplewebauthn/server`.
 *
 * `@better-auth/passkey` wraps the same library, but its endpoints sign a user in and make a new session. The admin
 * step-up only verifies a key on the current session, with its own policy in stepup.server.ts, so this module calls
 * the library's two verify functions directly:
 * - registration: attestation "none" is requested, so the attestation statement is not a trust anchor (the trust
 *   anchor is the admin's fresh session); only the authenticator data and the credential key count.
 * - authentication: client data type, one-time challenge, exact origin, RP ID hash, user presence and user
 *   verification flags, the signature, and the signature counter.
 * Keys use ES256 (-7), EdDSA (-8) or RS256 (-257).
 */

export const SUPPORTED_ALGORITHMS: readonly number[] = [-7, -8, -257];

export class WebAuthnError extends Error {}

/** Callers write the failure audit row only for a WebAuthnError, so no other error may leave a ceremony. */
async function asWebAuthnError<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error: unknown) {
    if (error instanceof WebAuthnError) throw error;
    const message =
      error instanceof Error
        ? error.message
        : "The key response could not be read.";
    throw new WebAuthnError(message, { cause: error });
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  return isoBase64URL.fromBuffer(Uint8Array.from(bytes));
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!isoBase64URL.isBase64URL(value) || value.length % 4 === 1)
    throw new WebAuthnError("Invalid base64url value.");
  return Uint8Array.from(isoBase64URL.toBuffer(value));
}

/**
 * The library accepts a cross-origin response when the browser sends no `topOrigin` (Safari), and token binding
 * "present". Keys for this site are only ever used top-level on its own origin, so both are refused here first.
 */
function refuseEmbedded(clientDataJSON: string): void {
  let data: unknown;
  try {
    data = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON));
  } catch {
    throw new WebAuthnError("Invalid client data.");
  }
  if (typeof data !== "object" || data === null)
    throw new WebAuthnError("Invalid client data.");
  const value = data as {
    crossOrigin?: unknown;
    tokenBinding?: { status?: unknown };
  };
  if (value.crossOrigin === true)
    throw new WebAuthnError("Cross-origin requests are not allowed.");
  if (value.tokenBinding?.status === "present")
    throw new WebAuthnError("Token binding is not supported.");
}

export interface Expected {
  /** The one-time challenge the server issued, base64url. */
  challenge: string;
  /** The exact page origin, for example https://streambullets.com. */
  origin: string;
  /** The relying-party ID: the origin's host name. */
  rpId: string;
}

export interface RegistrationCredential {
  id: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
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

export function verifyRegistration(
  credential: RegistrationCredential,
  expected: Expected,
): Promise<VerifiedRegistration> {
  return asWebAuthnError(async (): Promise<VerifiedRegistration> => {
    refuseEmbedded(credential.response.clientDataJSON);
    const result = await verifyRegistrationResponse({
      response: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          attestationObject: credential.response.attestationObject,
          transports: credential.response
            .transports as RegistrationResponseJSON["response"]["transports"],
        },
      },
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
    });
    if (!result.verified)
      throw new WebAuthnError("The attestation is not valid.");
    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey, "base64"),
      counter: info.credential.counter,
      aaguid: info.aaguid,
      backedUp: info.credentialBackedUp,
      deviceType: info.credentialDeviceType,
    };
  });
}

export interface AuthenticationCredential {
  id: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  };
}

/**
 * Verifies an assertion against a stored key and returns the new signature counter. A counter that does not
 * grow (while either value is non-zero) means a cloned key or a replay, so the assertion is refused.
 */
export function verifyAuthentication(
  credential: AuthenticationCredential,
  expected: Expected,
  stored: { publicKey: string; counter: number },
): Promise<{ counter: number }> {
  return asWebAuthnError(async (): Promise<{ counter: number }> => {
    refuseEmbedded(credential.response.clientDataJSON);
    const result = await verifyAuthenticationResponse({
      response: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: credential.response.clientDataJSON,
          authenticatorData: credential.response.authenticatorData,
          signature: credential.response.signature,
        },
      },
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: expected.rpId,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(stored.publicKey, "base64"),
        counter: stored.counter,
      },
    });
    if (!result.verified)
      throw new WebAuthnError("The signature is not valid.");
    return { counter: result.authenticationInfo.newCounter };
  });
}
