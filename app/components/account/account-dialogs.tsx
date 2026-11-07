import type { ReactNode } from "react";
import { t } from "../../i18n";
import { useShell } from "../../lib/shell";
import { SignInDialog } from "../shell/sign-in-dialog";
import { Sheet } from "../ui/sheet";
import { DataDialog } from "./data-dialog";
import { useAccountDialog, type AccountDialogName } from "./dialog-route";
import { EditPageDialog } from "./edit-page-dialog";
import { HostDialog } from "./host-dialog";
import { useMe } from "./me";
import { ProfileDialog } from "./profile-dialog";

const titles: Record<
  AccountDialogName,
  "account.yourProfile" | "account.hostCommunity" | "account.yourData" | "account.editPage"
> = {
  profile: "account.yourProfile",
  host: "account.hostCommunity",
  data: "account.yourData",
  page: "account.editPage",
};

/**
 * The account dialogs over any page (item 17): Your profile, Host a community, Your data and Edit your page,
 * opened by `?dialog=<name>` (the account menu links there, and /settings redirects to
 * /streamers?dialog=profile). Signed out, they ask to sign in and come back here.
 */
export function AccountDialogs(): ReactNode {
  const shell = useShell();
  const { name, close } = useAccountDialog();
  const { me, error, reload } = useMe(Boolean(name && shell.viewer));
  if (!name) return null;
  if (!shell.viewer)
    return (
      <SignInDialog
        open
        onOpenChange={(open: boolean) => {
          if (!open) close();
        }}
        providers={shell.providers}
      />
    );
  // Your profile and Your data open straight away from the shell; the sign-in provider fills in when loaded.
  if (name === "profile")
    return <ProfileDialog viewer={shell.viewer} provider={me?.signInProvider ?? null} onClose={close} />;
  if (name === "data")
    return <DataDialog provider={me?.signInProvider ?? null} owner={Boolean(shell.ownStreamer)} onClose={close} />;
  if (!me?.viewer)
    return (
      <Sheet
        open
        short
        name={name}
        title={t(titles[name])}
        onOpenChange={(open: boolean) => {
          if (!open) close();
        }}
      >
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <output className="muted">{t("account.loading")}</output>
        )}
      </Sheet>
    );
  const viewer = me.viewer;
  if (name === "host") {
    // Owners already host a page: send them to Edit your page instead.
    if (me.streamer)
      return <EditPageDialog streamer={me.streamer} support={me.support} viewer={viewer} onClose={close} />;
    return <HostDialog viewer={viewer} access={me.access} onSaved={reload} onClose={close} />;
  }
  if (!me.streamer) return <HostDialog viewer={viewer} access={me.access} onSaved={reload} onClose={close} />;
  return <EditPageDialog streamer={me.streamer} support={me.support} viewer={viewer} onClose={close} />;
}
