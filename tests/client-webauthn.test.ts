import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRequest, ceremonyError, confirmWithKey, errorText, registerKey } from "../app/components/admin/webauthn";
import { ApiError } from "../app/components/api";
import { t } from "../app/i18n";

afterEach((): void => { vi.unstubAllGlobals(); });

const options = {
  challenge: "-_8",
  rpId: "example.test",
  rp: { id: "example.test", name: "Test" },
  user: { id: "AA", name: "admin", displayName: "Admin" },
  timeout: 60_000,
  userVerification: "required",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  attestation: "none",
  authenticatorSelection: { userVerification: "required" },
  allowCredentials: [{ type: "public-key", id: "AQ", transports: ["usb"] }],
  excludeCredentials: [{ type: "public-key", id: "Ag", transports: ["nfc"] }],
};

function mockFetch(result: unknown = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(options))
    .mockResolvedValueOnce(Response.json(result));
  vi.stubGlobal("fetch", request);
  return request;
}

describe("browser security-key encoding", (): void => {
  it.each([
    [[], ""],
    [[255], "_w"],
    [[251, 255], "-_8"],
    [[251, 255, 0], "-_8A"],
  ])("serializes assertion bytes %j without base64 padding", async (bytes: number[], encoded: string): Promise<void> => {
    const buffer: ArrayBuffer = new Uint8Array(bytes).buffer;
    const get = vi.fn().mockResolvedValue({
      id: "key-id",
      response: { clientDataJSON: buffer, authenticatorData: buffer, signature: buffer, userHandle: buffer },
    });
    vi.stubGlobal("navigator", { credentials: { get } });
    const request = mockFetch();
    await confirmWithKey();
    expect(get).toHaveBeenCalledWith({ publicKey: {
      challenge: new Uint8Array([251, 255]).buffer,
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: new Uint8Array([1]).buffer, transports: ["usb"] }],
    } });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({
      id: "key-id",
      response: { clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded },
    });
  });

  it("preserves a missing user handle", async (): Promise<void> => {
    const buffer = new ArrayBuffer(0);
    vi.stubGlobal("navigator", { credentials: { get: vi.fn().mockResolvedValue({
      id: "key-id", response: { clientDataJSON: buffer, authenticatorData: buffer, signature: buffer, userHandle: null },
    }) } });
    const request = mockFetch();
    await confirmWithKey();
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).response.userHandle).toBeNull();
  });

  it.each([true, false])("registers a credential with transport support %s", async (hasTransports: boolean): Promise<void> => {
    const key = { id: "key-id", name: "Desk key", transports: ["usb"] };
    const create = vi.fn().mockResolvedValue({ id: key.id, response: {
      clientDataJSON: new Uint8Array([255]).buffer,
      attestationObject: new Uint8Array([251, 255]).buffer,
      ...(hasTransports ? { getTransports: (): string[] => ["usb", "invalid transport", ...Array<string>(10).fill("nfc")] } : {}),
    } });
    vi.stubGlobal("navigator", { credentials: { create } });
    const request = mockFetch({ key });
    await expect(registerKey(key.name)).resolves.toEqual(key);
    expect(create).toHaveBeenCalledWith({ publicKey: {
      challenge: new Uint8Array([251, 255]).buffer,
      rp: options.rp,
      user: { ...options.user, id: new Uint8Array([0]).buffer },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: [{ type: "public-key", id: new Uint8Array([2]).buffer, transports: ["nfc"] }],
    } });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ name: key.name, credential: {
      id: key.id, response: {
        clientDataJSON: "_w", attestationObject: "-_8",
        transports: hasTransports ? ["usb", ...Array<string>(7).fill("nfc")] : [],
      },
    } });
  });

  it.each(["get", "create"])("does not submit a cancelled %s ceremony", async (method: string): Promise<void> => {
    vi.stubGlobal("navigator", { credentials: { [method]: vi.fn().mockResolvedValue(null) } });
    const request = mockFetch();
    await expect(method === "get" ? confirmWithKey() : registerKey("Desk key")).rejects.toThrow(t("keys.cancelled"));
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("browser security-key errors", (): void => {
  it.each([
    ["NotAllowedError", "keys.cancelled"], ["AbortError", "keys.cancelled"],
    ["InvalidStateError", "keys.alreadyRegistered"], ["SecurityError", "keys.wrongSite"],
    ["UnknownError", "keys.failed"],
  ] as const)("explains %s", (name, message): void => {
    expect(ceremonyError(new DOMException("", name))).toBe(t(message));
  });

  it("preserves API errors and gives unknown errors a fallback", (): void => {
    const error = new ApiError("Denied", 403, "step_up_required");
    expect(ceremonyError(error)).toBe("Denied");
    expect(ceremonyError(null)).toBe(t("keys.failed"));
    expect(errorText(new Error("Failed"))).toBe("Failed");
    expect(errorText(null)).toBe(t("admin.requestFailed"));
  });

  it("reports an HTTP error when the response is not JSON", async (): Promise<void> => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    await expect(adminRequest("/api/admin/keys")).rejects.toMatchObject({ status: 503, code: null });
  });
});
