import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { MASH_PHASES, OVERLAY_MESSAGE_STYLES, OVERLAY_POSITIONS, OVERLAY_SIZES, OVERLAY_SOURCES } from "../../db/enums";
import type { LiveSnapshot, MashTick, OverlayPublic } from "../types";

const count = z.number().int().nonnegative();
const time = z.number().int().nullable();
const mashSchema = z.object({
  durationS: z.number().int().min(10).max(120),
  phase: z.enum(MASH_PHASES),
  startsAt: time,
  endsAt: time,
  winner: z.number().int().min(-1).max(3).nullable(),
  totals: z.array(count).max(4),
  players: count,
  assisted: count,
});
const overlaySchema = z.object({
  air: z.object({ type: z.enum(OVERLAY_SOURCES), ref: z.string().max(64).nullable() }),
  position: z.enum(OVERLAY_POSITIONS),
  size: z.enum(OVERLAY_SIZES),
  showResults: z.boolean(),
  message: z.string().max(120),
  messageStyle: z.enum(OVERLAY_MESSAGE_STYLES),
  revision: count,
});
const snapshotSchema = z.object({
  type: z.literal("snapshot"),
  revision: count,
  serverNow: count,
  polls: z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().max(160),
        kind: z.enum(["choice", "binary", "mash"]),
        options: z.array(z.string().max(80)).min(2).max(6),
        endsAt: z.number().int().nullable(),
        revealed: z.boolean(),
        counts: z.array(count).max(6).nullable(),
        total: count,
        mash: mashSchema.nullable().default(null),
      }),
    )
    .max(100),
  overlay: overlaySchema.nullable().optional(),
});
const tickSchema = z.object({
  type: z.literal("mash"),
  id: z.string().uuid(),
  phase: z.enum(MASH_PHASES),
  totals: z.array(count).max(4),
  left: count,
  endsAt: time,
  players: count,
  assisted: count,
  tps: count,
  serverNow: count,
});
const ackSchema = z.object({ type: z.literal("mash-ack"), id: z.string().uuid(), mine: count });
const deniedSchema = z.object({
  type: z.literal("mash-denied"),
  id: z.string().uuid(),
  reason: z.enum(["sign-in", "closed", "pick"]),
});
const overlayMessageSchema = z.object({ type: z.literal("overlay"), overlay: overlaySchema });

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";
export type MashDenial = z.infer<typeof deniedSchema>["reason"];

/** Live Mash Battle state shared by every component on the page: ticks, your accepted taps, refusals. */
export interface MashLive {
  ticks: Readonly<Record<string, MashTick>>;
  mine: Readonly<Record<string, number>>;
  denied: Readonly<Record<string, MashDenial>>;
  /** The start of the run `mine` and `denied` belong to, as the last snapshot showed it (null before a start). */
  runs: Readonly<Record<string, number | null>>;
}

const emptyMash: MashLive = { ticks: {}, mine: {}, denied: {}, runs: {} };
/** The client pings this often, so the room knows the socket is in use and does not close it as idle. */
const PING_INTERVAL_MS = 20_000;
let mashLive: MashLive = emptyMash;
let liveSocket: WebSocket | null = null;
const mashListeners = new Set<() => void>();

function setMashLive(change: (current: MashLive) => MashLive): void {
  const next: MashLive = change(mashLive);
  if (next === mashLive) return;
  mashLive = next;
  for (const listener of mashListeners) listener();
}

/**
 * Forgets your taps and refusals for a battle whose run changed in this snapshot (a restart sets it back to setup,
 * and a new start gives it a new start time), so "Your taps" never carries over from the last round.
 */
export function withSnapshotRuns(current: MashLive, snapshot: Pick<LiveSnapshot, "polls">): MashLive {
  let next: MashLive = current;
  for (const poll of snapshot.polls) {
    if (!poll.mash) continue;
    const startsAt: number | null = poll.mash.phase === "setup" ? null : poll.mash.startsAt;
    if (next.runs[poll.id] === startsAt) continue;
    const mine: Record<string, number> = { ...next.mine };
    const denied: Record<string, MashDenial> = { ...next.denied };
    delete mine[poll.id];
    delete denied[poll.id];
    next = { ...next, mine, denied, runs: { ...next.runs, [poll.id]: startsAt } };
  }
  return next;
}

function subscribeMash(listener: () => void): () => void {
  mashListeners.add(listener);
  return (): void => {
    mashListeners.delete(listener);
  };
}

/** Mash Battle ticks and acknowledgements from the page's live connection. */
export function useMashLive(): MashLive {
  return useSyncExternalStore(
    subscribeMash,
    (): MashLive => mashLive,
    (): MashLive => emptyMash,
  );
}

/** Sends a message over the page's live connection. False when it is not connected. */
export function sendLive(message: object): boolean {
  if (liveSocket?.readyState !== WebSocket.OPEN) return false;
  liveSocket.send(JSON.stringify(message));
  return true;
}

/** Handles the small messages next to snapshots. True when the message was one of them. */
function handleSideMessage(message: unknown, onOverlay: (overlay: OverlayPublic) => void): boolean {
  const tick = tickSchema.safeParse(message);
  if (tick.success) {
    setMashLive((current: MashLive) => ({ ...current, ticks: { ...current.ticks, [tick.data.id]: tick.data } }));
    return true;
  }
  const ack = ackSchema.safeParse(message);
  if (ack.success) {
    setMashLive((current: MashLive) => ({ ...current, mine: { ...current.mine, [ack.data.id]: ack.data.mine } }));
    return true;
  }
  const denied = deniedSchema.safeParse(message);
  if (denied.success) {
    setMashLive((current: MashLive) => ({
      ...current,
      denied: { ...current.denied, [denied.data.id]: denied.data.reason },
    }));
    return true;
  }
  const overlay = overlayMessageSchema.safeParse(message);
  if (overlay.success) {
    onOverlay(overlay.data.overlay);
    return true;
  }
  return false;
}

export function useLivePolls(
  handle: string,
  enabled = true,
  /** The owner's overlay key from the OBS URL, so the socket keeps the owner's seat. */
  overlayKey: string | null = null,
): { snapshot: LiveSnapshot | null; status: LiveStatus; reconnect: () => void } {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [retry, setRetry] = useState<number>(0);
  const session: string = `${handle}:${enabled}:${retry}`;
  const [previousSession, setPreviousSession] = useState<string>(session);
  if (previousSession !== session) {
    setPreviousSession(session);
    setSnapshot(null);
    setStatus("connecting");
  }
  useEffect(() => {
    if (!enabled) return;
    let active: boolean = true;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let attempts: number = 0;
    function armWatchdog(current: WebSocket): void {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        setStatus("reconnecting");
        current.close();
      }, 90_000);
    }
    function updateSnapshot(next: LiveSnapshot): void {
      setSnapshot((previous: LiveSnapshot | null) =>
        !previous ||
        next.revision > previous.revision ||
        (next.revision === previous.revision && next.serverNow >= previous.serverNow)
          ? next
          : previous,
      );
    }
    function updateOverlay(overlay: OverlayPublic): void {
      setSnapshot((previous: LiveSnapshot | null) => (previous ? { ...previous, overlay } : previous));
    }
    function receive(current: WebSocket, data: string): void {
      if (data === "pong") return;
      const message: unknown = JSON.parse(data);
      if (typeof message === "object" && message !== null && "type" in message && message.type === "unavailable") {
        setStatus("reconnecting");
        current.close();
        return;
      }
      if (handleSideMessage(message, updateOverlay)) return;
      const parsed = snapshotSchema.safeParse(message);
      if (!parsed.success) {
        current.close(1002, "Invalid snapshot");
        return;
      }
      attempts = 0;
      setStatus("live");
      armWatchdog(current);
      setMashLive((mash: MashLive) => withSnapshotRuns(mash, parsed.data));
      updateSnapshot(parsed.data);
    }
    function connect(): void {
      if (!active) return;
      const url: URL = new URL(`/api/live/${encodeURIComponent(handle)}`, globalThis.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      if (overlayKey) url.searchParams.set("key", overlayKey);
      socket = new WebSocket(url);
      const current: WebSocket = socket;
      armWatchdog(current);
      current.onopen = (): void => {
        if (!active) return;
        liveSocket = current;
        setStatus("connecting");
        if (pinger) clearInterval(pinger);
        pinger = setInterval(() => {
          if (current.readyState === WebSocket.OPEN) current.send("ping");
        }, PING_INTERVAL_MS);
      };
      current.onmessage = (event: MessageEvent<unknown>): void => {
        if (!active || typeof event.data !== "string" || event.data.length > 128 * 1024) return;
        try {
          receive(current, event.data);
        } catch {
          current.close(1002, "Invalid snapshot");
        }
      };
      current.onerror = (): void => {
        current.close();
      };
      current.onclose = (): void => {
        if (liveSocket === current) liveSocket = null;
        if (pinger) clearInterval(pinger);
        if (!active) return;
        if (watchdog) clearTimeout(watchdog);
        attempts = Math.min(9, attempts + 1);
        if (attempts > 8) {
          setStatus("offline");
        } else {
          setStatus("reconnecting");
        }
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** (attempts - 1)));
      };
    }
    connect();
    return (): void => {
      active = false;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      if (pinger) clearInterval(pinger);
      socket?.close();
    };
  }, [handle, enabled, retry, overlayKey]);
  return { snapshot, status, reconnect: (): void => setRetry((value: number) => value + 1) };
}

export function useServerTime(serverNow: number, intervalMs = 1000): number {
  const [clock, setClock] = useState<{ source: number; now: number }>({ source: serverNow, now: serverNow });
  useEffect(() => {
    const offset: number = serverNow - Date.now();
    const timer = setInterval(() => setClock({ source: serverNow, now: Date.now() + offset }), intervalMs);
    return (): void => clearInterval(timer);
  }, [serverNow, intervalMs]);
  return clock.source === serverNow ? clock.now : serverNow;
}

export function useLiveRevalidation(
  status: LiveStatus,
  revision: number | undefined,
  revalidate: () => Promise<void>,
  enabled = true,
): void {
  const observed = useRef<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const key: string = `${enabled}:${status}:${revision ?? ""}`;
    if (observed.current === key) return;
    observed.current = key;
    if (!enabled || status !== "live" || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void revalidate();
    }, 400);
  }, [status, revision, revalidate, enabled]);
  const disconnected: boolean = enabled && status !== "live";
  useEffect(() => {
    if (!disconnected) return;
    const fallback = setInterval(() => {
      void revalidate();
    }, 30_000);
    return (): void => clearInterval(fallback);
  }, [disconnected, revalidate]);
  useEffect(
    () => (): void => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      observed.current = "";
    },
    [],
  );
}
