import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "./index";

/**
 * The server's language source. One Worker isolate renders many requests at once, so the active language
 * lives in AsyncLocalStorage for the length of one render instead of in a module variable.
 */
const requestLanguage = new AsyncLocalStorage<Locale>();
setLocaleSource((): Locale => requestLanguage.getStore() ?? DEFAULT_LOCALE);

/** Loads the language's catalog, then runs `render` with that language active. */
export async function withLocale<T>(locale: Locale, render: () => Promise<T>): Promise<T> {
  await loadCatalog(locale);
  return requestLanguage.run(locale, render);
}
