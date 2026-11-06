import { useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "./common";
import { errorMessage } from "./api";
import { DialogActions } from "./ui/dialog";
import { Select, type SelectOption } from "./ui/select";

const categories: readonly SelectOption[] = [
  { value: "Tech & setups", label: "Tech & setups", icon: "cat-tech" },
  { value: "Gaming", label: "Gaming", icon: "cat-gaming" },
  { value: "Creative", label: "Creative", icon: "cat-creative" },
  { value: "Just chatting", label: "Just chatting", icon: "cat-chatting" },
];

const durations: readonly SelectOption[] = [
  { value: "0", label: "Unlimited — until I end it" },
  { value: "30", label: "30 seconds" },
  { value: "60", label: "1 minute" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "600", label: "10 minutes" },
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
  const [kind, setKind] = useState<"choice" | "binary">("choice");
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
      const body: unknown =
        mode === "topic"
          ? {
              action: "create",
              kind: "topic",
              title: textField("title"),
              body: textField("body"),
              category: textField("category"),
            }
          : {
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
      await onCreate(body);
      onOpenChange(false);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }
  const submitLabel: string = mode === "topic" ? "Submit topic" : "Start poll";
  return (
    <Modal
      open={open}
      onOpenChange={(next: boolean) => {
        if (!pending) {
          setError("");
          onOpenChange(next);
        }
      }}
      title={mode === "topic" ? "Suggest a topic" : "Create a poll"}
      description={
        mode === "topic" ? "What would make a great conversation?" : "Ask your community. You control when voting ends."
      }
    >
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          void submit(event);
        }}
      >
        <label>
          {mode === "topic" ? "Title" : "Question"}
          <input name="title" required maxLength={mode === "topic" ? 100 : 160} />
        </label>
        {mode === "topic" ? (
          <>
            <label>
              <span>Details</span>
              <textarea name="body" required maxLength={2000} rows={5} />
            </label>
            <div className="field">
              <span className="field-label" id="topic-category-label">
                Category
              </span>
              <Select
                id="topic-category"
                name="category"
                labelledBy="topic-category-label"
                defaultValue="Tech & setups"
                options={categories}
              />
            </div>
          </>
        ) : (
          <>
            <fieldset className="poll-types">
              <legend>Poll type</legend>
              <label>
                <input
                  type="radio"
                  name="kind"
                  value="choice"
                  checked={kind === "choice"}
                  onChange={() => setKind("choice")}
                />
                <span>Multiple choice</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="kind"
                  value="binary"
                  checked={kind === "binary"}
                  onChange={() => setKind("binary")}
                />
                <span>Yes / No</span>
              </label>
            </fieldset>
            {kind === "choice" ? (
              <label>
                <span>Options, one per line</span>
                <textarea name="options" rows={4} required maxLength={486} aria-describedby="options-help" />
                <small id="options-help">2 to 6 distinct options. Up to 80 characters each.</small>
              </label>
            ) : (
              <p className="muted">Yes / No results stay private until you reveal them.</p>
            )}
            <div className="field">
              <span className="field-label" id="poll-duration-label">
                Voting time
              </span>
              <Select
                id="poll-duration"
                name="duration"
                labelledBy="poll-duration-label"
                defaultValue="60"
                options={durations}
              />
            </div>
          </>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <DialogActions>
          <button className="gold" type="submit" disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
