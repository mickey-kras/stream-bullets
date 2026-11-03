import type { ReactNode } from "react";
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { getOverlaySnapshot, getStreamer } from "../server/data.server";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { PollResults, PollStatus } from "../components/poll";
import type { LiveSnapshot } from "../types";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  if (!params.handle?.startsWith("@")) throw new Response("Page not found.", { status: 404 });
  const streamer = await getStreamer(app.env, params.handle.slice(1));
  if (!streamer) throw new Response("Streamer not found.", { status: 404 });
  const pollId: string | null = new URL(request.url).searchParams.get("poll") || null;
  const initial: LiveSnapshot = await getOverlaySnapshot(app.env, streamer.id, pollId);
  if (pollId && initial.polls.length === 0) throw new Response("Poll not found.", { status: 404 });
  return { handle: streamer.handle, name: streamer.name, pollId, initial };
}

export default function Overlay(): ReactNode {
  const { handle, name, pollId, initial } = useLoaderData<typeof loader>();
  const { snapshot, status, reconnect } = useLivePolls(handle);
  const revalidator = useRevalidator();
  useLiveRevalidation(status, snapshot?.revision, revalidator.revalidate);
  const current: LiveSnapshot = snapshot && snapshot.revision >= initial.revision ? snapshot : initial;
  const now: number = useServerTime(current.serverNow);
  const poll = pollId
    ? current.polls.find((item) => item.id === pollId) || initial.polls.find((item) => item.id === pollId)
    : current.polls.find((item) => !item.revealed && (item.endsAt === null || item.endsAt > now)) || current.polls[0];
  return (
    <main className="overlay-screen" id="main-content" aria-label={`${name} live poll overlay`}>
      {poll ? (
        <article className="poll-card overlay-card">
          <span className="eyebrow">{name} · Live poll</span>
          <PollStatus poll={poll} now={now} />
          <h1>{poll.title}</h1>
          <PollResults poll={poll} now={now} />
          <p className="overlay-total">
            {poll.total} {poll.total === 1 ? "vote" : "votes"}
            {poll.kind === "binary" && !poll.revealed && " · Results not yet revealed"}
          </p>
        </article>
      ) : (
        <div className="overlay-empty">Waiting for the next poll</div>
      )}
      {status !== "live" && (
        <output className="overlay-connection">
          {status === "connecting" ? (
            "Connecting…"
          ) : status === "reconnecting" ? (
            "Reconnecting…"
          ) : (
            <>
              <span>Live updates offline.</span>{" "}
              <button type="button" onClick={reconnect}>
                Reconnect
              </button>
            </>
          )}
        </output>
      )}
    </main>
  );
}
