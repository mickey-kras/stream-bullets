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

/**
 * When an OBS source of the page last connected or went away, kept in the storage of the room. The time and the
 * number of connected sources go to the owner in an `overlay` message: a page that still runs an older script reads
 * the overlay and ignores the rest. A message type that such a page does not know would close its socket.
 */
export class OverlaySources {
  // Undefined before the first read of the stored value.
  private seenAt: number | null | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  async message(overlay: OverlayPublic, count: number): Promise<string> {
    this.seenAt ??= (await this.storage.get<number>(SEEN_KEY)) ?? null;
    return JSON.stringify({ type: "overlay", overlay, sources: { count, seenAt: this.seenAt } });
  }

  async touch(now: number): Promise<void> {
    this.seenAt = now;
    await this.storage.put(SEEN_KEY, now);
  }

  async reset(): Promise<void> {
    this.seenAt = undefined;
    await this.storage.delete(SEEN_KEY);
  }
}
