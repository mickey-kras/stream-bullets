import { afterEach, describe, expect, it, vi } from "vitest";
import { detached } from "../app/lib/detached";

describe("detached", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the name of a rejection and does not leave it unhandled", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    detached(Promise.reject(new TypeError("private detail")));
    detached(Promise.reject(new Error("plain")));
    await Promise.resolve();
    await Promise.resolve();
    expect(log.mock.calls).toEqual([
      ["detached_task_failed", { cause: "TypeError" }],
      ["detached_task_failed", { cause: "Error" }],
    ]);
  });

  it("ignores finished work and work that returned nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    detached(undefined);
    detached(Promise.resolve("done"));
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();
  });
});
