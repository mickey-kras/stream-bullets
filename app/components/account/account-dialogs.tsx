import type { ReactNode } from "react";
import { t } from "../../i18n";
import { useShell } from "../../lib/shell";
import { PreferencesDialog } from "../a11y/preferences-dialog";
import { LanguageDialog } from "../shell/language-dialog";
import { SignInDialog } from "../shell/sign-in-dialog";
import { Sheet } from "../ui/sheet";
import { DataDialog } from "./data-dialog";
import { useAccountDialog, type AccountDialogName } from "./dialog-route";
import { EditPageDialog } from "./edit-page-dialog";
import { HostDialog } from "./host-dialog";
import { useMe } from "./me";
import { ProfileDialog } from "./profile-dialog";

const titles: Record<
  Exclude<AccountDialogName, "language" | "a11y">,
  "account.yourProfile" | "account.hostCommunity" | "account.yourData" | "account.editPage"
> = {
  profile: "account.yourProfile",
  host: "account.hostCommunity",
  data: "account.yourData",
  page: "account.editPage",
};

// Account dialogs overlay any page through ?dialog=. Signed-out users return after sign-in; language/display
// dialogs work signed out.
export function AccountDialogs(): ReactNode {
  const shell = useShell();
  const { name, close } = useAccountDialog();
  const account: boolean = name !== null && name !== "language" && name !== "a11y";
  const { me, error, reload } = useMe(account && Boolean(shell.viewer));
  if (name === "language") return <LanguageDialog onClose={close} />;
  if (name === "a11y") return <PreferencesDialog onClose={close} />;
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
