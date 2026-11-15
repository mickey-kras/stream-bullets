import { describe, expect, it } from "vitest";
import {
  fromBase64Url,
  toBase64Url,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "../app/server/webauthn.server";
import {
  AT,
  encodeCbor,
  SoftKey,
  UP,
  UV,
  type CborInput,
  type KeyKind,
} from "./helpers/authenticator";

// Pin the @simplewebauthn/server guarantees required by admin step-up.

const origin = "https://stream.example.test";
const rpId = "stream.example.test";
const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const expected: Expected = { challenge, origin, rpId };

async function registered(
  kind: KeyKind = "es256",
): Promise<{ key: SoftKey; publicKey: string; counter: number }> {
  const key = await SoftKey.create(kind);
  const credential = await key.register(
    { challenge, rp: { id: rpId } },
    origin,
  );
  const result = await verifyRegistration(credential, expected);
  return { key, publicKey: result.publicKey, counter: result.counter };
}

function utf8(value: string): string {
  return toBase64Url(new TextEncoder().encode(value));
}

describe("encodings", (): void => {
  it("round-trips base64url and rejects bad input", (): void => {
    const bytes = Uint8Array.of(0, 250, 251, 255, 62, 63);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(() => fromBase64Url("a+b")).toThrow(WebAuthnError);
    expect(() => fromBase64Url("a")).toThrow(WebAuthnError);
  });
});

describe("registration", (): void => {
  it.each(["es256", "ed25519", "rs256"] as const)(
    "accepts a %s key with attestation none",
    async (kind): Promise<void> => {
      const key = await SoftKey.create(kind);
      const credential = await key.register(
        { challenge, rp: { id: rpId } },
        origin,
      );
      const result = await verifyRegistration(credential, expected);
      expect(result).toMatchObject({
        credentialId: key.id,
        counter: 0,
        backedUp: false,
        deviceType: "singleDevice",
      });
      expect(result.aaguid).toBe("00000000-0000-0000-0000-000000000000");
    },
  );

  it("stores the COSE key as base64, the passkey table's format", async (): Promise<void> => {
    const key = await SoftKey.create();
    const result = await verifyRegistration(
      await key.register({ challenge, rp: { id: rpId } }, origin),
      expected,
    );
    expect(
      Uint8Array.from(
        atob(result.publicKey),
        (c: string): number => c.codePointAt(0)!,
      ),
    ).toEqual(await key.cose());
  });

  it("reads the backup flags", async (): Promise<void> => {
    const key = await SoftKey.create();
    const credential = await key.register(
      { challenge, rp: { id: rpId } },
      origin,
      {
        flags: UP | UV | AT | 0x08 | 0x10,
      },
    );
    expect(await verifyRegistration(credential, expected)).toMatchObject({
      backedUp: true,
      deviceType: "multiDevice",
    });
  });

  it.each([
    [{ type: "webauthn.get" }, /type/],
    [{ challenge: toBase64Url(new Uint8Array(32)) }, /challenge/],
    [{ origin: "https://evil.example" }, /origin/],
    [{ crossOrigin: true }, "Cross-origin requests are not allowed."],
    [{ rpId: "evil.example" }, /RP ID/],
    [{ flags: UV | AT }, /presence/],
    [{ flags: UP | AT }, /verification/],
    [{ flags: UP | UV }, /./],
    [{ fmt: "packed" }, /./],
  ])("refuses %o", async (overrides, message): Promise<void> => {
    const key = await SoftKey.create();
    const credential = await key.register(
      { challenge, rp: { id: rpId } },
      origin,
      overrides,
    );
    const result = verifyRegistration(credential, expected);
    await expect(result).rejects.toThrow(WebAuthnError);
    await expect(result).rejects.toThrow(message);
  });

  it("refuses malformed client data and attestation objects", async (): Promise<void> => {
    const key = await SoftKey.create();
    const credential = await key.register(
      { challenge, rp: { id: rpId } },
      origin,
    );
    const bad = (patch: Partial<typeof credential.response>) =>
      verifyRegistration(
        { ...credential, response: { ...credential.response, ...patch } },
        expected,
      );
    await expect(bad({ clientDataJSON: utf8("{") })).rejects.toThrow(
      "Invalid client data.",
    );
    await expect(bad({ clientDataJSON: utf8("null") })).rejects.toThrow(
      "Invalid client data.",
    );
    const bound = {
      type: "webauthn.create",
      challenge,
      origin,
      tokenBinding: { status: "present" },
    };
    await expect(
      bad({ clientDataJSON: utf8(JSON.stringify(bound)) }),
    ).rejects.toThrow("Token binding");
    await expect(
      bad({ attestationObject: toBase64Url(encodeCbor([1])) }),
    ).rejects.toThrow(WebAuthnError);
    await expect(
      bad({
        attestationObject: toBase64Url(
          encodeCbor(new Map<CborInput, CborInput>([["fmt", "none"]])),
        ),
      }),
    ).rejects.toThrow(WebAuthnError);
  });

  it.each<{ name: string; entries: [CborInput, CborInput][] }>([
    { name: "unsupported algorithm", entries: [[3, -35]] },
    { name: "missing algorithm", entries: [[1, 2]] },
    { name: "algorithm without a key", entries: [[3, -7]] },
    { name: "ES256 with an OKP key", entries: [[1, 1], [3, -7]] },
    { name: "ES256 with the wrong curve", entries: [[1, 2], [3, -7], [-1, 2]] },
    {
      name: "ES256 with short x",
      entries: [[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(31)], [-3, new Uint8Array(32)]],
    },
    { name: "ES256 with missing y", entries: [[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)]] },
    {
      name: "ES256 with a point off the curve",
      entries: [[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]],
    },
    { name: "EdDSA with an EC2 key", entries: [[1, 2], [3, -8], [-1, 6]] },
    { name: "EdDSA with the wrong curve", entries: [[1, 1], [3, -8], [-1, 1]] },
    { name: "EdDSA with missing x", entries: [[1, 1], [3, -8], [-1, 6]] },
    { name: "EdDSA with short x", entries: [[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(31)]] },
    { name: "RS256 with an OKP key", entries: [[1, 1], [3, -257]] },
    { name: "RS256 with a missing modulus", entries: [[1, 3], [3, -257], [-2, Uint8Array.of(1, 0, 1)]] },
    {
      name: "RS256 with a 1024-bit modulus",
      entries: [[1, 3], [3, -257], [-1, new Uint8Array(128).fill(255)], [-2, Uint8Array.of(1, 0, 1)]],
    },
    {
      name: "RS256 with a padded short modulus",
      entries: [[1, 3], [3, -257], [-1, Uint8Array.from([0, ...new Uint8Array(255).fill(255)])], [-2, Uint8Array.of(1, 0, 1)]],
    },
    {
      name: "RS256 with a 2047-bit modulus",
      entries: [[1, 3], [3, -257], [-1, Uint8Array.from([127, ...new Uint8Array(255).fill(255)])], [-2, Uint8Array.of(1, 0, 1)]],
    },
    {
      name: "RS256 with an empty exponent",
      entries: [[1, 3], [3, -257], [-1, new Uint8Array(256).fill(255)], [-2, new Uint8Array()]],
    },
  ])("refuses $name", async ({ entries }): Promise<void> => {
    const attest = async (
      cose: Map<CborInput, CborInput>,
    ): Promise<unknown> => {
      const header = new Uint8Array(37);
      header.set(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
        ),
      );
      header[32] = UP | UV | AT;
      const authData = Uint8Array.from([
        ...header,
        ...new Uint8Array(16),
        0,
        1,
        7,
        ...encodeCbor(cose),
      ]);
      const attestation = encodeCbor(
        new Map<CborInput, CborInput>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      const clientData = { type: "webauthn.create", challenge, origin };
      return verifyRegistration(
        {
          id: toBase64Url(Uint8Array.of(7)),
          response: {
            clientDataJSON: utf8(JSON.stringify(clientData)),
            attestationObject: toBase64Url(attestation),
          },
        },
        expected,
      );
    };
    await expect(attest(new Map<CborInput, CborInput>(entries))).rejects.toThrow(WebAuthnError);
  });
});

describe("authentication", (): void => {
  it.each(["es256", "ed25519", "rs256"] as const)(
    "verifies a %s assertion and returns the counter",
    async (kind) => {
      const { key, publicKey } = await registered(kind);
      const assertion = await key.assert({ challenge, rpId }, origin);
      expect(
        await verifyAuthentication(assertion, expected, {
          publicKey,
          counter: 0,
        }),
      ).toEqual({ counter: 1 });
    },
  );

  it("allows keys without a counter but refuses a counter that does not grow", async (): Promise<void> => {
    const { key, publicKey } = await registered();
    key.counting = false;
    const still = await key.assert({ challenge, rpId }, origin);
    expect(
      await verifyAuthentication(still, expected, { publicKey, counter: 0 }),
    ).toEqual({ counter: 0 });
    const replayed = await key.assert({ challenge, rpId }, origin, {
      counter: 4,
    });
    await expect(
      verifyAuthentication(replayed, expected, { publicKey, counter: 4 }),
    ).rejects.toThrow(/counter/);
    await expect(
      verifyAuthentication(still, expected, { publicKey, counter: 3 }),
    ).rejects.toThrow(/counter/);
  });

  it.each([
    [{ type: "webauthn.create" }, /type/],
    [{ origin: "https://stream.example.test.evil.example" }, /origin/],
    [{ crossOrigin: true }, "Cross-origin requests are not allowed."],
    [{ rpId: "example.test" }, /RP ID/],
    [{ flags: UP }, /verification/],
    [{ flags: UV }, /not present/],
    [{ corruptSignature: true }, "The signature is not valid."],
  ])("refuses %o", async (overrides, message): Promise<void> => {
    const { key, publicKey } = await registered();
    const assertion = await key.assert({ challenge, rpId }, origin, overrides);
    const result = verifyAuthentication(assertion, expected, {
      publicKey,
      counter: 0,
    });
    await expect(result).rejects.toThrow(WebAuthnError);
    await expect(result).rejects.toThrow(message);
  });

  it.each(["es256", "ed25519", "rs256"] as const)(
    "refuses a signature from another %s key",
    async (kind) => {
      const { publicKey } = await registered(kind);
      const other = await SoftKey.create(kind);
      const assertion = await other.assert({ challenge, rpId }, origin);
      const result = verifyAuthentication(assertion, expected, {
        publicKey,
        counter: 0,
      });
      await expect(result).rejects.toThrow(WebAuthnError);
      await expect(result).rejects.toThrow("The signature is not valid.");
    },
  );

  it("refuses an assertion signed over another challenge", async (): Promise<void> => {
    const { key, publicKey } = await registered();
    const other = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const assertion = await key.assert({ challenge: other, rpId }, origin);
    await expect(
      verifyAuthentication(assertion, expected, { publicKey, counter: 0 }),
    ).rejects.toThrow(/challenge/);
  });

  it.each(["ed25519", "rs256"] as const)(
    "refuses a corrupted %s signature",
    async (kind) => {
      const { key, publicKey } = await registered(kind);
      const assertion = await key.assert({ challenge, rpId }, origin, {
        corruptSignature: true,
      });
      await expect(
        verifyAuthentication(assertion, expected, { publicKey, counter: 0 }),
      ).rejects.toThrow("The signature is not valid.");
    },
  );

  it.each([
    ["the counter", (bytes: Uint8Array): void => void (bytes[36] += 1)],
    ["a flag", (bytes: Uint8Array): void => void (bytes[32] |= 0x08)],
  ])(
    "refuses authenticator data with %s changed after signing",
    async (_name, change): Promise<void> => {
      const { key, publicKey } = await registered();
      const assertion = await key.assert({ challenge, rpId }, origin);
      const bytes = fromBase64Url(assertion.response.authenticatorData);
      change(bytes);
      const tampered = {
        ...assertion,
        response: {
          ...assertion.response,
          authenticatorData: toBase64Url(bytes),
        },
      };
      await expect(
        verifyAuthentication(tampered, expected, { publicKey, counter: 0 }),
      ).rejects.toThrow("The signature is not valid.");
    },
  );
});

describe("malformed input (security review finding 8)", (): void => {
  it("refuses an assertion with malformed extension data with a WebAuthnError", async (): Promise<void> => {
    const { key, publicKey } = await registered();
    const assertion = await key.assert({ challenge, rpId }, origin);
    const bytes = fromBase64Url(assertion.response.authenticatorData);
    const out = new Uint8Array(bytes.length + 2);
    out.set(bytes);
    out[32] |= 0x80;
    out.set([0x61, 0xff], bytes.length);
    const response = {
      ...assertion.response,
      authenticatorData: toBase64Url(out),
    };
    await expect(
      verifyAuthentication({ ...assertion, response }, expected, {
        publicKey,
        counter: 0,
      }),
    ).rejects.toThrow(WebAuthnError);
  });

  it("turns any failure while reading a stored key into a WebAuthnError", async (): Promise<void> => {
    const { key } = await registered();
    const assertion = await key.assert({ challenge, rpId }, origin);
    await expect(
      verifyAuthentication(assertion, expected, {
        publicKey: "!not base64!",
        counter: 0,
      }),
    ).rejects.toThrow(WebAuthnError);
    const rsa = encodeCbor(
      new Map<CborInput, CborInput>([
        [1, 3],
        [3, -257],
        [-1, new Uint8Array(256).fill(0xff)],
        [-2, new Uint8Array(0)],
      ]),
    );
    const refused = verifyAuthentication(assertion, expected, {
      publicKey: btoa(String.fromCodePoint(...rsa)),
      counter: 0,
    });
    await expect(refused).rejects.toThrow(WebAuthnError);
  });
});
