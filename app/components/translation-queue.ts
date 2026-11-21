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

function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function send<T>(url: string, body: unknown, stopped: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (stopped() || unavailable) throw new Error("The translation is not necessary.");
    try {
      return await postJson<T>(url, body);
    } catch (error) {
      const status: number = error instanceof ApiError ? error.status : 0;
      if (status === 503) unavailable = true;
      if (!(status in RETRY_MS) || attempt === RETRIES) throw error;
      await wait(RETRY_MS[status]);
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
