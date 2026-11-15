import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "./index";

// AsyncLocalStorage isolates each concurrent request's render locale.
const requestLanguage = new AsyncLocalStorage<Locale>();
setLocaleSource((): Locale => requestLanguage.getStore() ?? DEFAULT_LOCALE);

export async function withLocale<T>(locale: Locale, render: () => Promise<T>): Promise<T> {
  await loadCatalog(locale);
  return requestLanguage.run(locale, render);
}
