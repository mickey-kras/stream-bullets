import { createElement, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { useShell } from "../../lib/shell";
import { PreferencesDialog } from "../a11y/preferences-dialog";
import { NotificationsDialog } from "../notifications";
import { LanguageDialog } from "../shell/language-dialog";
import { SignInDialog } from "../shell/sign-in-dialog";
import { Sheet } from "../ui/sheet";
import { DataDialog } from "./data-dialog";
import { useAccountDialog, type AccountDialogName } from "./dialog-route";
import { EditPageDialog } from "./edit-page-dialog";
import { HostDialog } from "./host-dialog";
import { useMe } from "./me";
import { ProfileDialog } from "./profile-dialog";

const titles: Record<AccountDialogName, MessageId> = {
  profile: "account.yourProfile",
  host: "account.hostCommunity",
  data: "account.yourData",
  page: "account.editPage",
  language: "language.title",
  a11y: "prefs.title",
  notifications: "notifications.title",
};

// These dialogs need no account.
const OPEN_DIALOGS: Partial<Record<AccountDialogName, (props: Readonly<{ onClose: () => void }>) => ReactNode>> = {
  language: LanguageDialog,
  a11y: PreferencesDialog,
};

// These dialogs do not read the account data of the viewer.
const WITHOUT_ACCOUNT_DATA: ReadonlySet<AccountDialogName> = new Set<AccountDialogName>([
  "language",
  "a11y",
  "notifications",
]);

// Account dialogs overlay any page through ?dialog=. Signed-out users return after sign-in; language/display
// dialogs work signed out.
export function AccountDialogs(): ReactNode {
  const shell = useShell();
  const { name, close } = useAccountDialog();
  const account: boolean = name !== null && !WITHOUT_ACCOUNT_DATA.has(name);
  const { me, error, reload } = useMe(account && Boolean(shell.viewer));
  if (!name) return null;
  const open = OPEN_DIALOGS[name];
  if (open) return createElement(open, { onClose: close });
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
  if (name === "notifications") return <NotificationsDialog onClose={close} />;
  // Open profile/data immediately; fill provider details after loading.
  if (name === "profile")
    return <ProfileDialog viewer={shell.viewer} provider={me?.signInProvider ?? null} onClose={close} />;
  if (name === "data")
    return (
      <DataDialog
        provider={me?.signInProvider ?? null}
        providers={shell.providers}
        owner={Boolean(shell.ownStreamer)}
        onClose={close}
      />
    );
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
    // Existing owners edit their page instead of applying.
    if (me.streamer)
      return <EditPageDialog streamer={me.streamer} support={me.support} viewer={viewer} onClose={close} />;
    return <HostDialog viewer={viewer} access={me.access} onSaved={reload} onClose={close} />;
  }
  if (!me.streamer) return <HostDialog viewer={viewer} access={me.access} onSaved={reload} onClose={close} />;
  return <EditPageDialog streamer={me.streamer} support={me.support} viewer={viewer} onClose={close} />;
}
