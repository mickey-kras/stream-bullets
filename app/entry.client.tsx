import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { getLocale, loadCatalog } from "./i18n";

// The server rendered the page in <html lang>'s language. Load that catalog first, so hydration renders the same
// text. Changing the language reloads the page.
void loadCatalog(getLocale()).finally(() => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
});
