import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from 'react-router';
import type { ReactNode } from 'react';
import './styles.css';

export function Layout({ children }: { children: ReactNode }): ReactNode {
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><Meta /><link rel="stylesheet" href="/fonts.css" /><Links /></head><body>{children}<ScrollRestoration /><Scripts /></body></html>;
}

export default function App(): ReactNode { return <Outlet />; }

export function ErrorBoundary(): ReactNode {
  const error: unknown = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return <main className="page-panel"><h1>{missing ? 'Page not found' : 'Something went wrong'}</h1><p>{missing ? 'This page does not exist.' : 'Please reload the page and try again.'}</p><a href="/">StreamBullets home</a></main>;
}
