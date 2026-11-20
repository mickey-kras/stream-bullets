import { createContext, useEffect, useRef, useState } from "react";
import { channelsResponseSchema, type ChannelView } from "../../lib/channel-health";
import { requestJson } from "../api";

/**
 * How often the open page reads GET /api/channels. A read uses no mutation quota and no per-address limit
 * (worker/index.ts: `quotaScope` gives API reads no scope).
 */
export const CHANNEL_REFRESH_MS = 20_000;
/** After this many failed reads in a row, the panel says that the status is old. */
export const REFRESH_FAILURES_SHOWN = 3;

/** False when the studio knows that no connected platform delivers chat. True without live channel data. */
export const ChatDeliveryContext = createContext<boolean>(true);

async function readChannels(): Promise<ChannelView[]> {
  return channelsResponseSchema.parse(await requestJson<unknown>("/api/channels")).channels;
}

/**
 * Reads the channels every `intervalMs` while the document is visible, and at once when the tab shows again or
 * the browser is online again. One timer: the next read waits for the end of the current one. `report` gets the
 * new list and zero, or null and the number of failed reads in a row. Returns the function that stops all of it.
 */
export function startChannelRefresh(
  read: () => Promise<ChannelView[]>,
  report: (channels: ChannelView[] | null, failures: number) => void,
  intervalMs: number = CHANNEL_REFRESH_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures: number = 0;
  let reading: boolean = false;
  let stopped: boolean = false;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function schedule(): void {
    cancel();
    if (stopped || document.hidden) return;
    timer = setTimeout((): void => void refresh(), intervalMs);
  }
  async function refresh(): Promise<void> {
    if (reading) return;
    reading = true;
    cancel();
    try {
      const channels: ChannelView[] = await read();
      failures = 0;
      if (!stopped) report(channels, 0);
    } catch {
      // Not silent: the count goes to the panel, which keeps the last list and names the problem after a few.
      failures += 1;
      if (!stopped) report(null, failures);
    } finally {
      reading = false;
      schedule();
    }
  }
  function wake(): void {
    if (stopped || document.hidden) cancel();
    else void refresh();
  }

  document.addEventListener("visibilitychange", wake);
  globalThis.addEventListener("online", wake);
  schedule();
  return (): void => {
    stopped = true;
    cancel();
    document.removeEventListener("visibilitychange", wake);
    globalThis.removeEventListener("online", wake);
  };
}

/**
 * The channels of the open Overlay control page. They start as the loader's list, so the first render needs no
 * read. A newer loader list replaces a list from an older read. `stale` is true while reads keep failing.
 */
export function useLiveChannels(loaded: ChannelView[]): { channels: ChannelView[]; stale: boolean } {
  const [read, setRead] = useState<{ source: ChannelView[]; channels: ChannelView[] }>({
    source: loaded,
    channels: loaded,
  });
  const [failures, setFailures] = useState<number>(0);
  const source = useRef<ChannelView[]>(loaded);
  useEffect((): void => {
    source.current = loaded;
  }, [loaded]);
  useEffect(
    (): (() => void) =>
      startChannelRefresh(readChannels, (channels: ChannelView[] | null, failed: number): void => {
        setFailures(failed);
        if (channels) setRead({ source: source.current, channels });
      }),
    [],
  );
  return {
    channels: read.source === loaded ? read.channels : loaded,
    stale: failures >= REFRESH_FAILURES_SHOWN,
  };
}
