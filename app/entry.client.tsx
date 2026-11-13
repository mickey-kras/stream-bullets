import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { getLocale, loadCatalog } from "./i18n";

// Load the server-rendered locale before hydration. Language changes reload the page.
try {
  await loadCatalog(getLocale());
} finally {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
}
