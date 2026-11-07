import { describe, expect, it } from "vitest";
import {
  coseAlgorithm,
  decodeCbor,
  derToRaw,
  fromBase64,
  fromBase64Url,
  parseAuthenticatorData,
  toBase64,
  toBase64Url,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "../app/server/webauthn.server";
import { AT, encodeCbor, rawToDer, SoftKey, UP, UV, type CborInput, type KeyKind } from "./helpers/authenticator";

const origin = "https://stream.example.test";
const rpId = "stream.example.test";
const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const expected: Expected = { challenge, origin, rpId };

async function registered(kind: KeyKind = "es256"): Promise<{ key: SoftKey; publicKey: string; counter: number }> {
  const key = await SoftKey.create(kind);
  const credential = await key.register({ challenge, rp: { id: rpId } }, origin);
  const result = await verifyRegistration(credential.response, expected);
  return { key, publicKey: result.publicKey, counter: result.counter };
}

describe("encodings", (): void => {
  it("round-trips base64url and base64 and rejects bad input", (): void => {
    const bytes = Uint8Array.of(0, 250, 251, 255, 62, 63);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(() => fromBase64Url("a+b")).toThrow(WebAuthnError);
    expect(() => fromBase64Url("a")).toThrow(WebAuthnError);
  });

  it("decodes the CBOR subset and refuses what authenticators never send", (): void => {
    const map = new Map<CborInput, CborInput>([
      ["a", [1, -1, true, false, null]],
      [1, Uint8Array.of(1, 2)],
      [2, 300],
      [3, 70_000],
      [4, 5_000_000_000 % 4_294_967_296],
    ]);
    const { value, length } = decodeCbor(encodeCbor(map));
    expect(length).toBe(encodeCbor(map).length);
    expect(value).toEqual(map);
    expect(() => decodeCbor(Uint8Array.of(0x9f))).toThrow("Unsupported CBOR length.");
    expect(() => decodeCbor(Uint8Array.of(0xfb))).toThrow("Unsupported CBOR value.");
    expect(() => decodeCbor(Uint8Array.of(0xc1, 0x01))).toThrow("Unsupported CBOR value.");
    expect(() => decodeCbor(Uint8Array.of(0x42, 1))).toThrow("Truncated CBOR data.");
    expect(() => decodeCbor(Uint8Array.of(0xa2, 1, 1, 1, 2))).toThrow("Duplicate CBOR map key.");
    expect(() => decodeCbor(Uint8Array.from(Array.from({ length: 12 }, () => 0x81)))).toThrow("nested too deeply");
  });

  it("converts DER ECDSA signatures and refuses malformed ones", (): void => {
    const raw = Uint8Array.from({ length: 64 }, (_, index) => (index === 0 || index === 32 ? 0x80 : index));
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    const short = new Uint8Array(64);
    short[31] = 1;
    short[63] = 2;
    expect(derToRaw(rawToDer(short))).toEqual(short);
    expect(() => derToRaw(Uint8Array.of(0x31, 0))).toThrow("Invalid signature.");
    expect(() => derToRaw(Uint8Array.of(0x30, 2, 0x03, 0))).toThrow("Invalid signature.");
    expect(() => derToRaw(Uint8Array.of(0x30, 3, 0x02, 0, 0))).toThrow("Invalid signature.");
    expect(() => derToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 1, 0x02, 2, 1))).toThrow("Invalid signature.");
    const long = Uint8Array.of(0x30, 37, 0x02, 33, 1, ...new Uint8Array(32), 0x02, 1, 1);
    expect(() => derToRaw(long)).toThrow("Invalid signature.");
    expect(() => derToRaw(Uint8Array.of(0x30, 7, 0x02, 1, 1, 0x02, 1, 1, 0))).toThrow("Invalid signature.");
  });
});

describe("authenticator data", (): void => {
  it("needs the fixed header and an exact length", (): void => {
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow("too short");
    const base = new Uint8Array(37);
    expect(parseAuthenticatorData(base)).toMatchObject({ flags: 0, counter: 0, credential: null });
    expect(() => parseAuthenticatorData(new Uint8Array(38))).toThrow("Unexpected bytes");
    const attested = new Uint8Array(40);
    attested[32] = AT;
    expect(() => parseAuthenticatorData(attested)).toThrow("too short");
    const noId = new Uint8Array(37 + 18);
    noId[32] = AT;
    expect(() => parseAuthenticatorData(noId)).toThrow("Invalid credential ID.");
  });

  it("skips extension data", (): void => {
    const extensions = encodeCbor(new Map<CborInput, CborInput>([["credProtect", 1]]));
    const bytes = new Uint8Array(37 + extensions.length);
    bytes[32] = 0x80;
    bytes.set(extensions, 37);
    expect(parseAuthenticatorData(bytes).flags).toBe(0x80);
  });

  it("names the COSE algorithm and refuses others", (): void => {
    expect(() => coseAlgorithm(encodeCbor(new Map<CborInput, CborInput>([[3, -35]])))).toThrow("Unsupported key");
    expect(() => coseAlgorithm(encodeCbor([1]))).toThrow("Invalid COSE key.");
  });
});

describe("registration", (): void => {
  it.each(["es256", "ed25519", "rs256"] as const)(
    "accepts a %s key with attestation none",
    async (kind): Promise<void> => {
      const key = await SoftKey.create(kind);
      const credential = await key.register({ challenge, rp: { id: rpId } }, origin);
      const result = await verifyRegistration(credential.response, expected);
      expect(result).toMatchObject({ credentialId: key.id, counter: 0, backedUp: false, deviceType: "singleDevice" });
      expect(result.aaguid).toBe("00000000-0000-0000-0000-000000000000");
    },
  );

  it("reads the backup flags", async (): Promise<void> => {
    const key = await SoftKey.create();
    const credential = await key.register({ challenge, rp: { id: rpId } }, origin, {
      flags: UP | UV | AT | 0x08 | 0x10,
    });
    expect(await verifyRegistration(credential.response, expected)).toMatchObject({
      backedUp: true,
      deviceType: "multiDevice",
    });
  });

  it.each([
    [{ type: "webauthn.get" }, "Wrong ceremony type."],
    [{ challenge: toBase64Url(new Uint8Array(32)) }, "The challenge does not match."],
    [{ origin: "https://evil.example" }, "The origin does not match."],
    [{ crossOrigin: true }, "Cross-origin requests are not allowed."],
    [{ rpId: "evil.example" }, "The RP ID does not match."],
    [{ flags: UV | AT }, "The key was not touched."],
    [{ flags: UP | AT }, "The key did not verify"],
    [{ flags: UP | UV }, "Unexpected bytes"],
  ])("refuses %o", async (overrides, message): Promise<void> => {
    const key = await SoftKey.create();
    const credential = await key.register({ challenge, rp: { id: rpId } }, origin, overrides);
    await expect(verifyRegistration(credential.response, expected)).rejects.toThrow(message);
  });

  it("refuses malformed client data and attestation objects", async (): Promise<void> => {
    const key = await SoftKey.create();
    const { response } = await key.register({ challenge, rp: { id: rpId } }, origin);
    const bad = (patch: Partial<typeof response>) => verifyRegistration({ ...response, ...patch }, expected);
    await expect(bad({ clientDataJSON: toBase64Url(new TextEncoder().encode("{")) })).rejects.toThrow("client data");
    await expect(bad({ clientDataJSON: toBase64Url(new TextEncoder().encode("null")) })).rejects.toThrow("client data");
    const bound = { type: "webauthn.create", challenge, origin, tokenBinding: { status: "present" } };
    await expect(bad({ clientDataJSON: toBase64Url(new TextEncoder().encode(JSON.stringify(bound))) })).rejects.toThrow(
      "Token binding",
    );
    await expect(bad({ attestationObject: toBase64Url(encodeCbor([1])) })).rejects.toThrow("attestation object");
    await expect(
      bad({ attestationObject: toBase64Url(encodeCbor(new Map<CborInput, CborInput>([["fmt", "none"]]))) }),
    ).rejects.toThrow("attestation object");
    const trailing = new Uint8Array([...fromBase64Url(response.attestationObject), 0]);
    await expect(bad({ attestationObject: toBase64Url(trailing) })).rejects.toThrow("attestation object");
  });

  it("refuses COSE keys that do not match their algorithm", async (): Promise<void> => {
    const attest = async (cose: Map<CborInput, CborInput>): Promise<unknown> => {
      const header = new Uint8Array(37);
      header.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))));
      header[32] = UP | UV | AT;
      const authData = Uint8Array.from([...header, ...new Uint8Array(16), 0, 1, 7, ...encodeCbor(cose)]);
      const attestation = encodeCbor(
        new Map<CborInput, CborInput>([
          ["fmt", "none"],
          ["authData", authData],
        ]),
      );
      const clientData = { type: "webauthn.create", challenge, origin };
      return verifyRegistration(
        {
          clientDataJSON: toBase64Url(new TextEncoder().encode(JSON.stringify(clientData))),
          attestationObject: toBase64Url(attestation),
        },
        expected,
      );
    };
    const map = (entries: [CborInput, CborInput][]) => new Map<CborInput, CborInput>(entries);
    await expect(
      attest(
        map([
          [1, 1],
          [3, -7],
        ]),
      ),
    ).rejects.toThrow("Invalid COSE key.");
    await expect(
      attest(
        map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(31)],
          [-3, new Uint8Array(32)],
        ]),
      ),
    ).rejects.toThrow("Invalid COSE key.");
    await expect(
      attest(
        map([
          [1, 2],
          [3, -8],
          [-1, 6],
        ]),
      ),
    ).rejects.toThrow("Invalid COSE key.");
    await expect(
      attest(
        map([
          [1, 1],
          [3, -257],
        ]),
      ),
    ).rejects.toThrow("Invalid COSE key.");
    await expect(
      attest(
        map([
          [1, 3],
          [3, -257],
          [-1, new Uint8Array(128)],
          [-2, Uint8Array.of(1, 0, 1)],
        ]),
      ),
    ).rejects.toThrow("too short");
  });
});

describe("authentication", (): void => {
  it.each(["es256", "ed25519", "rs256"] as const)("verifies a %s assertion and returns the counter", async (kind) => {
    const { key, publicKey } = await registered(kind);
    const assertion = await key.assert({ challenge, rpId }, origin);
    expect(await verifyAuthentication(assertion.response, expected, { publicKey, counter: 0 })).toEqual({ counter: 1 });
  });

  it("allows keys without a counter but refuses a counter that does not grow", async (): Promise<void> => {
    const { key, publicKey } = await registered();
    key.counting = false;
    const still = await key.assert({ challenge, rpId }, origin);
    expect(await verifyAuthentication(still.response, expected, { publicKey, counter: 0 })).toEqual({ counter: 0 });
    const replayed = await key.assert({ challenge, rpId }, origin, { counter: 4 });
    await expect(verifyAuthentication(replayed.response, expected, { publicKey, counter: 4 })).rejects.toThrow(
      "counter did not increase",
    );
    await expect(verifyAuthentication(still.response, expected, { publicKey, counter: 3 })).rejects.toThrow(
      "counter did not increase",
    );
  });

  it.each([
    [{ type: "webauthn.create" }, "Wrong ceremony type."],
    [{ origin: "https://stream.example.test.evil.example" }, "The origin does not match."],
    [{ rpId: "example.test" }, "The RP ID does not match."],
    [{ flags: UP }, "did not verify"],
    [{ flags: UV }, "not touched"],
    [{ corruptSignature: true }, "The signature is not valid."],
  ])("refuses %o", async (overrides, message): Promise<void> => {
    const { key, publicKey } = await registered();
    const assertion = await key.assert({ challenge, rpId }, origin, overrides);
    await expect(verifyAuthentication(assertion.response, expected, { publicKey, counter: 0 })).rejects.toThrow(
      message,
    );
  });

  it("refuses a signature from another key", async (): Promise<void> => {
    const { publicKey } = await registered();
    const other = await SoftKey.create();
    const assertion = await other.assert({ challenge, rpId }, origin);
    await expect(verifyAuthentication(assertion.response, expected, { publicKey, counter: 0 })).rejects.toThrow(
      WebAuthnError,
    );
  });
});
