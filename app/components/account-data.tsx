import { useState, type FormEvent, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { errorMessage, postJson } from "./api";

const CONFIRMATION = "DELETE";

function DeleteAccountDialog(): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [confirmation, setConfirmation] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  function changeOpen(next: boolean): void {
    if (pending) return;
    setOpen(next);
    setConfirmation("");
    setError("");
  }

  async function remove(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || confirmation !== CONFIRMATION) return;
    setPending(true);
    setError("");
    try {
      await postJson<{ deleted: true }>("/api/account/delete", { confirm: confirmation });
      globalThis.location.assign("/");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={changeOpen}>
      <AlertDialog.Trigger asChild>
        <button type="button" className="danger">
          Delete my account
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="modal-backdrop" />
        <AlertDialog.Content className="modal-content">
          <AlertDialog.Title>Delete your account?</AlertDialog.Title>
          <AlertDialog.Description>
            This permanently deletes your account. You can't undo it, and we can't restore it.
          </AlertDialog.Description>
          <p>We delete:</p>
          <ul className="deletion-list">
            <li>Your profile, display name, and email address</li>
            <li>Your Google and Twitch sign-in links and every signed-in session</li>
            <li>Topics and polls you created, with their discussions</li>
            <li>Your comments, votes, reactions, and comment likes</li>
            <li>Your streamer page and everything posted on it</li>
            <li>Your streamer waitlist application</li>
            <li>Your uploaded profile picture and page background</li>
          </ul>
          <p>Replies other people wrote under your comments stay, without your comment above them.</p>
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              void remove(event);
            }}
          >
            <label>
              <span>Type {CONFIRMATION} to confirm</span>
              <input
                name="confirm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                aria-describedby="delete-account-error"
              />
            </label>
            <p className="form-error" id="delete-account-error" role="alert">
              {error}
            </p>
            <div className="modal-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" disabled={pending}>
                  Keep my account
                </button>
              </AlertDialog.Cancel>
              <button className="danger" type="submit" disabled={pending || confirmation !== CONFIRMATION}>
                {pending ? "Deleting…" : "Delete my account"}
              </button>
            </div>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function AccountData(): ReactNode {
  return (
    <section className="info-card" aria-labelledby="data-heading">
      <h2 id="data-heading">Your data</h2>
      <p>Download a copy of everything we hold about your account as a JSON file.</p>
      <a className="button-link" href="/api/account/export" download>
        Download my data
      </a>
      <p>Deleting your account removes your profile and everything you posted. You can't undo it.</p>
      <DeleteAccountDialog />
    </section>
  );
}
