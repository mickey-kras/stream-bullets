import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useMatches,
  useRouteError,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { ReactNode } from "react";
import { AccountDialogs } from "./components/account/account-dialogs";
import { BackLink } from "./components/shell/back-link";
import { SiteFooter } from "./components/shell/footer";
import { SiteHeader } from "./components/shell/site-header";
import { Icon } from "./components/ui/icon";
import { ToastProvider } from "./components/ui/toast";
import { appContext } from "./env";
import { HttpError } from "./server/http.server";
import { locale, t } from "./i18n";
import { loadShell } from "./lib/shell.server";
import { paths, type ShellData } from "./lib/shell";
import "./styles.css";

/** Routes without site chrome. The OBS overlay is a browser source, so it shows only the poll. */
const bareRoutes: ReadonlySet<string> = new Set(["routes/overlay"]);

/** Shell data for every header, the account menu and the footer (see app/lib/shell.ts). */
export async function loader({ request, context }: LoaderFunctionArgs): Promise<ShellData> {
  try {
    return await loadShell(request, context.get(appContext));
  } catch (error: unknown) {
    if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
    throw error;
  }
}

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

export function Layout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
    <a className="skip-link" href="#main-content">
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
    </ToastProvider>
  );
}

/** The 404 page and the error page: the generic header, a back link and a way on. */
export function ErrorBoundary(): ReactNode {
  const error: unknown = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <ToastProvider>
      <SkipLink />
      <SiteHeader />
      <main className="page-panel not-found-page" id="main-content">
        <div className="page-column">
          <BackLink />
          <Icon name={missing ? "compass" : "warning"} size={40} />
          <h1>{missing ? t("error.notFoundTitle") : t("error.title")}</h1>
          <p>{missing ? t("error.notFoundBody") : t("error.body")}</p>
          <div className="not-found-actions">
            <Link className="button-link gold" to={paths.streamers}>
              <Icon name="streamers" size={18} />
              {t("error.browseStreamers")}
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </ToastProvider>
  );
}
