import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StreamerApplication } from "../types";
import { intlLocale, t } from "../i18n";
import { Icon } from "./ui/icon";
import { Req, RequiredNote } from "./ui/required";

const MAX_LINKS = 5;

interface LinkRow {
  key: string;
  value: string;
}

// Use identical timestamp formatting during SSR and hydration.
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
          {t("waitlist.rejected")}
        </strong>
        <p>{t("waitlist.rejectedBody", { date: formatDate(application.updatedAt) })}</p>
      </div>
    );
  return (
    <div className="application-status pending">
      <strong>
        <Icon name="pending" size={18} />
        {t("waitlist.received")}
      </strong>
      <p>{t("waitlist.receivedBody", { date: formatDate(application.updatedAt) })}</p>
    </div>
  );
}

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
  // New rows take focus on mount.
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

  let submitLabel: string = t("waitlist.request");
  if (application?.status === "pending") submitLabel = t("waitlist.update");
  if (application?.status === "rejected") submitLabel = t("waitlist.sendAgain");

  return (
    <>
      <p>{t("waitlist.intro")}</p>
      {application && <ApplicationStatusNote application={application} />}
      <form
        className="waitlist-form"
        aria-label={t("waitlist.formLabel")}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          void submit(event);
        }}
      >
        <RequiredNote />
        <fieldset>
          <legend>{t("waitlist.channels")}</legend>
          <p className="muted" id="channel-links-help">
            {t("waitlist.channelsHelp", { n: MAX_LINKS })}
          </p>
          <ul className="link-rows">
            {rows.map((row: LinkRow, index: number) => (
              <li key={row.key}>
                <label>
                  <span>
                    {t("waitlist.channelLink", { n: index + 1 })}
                    <Req />
                  </span>
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
                    title={t("waitlist.httpsHint")}
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
                    aria-label={t("waitlist.removeLink", { n: index + 1 })}
                    onClick={() => removeRow(index)}
                  >
                    <Icon name="close" size={16} />
                    <span className="remove-text">{t("waitlist.remove")}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {rows.length < MAX_LINKS ? (
            <button type="button" onClick={addRow}>
              <Icon name="plus" size={16} />
              {t("waitlist.addLink")}
            </button>
          ) : (
            <p className="muted">{t("waitlist.maxLinks", { n: MAX_LINKS })}</p>
          )}
        </fieldset>
        <label>
          <span>{t("waitlist.note")}</span>
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
          {t("waitlist.noteHelp")}
        </p>
        <button className="gold" type="submit" disabled={disabled}>
          <Icon name="send" size={18} />
          {submitLabel}
        </button>
      </form>
    </>
  );
}
