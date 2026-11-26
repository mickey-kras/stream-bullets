import { withRouteErrors } from "../server/route-errors.server";
import { useMemo, type ReactNode } from "react";
import {
  isRouteErrorResponse,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { appContext } from "../env";
import { t } from "../i18n";
import { deliversChat } from "../lib/channel-health";
import { listConnections } from "../server/channels.server";
import { getOverlaySnapshot, getStreamer } from "../server/data.server";
import { dockKeyMatches } from "../server/dock-key.server";
import { getOverlayData, getOverlayState } from "../server/overlay.server";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { useActivityFeed, type ActivityFeed } from "../components/overlay/activity-feed";
import { ConnectionNote } from "../components/overlay/connection-note";
import { ControlApiContext, dockApi, type ControlApi } from "../components/overlay/control-api";
import type { OverlayPoll, OverlayScene } from "../components/overlay/overlay-stage";
import { useOverlayState } from "../components/overlay/use-overlay-state";
import { LiveChat } from "../components/tools/live-chat";
import { LiveMessage } from "../components/tools/live-message";
import { LivePoll } from "../components/tools/live-poll";
import { onAirTitle } from "../components/tools/live-section";
import { LiveTopics } from "../components/tools/live-topics";
import { useRevalidateAt } from "../components/use-clock";
import type { LiveSnapshot, OverlayPublic, OverlayState } from "../types";
import "../components/overlay/wasteland/wasteland.css";
import "../components/overlay/composition.css";
import "../components/tools/live.css";

export function meta() {
  return [{ title: `${t("dock.title")} · StreamBullets` }, { name: "robots", content: "noindex" }];
}

// The private OBS dock: the live controls of one page, for a custom browser dock in OBS. The page has no session.
// The dock key in the address opens it, and a wrong key gets the answer of a page that does not exist.
export const loader = withRouteErrors(async ({ request, context, params }: LoaderFunctionArgs) => {
  const app = context.get(appContext);
  const streamer = params.handle?.startsWith("@") ? await getStreamer(app.env, params.handle.slice(1)) : null;
  const key: string | null = new URL(request.url).searchParams.get("key");
  if (!streamer || streamer.status === "suspended" || !(await dockKeyMatches(app.env, streamer.id, key)))
    throw new Response("Page not found.", { status: 404 });
  const state = await getOverlayState(app.env, streamer.id);
  // The poll and the topic of their layers load also outside the newest 50. A null poll is the automatic poll.
  const { poll, topic } = state.layers.items;
  const refs = new Set<string | null>([null, poll.ref]);
  const [data, ...snapshots] = await Promise.all([
    getOverlayData(app.env, streamer.id, topic.ref === null ? [] : [topic.ref]),
    ...[...refs].map((ref: string | null) => getOverlaySnapshot(app.env, streamer.id, ref)),
  ]);
  const polls: OverlayPoll[] = [];
  for (const snapshot of snapshots)
    for (const item of snapshot.polls) if (!polls.some((other) => other.id === item.id)) polls.push(item);
  const origin: URL = new URL(app.env.APP_ORIGIN);
  return {
    handle: streamer.handle,
    name: streamer.name,
    host: origin.host,
    origin: origin.origin,
    delivers: deliversChat(await listConnections(app.env, streamer.id)),
    state,
    data,
    initial: { ...snapshots[0], polls } satisfies LiveSnapshot,
  };
});

/**
 * The dock without its controls. A dock link that does not work gets the answer 404: the key is wrong, or the owner
 * made a new link. An open dock comes here too, when it loads its data again after the server closed its sockets.
 */
export function ErrorBoundary(): ReactNode {
  const error: unknown = useRouteError();
  const closed: boolean = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="dock-page" id="main-content" aria-label={t("dock.title")} data-dock-closed={closed}>
      <h1 className="dock-title">{t(closed ? "dock.closed.title" : "common.failed")}</h1>
      {closed && <p className="muted">{t("dock.closed.body")}</p>}
    </main>
  );
}

/** The controls of the dock: the parts of the Live section that fit a narrow panel, in one column. */
function DockControls({
  initial,
  live,
  scene,
  delivers,
  connected,
  reconnect,
  dockKey,
}: Readonly<{
  initial: OverlayState;
  live: OverlayPublic | null;
  scene: Omit<OverlayScene, "overlay">;
  delivers: boolean;
  connected: boolean;
  reconnect?: () => void;
  dockKey: string;
}>): ReactNode {
  const { state, busy, send, run } = useOverlayState(initial, live);
  const view: OverlayScene = { ...scene, overlay: state };
  const feed: ActivityFeed = useActivityFeed(scene.handle, dockKey, true);
  return (
    <>
      <ConnectionNote connected={connected} reconnect={reconnect} />
      <LivePoll scene={view} state={state} busy={busy} run={run} />
      <LiveTopics scene={view} state={state} busy={busy} run={run} />
      <LiveMessage key={`${state.message}:${state.messageStyle}`} state={state} busy={busy} send={send} />
      <LiveChat feed={feed} delivers={delivers} onAir={onAirTitle(view, state.layers)} />
    </>
  );
}

export default function DockPage(): ReactNode {
  const loaded = useLoaderData<typeof loader>();
  const [search] = useSearchParams();
  const key: string = search.get("key") ?? "";
  const api: ControlApi = useMemo(() => dockApi(loaded.handle, key), [loaded.handle, key]);
  // The dock key gets the seat and the snapshot of the owner in the live room.
  const { snapshot, status, reconnect } = useLivePolls(loaded.handle, true, key);
  const revalidator = useRevalidator();
  useLiveRevalidation(status, snapshot?.revision, revalidator.revalidate);
  // Reload changes from Streamer tools; live messages omit the message draft.
  const liveOverlay: OverlayPublic | null = snapshot?.overlay ?? null;
  useLiveRevalidation(
    status,
    liveOverlay?.revision,
    revalidator.revalidate,
    (liveOverlay?.revision ?? 0) > loaded.state.revision,
  );
  const current: LiveSnapshot = snapshot && snapshot.revision >= loaded.initial.revision ? snapshot : loaded.initial;
  const now: number = useServerTime(current.serverNow);
  useRevalidateAt(loaded.initial.serverNow, loaded.data.next?.startsAt ?? null, revalidator.revalidate);
  const polls: OverlayPoll[] = [...current.polls];
  for (const poll of loaded.initial.polls) if (!polls.some((item) => item.id === poll.id)) polls.push(poll);
  const scene: Omit<OverlayScene, "overlay"> = {
    name: loaded.name,
    handle: loaded.handle,
    host: loaded.host,
    origin: loaded.origin,
    polls,
    data: loaded.data,
    now,
  };
  return (
    <main className="dock-page" id="main-content" aria-label={t("dock.title")} data-dock>
      <h1 className="dock-title">{t("dock.heading", { name: loaded.name })}</h1>
      <ControlApiContext.Provider value={api}>
        <DockControls
          initial={loaded.state}
          live={liveOverlay}
          scene={scene}
          delivers={loaded.delivers}
          connected={status === "live" || status === "connecting"}
          reconnect={status === "offline" ? reconnect : undefined}
          dockKey={key}
        />
      </ControlApiContext.Provider>
    </main>
  );
}
