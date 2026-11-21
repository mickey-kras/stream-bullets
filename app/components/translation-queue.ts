import { ApiError, postJson } from "./api";

// A page with many items asks for a small number of translations at one time.
const LANES = 3;
// A different reader has the reservation (409), or the account is at its limit for one minute (429).
const RETRY_MS: Readonly<Record<number, number>> = { 409: 4000, 429: 20_000 };
const RETRIES = 2;
let active: number = 0;
const waiting: (() => void)[] = [];
// The deployment has no translation, or the daily limit is reached. The page stops its requests.
let unavailable: boolean = false;

export function translationOff(): boolean {
  return unavailable;
}

/** The item left the page before its request started. A later visit can ask again. */
export class TranslationStopped extends Error {}

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// The time to wait before the next attempt. Null when a new attempt has no use.
function retryAfter(error: unknown): number | null {
  const status: number = error instanceof ApiError ? error.status : 0;
  if (status === 503) unavailable = true;
  return RETRY_MS[status] ?? null;
}

async function send<T>(url: string, body: unknown, stopped: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (stopped()) throw new TranslationStopped();
    if (unavailable) throw new Error("Translation is not available.");
    try {
      return await postJson<T>(url, body);
    } catch (error) {
      const delay: number | null = retryAfter(error);
      if (delay === null || attempt === RETRIES) throw error;
      await wait(delay);
    }
  }
}

/**
 * Asks the server for one translation. The request waits for a free lane. `stopped` tells that the item left
 * the page: a request that did not start is then not sent. A transient refusal gets a small number of retries.
 */
export function requestTranslation<T>(url: string, body: unknown, stopped: () => boolean = () => false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      active += 1;
      send<T>(url, body, stopped)
        .then(resolve, (error: unknown) => reject(error instanceof Error ? error : new Error("Translation failed.")))
        .finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
    };
    if (active < LANES) start();
    else waiting.push(start);
  });
}
