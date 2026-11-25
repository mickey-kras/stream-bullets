import { describe, expect, it } from "vitest";
import { DEFAULT_LAYERS } from "../app/lib/overlay-layers";
import {
  keyOf,
  keyTags,
  outputInBody,
  outputOf,
  outputTag,
  overlayOutput,
  OverlaySources,
  socketKey,
  sourceOutput,
} from "../app/server/room-connections";
import type { OverlayPublic } from "../app/types";

// The outputs of the OBS sockets of a room, and the times that the room keeps for them.

const overlay: OverlayPublic = {
  showResults: true,
  message: "",
  messageStyle: "info",
  layers: DEFAULT_LAYERS,
  chatTestUntil: 0,
  revision: 4,
};

interface Seen {
  count: number;
  seenAt: number | null;
}
interface Message {
  type: string;
  overlay: OverlayPublic;
  sources: Seen & { outputs: { horizontal: Seen; vertical: Seen } };
}

/** The part of the storage of a room that the sources use, with a count of the reads. */
class Storage {
  readonly values = new Map<string, number>();
  reads = 0;

  get<T>(keys: string[]): Promise<Map<string, T>> {
    this.reads += 1;
    const found = new Map<string, T>();
    for (const key of keys) if (this.values.has(key)) found.set(key, this.values.get(key) as T);
    return Promise.resolve(found);
  }

  put(entries: Record<string, number>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
    return Promise.resolve();
  }

  delete(keys: string[]): Promise<number> {
    return Promise.resolve(keys.filter((key: string): boolean => this.values.delete(key)).length);
  }
}

function sourcesOn(storage: Storage): OverlaySources {
  return new OverlaySources(storage as unknown as DurableObjectStorage);
}

async function read(
  sources: OverlaySources,
  counts: { horizontal: number; vertical: number } = { horizontal: 0, vertical: 0 },
): Promise<Message["sources"]> {
  const message = JSON.parse(await sources.message(overlay, counts)) as Message;
  expect(message.type).toBe("overlay");
  expect(message.overlay).toEqual(overlay);
  return message.sources;
}

function request(body?: string): Request {
  return new Request("https://room.internal/overlay-key", { method: "POST", body });
}

describe("the output of an OBS socket", (): void => {
  it("reads the output that the Worker names for a valid key, and nothing else", (): void => {
    expect(overlayOutput("horizontal")).toBe("horizontal");
    expect(overlayOutput("vertical")).toBe("vertical");
    for (const header of [null, "", "1", "Vertical", "vertical ", "diagonal", "horizontal,vertical"])
      expect(overlayOutput(header), String(header)).toBeNull();
  });

  it("tags a socket with its output, and reads a socket without such a tag as horizontal", (): void => {
    expect(outputTag("horizontal")).toBe("output:horizontal");
    expect(outputTag("vertical")).toBe("output:vertical");
    expect(outputOf(["role:owner", "overlay-key", outputTag("vertical")])).toBe("vertical");
    expect(outputOf(["activity", "overlay-key", outputTag("horizontal")])).toBe("horizontal");
    // A socket that a room from before the two outputs accepted.
    expect(outputOf(["role:owner", "overlay-key"])).toBe("horizontal");
    expect(outputOf([])).toBe("horizontal");
  });

  it("reads the output of a notice from its JSON body", async (): Promise<void> => {
    expect(await outputInBody(request('{"output":"vertical"}'))).toBe("vertical");
    expect(await outputInBody(request('{"output":"horizontal","more":1}'))).toBe("horizontal");
    for (const body of [
      undefined,
      "",
      "{",
      "null",
      "[]",
      '"vertical"',
      "{}",
      '{"output":"diagonal"}',
      '{"output":1}',
      '{"output":null}',
    ])
      expect(await outputInBody(request(body)), String(body)).toBeNull();
  });
});

describe("the OBS sources of a page", (): void => {
  it("starts with no source and no time, and counts each output", async (): Promise<void> => {
    const sources: OverlaySources = sourcesOn(new Storage());
    const none: Seen = { count: 0, seenAt: null };
    expect(await read(sources)).toEqual({ ...none, outputs: { horizontal: none, vertical: none } });
    expect(await read(sources, { horizontal: 2, vertical: 1 })).toEqual({
      count: 3,
      seenAt: null,
      outputs: { horizontal: { count: 2, seenAt: null }, vertical: { count: 1, seenAt: null } },
    });
  });

  it("keeps a time for each output and the newest time for the page", async (): Promise<void> => {
    const storage = new Storage();
    const sources: OverlaySources = sourcesOn(storage);
    await sources.touch("vertical", 100);
    expect(await read(sources)).toMatchObject({
      seenAt: 100,
      outputs: { horizontal: { seenAt: null }, vertical: { seenAt: 100 } },
    });
    await sources.touch("horizontal", 250);
    expect(await read(sources)).toMatchObject({
      seenAt: 250,
      outputs: { horizontal: { seenAt: 250 }, vertical: { seenAt: 100 } },
    });
    expect(Object.fromEntries(storage.values)).toEqual({
      overlaySeenAt: 250,
      "overlaySeenAt:horizontal": 250,
      "overlaySeenAt:vertical": 100,
    });
    // The values are in memory after the first read.
    expect(storage.reads).toBe(1);
    // A room that starts again reads the stored times.
    expect(await read(sourcesOn(storage), { horizontal: 1, vertical: 0 })).toEqual({
      count: 1,
      seenAt: 250,
      outputs: { horizontal: { count: 1, seenAt: 250 }, vertical: { count: 0, seenAt: 100 } },
    });
  });

  it("reads a time from before the two outputs as the time of the horizontal output", async (): Promise<void> => {
    const storage = new Storage();
    storage.values.set("overlaySeenAt", 77);
    const sources: OverlaySources = sourcesOn(storage);
    expect(await read(sources)).toMatchObject({
      seenAt: 77,
      outputs: { horizontal: { seenAt: 77 }, vertical: { seenAt: null } },
    });
    // The first vertical source after that keeps the horizontal time, also when the room starts again.
    await sources.touch("vertical", 90);
    for (const current of [sources, sourcesOn(storage)])
      expect(await read(current)).toMatchObject({
        seenAt: 90,
        outputs: { horizontal: { seenAt: 77 }, vertical: { seenAt: 90 } },
      });
    expect(Object.fromEntries(storage.values)).toEqual({
      overlaySeenAt: 90,
      "overlaySeenAt:horizontal": 77,
      "overlaySeenAt:vertical": 90,
    });
  });

  it("does not give the time of the vertical output to the horizontal output", async (): Promise<void> => {
    // Only a vertical source connected since the two outputs: the page time is its time.
    const storage = new Storage();
    storage.values.set("overlaySeenAt", 90);
    storage.values.set("overlaySeenAt:vertical", 90);
    expect(await read(sourcesOn(storage))).toMatchObject({
      seenAt: 90,
      outputs: { horizontal: { seenAt: null }, vertical: { seenAt: 90 } },
    });
  });

  it("forgets each time on a reset", async (): Promise<void> => {
    const storage = new Storage();
    const sources: OverlaySources = sourcesOn(storage);
    await sources.touch("horizontal", 5);
    await sources.touch("vertical", 6);
    await sources.reset();
    expect(storage.values.size).toBe(0);
    expect(await read(sources)).toMatchObject({
      seenAt: null,
      outputs: { horizontal: { seenAt: null }, vertical: { seenAt: null } },
    });
  });
});

describe("the key of a socket", (): void => {
  const headers = (values: Record<string, string>): Headers => new Headers(values);

  it("reads the dock key and the overlay key of each output from the headers of the Worker", (): void => {
    expect(socketKey(headers({}))).toBeNull();
    expect(socketKey(headers({ "X-SB-Overlay": "vertical" }))).toBe("vertical");
    expect(socketKey(headers({ "X-SB-Overlay": "horizontal" }))).toBe("horizontal");
    expect(socketKey(headers({ "X-SB-Dock": "1" }))).toBe("dock");
    // Only the value that the Worker sets counts.
    expect(socketKey(headers({ "X-SB-Dock": "yes" }))).toBeNull();
    expect(socketKey(headers({ "X-SB-Overlay": "dock" }))).toBeNull();
  });

  it("gives a dock socket its own tag: it is never an OBS source", (): void => {
    expect(keyTags("dock")).toEqual(["dock-key"]);
    expect(keyTags("vertical")).toEqual(["overlay-key", "output:vertical"]);
    expect(keyOf(["role:owner", "dock-key"])).toBe("dock");
    expect(keyOf(["role:owner", "overlay-key", "output:vertical"])).toBe("vertical");
    // A socket from before the two outputs is a horizontal OBS source.
    expect(keyOf(["role:owner", "overlay-key"])).toBe("horizontal");
    // The signed-in owner has no key.
    expect(keyOf(["role:owner"])).toBeNull();
    expect(sourceOutput("dock")).toBeNull();
    expect(sourceOutput("vertical")).toBe("vertical");
    expect(sourceOutput(null)).toBeNull();
  });

  it("reads the key of a revocation from the body", async (): Promise<void> => {
    const request = (body: unknown): Request =>
      new Request("https://room.internal/overlay-key", { method: "POST", body: JSON.stringify(body) });
    expect(await outputInBody(request({ output: "dock" }))).toBe("dock");
    expect(await outputInBody(request({ output: "vertical" }))).toBe("vertical");
    expect(await outputInBody(request({ output: "other" }))).toBeNull();
    expect(await outputInBody(request({ output: 1 }))).toBeNull();
  });
});
