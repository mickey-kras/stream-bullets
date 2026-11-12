import { withRouteErrors } from "../server/route-errors.server";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { t } from "../i18n";
import { getOverlaySnapshot, getStreamer } from "../server/data.server";
import { getOverlayData, getOverlayState, sourceTopics } from "../server/overlay.server";
import { overlayPublic } from "../server/overlay-state";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { OverlayStage, upNextStart, type OverlayPoll, type OverlayScene } from "../components/overlay/overlay-stage";
import { useRevalidateAt } from "../components/use-clock";
import type { LiveSnapshot, OverlayPublic, OverlaySourceRef } from "../types";

export const loader = withRouteErrors(async ({ request, context, params }: LoaderFunctionArgs) => {
  const app = context.get(appContext);
  if (!params.handle?.startsWith("@")) throw new Response("Page not found.", { status: 404 });
  const streamer = await getStreamer(app.env, params.handle.slice(1));
  // A suspended page shows nothing in the overlay.
  if (!streamer || streamer.status === "suspended") throw new Response("Streamer not found.", { status: 404 });
  // `?poll=` stays as an override of the overlay control state (item 33).
  const override: string | null = new URL(request.url).searchParams.get("poll") || null;
  const overlay: OverlayPublic = overlayPublic(await getOverlayState(app.env, streamer.id));
  const pollId: string | null = override ?? (overlay.air.type === "poll" ? overlay.air.ref : null);
  const [initial, data] = await Promise.all([
    getOverlaySnapshot(app.env, streamer.id, pollId),
    getOverlayData(app.env, streamer.id, sourceTopics(overlay.air)),
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
});

/** The one OBS browser source URL. It shows whatever the owner puts on air from Overlay control. */
export default function Overlay(): ReactNode {
  const loaded = useLoaderData<typeof loader>();
  const [search] = useSearchParams();
  const { snapshot, status } = useLivePolls(loaded.handle, true, search.get("key"), true);
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
  // Up next names the next stream at load time; once it starts, the loader names the one after it.
  useRevalidateAt(loaded.initial.serverNow, upNextStart(source, loaded.data), revalidator.revalidate);
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
      {/* The overlay never goes offline (it keeps retrying), so it never puts a button on stream. */}
      {status !== "live" && (
        <output className="overlay-connection">
          {status === "connecting" ? t("overlay.connecting") : t("overlay.reconnecting")}
        </output>
      )}
    </main>
  );
}

/** Attempts reload the data first; after this many a full page load also recovers a failed route module. */
const ERROR_RELOAD_AFTER = 6;

/**
 * An OBS source runs unattended, so a failed load (a 429, a network blip, a deploy) must not leave the site's error
 * page on stream. This shows nothing over the stream and retries with backoff until the overlay loads again.
 */
export function ErrorBoundary(): ReactNode {
  const { revalidate } = useRevalidator();
  const retry = useRef<() => Promise<void>>(revalidate);
  useEffect(() => {
    retry.current = revalidate;
  }, [revalidate]);
  const attempts = useRef<number>(0);
  /** Counts finished attempts: one that fails and leaves this boundary up schedules the next. */
  const [settled, setSettled] = useState<number>(0);
  useEffect(() => {
    attempts.current += 1;
    const attempt: number = attempts.current;
    const jitter: number = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const delay: number = Math.min(60_000, 5000 * 2 ** (Math.min(attempt, 8) - 1)) * (0.5 + jitter * 0.5);
    const timer = setTimeout(() => {
      if (attempt > ERROR_RELOAD_AFTER) globalThis.location.reload();
      else void retry.current().finally(() => setSettled((value: number) => value + 1));
    }, delay);
    return (): void => clearTimeout(timer);
  }, [settled]);
  return <main className="overlay-screen ov-screen" id="main-content" aria-busy="true" />;
}
