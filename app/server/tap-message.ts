import { MASH_MAX_BATCH } from "../lib/mash";

export const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 256;

export interface TapMessage {
  t: "tap";
  id: string;
  n: number;
  assisted: boolean;
  seq: number;
}

/** Reads one tap message from a room socket. Returns null for anything else. */
export function tapMessage(raw: string | ArrayBuffer): TapMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { t, id, n, assisted, seq } = value as Record<string, unknown>;
  if (
    t !== "tap" ||
    typeof id !== "string" ||
    !ENTRY_ID.test(id) ||
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    typeof assisted !== "boolean" ||
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0
  )
    return null;
  // Cap reconnect backlogs per message; the token bucket decides accepted taps.
  return { t, id, n: Math.min(n, MASH_MAX_BATCH), assisted, seq };
}
