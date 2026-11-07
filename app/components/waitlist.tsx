import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StreamerApplication } from "../types";
import { intlLocale } from "../i18n";
import { Icon } from "./ui/icon";

const MAX_LINKS = 5;

interface LinkRow {
  key: string;
  value: string;
}

/** Formats a timestamp the same way on the server and in the browser, so hydration matches. */
export function formatDate(time: number): string {
  return new Date(time).toLocaleDateString(intlLocale(), { timeZone: "UTC", dateStyle: "medium" });
}

export function DateTime({ time }: Readonly<{ time: number }>): ReactNode {
  return <time dateTime={new Date(time).toISOString()}>{formatDate(time)}</time>;
}

function ApplicationStatusNote({ application }: Readonly<{ application: StreamerApplication }>): ReactNode {
  if (application.status === "rejected")
    return (
      <div className="application-status rejected">
        <strong>
          <Icon name="rejected" size={18} />
          Not approved this time.
        </strong>
        <p>
          Your request from <DateTime time={application.updatedAt} /> was not approved. You can update your links or
          note and send it again.
        </p>
      </div>
    );
  return (
    <div className="application-status pending">
      <strong>
        <Icon name="pending" size={18} />
        Request received.
      </strong>
      <p>
        We&apos;ll review your request. Submitted <DateTime time={application.updatedAt} />. You can still update it
        while you wait.
      </p>
    </div>
  );
}

/** The waitlist form for accounts that cannot create a streamer profile yet. */
export function StreamerWaitlist({
  application,
  disabled,
  onSubmit,
}: Readonly<{
  application: StreamerApplication | null;
  disabled: boolean;
  onSubmit: (input: { links: string[]; note: string }) => Promise<boolean>;
}>): ReactNode {
  const makeRow = (value: string): LinkRow => ({ key: crypto.randomUUID(), value });
  const [rows, setRows] = useState<LinkRow[]>(() =>
    (application?.links.length ? application.links : [""]).map((value: string) => makeRow(value)),
  );
  const [note, setNote] = useState<string>(application?.note ?? "");
  // Focus moves from event handlers: an added row focuses itself when it mounts.
  const pendingFocus = useRef<string | null>(null);
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());

  function addRow(): void {
    if (rows.length >= MAX_LINKS) return;
    const row = makeRow("");
    pendingFocus.current = row.key;
    setRows([...rows, row]);
  }

  function removeRow(index: number): void {
    if (rows.length <= 1) return;
    const remaining = rows.filter((_row: LinkRow, position: number) => position !== index);
    setRows(remaining);
    inputs.current.get(remaining[Math.max(0, index - 1)].key)?.focus();
  }

  function updateRow(key: string, value: string): void {
    setRows((current: LinkRow[]) => current.map((item: LinkRow) => (item.key === key ? { ...item, value } : item)));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const links = rows.map((row: LinkRow) => row.value.trim()).filter(Boolean);
    await onSubmit({ links, note: note.trim() });
  }

  let submitLabel = "Request to host";
  if (application?.status === "pending") submitLabel = "Update request";
  if (application?.status === "rejected") submitLabel = "Send request again";

  return (
    <>
      <p>
        Hosting a community is invite-only for now. Tell us where you stream and we&apos;ll let you know when you can
        claim your page. You can keep voting and commenting as a viewer in the meantime.
      </p>
      {application && <ApplicationStatusNote application={application} />}
      <form
        className="waitlist-form"
        aria-label="Host a community request"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          void submit(event);
        }}
      >
        <fieldset>
          <legend>Your channels</legend>
          <p className="muted" id="channel-links-help">
            Add 1–{MAX_LINKS} HTTPS links to channels you stream on, such as Twitch, YouTube, or Kick.
          </p>
          <ul className="link-rows">
            {rows.map((row: LinkRow, index: number) => (
              <li key={row.key}>
                <label>
                  <span>Channel link {index + 1}</span>
                  <input
                    ref={(element: HTMLInputElement | null) => {
                      if (!element) {
                        inputs.current.delete(row.key);
                        return;
                      }
                      inputs.current.set(row.key, element);
                      if (pendingFocus.current === row.key) {
                        pendingFocus.current = null;
                        element.focus();
                      }
                    }}
                    type="url"
                    name="links"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://twitch.tv/yourchannel"
                    pattern="https://.+"
                    title="Use an HTTPS link, starting with https://"
                    maxLength={200}
                    required
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-describedby="channel-links-help"
                    value={row.value}
                    onChange={(event) => {
                      updateRow(row.key, event.currentTarget.value);
                    }}
                  />
                </label>
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="remove-link"
                    aria-label={`Remove channel link ${index + 1}`}
                    onClick={() => removeRow(index)}
                  >
                    <Icon name="close" size={16} />
                    <span className="remove-text">Remove</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {rows.length < MAX_LINKS ? (
            <button type="button" onClick={addRow}>
              <Icon name="plus" size={16} />
              Add another link
            </button>
          ) : (
            <p className="muted">You can add up to {MAX_LINKS} links.</p>
          )}
        </fieldset>
        <label>
          <span>Anything else we should know? (optional)</span>
          <textarea
            name="note"
            value={note}
            maxLength={1000}
            rows={4}
            aria-describedby="note-help"
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <p className="muted" id="note-help">
          For example, your schedule or the community you want to host. Up to 1000 characters.
        </p>
        <button className="gold" type="submit" disabled={disabled}>
          <Icon name="send" size={18} />
          {submitLabel}
        </button>
      </form>
    </>
  );
}
