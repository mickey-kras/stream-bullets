import { withRouteErrors } from "./server/route-errors.server";
import { RouteErrorBoundary } from "./components/route-error";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { ReactNode } from "react";
import { Announcer } from "./components/a11y/announcer";
import { AccountDialogs } from "./components/account/account-dialogs";
import { SiteFooter } from "./components/shell/footer";
import { ToastProvider } from "./components/ui/toast";
import { appContext } from "./env";
import { getLocale, t } from "./i18n";
import { useNonce } from "./lib/nonce";
import { PREFS_SCRIPT } from "./lib/prefs";
import { loadShell } from "./lib/shell.server";
import { type ShellData } from "./lib/shell";
import "./styles.css";

// OBS routes omit site chrome.
const bareRoutes: ReadonlySet<string> = new Set(["routes/overlay"]);

// Shared header, account menu and footer data.
export const loader = withRouteErrors(async ({ request, context }: LoaderFunctionArgs): Promise<ShellData> => {
  return loadShell(request, context.get(appContext));
});

// Reuse shell data across navigation. Refresh after submissions, explicit same-URL revalidation or full
// reload.
export function shouldRevalidate({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}

// Apply saved preferences before paint. The fixed script reads data-prefs and uses the CSP nonce; request
// data never becomes code.
function PrefsScript(): ReactNode {
  const nonce: string | undefined = useNonce();
  const shell = useRouteLoaderData<ShellData>("root");
  return (
    <script nonce={nonce} data-prefs={JSON.stringify(shell?.prefs ?? {})} suppressHydrationWarning>
      {PREFS_SCRIPT}
    </script>
  );
}

export function Layout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  // The head script changes these attributes before hydration.
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <PrefsScript />
        <meta name="theme-color" content="#061a1e" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Meta />
        <link
          rel="preload"
          href="/assets/fonts/oswald-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/assets/fonts/figtree-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href="/fonts.css" />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function SkipLink(): ReactNode {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={() => {
        const main: HTMLElement | null = document.getElementById("main-content");
        if (main) {
          main.tabIndex = -1;
          main.focus();
        }
      }}
    >
      {t("shell.skip")}
    </a>
  );
}

export default function App(): ReactNode {
  const bare: boolean = useMatches().some((match) => bareRoutes.has(match.id));
  if (bare) return <Outlet />;
  return (
    <ToastProvider>
      <SkipLink />
      <Outlet />
      <SiteFooter />
      <AccountDialogs />
      <Announcer />
    </ToastProvider>
  );
}

export function ErrorBoundary(): ReactNode {
  return (
    <ToastProvider>
      <SkipLink />
      <RouteErrorBoundary />
      <SiteFooter />
    </ToastProvider>
  );
}
