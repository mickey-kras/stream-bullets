import { ORIENTATIONS, type Orientation } from "../lib/overlay-layers";
import type { OverlayPublic } from "../types";

// Worker-vouched account, opening time, and lease expiry.
export interface ConnectionLease {
  expiresAt: number;
  userId: string | null;
  openedAt: number;
}

// The lease that the room attached to a socket. A missing or malformed lease is one that already ended.
export function leaseOf(socket: WebSocket): ConnectionLease {
  const lease: unknown = socket.deserializeAttachment();
  if (
    typeof lease !== "object" ||
    lease === null ||
    !("expiresAt" in lease) ||
    typeof lease.expiresAt !== "number" ||
    !Number.isSafeInteger(lease.expiresAt)
  )
    return { expiresAt: 0, userId: null, openedAt: 0 };
  const userId = "userId" in lease && typeof lease.userId === "string" ? lease.userId : null;
  const openedAt = "openedAt" in lease && typeof lease.openedAt === "number" ? lease.openedAt : 0;
  return { expiresAt: lease.expiresAt, userId, openedAt };
}

// The socket that opened first, or null for none.
export function oldest(sockets: readonly WebSocket[], openedAt: (socket: WebSocket) => number): WebSocket | null {
  let found: WebSocket | null = null;
  for (const socket of sockets) if (found === null || openedAt(socket) < openedAt(found)) found = socket;
  return found;
}

const SEEN_KEY = "overlaySeenAt";
const OUTPUT_SEEN_KEYS: Readonly<Record<Orientation, string>> = {
  horizontal: "overlaySeenAt:horizontal",
  vertical: "overlaySeenAt:vertical",
};

/** The output of the overlay key in the `X-SB-Overlay` header of the Worker. Null: the request has no valid key. */
export function overlayOutput(header: string | null): Orientation | null {
  return ORIENTATIONS.find((output: Orientation): boolean => output === header) ?? null;
}

/** The output in the JSON body `{output}` of a request between the Worker and an object. Null: none or invalid. */
export async function outputInBody(request: Request): Promise<Orientation | null> {
  const body: unknown = await request.json().catch((): null => null);
  const output: unknown = typeof body === "object" && body !== null && "output" in body ? body.output : null;
  return typeof output === "string" ? overlayOutput(output) : null;
}

/** The tag of the sockets of one output. A socket from before the two outputs has no such tag and is horizontal. */
export function outputTag(output: Orientation): string {
  return `output:${output}`;
}

/** The output of an OBS socket from its tags. */
export function outputOf(tags: readonly string[]): Orientation {
  return tags.includes(outputTag("vertical")) ? "vertical" : "horizontal";
}

interface SeenTimes {
  all: number | null;
  outputs: Record<Orientation, number | null>;
}

/**
 * When an OBS source of the page last connected or went away, for the page and for each output, kept in the storage
 * of the room. The times and the numbers of connected sources go to the owner in an `overlay` message: a page that
 * still runs an older script reads the overlay and ignores the rest. A message type that such a page does not know
 * would close its socket.
 */
export class OverlaySources {
  // Undefined before the first read of the stored values.
  private seen: SeenTimes | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  private async times(): Promise<SeenTimes> {
    if (this.seen) return this.seen;
    const stored: Map<string, number> = await this.storage.get<number>([
      SEEN_KEY,
      OUTPUT_SEEN_KEYS.horizontal,
      OUTPUT_SEEN_KEYS.vertical,
    ]);
    const all: number | null = stored.get(SEEN_KEY) ?? null;
    const vertical: number | null = stored.get(OUTPUT_SEEN_KEYS.vertical) ?? null;
    // A time from before the two outputs is the time of the horizontal output.
    const horizontal: number | null = stored.get(OUTPUT_SEEN_KEYS.horizontal) ?? (vertical === null ? all : null);
    this.seen = { all, outputs: { horizontal, vertical } };
    return this.seen;
  }

  async message(overlay: OverlayPublic, counts: Readonly<Record<Orientation, number>>): Promise<string> {
    const seen: SeenTimes = await this.times();
    const outputs = {
      horizontal: { count: counts.horizontal, seenAt: seen.outputs.horizontal },
      vertical: { count: counts.vertical, seenAt: seen.outputs.vertical },
    };
    const sources = { count: counts.horizontal + counts.vertical, seenAt: seen.all, outputs };
    return JSON.stringify({ type: "overlay", overlay, sources });
  }

  async touch(output: Orientation, now: number): Promise<void> {
    const seen: SeenTimes = await this.times();
    const outputs: Record<Orientation, number | null> = { ...seen.outputs, [output]: now };
    this.seen = { all: now, outputs };
    // Store each known time. Thus a horizontal time from before the two outputs stays with its output when a
    // vertical source replaces the time of the page.
    const stored: Record<string, number> = { [SEEN_KEY]: now };
    for (const name of ORIENTATIONS) {
      const at: number | null = outputs[name];
      if (at !== null) stored[OUTPUT_SEEN_KEYS[name]] = at;
    }
    await this.storage.put(stored);
  }

  async reset(): Promise<void> {
    this.seen = undefined;
    await this.storage.delete([SEEN_KEY, OUTPUT_SEEN_KEYS.horizontal, OUTPUT_SEEN_KEYS.vertical]);
  }
}
