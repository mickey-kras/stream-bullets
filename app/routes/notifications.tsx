import type { ReactNode } from "react";
import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Notifications } from "../components/notifications";
import { SiteHeader } from "../components/shell/site-header";
import { appContext } from "../env";
import { t } from "../i18n";
import { requestViewer } from "../lib/shell.server";
import { listNotifications } from "../server/discussion-notifications.server";
import { withRouteErrors } from "../server/route-errors.server";
import type { NotificationSnapshot } from "../types";

export { RouteErrorBoundary as ErrorBoundary } from "../components/route-error";

export function meta() {
  return [{ title: `${t("notifications.title")} · StreamBullets` }, { name: "robots", content: "noindex" }];
}

export const loader = withRouteErrors(
  async ({ request, context }: LoaderFunctionArgs): Promise<NotificationSnapshot> => {
    const app = context.get(appContext);
    const viewer = await requestViewer(request, app);
    if (!viewer) throw redirect("/sign-in?next=/notifications");
    return listNotifications(app.env, viewer.id);
  },
);

export default function NotificationsPage(): ReactNode {
  const initial = useLoaderData<typeof loader>();
  return (
    <>
      <SiteHeader />
      <main className="page-panel notifications-page" id="main-content">
        <Notifications initial={initial} />
      </main>
    </>
  );
}
