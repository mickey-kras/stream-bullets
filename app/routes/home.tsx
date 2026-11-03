import type { ReactNode } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { configuredProviders, getViewer } from "../server/auth.server";
import { getOwnStreamer, listStreamers } from "../server/data.server";
import { Avatar, EmptyState, SiteHeader } from "../components/common";
import type { Streamer } from "../types";
import { appContext } from "../env";
import { HttpError, queryParams } from "../server/http.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const app = context.get(appContext);
    const cursor = queryParams(request, ["cursor"]).get("cursor");
    const viewer = await getViewer(request, app);
    const [directory, ownStreamer] = await Promise.all([
      listStreamers(app.env, cursor),
      viewer ? getOwnStreamer(app.env, viewer.id) : Promise.resolve(null),
    ]);
    return { viewer, ...directory, cursor, ownStreamer, providers: configuredProviders(app.env) };
  } catch (error: unknown) {
    if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
    throw error;
  }
}

export default function Home(): ReactNode {
  const { viewer, streamers, nextCursor, cursor, ownStreamer, providers } = useLoaderData<typeof loader>();
  return (
    <>
      <SiteHeader viewer={viewer} providers={providers} />
      <main className="page-panel directory-page" id="main-content">
        <span className="eyebrow">YOUR VOICE, ON AIR</span>
        <h1>Pick the next conversation</h1>
        <p>Find your streamer. Suggest topics. Vote. Join the discussion.</p>
        <Link className="button-link gold" to={ownStreamer ? `/@${ownStreamer.handle}` : "/settings"}>
          {ownStreamer ? "Open your community" : "Create a streamer profile"}
        </Link>
        {streamers.length ? (
          <div className="streamer-grid">
            {streamers.map((streamer: Streamer) => (
              <Link className="info-card streamer-card" key={streamer.id} to={`/@${streamer.handle}`}>
                <Avatar name={streamer.name} url={streamer.avatar} />
                <div>
                  <h2>{streamer.name}</h2>
                  <p>@{streamer.handle}</p>
                  <p className="streamer-bio">{streamer.about || "Topics, polls, and good conversations."}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState title={cursor ? "No more streamers." : "The mic is ready."}>
            {cursor
              ? "Return to the first page to browse streamer profiles."
              : "There are no public streamer profiles yet. Create one when you are ready to host."}
          </EmptyState>
        )}
        {(cursor || nextCursor) && (
          <nav aria-label="Streamer pages" className="flex gap-4">
            {cursor && (
              <Link className="button-link" to="/">
                First page
              </Link>
            )}
            {nextCursor && (
              <Link className="button-link" to={`/?cursor=${encodeURIComponent(nextCursor)}`}>
                Next page
              </Link>
            )}
          </nav>
        )}
      </main>
    </>
  );
}
