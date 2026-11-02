import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router';
import { appContext } from '../env';
import { authClient } from '../auth-client';
import { getViewer } from '../server/auth.server';
import { getOwnStreamer } from '../server/data.server';
import { Avatar, SignIn, SiteHeader } from '../components/common';
import { configuredProviders } from '../server/auth.server';
import { errorMessage, postJson, requestJson } from '../components/api';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const viewer = await getViewer(request, app);
  const streamer = viewer ? await getOwnStreamer(app.env, viewer.id) : null;
  return { viewer, streamer, providers: configuredProviders(app.env) };
}

export default function Settings(): ReactNode {
  const { viewer, streamer, providers } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [imageRevision, setImageRevision] = useState<number>(0);

  async function save(event: FormEvent<HTMLFormElement>, endpoint: string): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === 'string') body[key] = value;
    setPending(endpoint);
    setError('');
    setNotice('');
    try {
      await postJson<unknown>(endpoint, body);
      setNotice('Your changes are saved.');
      await revalidator.revalidate();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setPending('');
    }
  }

  async function upload(file: File | undefined, kind: 'avatar' | 'background'): Promise<void> {
    if (!file || pending) return;
    setError('');
    setNotice('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a JPG, PNG, or WebP image no larger than 5 MB.');
      return;
    }
    setPending(kind);
    try {
      await requestJson<{ url: string }>(`/api/images/${kind}`, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      await revalidator.revalidate();
      setImageRevision((revision: number) => revision + 1);
      setNotice(`Your ${kind} is saved.`);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setPending('');
    }
  }

  async function signOut(): Promise<void> {
    setPending('sign-out');
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || 'Could not sign out.');
      window.location.assign('/');
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      setPending('');
    }
  }

  return <>
    <SiteHeader viewer={viewer} providers={providers} />
    <main className="page-panel settings-page" id="main-content">
      <span className="eyebrow">MAKE YOURSELF AT HOME</span>
      <h1>Your profile</h1>
      {!viewer ? <section className="info-card"><h2>Join the conversation</h2><p>Sign in to vote, comment, and save your profile.</p><SignIn providers={providers} /></section> : <>
        <p className="form-error" role="alert">{error}</p>
        <p role="status">{notice || (pending ? 'Saving…' : '')}</p>
        <section className="info-card" aria-labelledby="account-heading">
          <h2 id="account-heading">Your community identity</h2>
          <div className="avatar-preview"><Avatar key={imageRevision} name={viewer.name} url={viewer.avatar ? `${viewer.avatar}?v=${imageRevision}` : null} /><span>{viewer.name}</span></div>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => { void save(event, '/api/account'); }}>
            <label>Display name<input name="name" defaultValue={viewer.name} required minLength={1} maxLength={40} autoComplete="nickname" /></label>
            <button className="gold" disabled={Boolean(pending)} type="submit">Save display name</button>
          </form>
          <label className="upload-field">Profile picture<input type="file" accept="image/png,image/jpeg,image/webp" disabled={Boolean(pending)} onChange={(event) => { void upload(event.currentTarget.files?.[0], 'avatar'); event.currentTarget.value = ''; }} /></label>
          <p className="muted">JPG, PNG, or WebP. Up to 5 MB and 8192 pixels per side.</p>
        </section>
        <section className="info-card" aria-labelledby="streamer-heading">
          <h2 id="streamer-heading">{streamer ? 'Your streamer page' : 'Host a community'}</h2>
          <p>{streamer ? 'Edit the name and details on your public page.' : 'Your account starts as a viewer. Create a streamer profile to claim a public page and run polls.'}</p>
          {streamer && <p><Link className="text-link" to={`/@${streamer.handle}`}>Open /@{streamer.handle}</Link> · <Link className="text-link" to={`/@${streamer.handle}/overlay`}>Open OBS overlay</Link></p>}
          <form key={streamer?.id || 'new'} onSubmit={(event: FormEvent<HTMLFormElement>) => { void save(event, '/api/profile'); }}>
            <label>Handle<input name="handle" defaultValue={streamer?.handle || ''} required minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" autoCapitalize="none" spellCheck={false} aria-describedby="handle-help" /></label>
            <p className="muted" id="handle-help">3–30 lowercase letters, numbers, or underscores. Your page uses /@handle.</p>
            <label>Streamer name<input name="name" defaultValue={streamer?.name || viewer.name} required maxLength={40} /></label>
            <label>About your stream<textarea name="about" defaultValue={streamer?.about || ''} maxLength={2000} rows={5} /></label>
            <button className="gold" type="submit" disabled={Boolean(pending)}>{streamer ? 'Save streamer profile' : 'Create public streamer profile'}</button>
          </form>
          {streamer && <>
            <label className="upload-field">Page background<input type="file" accept="image/png,image/jpeg,image/webp" disabled={Boolean(pending)} onChange={(event) => { void upload(event.currentTarget.files?.[0], 'background'); event.currentTarget.value = ''; }} /></label>
            <p className="muted">Background images are public. JPG, PNG, or WebP, up to 5 MB.</p>
            {streamer.background && <img key={imageRevision} className="background-preview" src={`${streamer.background}?v=${imageRevision}`} alt="Your page background" />}
          </>}
        </section>
        <div className="settings-footer"><Link to="/">Back to streamers</Link><button type="button" disabled={Boolean(pending)} onClick={() => { void signOut(); }}>Sign out</button></div>
      </>}
    </main>
  </>;
}
