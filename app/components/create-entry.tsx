import { useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "./common";
import { errorMessage } from "./api";

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
            <label>
              <span>Category</span>
              <select name="category">
                <option>Tech &amp; setups</option>
                <option>Gaming</option>
                <option>Creative</option>
                <option>Just chatting</option>
              </select>
            </label>
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
            <label>
              <span>Voting time</span>
              <select name="duration" defaultValue="60">
                <option value="0">Unlimited — until I end it</option>
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
                <option value="120">2 minutes</option>
                <option value="300">5 minutes</option>
                <option value="600">10 minutes</option>
              </select>
            </label>
          </>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <button className="gold" type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
      </form>
    </Modal>
  );
}
