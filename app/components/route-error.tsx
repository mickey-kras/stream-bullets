import type { ReactNode } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";
import { t } from "../i18n";
import { paths } from "../lib/shell";
import { StreamerSearch } from "./shell/directory-search";
import { SiteHeader } from "./shell/site-header";
import { Icon } from "./ui/icon";

export function RouteErrorBoundary(): ReactNode {
  const error: unknown = useRouteError();
  const missing: boolean = isRouteErrorResponse(error) && error.status === 404;
  const data: unknown = isRouteErrorResponse(error) && error.status >= 500 ? error.data : null;
  const requestId: unknown = data && typeof data === "object" && "requestId" in data ? data.requestId : null;
  return (
    <>
      <SiteHeader />
      <main className="page-panel not-found-page" id="main-content">
        <div className="page-column">
          <Icon name={missing ? "compass" : "warning"} size={40} />
          <h1>{missing ? t("error.notFoundTitle") : t("error.title")}</h1>
          <p>{missing ? t("error.notFoundBody") : t("error.body")}</p>
          {typeof requestId === "string" && /^[a-f0-9-]{36}$/.test(requestId) && (
            <p>{t("error.requestId", { id: requestId })}</p>
          )}
          {missing && <StreamerSearch id="nf-search" />}
          <div className="not-found-actions">
            <Link className="button-link gold" to={paths.streamers}>
              <Icon name="streamers" size={18} />
              {t("error.browseStreamers")}
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
