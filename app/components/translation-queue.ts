import { ApiError, postJson } from "./api";

// A page with many items asks for a small number of translations at one time.
const LANES = 3;
let active: number = 0;
const waiting: (() => void)[] = [];
// The deployment has no translation, or the daily limit is reached. The page stops its requests.
let unavailable: boolean = false;

export function translationOff(): boolean {
  return unavailable;
}

/** Asks the server for one translation. The request waits for a free lane. */
export function requestTranslation<T>(url: string, body: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      if (unavailable) {
        reject(new Error("Translation is not available."));
        waiting.shift()?.();
        return;
      }
      active += 1;
      postJson<T>(url, body)
        .then(resolve, (error: unknown) => {
          if (error instanceof ApiError && error.status === 503) unavailable = true;
          reject(error instanceof Error ? error : new Error("Translation failed."));
        })
        .finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
    };
    if (active < LANES) start();
    else waiting.push(start);
  });
}
