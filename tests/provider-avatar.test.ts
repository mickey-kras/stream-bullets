import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import { allowedProviderPhoto, importProviderPhoto } from "../app/server/provider-avatar.server";
import { createTestDatabase } from "./helpers/database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: AppEnv;
beforeAll(async () => {
  database = await createTestDatabase();
  env = { DB: database.db, IMAGES: database.bucket, APP_ORIGIN: "https://stream.example.test" } as AppEnv;
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('photo-user','Viewer','photo@example.test',1,0,0)",
  ).run();
});
afterAll(async () => {
  await database.dispose();
});

describe("provider avatar import", () => {
  it.each([
    "http://lh3.googleusercontent.com/photo",
    "https://lh3.googleusercontent.com.attacker.test/photo",
    "https://lh3.googleusercontent.com@127.0.0.1/photo",
    "https://lh3.googleusercontent.com:444/photo",
    "not a URL",
  ])("rejects an unsafe source %s before fetching", async (source) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      await importProviderPhoto(env, "photo-user", source, "google");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
  it("requires the source host to match the provider", () => {
    expect(allowedProviderPhoto("https://static-cdn.jtvnw.net/photo", "twitch")).toBe(true);
    expect(allowedProviderPhoto("https://lh3.googleusercontent.com/photo", "twitch")).toBe(false);
  });
  it("imports a validated photo into local storage and rejects redirects and oversized content", async () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "image/png" } }))
      .mockRejectedValueOnce(new TypeError("redirect"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { "Content-Type": "image/png" } }),
      )
      .mockResolvedValueOnce(new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await importProviderPhoto(env, "photo-user", "https://lh3.googleusercontent.com/photo", "google");
      expect(await env.DB.prepare("SELECT image FROM user WHERE id='photo-user'").first()).toEqual({
        image: "/images/avatar/photo-user",
      });
      const initial = await env.DB.prepare("SELECT version FROM image_versions WHERE owner_id='photo-user'").first();
      for (let i = 0; i < 3; i++)
        await importProviderPhoto(env, "photo-user", "https://lh3.googleusercontent.com/photo", "google");
      expect(await env.DB.prepare("SELECT version FROM image_versions WHERE owner_id='photo-user'").first()).toEqual(
        initial,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://lh3.googleusercontent.com/photo",
        expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
      );
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      fetchMock.mockRestore();
      warn.mockRestore();
    }
  });
});
