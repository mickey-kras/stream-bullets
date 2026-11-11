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

/** Routes without site chrome. The OBS overlay is a browser source, so it shows only the poll. */
const bareRoutes: ReadonlySet<string> = new Set(["routes/overlay"]);

/** Shell data for every header, the account menu and the footer (see app/lib/shell.ts). */
export const loader = withRouteErrors(async ({ request, context }: LoaderFunctionArgs): Promise<ShellData> => {
  return loadShell(request, context.get(appContext));
});

/**
 * The shell changes only when the session or the person's role changes: after a form submission, an explicit
 * revalidate() (same URL) or a full reload. Plain navigations reuse it.
 */
export function shouldRevalidate({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod || currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return false;
}

/**
 * Applies the saved display preferences (text size, contrast, colour vision, motion, links, font) to <html>
 * before first paint. It is the one inline script; it carries the request's CSP nonce, and its code is a fixed
 * string (app/lib/prefs.ts) that reads the preferences from `data-prefs`, so no request data becomes code.
 */
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
  // The head script sets the preference attributes on <html> before React hydrates, so they never match.
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

/** The 404 page and the error page: the generic header, a streamer search (404) and a way on, as in the mockup. */
export function ErrorBoundary(): ReactNode {
  return (
    <ToastProvider>
      <SkipLink />
      <RouteErrorBoundary />
      <SiteFooter />
    </ToastProvider>
  );
}
