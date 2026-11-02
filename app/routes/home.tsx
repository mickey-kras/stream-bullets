import type { ReactNode } from 'react';
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { getViewer } from '../server/auth.server';
import { getOwnStreamer, listStreamers } from '../server/data.server';
import { Avatar, EmptyState, SiteHeader } from '../components/common';
import { configuredProviders } from '../server/auth.server';
import type { Streamer } from '../types';
import { appContext } from '../env';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const viewer = await getViewer(request, app);
  const [streamers, ownStreamer] = await Promise.all([
    listStreamers(app.env),
    viewer ? getOwnStreamer(app.env, viewer.id) : Promise.resolve(null),
  ]);
  return { viewer, streamers, ownStreamer, providers: configuredProviders(app.env) };
}

export default function Home(): ReactNode {
  const { viewer, streamers, ownStreamer, providers } = useLoaderData<typeof loader>();
  return <>
    <SiteHeader viewer={viewer} providers={providers} />
    <main className="page-panel directory-page" id="main-content">
      <span className="eyebrow">YOUR VOICE, ON AIR</span>
      <h1>Pick the next conversation</h1>
      <p>Find your streamer. Suggest topics. Vote. Join the discussion.</p>
      <Link className="button-link gold" to={ownStreamer ? `/@${ownStreamer.handle}` : '/settings'}>{ownStreamer ? 'Open your community' : 'Create a streamer profile'}</Link>
      {streamers.length ? <div className="streamer-grid">
        {streamers.map((streamer: Streamer) => <Link className="info-card streamer-card" key={streamer.id} to={`/@${streamer.handle}`}>
          <Avatar name={streamer.name} url={streamer.avatar} />
          <div><h2>{streamer.name}</h2><p>@{streamer.handle}</p><p className="streamer-bio">{streamer.about || 'Topics, polls, and good conversations.'}</p></div>
        </Link>)}
      </div> : <EmptyState title="The mic is ready.">There are no public streamer profiles yet. Create one when you are ready to host.</EmptyState>}
    </main>
  </>;
}
