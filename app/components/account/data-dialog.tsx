import { useState, type FormEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import type { Provider } from "../../types";
import { errorMessage, postJson } from "../api";
import { providerName } from "../shell/sign-in-dialog";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { SignedInWith } from "./profile-dialog";

const CONFIRMATION = "DELETE";

/** Typing "delete" in any case confirms (review m21). */
export function confirmsDeletion(value: string): boolean {
  return value.trim().toUpperCase() === CONFIRMATION;
}

/** What deleting removes, worded for this account: page owners and viewers have different things (m21). */
export function deletionItems(input: { provider: Provider | null; owner: boolean }): string[] {
  const items: string[] = [
    t("data.delete.profile"),
    input.provider
      ? t("data.delete.signInProvider", { provider: providerName[input.provider] })
      : t("data.delete.signIn"),
    input.owner ? t("data.delete.ownerEntries") : t("data.delete.viewerEntries"),
    t("data.delete.activity"),
  ];
  if (input.owner) items.push(t("data.delete.page"), t("data.delete.ownerImages"));
  else items.push(t("data.delete.request"), t("data.delete.viewerImages"));
  return items;
}

/**
 * "Your data" (item 17): download the JSON export, or step into "Delete your account?" inside the same
 * dialog. The delete step lists what goes (for this account's role) and needs DELETE typed to enable.
 */
export function DataDialog({
  provider,
  owner,
  onClose,
}: Readonly<{ provider: Provider | null; owner: boolean; onClose: () => void }>): ReactNode {
  const [step, setStep] = useState<"data" | "delete">("data");
  const [confirmation, setConfirmation] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const confirmed: boolean = confirmsDeletion(confirmation);

  async function remove(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || !confirmed) return;
    setPending(true);
    setError("");
    try {
      await postJson<{ deleted: true }>("/api/account/delete", { confirm: CONFIRMATION });
      globalThis.location.assign("/");
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setPending(false);
    }
  }

  const deleting: boolean = step === "delete";
  return (
    <Sheet
      open
      short={!deleting}
      onOpenChange={(open: boolean) => {
        if (!open && !pending) onClose();
      }}
      name="data"
      title={deleting ? t("data.deleteTitle") : t("account.yourData")}
      description={deleting ? t("data.deleteDescription") : undefined}
      onBack={deleting && !pending ? () => setStep("data") : undefined}
      actions={
        deleting ? (
          <DialogActions cancel={false} className="keep-first">
            <button type="button" disabled={pending} onClick={() => setStep("data")}>
              {t("data.keep")}
            </button>
            <button className="danger" type="submit" form="delete-account-form" disabled={pending || !confirmed}>
              <Icon name="trash" size={18} />
              {deleteLabel(pending, confirmed)}
            </button>
          </DialogActions>
        ) : undefined
      }
    >
      {deleting ? (
        <>
          <p>{t("data.deleteDescription")}</p>
          <p>{t("data.weDelete")}</p>
          <ul className="deletion-list">
            {deletionItems({ provider, owner }).map((item: string) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>{t("data.repliesStay")}</p>
          <form id="delete-account-form" onSubmit={(event: FormEvent<HTMLFormElement>) => void remove(event)}>
            <label>
              <span>{t("data.typeDelete")}</span>
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
          </form>
        </>
      ) : (
        <>
          <SignedInWith provider={provider} />
          <p>{t("data.downloadBody")}</p>
          <a className="button-link" href="/api/account/export" download>
            <Icon name="download" size={18} />
            {t("data.download")}
          </a>
          <p>{t("data.deleteBody")}</p>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setConfirmation("");
              setError("");
              setStep("delete");
            }}
          >
            <Icon name="trash" size={18} />
            {t("data.deleteAccount")}
          </button>
        </>
      )}
    </Sheet>
  );
}

function deleteLabel(pending: boolean, confirmed: boolean): string {
  if (pending) return t("data.deleting");
  return confirmed ? t("data.deleteAccount") : t("data.typeToEnable");
}
