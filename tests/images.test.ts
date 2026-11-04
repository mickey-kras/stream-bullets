import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveImage, uploadImage, validateImage } from "../app/server/images.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import type { AppEnv } from "../app/env";

const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
);

describe("uploaded image validation", () => {
  it("accepts a bounded PNG with matching MIME", () => {
    expect(validateImage(png, "image/png")).toBe("image/png");
  });
  it("rejects active documents, renamed images, and unsupported formats", () => {
    expect(() => validateImage(new TextEncoder().encode('<svg onload="alert(1)"></svg>'), "image/svg+xml")).toThrow();
    expect(() => validateImage(png, "image/jpeg")).toThrow();
    expect(() => validateImage(new TextEncoder().encode("<html>hello</html>"), "image/png")).toThrow();
  });
  it("rejects excessive upload size and dimensions", () => {
    expect(() => validateImage(new Uint8Array(5 * 1024 * 1024 + 1), "image/png")).toThrow();
    const huge = png.slice();
    new DataView(huge.buffer).setUint32(16, 20_000);
    expect(() => validateImage(huge, "image/png")).toThrow();
  });
});

describe("owned image storage", () => {
  let database: TestDatabase;
  let env: AppEnv;
  beforeEach(async () => {
    database = await createTestDatabase();
    env = { DB: database.db, IMAGES: database.bucket } as AppEnv;
    await env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)")
      .bind("viewer", "Viewer", "viewer@example.test", 1, 1)
      .run();
  });
  afterEach(async () => {
    await database.dispose();
  });
  const upload = (): Request =>
    new Request("https://streambullets.test/api/images/avatar", {
      method: "PUT",
      body: png,
      headers: { "Content-Type": "image/png" },
    });

  it("stores only the authenticated owner key and serves a passive image", async () => {
    expect(await uploadImage(upload(), env, "viewer", "avatar")).toBe("/images/avatar/viewer");
    expect(await env.DB.prepare("SELECT image FROM user WHERE id=?").bind("viewer").first("image")).toBe(
      "/images/avatar/viewer",
    );
    const response = await serveImage(env, "avatar/viewer", "GET");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect((await serveImage(env, "avatar/viewer", "HEAD")).body).toBeNull();
  });
  it("requires an opt-in streamer profile before storing a background", async () => {
    await expect(uploadImage(upload(), env, "viewer", "background")).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), "viewer", "viewer", "Viewer")
      .run();
    expect(await uploadImage(upload(), env, "viewer", "background")).toBe("/images/background/viewer");
    expect(
      await env.DB.prepare("SELECT background FROM streamers WHERE owner_id=?").bind("viewer").first("background"),
    ).toBe("/images/background/viewer");
  });
  it("stops serving images that no live account or page references, even if R2 still has them", async () => {
    await env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), "viewer", "viewer", "Viewer")
      .run();
    await uploadImage(upload(), env, "viewer", "avatar");
    await uploadImage(upload(), env, "viewer", "background");
    expect((await serveImage(env, "background/viewer", "GET")).status).toBe(200);
    // Simulate an account deletion whose R2 cleanup failed: the rows are gone, the objects remain.
    await env.DB.prepare("DELETE FROM user WHERE id=?").bind("viewer").run();
    expect(await env.IMAGES.head("avatar/viewer")).not.toBeNull();
    expect(await env.IMAGES.head("background/viewer")).not.toBeNull();
    await expect(serveImage(env, "avatar/viewer", "GET")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "background/viewer", "GET")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects path traversal, unsupported slots, and absent objects", async () => {
    await expect(uploadImage(upload(), env, "viewer", "other")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "../avatar/viewer", "GET")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "avatar/missing", "GET")).rejects.toMatchObject({ status: 404 });
  });
});
