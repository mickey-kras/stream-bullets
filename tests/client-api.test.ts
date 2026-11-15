import { afterEach, describe, expect, it, vi } from "vitest";
import { adminRequest, webAuthnAvailable } from "../app/components/admin/webauthn";
import { ApiError, needsStepUp, postJson, requestJson } from "../app/components/api";
import { copyText } from "../app/lib/clipboard";

// Delete controls and Admin share `step_up_required`.
describe("client API errors", (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function respond(status: number, body: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => Response.json(body, { status })),
    );
  }

  it("keeps the server's code on a page request, so the delete dialog can ask for the key", async (): Promise<void> => {
    respond(403, { error: "Confirm with your security key to continue.", code: "step_up_required" });
    const error: unknown = await postJson("/api/comments", { action: "delete", id: "x" }).catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "step_up_required" });
    expect(needsStepUp(error)).toBe(true);
  });

  it("treats other failures as plain errors", async (): Promise<void> => {
    respond(403, { error: "Only the author or streamer can remove this comment." });
    const error: unknown = await postJson("/api/comments", {}).catch((value) => value);
    expect(error).toMatchObject({ message: "Only the author or streamer can remove this comment.", code: null });
    expect(needsStepUp(error)).toBe(false);
    expect(needsStepUp(new Error("step_up_required"))).toBe(false);
    respond(500, null);
    expect(await postJson("/api/comments", {}).catch((value) => value)).toMatchObject({ status: 500, code: null });
  });

  it("throws an ApiError, not a SyntaxError, when a body is not JSON", async (): Promise<void> => {
    const text = (status: number): void => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (): Promise<Response> => new Response("<html>Bad gateway</html>", { status })),
      );
    };
    text(502);
    expect(await requestJson("/api/me").catch((value) => value)).toMatchObject({ status: 502, code: null });
    text(200);
    const error: unknown = await adminRequest("/api/admin/streamers").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: null });
  });

  it("gives admin requests the same error type", async (): Promise<void> => {
    respond(403, { error: "Confirm with your security key to continue.", code: "step_up_required" });
    const error: unknown = await adminRequest("/api/admin/streamers").catch((value) => value);
    expect(needsStepUp(error)).toBe(true);
  });
});


describe("WebAuthn availability", (): void => {
  afterEach((): void => { vi.unstubAllGlobals(); });

  it("requires both a browser window and a credential constructor", (): void => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("PublicKeyCredential", class {});
    expect(webAuthnAvailable()).toBe(false);
    vi.stubGlobal("window", {});
    expect(webAuthnAvailable()).toBe(true);
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(webAuthnAvailable()).toBe(false);
  });
});

describe("copyText", (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it("reports whether the text reached the clipboard", async (): Promise<void> => {
    const writeText = vi.fn(async (): Promise<void> => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("https://streambullets.test/@zed")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://streambullets.test/@zed");
    writeText.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    expect(await copyText("x")).toBe(false);
    // Insecure origins have no clipboard.
    vi.stubGlobal("navigator", {});
    expect(await copyText("x")).toBe(false);
  });
});
