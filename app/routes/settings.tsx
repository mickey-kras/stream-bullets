import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { authClient } from "../auth-client";
import { configuredProviders, getViewer } from "../server/auth.server";
import { getOwnStreamer } from "../server/data.server";
import { Avatar, SignIn, SiteHeader } from "../components/common";
import { errorMessage, postJson, requestJson } from "../components/api";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const viewer = await getViewer(request, app);
  const streamer = viewer ? await getOwnStreamer(app.env, viewer.id) : null;
  return { viewer, streamer, providers: configuredProviders(app.env) };
}

function ImageUpload({
  label,
  disabled,
  onUpload,
}: Readonly<{
  label: string;
  disabled: boolean;
  onUpload: (file: File | undefined) => Promise<void>;
}>): ReactNode {
  return (
    <label className="upload-field">
      {label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        onChange={(event) => {
          void onUpload(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

export default function Settings(): ReactNode {
  const { viewer, streamer, providers } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [imageRevision, setImageRevision] = useState<number>(0);

  async function save(event: FormEvent<HTMLFormElement>, endpoint: string): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") body[key] = value;
    setPending(endpoint);
    setError("");
    setNotice("");
    try {
      await postJson<unknown>(endpoint, body);
      setNotice("Your changes are saved.");
      await revalidator.revalidate();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending("");
    }
  }

  async function upload(file: File | undefined, kind: "avatar" | "background"): Promise<void> {
    if (!file || pending) return;
    setError("");
    setNotice("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError("Choose a JPG, PNG, or WebP image no larger than 5 MB.");
      return;
    }
    setPending(kind);
    try {
      await requestJson<{ url: string }>(`/api/images/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      await revalidator.revalidate();
      setImageRevision((revision: number) => revision + 1);
      setNotice(`Your ${kind} is saved.`);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending("");
    }
  }

  async function signOut(): Promise<void> {
    setPending("sign-out");
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Could not sign out.");
      globalThis.location.assign("/");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending("");
    }
  }

  return (
    <>
      <SiteHeader viewer={viewer} providers={providers} />
      <main className="page-panel settings-page" id="main-content">
        <span className="eyebrow">MAKE YOURSELF AT HOME</span>
        <h1>Your profile</h1>
        {viewer ? (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <output>{notice || (pending ? "Saving…" : "")}</output>
            <section className="info-card" aria-labelledby="account-heading">
              <h2 id="account-heading">Your community identity</h2>
              <div className="avatar-preview">
                <Avatar
                  key={imageRevision}
                  name={viewer.name}
                  url={viewer.avatar ? `${viewer.avatar}?v=${imageRevision}` : null}
                />
                <span>{viewer.name}</span>
              </div>
              <form
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  void save(event, "/api/account");
                }}
              >
                <label>
                  <span>Display name</span>
                  <input
                    name="name"
                    defaultValue={viewer.name}
                    required
                    minLength={1}
                    maxLength={40}
                    autoComplete="nickname"
                  />
                </label>
                <button className="gold" disabled={Boolean(pending)} type="submit">
                  Save display name
                </button>
              </form>
              <ImageUpload
                label="Profile picture"
                disabled={Boolean(pending)}
                onUpload={(file: File | undefined) => upload(file, "avatar")}
              />
              <p className="muted">JPG, PNG, or WebP. Up to 5 MB and 8192 pixels per side.</p>
            </section>
            <section className="info-card" aria-labelledby="streamer-heading">
              <h2 id="streamer-heading">{streamer ? "Your streamer page" : "Host a community"}</h2>
              <p>
                {streamer
                  ? "Edit the name and details on your public page."
                  : "Your account starts as a viewer. Create a streamer profile to claim a public page and run polls."}
              </p>
              {streamer && (
                <p>
                  <Link className="text-link" to={`/@${streamer.handle}`}>
                    Open /@{streamer.handle}
                  </Link>{" "}
                  ·{" "}
                  <Link className="text-link" to={`/@${streamer.handle}/overlay`}>
                    Open OBS overlay
                  </Link>
                </p>
              )}
              <form
                key={streamer?.id || "new"}
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  void save(event, "/api/profile");
                }}
              >
                <label>
                  <span>Handle</span>
                  <input
                    name="handle"
                    defaultValue={streamer?.handle || ""}
                    required
                    minLength={3}
                    maxLength={30}
                    pattern="[a-z0-9_]{3,30}"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="handle-help"
                  />
                </label>
                <p className="muted" id="handle-help">
                  3–30 lowercase letters, numbers, or underscores. Your page uses /@handle.
                </p>
                <label>
                  <span>Streamer name</span>
                  <input name="name" defaultValue={streamer?.name || viewer.name} required maxLength={40} />
                </label>
                <label>
                  <span>About your stream</span>
                  <textarea name="about" defaultValue={streamer?.about || ""} maxLength={2000} rows={5} />
                </label>
                <button className="gold" type="submit" disabled={Boolean(pending)}>
                  {streamer ? "Save streamer profile" : "Create public streamer profile"}
                </button>
              </form>
              {streamer && (
                <>
                  <ImageUpload
                    label="Page background"
                    disabled={Boolean(pending)}
                    onUpload={(file: File | undefined) => upload(file, "background")}
                  />
                  <p className="muted">Background images are public. JPG, PNG, or WebP, up to 5 MB.</p>
                  {streamer.background && (
                    <img
                      key={imageRevision}
                      className="background-preview"
                      src={`${streamer.background}?v=${imageRevision}`}
                      alt="Your page background"
                    />
                  )}
                </>
              )}
            </section>
            <div className="settings-footer">
              <Link to="/">Back to streamers</Link>
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() => {
                  void signOut();
                }}
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <section className="info-card">
            <h2>Join the conversation</h2>
            <p>Sign in to vote, comment, and save your profile.</p>
            <SignIn providers={providers} />
          </section>
        )}
      </main>
    </>
  );
}
