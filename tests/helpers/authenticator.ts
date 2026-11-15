import { toBase64Url } from "../../app/server/webauthn.server";

// Software FIDO2 authenticator using genuine Web Crypto attestation and assertion bytes.

export type CborInput = number | string | Uint8Array | CborInput[] | Map<CborInput, CborInput> | boolean | null;

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 0x100) return [(major << 5) | 24, value];
  if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
  return [(major << 5) | 26, (value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function encodeCbor(value: CborInput): Uint8Array {
  const parts: number[] = [];
  const write = (item: CborInput): void => {
    if (item === false) parts.push(0xf4);
    else if (item === true) parts.push(0xf5);
    else if (item === null) parts.push(0xf6);
    else if (typeof item === "number") parts.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    else if (typeof item === "string") {
      const bytes = new TextEncoder().encode(item);
      parts.push(...head(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) parts.push(...head(2, item.length), ...item);
    else if (Array.isArray(item)) {
      parts.push(...head(4, item.length));
      for (const entry of item) write(entry);
    } else {
      parts.push(...head(5, item.size));
      for (const [key, entry] of item) {
        write(key);
        write(entry);
      }
    }
  };
  write(value);
  return Uint8Array.from(parts);
}

function bytesOf(value: string): Uint8Array {
  const text = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4));
  return Uint8Array.from(text, (character: string): number => character.codePointAt(0)!);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const body = trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
  return concat(Uint8Array.of(0x02, body.length), body);
}

export function rawToDer(raw: Uint8Array): Uint8Array {
  const body = concat(derInteger(raw.subarray(0, 32)), derInteger(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export type KeyKind = "es256" | "ed25519" | "rs256";

export interface Overrides {
  type?: string;
  origin?: string;
  challenge?: string;
  rpId?: string;
  flags?: number;
  counter?: number;
  crossOrigin?: boolean;
  corruptSignature?: boolean;
  fmt?: string;
}

export const UP = 0x01;
export const UV = 0x04;
export const AT = 0x40;

export class SoftKey {
  readonly credentialId: Uint8Array = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  // Increment each assertion unless the key has no counter.
  counting = true;

  private constructor(
    readonly kind: KeyKind,
    private readonly keys: CryptoKeyPair,
  ) {}

  static async create(kind: KeyKind = "es256"): Promise<SoftKey> {
    const algorithm =
      kind === "es256"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : kind === "ed25519"
          ? { name: "Ed25519" }
          : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" };
    const keys = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
    return new SoftKey(kind, keys);
  }

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  async cose(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    if (this.kind === "es256")
      return encodeCbor(
        new Map<CborInput, CborInput>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, bytesOf(jwk.x!)],
          [-3, bytesOf(jwk.y!)],
        ]),
      );
    if (this.kind === "ed25519")
      return encodeCbor(
        new Map<CborInput, CborInput>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, bytesOf(jwk.x!)],
        ]),
      );
    return encodeCbor(
      new Map<CborInput, CborInput>([
        [1, 3],
        [3, -257],
        [-1, bytesOf(jwk.n!)],
        [-2, bytesOf(jwk.e!)],
      ]),
    );
  }

  private clientData(type: string, challenge: string, origin: string, overrides: Overrides): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        type: overrides.type ?? type,
        challenge: overrides.challenge ?? challenge,
        origin: overrides.origin ?? origin,
        crossOrigin: overrides.crossOrigin ?? false,
      }),
    );
  }

  private async authData(rpId: string, flags: number, counter: number, attested?: Uint8Array): Promise<Uint8Array> {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    return concat(
      await sha256(new TextEncoder().encode(rpId)),
      Uint8Array.of(flags),
      count,
      attested ?? new Uint8Array(),
    );
  }

  async register(
    options: { challenge: string; rp: { id: string } },
    origin: string,
    overrides: Overrides = {},
  ): Promise<{ id: string; response: { clientDataJSON: string; attestationObject: string; transports: string[] } }> {
    const id = this.credentialId;
    const attested = concat(new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 0xff), id, await this.cose());
    const authData = await this.authData(
      overrides.rpId ?? options.rp.id,
      overrides.flags ?? UP | UV | AT,
      overrides.counter ?? this.counter,
      attested,
    );
    const attestation = encodeCbor(
      new Map<CborInput, CborInput>([
        ["fmt", overrides.fmt ?? "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      response: {
        clientDataJSON: toBase64Url(this.clientData("webauthn.create", options.challenge, origin, overrides)),
        attestationObject: toBase64Url(attestation),
        transports: ["usb", "nfc"],
      },
    };
  }

  async assert(
    options: { challenge: string; rpId: string },
    origin: string,
    overrides: Overrides = {},
  ): Promise<{ id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } }> {
    if (this.counting) this.counter += 1;
    const clientData = this.clientData("webauthn.get", options.challenge, origin, overrides);
    const authData = await this.authData(
      overrides.rpId ?? options.rpId,
      overrides.flags ?? UP | UV,
      overrides.counter ?? this.counter,
    );
    const signed = concat(authData, await sha256(Uint8Array.from(clientData)));
    const params =
      this.kind === "es256" ? { name: "ECDSA", hash: "SHA-256" } : { name: this.keys.privateKey.algorithm.name };
    let signature = new Uint8Array(await crypto.subtle.sign(params, this.keys.privateKey, signed));
    if (this.kind === "es256") signature = Uint8Array.from(rawToDer(signature));
    if (overrides.corruptSignature) signature[signature.length - 1] ^= 1;
    return {
      id: this.id,
      response: {
        clientDataJSON: toBase64Url(clientData),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(signature),
      },
    };
  }
}
