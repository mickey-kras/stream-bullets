import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { LiveSnapshot } from '../types';

const snapshotSchema = z.object({
  type: z.literal('snapshot'),
  revision: z.number().int().nonnegative(),
  serverNow: z.number().int().nonnegative(),
  polls: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().max(160),
    kind: z.enum(['choice', 'binary']),
    options: z.array(z.string().max(80)).min(2).max(6),
    endsAt: z.number().int().nullable(),
    revealed: z.boolean(),
    counts: z.array(z.number().int().nonnegative()).max(6).nullable(),
    total: z.number().int().nonnegative(),
  })).max(100),
});

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export function useLivePolls(handle: string, enabled = true): { snapshot: LiveSnapshot | null; status: LiveStatus; reconnect: () => void } {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [retry, setRetry] = useState<number>(0);
  useEffect(() => {
    if (!enabled) return;
    let active: boolean = true;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let attempts: number = 0;
    setSnapshot(null);
    setStatus('connecting');
    function connect(): void {
      if (!active) return;
      const url: URL = new URL(`/api/live/${encodeURIComponent(handle)}`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      const current: WebSocket = socket;
      function armWatchdog(): void {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => { setStatus('reconnecting'); current.close(); }, 90_000);
      }
      armWatchdog();
      current.onopen = (): void => {
        if (!active) return;
        setStatus('connecting');
      };
      current.onmessage = (event: MessageEvent<unknown>): void => {
        if (!active || typeof event.data !== 'string' || event.data.length > 128 * 1024) return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'unavailable') {
            setStatus('reconnecting');
            current.close();
            return;
          }
          const parsed = snapshotSchema.safeParse(message);
          if (!parsed.success) {
            current.close(1002, 'Invalid snapshot');
            return;
          }
          const next: LiveSnapshot = parsed.data;
          attempts = 0;
          setStatus('live');
          armWatchdog();
          setSnapshot((previous: LiveSnapshot | null) => !previous || next.revision > previous.revision || (next.revision === previous.revision && next.serverNow >= previous.serverNow) ? next : previous);
        } catch {
          current.close(1002, 'Invalid snapshot');
        }
      };
      current.onerror = (): void => { current.close(); };
      current.onclose = (): void => {
        if (!active) return;
        if (watchdog) clearTimeout(watchdog);
        attempts = Math.min(9, attempts + 1);
        if (attempts > 8) {
          setStatus('offline');
        } else {
          setStatus('reconnecting');
        }
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** (attempts - 1)));
      };
    }
    connect();
    return (): void => {
      active = false;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      socket?.close();
    };
  }, [handle, enabled, retry]);
  return { snapshot, status, reconnect: (): void => setRetry((value: number) => value + 1) };
}

export function useServerTime(serverNow: number): number {
  const [now, setNow] = useState<number>(serverNow);
  useEffect(() => {
    const offset: number = serverNow - Date.now();
    setNow(serverNow);
    const timer = setInterval(() => setNow(Date.now() + offset), 1000);
    return (): void => clearInterval(timer);
  }, [serverNow]);
  return now;
}

export function useLiveRevalidation(status: LiveStatus, revision: number | undefined, revalidate: () => Promise<void>, enabled = true): void {
  const observed = useRef<string>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const key: string = `${enabled}:${status}:${revision ?? ''}`;
    if (observed.current === key) return;
    observed.current = key;
    if (!enabled || status !== 'live' || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void revalidate();
    }, 400);
  }, [status, revision, revalidate, enabled]);
  const disconnected: boolean = enabled && status !== 'live';
  useEffect(() => {
    if (!disconnected) return;
    const fallback = setInterval(() => { void revalidate(); }, 30_000);
    return (): void => clearInterval(fallback);
  }, [disconnected, revalidate]);
  useEffect(() => (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    observed.current = '';
  }, []);
}
