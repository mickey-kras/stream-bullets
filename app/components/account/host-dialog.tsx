import { useState, type FormEvent, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { t } from "../../i18n";
import type { Streamer, StreamerAccess, Viewer } from "../../types";
import { errorMessage, postJson, sendJson } from "../api";
import { Icon } from "../ui/icon";
import { Req, RequiredNote } from "../ui/required";
import { Sheet } from "../ui/sheet";
import { useToast } from "../ui/toast";
import { StreamerWaitlist } from "../waitlist";

/**
 * "Host a community" (item 17): the waitlist request and its states (pending, not approved), or, once
 * approved (or for an admin), claiming a handle to create the page with `POST /api/streamer`.
 */
export function HostDialog({
  viewer,
  access,
  onSaved,
  onClose,
}: Readonly<{
  viewer: Viewer;
  access: StreamerAccess | null;
  /** Reloads the dialog's data after a request is sent. */
  onSaved: () => Promise<void>;
  onClose: () => void;
}>): ReactNode {
  const toast = useToast();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  async function request(input: { links: string[]; note: string }): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError("");
    const updating: boolean = access?.application?.status === "pending";
    try {
      await postJson<unknown>("/api/application", input);
      await onSaved();
      toast(updating ? t("host.updated") : t("host.sent"));
      return true;
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function claim(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string): string => {
      const field: FormDataEntryValue | null = form.get(key);
      return typeof field === "string" ? field.trim() : "";
    };
    setPending(true);
    setError("");
    try {
      const { streamer } = await sendJson<{ streamer: Streamer }>("POST", "/api/streamer", {
        handle: value("handle"),
        name: value("name"),
        about: value("about"),
      });
      await revalidator.revalidate();
      toast(t("host.created", { handle: streamer.handle }));
      onClose();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      name="host"
      title={t("account.hostCommunity")}
    >
      <p className="form-error" role="alert">
        {error}
      </p>
      {access?.canCreateStreamer ? (
        <>
          <p>
            {access.admin && access.application?.status !== "approved" ? t("host.adminBody") : t("host.approvedBody")}
          </p>
          <form onSubmit={(event: FormEvent<HTMLFormElement>) => void claim(event)}>
            <RequiredNote />
            <label>
              <span>
                {t("host.handle")}
                <Req />
              </span>
              <input
                name="handle"
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
              {t("host.handleHelp")}
            </p>
            <label>
              <span>
                {t("host.name")}
                <Req />
              </span>
              <input name="name" defaultValue={viewer.name} required maxLength={40} />
            </label>
            <label>
              <span>{t("host.about")}</span>
              <textarea name="about" maxLength={2000} rows={5} />
            </label>
            <button className="gold" type="submit" disabled={pending}>
              <Icon name="send" size={18} />
              {t("host.create")}
            </button>
          </form>
        </>
      ) : (
        <StreamerWaitlist application={access?.application ?? null} disabled={pending} onSubmit={request} />
      )}
    </Sheet>
  );
}
