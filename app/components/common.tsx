import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Dialog } from "radix-ui";
import { authClient } from "../auth-client";
import type { Streamer, Viewer } from "../types";
import { errorMessage } from "./api";

export type Provider = "google" | "twitch";

export function Avatar({
  name,
  url,
  className = "",
}: {
  name: string;
  url: string | null;
  className?: string;
}): ReactNode {
  return url ? (
    <img className={`user-avatar ${className}`} src={url} alt="" loading="lazy" />
  ) : (
    <span className={`user-avatar avatar-initial ${className}`} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "S"}
    </span>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}): ReactNode {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal-content"
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
        >
          <Dialog.Close className="modal-close" aria-label="Close dialog">
            ×
          </Dialog.Close>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SignIn({
  providers,
  callbackURL = "/settings",
}: {
  providers: Provider[];
  callbackURL?: string;
}): ReactNode {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string>("");
  async function signIn(provider: Provider): Promise<void> {
    setError("");
    setPending(provider);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (result.error) throw new Error(result.error.message || "Sign-in failed. Please try again.");
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="sign-in-options">
      {providers.map((provider: Provider) => (
        <button
          type="button"
          className="gold"
          disabled={pending !== null}
          key={provider}
          onClick={() => {
            void signIn(provider);
          }}
        >
          {pending === provider ? "Connecting…" : `Continue with ${provider === "google" ? "Google" : "Twitch"}`}
        </button>
      ))}
      {providers.length === 0 && <output>Sign-in is not available yet.</output>}
      <p className="form-error" role="alert">
        {error}
      </p>
    </div>
  );
}

export function AccountControls({ viewer, providers }: { viewer: Viewer | null; providers: Provider[] }): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  return viewer ? (
    <Link className="profile" to="/settings" aria-label={`Account settings for ${viewer.name}`}>
      <Avatar name={viewer.name} url={viewer.avatar} />
    </Link>
  ) : (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Sign in
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Join the conversation"
        description="Sign in to suggest topics, vote, and comment."
      >
        <SignIn providers={providers} />
      </Modal>
    </>
  );
}

export function SiteHeader({
  viewer,
  providers,
  streamer,
  children,
}: {
  viewer: Viewer | null;
  providers: Provider[];
  streamer?: Streamer;
  children?: ReactNode;
}): ReactNode {
  return (
    <header className="site-header">
      <Link
        className="brand"
        to={streamer ? `/@${streamer.handle}` : "/"}
        aria-label={streamer ? `${streamer.name} home` : "StreamBullets home"}
      >
        {streamer ? (
          <Avatar className="brand-avatar" name={streamer.name} url={streamer.avatar} />
        ) : (
          <span className="brand-name">
            Stream
            <br />
            Bullets
          </span>
        )}
      </Link>
      {children || (
        <nav aria-label="Main navigation">
          <Link to="/">Streamers</Link>
          <Link to="/settings">Your profile</Link>
        </nav>
      )}
      <div className="header-end">
        <AccountControls viewer={viewer} providers={providers} />
      </div>
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
