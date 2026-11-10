import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppEnv } from "../app/env";
import {
  HttpError,
  errorResponse,
  getOrigin,
  queryParams,
  readBody,
  readJson,
  requireSameOrigin,
  securityHeaders,
} from "../app/server/http.server";

const env = { APP_ORIGIN: "https://streambullets.test" } as AppEnv;

describe("request boundaries", () => {
  it.each([
    "javascript:alert(1)",
    "http://example.com",
    "https://example.com/path",
    "https://example.com/",
    "https://user:pass@example.com",
  ])("rejects unsafe configured origins: %s", (origin: string) => {
    expect(() => getOrigin({ ...env, APP_ORIGIN: origin })).toThrow(HttpError);
  });
  it("accepts exact production origin and local HTTP", () => {
    expect(getOrigin(env)).toBe("https://streambullets.test");
    expect(getOrigin({ ...env, APP_ORIGIN: "http://localhost:5173" })).toBe("http://localhost:5173");
  });
  it.each([undefined, "null", "https://attacker.test", "https://streambullets.test.attacker.test"])(
    "rejects foreign or absent write origins: %s",
    (origin: string | undefined) => {
      expect(() =>
        requireSameOrigin(new Request(env.APP_ORIGIN, { headers: origin ? { Origin: origin } : {} }), env),
      ).toThrow(HttpError);
    },
  );
  it("accepts a same-origin write and rejects contradictory fetch metadata", () => {
    expect(() =>
      requireSameOrigin(new Request(env.APP_ORIGIN, { headers: { Origin: env.APP_ORIGIN } }), env),
    ).not.toThrow();
    expect(() =>
      requireSameOrigin(
        new Request(env.APP_ORIGIN, { headers: { Origin: env.APP_ORIGIN, "Sec-Fetch-Site": "cross-site" } }),
        env,
      ),
    ).toThrow(HttpError);
  });
  it("bounds streamed bodies without trusting Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const request = new Request(env.APP_ORIGIN, { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(readBody(request, 10)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects invalid declared lengths and missing bodies", async () => {
    await expect(
      readBody(new Request(env.APP_ORIGIN, { method: "POST", headers: { "Content-Length": "100" }, body: "x" }), 5),
    ).rejects.toMatchObject({ status: 413 });
    await expect(readBody(new Request(env.APP_ORIGIN), 5)).rejects.toMatchObject({ status: 400 });
  });
  it("validates JSON encoding, content type, and schema", async () => {
    const schema = z.object({ name: z.string().min(1) }).strict();
    const request = (body: string, contentType = "application/json"): Request =>
      new Request(env.APP_ORIGIN, { method: "POST", body, headers: { "Content-Type": contentType } });
    await expect(readJson(request('{"name":"Misha"}'), schema)).resolves.toEqual({ name: "Misha" });
    await expect(readJson(request("bad"), schema)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request('{"name":"Misha","admin":true}'), schema)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request("{}", "text/plain"), schema)).rejects.toMatchObject({ status: 415 });
  });
  it("rejects repeated and unknown query fields", () => {
    expect(() => queryParams(new Request(`${env.APP_ORIGIN}/?sort=top&sort=newest`), ["sort"])).toThrow(HttpError);
    expect(() => queryParams(new Request(`${env.APP_ORIGIN}/?admin=true`), ["sort"])).toThrow(HttpError);
    expect(queryParams(new Request(`${env.APP_ORIGIN}/?sort=top`), ["sort"]).get("sort")).toBe("top");
  });
  it("sets production CSP and transport headers without unsafe script execution", () => {
    const response = securityHeaders(
      new Response("ok"),
      new Request(env.APP_ORIGIN),
      "nonce-value",
      env.APP_ORIGIN,
      false,
    );
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-nonce-value';");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-eval");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns typed retry errors and hides unexpected failure details", async () => {
    const limited = errorResponse(new HttpError(429, "Wait."));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    const unexpected = errorResponse(new Error("private provider details"));
    expect(unexpected.status).toBe(500);
    expect(await unexpected.text()).not.toContain("private provider details");
  });
});
