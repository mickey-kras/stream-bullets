// Debounce saves; flush on dialog close or page exit.
export interface PendingSave<T> {
  schedule: (value: T) => void;
  flush: () => void;
}

export function pendingSave<T>(send: (value: T, keepalive: boolean) => void, delayMs: number): PendingSave<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: { value: T } | null = null;
  function sendWaiting(keepalive: boolean): void {
    clearTimeout(timer);
    timer = undefined;
    if (!waiting) return;
    const { value } = waiting;
    waiting = null;
    send(value, keepalive);
  }
  return {
    schedule(value: T): void {
      waiting = { value };
      clearTimeout(timer);
      timer = setTimeout(() => sendWaiting(false), delayMs);
    },
    flush(): void {
      sendWaiting(true);
    },
  };
}
