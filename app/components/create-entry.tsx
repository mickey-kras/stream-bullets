import { useState, type FormEvent, type ReactNode } from "react";
import { t, type MessageId } from "../i18n";
import { Modal } from "./common";
import { errorMessage } from "./api";
import { MASH_NAME } from "../lib/mash";
import { MashFields } from "./mash/mash-fields";
import { topicCategoryLabel } from "./topic-icon";
import { DialogActions } from "./ui/dialog";
import { Select, type SelectOption } from "./ui/select";
import { Req, RequiredNote } from "./ui/required";

type PollKind = "choice" | "binary" | "mash";

/** The poll types in the order the dialog lists them, with their labels. Mash Battle keeps its own name. */
const POLL_KINDS: readonly (readonly [PollKind, "create.choice" | "create.binary" | "mash"])[] = [
  ["choice", "create.choice"],
  ["binary", "create.binary"],
  ["mash", "mash"],
];

const categories: readonly Omit<SelectOption, "label">[] = [
  { value: "Tech & setups", icon: "cat-tech" },
  { value: "Gaming", icon: "cat-gaming" },
  { value: "Creative", icon: "cat-creative" },
  { value: "Just chatting", icon: "cat-chatting" },
];

const durations: readonly [string, MessageId][] = [
  ["0", "create.unlimited"],
  ["30", "create.seconds30"],
  ["60", "create.minute1"],
  ["120", "create.minutes2"],
  ["300", "create.minutes5"],
  ["600", "create.minutes10"],
];

export function CreateEntry({
  mode,
  open,
  onOpenChange,
  onCreate,
}: Readonly<{
  mode: "topic" | "poll";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: unknown) => Promise<void>;
}>): ReactNode {
  const [kind, setKind] = useState<PollKind>("choice");
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const form: FormData = new FormData(event.currentTarget);
      function textField(name: string): string {
        const value: FormDataEntryValue | null = form.get(name);
        if (value === null) return "";
        if (typeof value !== "string") throw new TypeError(`${name} must be text.`);
        return value;
      }
      const mash = {
        action: "create",
        kind: "mash",
        title: textField("title"),
        options: form.getAll("side").map((side: FormDataEntryValue): string => {
          if (typeof side !== "string") throw new TypeError("side must be text.");
          return side.trim();
        }),
        durationS: Number(textField("durationS")),
      };
      let body: unknown = mash;
      if (mode === "topic") {
        body = {
          action: "create",
          kind: "topic",
          title: textField("title"),
          body: textField("body"),
          category: textField("category"),
        };
      } else if (kind !== "mash") {
        body = {
          action: "create",
          kind,
          title: textField("title"),
          options:
            kind === "binary"
              ? ["Yes", "No"]
              : textField("options")
                  .split("\n")
                  .map((option: string) => option.trim())
                  .filter(Boolean),
          duration: Number(textField("duration")),
        };
      }
      await onCreate(body);
      onOpenChange(false);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }
  const submitLabel: string = mode === "topic" ? t("create.submitTopic") : t("create.startPoll");
  return (
    <Modal
      open={open}
      onOpenChange={(next: boolean) => {
        if (!pending) {
          setError("");
          onOpenChange(next);
        }
      }}
      title={mode === "topic" ? t("create.topicTitle") : t("create.pollTitle")}
      description={mode === "topic" ? t("create.topicLead") : t("create.pollLead")}
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          void submit(event);
        }}
      >
        <RequiredNote />
        <label>
          <span>
            {mode === "topic" ? t("create.title") : t("create.question")}
            <Req />
          </span>
          <input name="title" required maxLength={mode === "topic" ? 100 : 160} />
        </label>
        {mode === "topic" ? (
          <>
            <label>
              <span>
                {t("create.details")}
                <Req />
              </span>
              <textarea name="body" required maxLength={2000} rows={5} />
            </label>
            <div className="field">
              <span className="field-label" id="topic-category-label">
                {t("create.category")}
                <Req />
              </span>
              <Select
                id="topic-category"
                name="category"
                labelledBy="topic-category-label"
                defaultValue="Tech & setups"
                options={categories.map((option) => ({ ...option, label: topicCategoryLabel(option.value) }))}
              />
            </div>
          </>
        ) : (
          <>
            <fieldset className="poll-types">
              <legend>{t("create.pollType")}</legend>
              {POLL_KINDS.map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  <span>{label === "mash" ? MASH_NAME : t(label)}</span>
                </label>
              ))}
            </fieldset>
            {kind === "mash" && <MashFields />}
            {kind === "choice" && (
              <label>
                <span>
                  {t("create.options")}
                  <Req />
                </span>
                <textarea name="options" rows={4} required maxLength={486} aria-describedby="options-help" />
                <small id="options-help">{t("create.optionsHelp")}</small>
              </label>
            )}
            {kind === "binary" && <p className="muted">{t("create.binaryHelp")}</p>}
            <div className="field" hidden={kind === "mash"}>
              <span className="field-label" id="poll-duration-label">
                {t("create.votingTime")}
              </span>
              <Select
                id="poll-duration"
                name="duration"
                labelledBy="poll-duration-label"
                defaultValue="60"
                options={durations.map(([value, id]) => ({ value, label: t(id) }))}
              />
            </div>
          </>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <DialogActions>
          <button className="gold" type="submit" disabled={pending}>
            {pending ? t("common.saving") : submitLabel}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
