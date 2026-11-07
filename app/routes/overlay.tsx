import type { ReactNode } from "react";
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { t } from "../i18n";
import { getOverlaySnapshot, getStreamer } from "../server/data.server";
import { getOverlayData, getOverlayState } from "../server/overlay.server";
import { overlayPublic } from "../server/overlay-state";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { OverlayStage, type OverlayPoll, type OverlayScene } from "../components/overlay/overlay-stage";
import type { LiveSnapshot, OverlayPublic, OverlaySourceRef } from "../types";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  if (!params.handle?.startsWith("@")) throw new Response("Page not found.", { status: 404 });
  const streamer = await getStreamer(app.env, params.handle.slice(1));
  // A suspended page shows nothing in the overlay.
  if (!streamer || streamer.status === "suspended") throw new Response("Streamer not found.", { status: 404 });
  // `?poll=` stays as an override of the overlay control state (item 33).
  const override: string | null = new URL(request.url).searchParams.get("poll") || null;
  const overlay: OverlayPublic = overlayPublic(await getOverlayState(app.env, streamer.id));
  const pollId: string | null = override ?? (overlay.air.type === "poll" ? overlay.air.ref : null);
  const topicId: string | null = overlay.air.type === "topic" ? overlay.air.ref : null;
  const [initial, data] = await Promise.all([
    getOverlaySnapshot(app.env, streamer.id, pollId),
    getOverlayData(app.env, streamer.id, topicId),
  ]);
  if (override && initial.polls.length === 0) throw new Response("Poll not found.", { status: 404 });
  return {
    handle: streamer.handle,
    name: streamer.name,
    host: new URL(app.env.APP_ORIGIN).host,
    override,
    overlay,
    initial,
    data,
  };
}

/** The one OBS browser source URL. It shows whatever the owner puts on air from Overlay control. */
export default function Overlay(): ReactNode {
  const loaded = useLoaderData<typeof loader>();
  const { snapshot, status, reconnect } = useLivePolls(loaded.handle);
  const revalidator = useRevalidator();
  const current: LiveSnapshot = snapshot && snapshot.revision >= loaded.initial.revision ? snapshot : loaded.initial;
  const live: OverlayPublic | null | undefined = snapshot?.overlay;
  const overlay: OverlayPublic = live && live.revision >= loaded.overlay.revision ? live : loaded.overlay;
  useLiveRevalidation(status, snapshot?.revision, revalidator.revalidate);
  // A new source on air may need data the page does not have yet (a topic, a card, an older poll).
  useLiveRevalidation(status, overlay.revision, revalidator.revalidate);
  const now: number = useServerTime(current.serverNow);
  const polls: OverlayPoll[] = [...current.polls];
  for (const poll of loaded.initial.polls) if (!polls.some((item) => item.id === poll.id)) polls.push(poll);
  const source: OverlaySourceRef = loaded.override ? { type: "poll", ref: loaded.override } : overlay.air;
  const scene: OverlayScene = {
    name: loaded.name,
    handle: loaded.handle,
    host: loaded.host,
    overlay,
    polls,
    data: loaded.data,
    now,
  };
  return (
    <main className="overlay-screen ov-screen" id="main-content" aria-label={t("overlay.label", { name: loaded.name })}>
      <OverlayStage scene={scene} source={source} />
      {status !== "live" && (
        <output className="overlay-connection">
          {status === "connecting" && t("overlay.connecting")}
          {status === "reconnecting" && t("overlay.reconnecting")}
          {status === "offline" && (
            <>
              <span>{t("overlay.offline")}</span>{" "}
              <button type="button" onClick={reconnect}>
                {t("overlay.reconnect")}
              </button>
            </>
          )}
        </output>
      )}
    </main>
  );
}
