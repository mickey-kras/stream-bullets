import { useId, useState, type FormEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import { BUG_TEMPLATE, IDEA_CATEGORIES, isUntouchedTemplate, type IdeaCategory } from "../../lib/ideas";
import { errorMessage } from "../api";
import { categoryIcon } from "../topic-icon";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { categoryLabel } from "./ideas";

const template = BUG_TEMPLATE.trim();

/** Switching to Bug adds the template after any text; leaving Bug removes it again while it is untouched. */
export function switchTemplate(body: string, from: IdeaCategory, to: IdeaCategory): string {
  const text = body.trimEnd();
  if (to === "bug" && from !== "bug") {
    if (text.endsWith(template)) return body;
    return text ? `${text}\n\n${BUG_TEMPLATE}` : BUG_TEMPLATE;
  }
  if (from === "bug" && to !== "bug" && text.endsWith(template)) return text.slice(0, -template.length).trimEnd();
  return body;
}

/** Browser and page details for a bug report. No personal data: no account, no address, no history. */
function environment(): string {
  const browser = /(Edg|Firefox|Chrome|Safari)\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? "Unknown";
  return `Browser: ${browser} · Screen: ${screen.width}×${screen.height} · Page: ${location.pathname}${location.search}`;
}

/** "Suggest an improvement" on the official page (item 46). New ideas start Under review. */
export function IdeaDialog({
  open,
  initialCategory = "feature",
  onOpenChange,
  onCreate,
}: Readonly<{
  open: boolean;
  initialCategory?: IdeaCategory;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: { title: string; body: string; category: IdeaCategory }) => Promise<void>;
}>): ReactNode {
  const id = useId();
  const [category, setCategory] = useState<IdeaCategory>(initialCategory);
  const [title, setTitle] = useState<string>("");
  const [body, setBody] = useState<string>(initialCategory === "bug" ? BUG_TEMPLATE : "");
  const [meta, setMeta] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const options: SelectOption[] = IDEA_CATEGORIES.map((value: IdeaCategory) => ({
    value,
    label: categoryLabel(value),
    icon: categoryIcon(value),
  }));

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (category === "bug" && (isUntouchedTemplate(body) || body.trimEnd().endsWith(template))) {
      setError(t("ideas.form.fillTemplate"));
      return;
    }
    setPending(true);
    setError("");
    try {
      const details = category === "bug" && meta ? `${body.trim()}\n\n---\n${environment()}` : body.trim();
      await onCreate({ title: title.trim(), body: details.slice(0, 2000), category });
      onOpenChange(false);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => !pending && onOpenChange(next)}
      title={t("ideas.suggest")}
      description={t("ideas.form.description")}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <span className="field-label" id={`${id}-category`}>
            {t("ideas.form.category")}
          </span>
          <Select
            id={`${id}-category-select`}
            labelledBy={`${id}-category`}
            options={options}
            value={category}
            onValueChange={(value: string) => {
              const next = value as IdeaCategory;
              setBody((current: string) => switchTemplate(current, category, next));
              setCategory(next);
            }}
          />
        </div>
        <label>
          <span>{t("ideas.form.title")}</span>
          <input
            name="title"
            required
            maxLength={100}
            value={title}
            onChange={(input) => setTitle(input.currentTarget.value)}
          />
        </label>
        <label>
          <span>{t("ideas.form.details")}</span>
          <textarea
            name="body"
            required
            maxLength={1900}
            rows={6}
            value={body}
            onChange={(input) => setBody(input.currentTarget.value)}
          />
        </label>
        {category === "bug" && (
          <label className="choice">
            <input
              type="checkbox"
              name="meta"
              checked={meta}
              onChange={(input) => setMeta(input.currentTarget.checked)}
            />
            <span>
              {t("ideas.form.includeInfo")}
              <small>{t("ideas.form.includeInfoHint")}</small>
            </span>
          </label>
        )}
        <p className="form-error" role="alert">
          {error}
        </p>
        <DialogActions>
          <button className="gold" type="submit" disabled={pending}>
            <Icon name="send" size={18} />
            {t("ideas.form.submit")}
          </button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
