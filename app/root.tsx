import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useMatches,
  useRouteError,
} from "react-router";
import type { ReactNode } from "react";
import { SiteFooter } from "./components/common";
import "./styles.css";

/** Routes without site chrome. The OBS overlay is a browser source, so it shows only the poll. */
const bareRoutes: ReadonlySet<string> = new Set(["routes/overlay"]);

export function Layout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
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

export default function App(): ReactNode {
  const bare: boolean = useMatches().some((match) => bareRoutes.has(match.id));
  return (
    <>
      <Outlet />
      {!bare && <SiteFooter />}
    </>
  );
}

export function ErrorBoundary(): ReactNode {
  const error: unknown = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <>
      <main className="page-panel">
        <h1>{missing ? "Page not found" : "Something went wrong"}</h1>
        <p>{missing ? "This page does not exist." : "Please reload the page and try again."}</p>
        <a href="/">StreamBullets home</a>
      </main>
      <SiteFooter />
    </>
  );
}
