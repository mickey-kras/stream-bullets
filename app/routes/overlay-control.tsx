export { RouteErrorBoundary as ErrorBoundary } from "../components/route-error";
import { withRouteErrors } from "../server/route-errors.server";
import type { ReactNode } from "react";
import { redirect, useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { t } from "../i18n";
import { paths } from "../lib/shell";
import { requestViewer } from "../lib/shell.server";
import { signInProvider } from "../server/api/account";
import { configuredProviders } from "../server/auth.server";
import { listConnections } from "../server/channels.server";
import { getOverlaySnapshot, getOwnStreamer } from "../server/data.server";
import { hasOverlayKey } from "../server/overlay-key.server";
import { getOverlayData, getOverlayState, sourceTopics } from "../server/overlay.server";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { ChannelPanel, resultMessage } from "../components/channels/channel-panel";
import { OverlayControl } from "../components/overlay/overlay-control";
import type { OverlayPoll } from "../components/overlay/overlay-stage";
import { SiteHeader } from "../components/shell/site-header";
import { useRevalidateAt } from "../components/use-clock";
import type { LiveSnapshot } from "../types";

export function meta() {
  return [{ title: `${t("overlay.controlTitle")} · StreamBullets` }, { name: "robots", content: "noindex" }];
}

export const loader = withRouteErrors(async ({ request, context }: LoaderFunctionArgs) => {
  const app = context.get(appContext);
  const viewer = await requestViewer(request, app);
  if (!viewer) throw redirect(paths.streamers);
  const streamer = await getOwnStreamer(app.env, viewer.id);
  if (!streamer) throw new Response("Page not found.", { status: 404 });
  const state = await getOverlayState(app.env, streamer.id);
  // Load on-air and preview entries even outside the newest 50.
  const refs = new Set<string | null>([null]);
  for (const source of [state.air, state.preview]) if (source.type === "poll") refs.add(source.ref);
  const [data, ...snapshots] = await Promise.all([
    getOverlayData(app.env, streamer.id, sourceTopics(state.air, state.preview)),
    ...[...refs].map((ref: string | null) => getOverlaySnapshot(app.env, streamer.id, ref)),
  ]);
  const polls: OverlayPoll[] = [];
  for (const snapshot of snapshots)
    for (const poll of snapshot.polls) if (!polls.some((item) => item.id === poll.id)) polls.push(poll);
  const origin: string = app.env.APP_ORIGIN;
  return {
    handle: streamer.handle,
    name: streamer.name,
    host: new URL(origin).host,
    hasOverlayKey: await hasOverlayKey(app.env, streamer.id),
    channels: await listConnections(app.env, streamer.id),
    providers: configuredProviders(app.env),
    signInProvider: await signInProvider(app.env, viewer.id),
    state,
    data,
    initial: { ...snapshots[0], polls } satisfies LiveSnapshot,
  };
});

export default function OverlayControlPage(): ReactNode {
  const loaded = useLoaderData<typeof loader>();
  const { snapshot, status, reconnect } = useLivePolls(loaded.handle);
  const revalidator = useRevalidator();
  const [search] = useSearchParams();
  useLiveRevalidation(status, snapshot?.revision, revalidator.revalidate);
  // Reload changes from other tabs; live messages omit preview state.
  const liveOverlay = snapshot?.overlay ?? null;
  useLiveRevalidation(
    status,
    liveOverlay?.revision,
    revalidator.revalidate,
    (liveOverlay?.revision ?? 0) > loaded.state.revision,
  );
  const current: LiveSnapshot = snapshot && snapshot.revision >= loaded.initial.revision ? snapshot : loaded.initial;
  const now: number = useServerTime(current.serverNow);
  // Refresh Up next at the loaded stream's start, even when neither monitor currently shows it.
  useRevalidateAt(loaded.initial.serverNow, loaded.data.next?.startsAt ?? null, revalidator.revalidate);
  const polls: OverlayPoll[] = [...current.polls];
  for (const poll of loaded.initial.polls) if (!polls.some((item) => item.id === poll.id)) polls.push(poll);
  return (
    <>
      <SiteHeader />
      <main className="page-panel ov-control" id="main-content">
        <OverlayControl
          initial={loaded.state}
          live={liveOverlay}
          hasOverlayKey={loaded.hasOverlayKey}
          connected={status === "live" || status === "connecting"}
          reconnect={status === "offline" ? reconnect : undefined}
          scene={{ name: loaded.name, handle: loaded.handle, host: loaded.host, polls, data: loaded.data, now }}
        />
        <section className="ch-section" aria-labelledby="channels-title">
          <h2 id="channels-title" tabIndex={-1}>
            {t("channels.title")}
          </h2>
          <ChannelPanel
            channels={loaded.channels}
            providers={loaded.providers}
            signInProvider={loaded.signInProvider}
            result={resultMessage(search.get("channel"), search.get("result"))}
          />
        </section>
      </main>
    </>
  );
}
