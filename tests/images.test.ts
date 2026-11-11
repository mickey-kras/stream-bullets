import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAvatar,
  deleteImageObjects,
  deleteLogo,
  imageStorageKey,
  serveImage,
  uploadImage,
  validateImage,
} from "../app/server/images.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";
import type { AppEnv } from "../app/env";

const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
);

const redPng = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"),
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
    const bucket = {
      get: database.bucket.get.bind(database.bucket),
      put: database.bucket.put.bind(database.bucket),
      delete: database.bucket.delete.bind(database.bucket),
      head: database.bucket.head.bind(database.bucket),
      list: database.bucket.list.bind(database.bucket),
    } as R2Bucket;
    const db = {
      prepare: database.db.prepare.bind(database.db),
      batch: database.db.batch.bind(database.db),
    } as D1Database;
    env = { DB: db, IMAGES: bucket, APP_ORIGIN: "https://streambullets.test" } as AppEnv;
    await env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)")
      .bind("viewer", "Viewer", "viewer@example.test", 1, 1)
      .run();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
  function imageCache(): Pick<Cache, "match" | "put"> {
    const entries = new Map<string, Response>();
    return {
      match: vi.fn(async (key: RequestInfo | URL): Promise<Response | undefined> => entries.get(String(key))?.clone()),
      put: vi.fn(async (key: RequestInfo | URL, response: Response): Promise<void> => {
        entries.set(String(key), response.clone());
      }),
    };
  }

  it("shares cached bodies between GET and HEAD while checking live references on every read", async () => {
    const cache = imageCache();
    await uploadImage(upload(), env, "viewer", "avatar");
    const get = vi.spyOn(env.IMAGES, "get");
    const first = await serveImage(env, "avatar/viewer", "HEAD", cache);
    expect(first.body).toBeNull();
    const second = await serveImage(env, "avatar/viewer", "GET", cache);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png);
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(get).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    await deleteAvatar(env, "viewer");
    await expect(serveImage(env, "avatar/viewer", "GET", cache)).rejects.toMatchObject({ status: 404 });
    expect(cache.match).toHaveBeenCalledTimes(2);
  });

  it("uses a new cache key after replacement, including a late write of the previous body", async () => {
    const cache = imageCache();
    await uploadImage(upload(), env, "viewer", "avatar");
    const put = cache.put.bind(cache);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      vi.spyOn(cache, "put").mockImplementationOnce(async (key, response) => {
        resolve();
        await held;
        await put(key, response);
      });
    });
    const old = serveImage(env, "avatar/viewer", "GET", cache);
    await writing;
    await uploadImage(new Request(upload(), { body: redPng }), env, "viewer", "avatar");
    const replacement = await serveImage(env, "avatar/viewer", "GET", cache);
    const replacementTag = replacement.headers.get("ETag");
    expect(new Uint8Array(await replacement.arrayBuffer())).toEqual(redPng);
    release?.();
    expect((await old).headers.get("ETag")).not.toBe(replacementTag);
    const get = vi.spyOn(env.IMAGES, "get");
    const latest = await serveImage(env, "avatar/viewer", "GET", cache);
    expect(latest.headers.get("ETag")).toBe(replacementTag);
    expect(get).not.toHaveBeenCalled();
    const keys = vi.mocked(cache.put).mock.calls.map(([key]) => String(key));
    expect(new Set(keys).size).toBe(2);
  });

  it("revokes cached page images and old account images even when storage cleanup fails", async () => {
    const cache = imageCache();
    await env.DB.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','viewer','viewer','Viewer')",
    ).run();
    for (const kind of ["logo", "background", "avatar"]) {
      await uploadImage(upload(), env, "viewer", kind);
      await serveImage(env, `${kind}/viewer`, "GET", cache);
    }
    vi.spyOn(env.IMAGES, "delete").mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(deleteLogo(env, "viewer")).rejects.toThrow("Storage unavailable");
    await expect(serveImage(env, "logo/viewer", "GET", cache)).rejects.toMatchObject({ status: 404 });
    await env.DB.prepare("DELETE FROM user WHERE id='viewer'").run();
    for (const kind of ["background", "avatar"]) {
      await expect(serveImage(env, `${kind}/viewer`, "GET", cache)).rejects.toMatchObject({ status: 404 });
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_versions").first("n")).toBe(0);
  });

  it("falls back to storage on cache expiry and cache errors without caching a failure", async () => {
    const cache = imageCache();
    await uploadImage(upload(), env, "viewer", "avatar");
    await serveImage(env, "avatar/viewer", "GET", cache);
    const get = vi.spyOn(env.IMAGES, "get");
    vi.mocked(cache.match).mockResolvedValueOnce(undefined);
    await serveImage(env, "avatar/viewer", "GET", cache);
    expect(get).toHaveBeenCalledTimes(1);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(cache.match).mockRejectedValueOnce(new Error("Cache unavailable"));
    vi.mocked(cache.put).mockRejectedValueOnce(new Error("Cache unavailable"));
    expect((await serveImage(env, "avatar/viewer", "GET", cache)).status).toBe(200);
    expect(log).toHaveBeenCalledTimes(2);
    vi.stubGlobal("caches", { open: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    expect((await serveImage(env, "avatar/viewer", "GET")).status).toBe(200);
    vi.mocked(cache.match).mockResolvedValueOnce(undefined);
    get.mockRejectedValueOnce(new Error("Storage unavailable"));
    const writes = vi.mocked(cache.put).mock.calls.length;
    await expect(serveImage(env, "avatar/viewer", "GET", cache)).rejects.toThrow("Storage unavailable");
    expect(cache.put).toHaveBeenCalledTimes(writes);
    vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
      throw new Error("Database unavailable");
    });
    await expect(serveImage(env, "avatar/viewer", "GET", cache)).rejects.toThrow("Database unavailable");
  });

  it("keeps the published version after a failed replacement", async () => {
    const cache = imageCache();
    await uploadImage(upload(), env, "viewer", "avatar");
    await serveImage(env, "avatar/viewer", "GET", cache);
    vi.spyOn(env.IMAGES, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(uploadImage(upload(), env, "viewer", "avatar")).rejects.toThrow("Storage unavailable");
    const get = vi.spyOn(env.IMAGES, "get");
    expect((await serveImage(env, "avatar/viewer", "GET", cache)).status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(cache.match).toHaveBeenCalledTimes(2);
  });

  it("keeps one published body across caches when an overlapping upload fails after its R2 write", async () => {
    const cache = imageCache();
    const put = env.IMAGES.put.bind(env.IMAGES);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(env.IMAGES, "put").mockImplementationOnce(async (...args) => {
      reached?.();
      await held;
      return put(...args);
    });
    const first = uploadImage(new Request(upload(), { body: redPng }), env, "viewer", "avatar");
    await writing;
    await uploadImage(upload(), env, "viewer", "avatar");
    const published = await imageStorageKey(env, "viewer", "avatar");
    const warm = await serveImage(env, "avatar/viewer", "GET", cache);
    vi.spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("Publication failed"));
    release?.();
    await expect(first).rejects.toThrow("Publication failed");
    expect(await imageStorageKey(env, "viewer", "avatar")).toBe(published);
    const hit = await serveImage(env, "avatar/viewer", "GET", cache);
    const miss = await serveImage(env, "avatar/viewer", "GET", imageCache());
    expect(hit.headers.get("ETag")).toBe(warm.headers.get("ETag"));
    expect(miss.headers.get("ETag")).toBe(warm.headers.get("ETag"));
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(png);
    expect(new Uint8Array(await miss.arrayBuffer())).toEqual(png);
    expect((await env.IMAGES.list({ prefix: "avatar/viewer/" })).objects).toHaveLength(2);
    await deleteImageObjects(env, "viewer", "avatar");
    expect((await env.IMAGES.list({ prefix: "avatar/viewer/" })).objects).toEqual([]);
  });

  it("deletes every stored version through paginated cleanup without crossing owner prefixes", async () => {
    for (const key of ["avatar/viewer", "avatar/viewer/one", "avatar/viewer/two", "avatar/viewer_extra/one"]) {
      await env.IMAGES.put(key, png);
    }
    const list = vi
      .spyOn(env.IMAGES, "list")
      .mockImplementation((options) => database.bucket.list({ ...options, limit: 1 }));
    await deleteImageObjects(env, "viewer", "avatar");
    expect(list).toHaveBeenCalledTimes(2);
    expect(await env.IMAGES.head("avatar/viewer")).toBeNull();
    expect((await database.bucket.list({ prefix: "avatar/viewer/" })).objects).toEqual([]);
    expect(await env.IMAGES.head("avatar/viewer_extra/one")).not.toBeNull();
  });

  it("publishes the replacement when previous-object cleanup fails and reports the cleanup error", async () => {
    await uploadImage(upload(), env, "viewer", "avatar");
    const previous = await imageStorageKey(env, "viewer", "avatar");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env.IMAGES, "delete").mockRejectedValueOnce(new Error("Private storage details"));
    await uploadImage(new Request(upload(), { body: redPng }), env, "viewer", "avatar");
    expect(new Uint8Array(await (await serveImage(env, "avatar/viewer", "GET")).arrayBuffer())).toEqual(redPng);
    expect(await env.IMAGES.head(previous)).not.toBeNull();
    expect(log.mock.calls).toEqual([["Previous image cleanup failed.", { cause: "Error" }]]);
  });

  it("does not delete a replacement published while a slot removal cleans up its previous object", async () => {
    await uploadImage(upload(), env, "viewer", "avatar");
    const remove = env.IMAGES.delete.bind(env.IMAGES);
    vi.spyOn(env.IMAGES, "delete").mockImplementationOnce(async (keys) => {
      await uploadImage(new Request(upload(), { body: redPng }), env, "viewer", "avatar");
      await remove(keys);
    });
    await deleteAvatar(env, "viewer");
    expect(new Uint8Array(await (await serveImage(env, "avatar/viewer", "GET")).arrayBuffer())).toEqual(redPng);
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
    const avatarKey = await imageStorageKey(env, "viewer", "avatar");
    const backgroundKey = await imageStorageKey(env, "viewer", "background");
    // Simulate an account deletion whose R2 cleanup failed: the rows are gone, the objects remain.
    await env.DB.prepare("DELETE FROM user WHERE id=?").bind("viewer").run();
    expect(await env.IMAGES.head(avatarKey)).not.toBeNull();
    expect(await env.IMAGES.head(backgroundKey)).not.toBeNull();
    await expect(serveImage(env, "avatar/viewer", "GET")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "background/viewer", "GET")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects path traversal, unsupported slots, and absent objects", async () => {
    await expect(uploadImage(upload(), env, "viewer", "other")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "../avatar/viewer", "GET")).rejects.toMatchObject({ status: 404 });
    await expect(serveImage(env, "avatar/missing", "GET")).rejects.toMatchObject({ status: 404 });
  });
});
