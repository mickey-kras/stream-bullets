import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import type { SecurityKey, StepUpStatus } from "../../admin-types";
import { t } from "../../i18n";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { DateTime } from "../waitlist";
import { KeyConfirm } from "./key-confirm";
import { adminRequest, ceremonyError, errorText, registerKey, webAuthnAvailable } from "./webauthn";

/* Security keys (item 29): first-time setup with two keys, then the Security keys tab (add, rename, remove). */

const NAME_MAX = 40;

/** The name field and the "touch your key" button. Registers on submit and reloads the admin data. */
function RegisterForm({
  defaultName,
  submitLabel,
  onRegistered,
}: Readonly<{ defaultName: string; submitLabel: string; onRegistered: () => Promise<void> }>): ReactNode {
  const [waiting, setWaiting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (waiting) return;
    if (!webAuthnAvailable()) {
      setError(t("keys.unsupported"));
      return;
    }
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setWaiting(true);
    setError("");
    try {
      await registerKey(name);
      await onRegistered();
    } catch (error_: unknown) {
      setError(ceremonyError(error_));
    } finally {
      setWaiting(false);
    }
  }

  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label>
        <span>{t("keys.name")}</span>
        <input name="name" maxLength={NAME_MAX} required defaultValue={defaultName} autoComplete="off" />
      </label>
      <p className="form-error" role="alert">
        {error}
      </p>
      {waiting ? (
        <output className="key-wait">
          <span className="key-pulse">
            <Icon name="key" size={40} />
          </span>
          {t("keys.touchToRegister")}
        </output>
      ) : (
        <button className="gold" type="submit">
          <Icon name="key" size={20} />
          {submitLabel}
        </button>
      )}
    </form>
  );
}

/** First-time setup: add a first key, then a backup key. Admin stays locked (under enforce) until both exist. */
export function KeySetup({
  status,
  keys,
  standalone = false,
}: Readonly<{ status: StepUpStatus; keys: SecurityKey[]; standalone?: boolean }>): ReactNode {
  const revalidator = useRevalidator();
  const [confirmed, setConfirmed] = useState<boolean>(false);
  const step: number = Math.min(keys.length + 1, 3);
  const steps: string[] = [t("keys.stepFirst"), t("keys.stepBackup"), t("keys.stepDone")];
  const reload = async (): Promise<void> => {
    await revalidator.revalidate();
  };

  let body: ReactNode;
  if (step === 3) {
    body = (
      <>
        <h2>{t("keys.doneTitle")}</h2>
        <ul className="key-list compact">
          {keys.map((key: SecurityKey) => (
            <li key={key.id}>
              <Icon name="key" size={20} />
              <strong>{key.name}</strong>
              <span className="muted">{t("keys.type")}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{t("keys.backupHint")}</p>
        <Link className="button-link gold" to="/admin">
          <Icon name="arrow-right" size={18} />
          {t("keys.openAdmin")}
        </Link>
      </>
    );
  } else if (status.registerBlock === "sign_in_again") {
    body = (
      <>
        <h2>{t("keys.stepFirst")}</h2>
        <p className="form-error" role="alert">
          {t("keys.signInAgain")}
        </p>
      </>
    );
  } else if (status.registerBlock === "step_up" && !confirmed) {
    body = (
      <>
        <h2>{t("keys.stepBackup")}</h2>
        <p className="muted">{t("keys.confirmFirst")}</p>
        <KeyConfirm inDialog onConfirmed={() => setConfirmed(true)} />
      </>
    );
  } else {
    const first: boolean = step === 1;
    body = (
      <>
        <h2>{first ? t("keys.stepFirst") : t("keys.stepBackup")}</h2>
        <p className="muted">{first ? t("keys.firstHint") : t("keys.backupHint")}</p>
        <RegisterForm
          key={step}
          defaultName={first ? t("keys.defaultFirst") : t("keys.defaultBackup")}
          submitLabel={t("keys.touchToRegisterButton")}
          onRegistered={reload}
        />
      </>
    );
  }

  return (
    <>
      {standalone && (
        <>
          <span className="eyebrow">{t("keys.setupEyebrow")}</span>
          <h1>{t("keys.setupTitle")}</h1>
        </>
      )}
      {!standalone && <p>{t("keys.setupIntro")}</p>}
      <ol className="key-steps">
        {steps.map((label: string, index: number) => {
          const number = index + 1;
          const state = number < step ? "done" : number === step ? "current" : "";
          return (
            <li key={label} className={state} aria-current={number === step ? "step" : undefined}>
              <span>{number < step ? <Icon name="check" size={16} /> : number}</span>
              {label}
            </li>
          );
        })}
      </ol>
      <section className="info-card key-setup" aria-live="polite">
        {body}
      </section>
    </>
  );
}

type KeyDialog = { kind: "add" } | { kind: "rename"; key: SecurityKey } | { kind: "remove"; key: SecurityKey } | null;

function AddKeySheet({
  status,
  onClose,
  onDone,
}: Readonly<{ status: StepUpStatus; onClose: () => void; onDone: (name: string) => Promise<void> }>): ReactNode {
  const [confirmed, setConfirmed] = useState<boolean>(false);
  let body: ReactNode;
  if (status.registerBlock === "limit") body = <p className="form-error">{t("keys.limit")}</p>;
  else if (status.registerBlock === "step_up" && !confirmed)
    body = (
      <>
        <p>{t("keys.confirmFirst")}</p>
        <KeyConfirm inDialog onConfirmed={() => setConfirmed(true)} />
      </>
    );
  else
    body = (
      <RegisterForm
        defaultName={t("keys.defaultExtra")}
        submitLabel={t("keys.touchNew")}
        onRegistered={async () => {
          await onDone(t("keys.added"));
        }}
      />
    );
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()} title={t("keys.addTitle")} short name="key-add">
      {body}
    </Sheet>
  );
}

function RenameKeySheet({
  item,
  onClose,
  onDone,
}: Readonly<{ item: SecurityKey; onClose: () => void; onDone: (message: string) => Promise<void> }>): ReactNode {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const formId = `rename-${item.id}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      await adminRequest<unknown>(`/api/admin/keys/${item.id}`, "PATCH", { name });
      await onDone(t("keys.renamed", { name }));
    } catch (error_: unknown) {
      setError(errorText(error_));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("keys.renameTitle")}
      short
      name="key-rename"
      actions={
        <DialogActions>
          <button className="gold" type="submit" form={formId} disabled={busy}>
            {t("keys.save")}
          </button>
        </DialogActions>
      }
    >
      <form
        id={formId}
        className="key-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          <span>{t("keys.name")}</span>
          <input name="name" maxLength={NAME_MAX} required defaultValue={item.name} autoComplete="off" />
        </label>
        <p className="form-error" role="alert">
          {error}
        </p>
      </form>
    </Sheet>
  );
}

function RemoveKeySheet({
  item,
  others,
  onClose,
  onDone,
}: Readonly<{
  item: SecurityKey;
  others: SecurityKey[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}>): ReactNode {
  const [error, setError] = useState<string>("");

  async function remove(): Promise<void> {
    setError("");
    try {
      await adminRequest<unknown>(`/api/admin/keys/${item.id}`, "DELETE");
      await onDone(t("keys.removed", { name: item.name }));
    } catch (error_: unknown) {
      setError(errorText(error_));
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("keys.removeTitle", { name: item.name })}
      short
      name="key-remove"
    >
      <p>{t("keys.removeBody", { others: others.map((key) => key.name).join(", ") })}</p>
      <p className="form-error" role="alert">
        {error}
      </p>
      <KeyConfirm inDialog label={t("keys.confirmRemove")} onConfirmed={remove} />
    </Sheet>
  );
}

function KeyCard({
  item,
  only,
  onOpen,
}: Readonly<{ item: SecurityKey; only: boolean; onOpen: (dialog: KeyDialog) => void }>): ReactNode {
  const headingId = `key-${item.id}`;
  return (
    <li>
      <article className="info-card application-card key-row" aria-labelledby={headingId}>
        <div className="application-head">
          <div className="person">
            <span className="key-badge small">
              <Icon name="key" size={24} />
            </span>
            <div>
              <h2 id={headingId}>{item.name}</h2>
              <p className="muted">{t("keys.type")}</p>
            </div>
          </div>
          <dl className="application-dates">
            <div>
              <dt>{t("keys.addedOn")}</dt>
              <dd>{item.createdAt === null ? "—" : <DateTime time={item.createdAt} />}</dd>
            </div>
            <div>
              <dt>{t("keys.lastUsed")}</dt>
              <dd>{item.lastUsedAt === null ? t("keys.never") : <DateTime time={item.lastUsedAt} />}</dd>
            </div>
          </dl>
        </div>
        <div className="application-actions">
          <button
            type="button"
            aria-label={t("keys.renameLabel", { name: item.name })}
            onClick={() => onOpen({ kind: "rename", key: item })}
          >
            <Icon name="pencil" size={18} />
            {t("keys.rename")}
          </button>
          <button
            type="button"
            className="danger"
            disabled={only}
            aria-label={t("keys.removeLabel", { name: item.name })}
            onClick={() => onOpen({ kind: "remove", key: item })}
          >
            <Icon name="trash" size={18} />
            {t("keys.remove")}
          </button>
        </div>
        {only && <p className="muted">{t("keys.onlyKey")}</p>}
      </article>
    </li>
  );
}

/** The Security keys tab once setup is done. */
export function SecurityKeys({ status, keys }: Readonly<{ status: StepUpStatus; keys: SecurityKey[] }>): ReactNode {
  const revalidator = useRevalidator();
  const [dialog, setDialog] = useState<KeyDialog>(null);
  const [notice, setNotice] = useState<string>("");
  if (keys.length < status.requiredKeys) return <KeySetup status={status} keys={keys} />;

  const done = async (message: string): Promise<void> => {
    setDialog(null);
    setNotice(message);
    await revalidator.revalidate();
  };
  const close = (): void => setDialog(null);

  return (
    <>
      <p>{t("keys.intro")}</p>
      <div className="sched-actions">
        <button type="button" className="gold" onClick={() => setDialog({ kind: "add" })}>
          <Icon name="plus" size={18} />
          {t("keys.add")}
        </button>
      </div>
      <output className="admin-notice">{notice}</output>
      <ul className="application-list">
        {keys.map((item: SecurityKey) => (
          <KeyCard key={item.id} item={item} only={keys.length === 1} onOpen={setDialog} />
        ))}
      </ul>
      {dialog?.kind === "add" && <AddKeySheet status={status} onClose={close} onDone={done} />}
      {dialog?.kind === "rename" && <RenameKeySheet item={dialog.key} onClose={close} onDone={done} />}
      {dialog?.kind === "remove" && (
        <RemoveKeySheet
          item={dialog.key}
          others={keys.filter((key: SecurityKey) => key.id !== dialog.key.id)}
          onClose={close}
          onDone={done}
        />
      )}
    </>
  );
}
