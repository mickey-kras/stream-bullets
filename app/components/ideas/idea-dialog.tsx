import { useId, useState, type FormEvent, type ReactNode } from "react";
import { getLocale, t } from "../../i18n";
import { IDEA_CATEGORIES, isUntouchedTemplate, type IdeaCategory } from "../../lib/ideas";
import { errorMessage } from "../api";
import { categoryIcon } from "../topic-icon";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Req, RequiredNote } from "../ui/required";
import { Select, type SelectOption } from "../ui/select";
import { categoryLabel } from "./ideas";

import { BUG_TEMPLATES } from "../../lib/bug-templates";

// Add the bug template after existing text; remove it on category change only while untouched.
export function switchTemplate(body: string, from: IdeaCategory, to: IdeaCategory): string {
  const bugTemplate: string = BUG_TEMPLATES[getLocale()];
  const template: string = bugTemplate.trim();
  const text = body.trimEnd();
  if (to === "bug" && from !== "bug") {
    if (text.endsWith(template)) return body;
    return text ? `${text}\n\n${bugTemplate}` : bugTemplate;
  }
  if (from === "bug" && to !== "bug" && text.endsWith(template)) return text.slice(0, -template.length).trimEnd();
  return body;
}

// Only these browser fields enter public reports.
export function environment(): string {
  const browser =
    /(Edg|Firefox|Chrome|Safari)\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? t("ideas.form.unknownBrowser");
  return t("ideas.form.environment", { browser, width: screen.width, height: screen.height });
}

// New official-board ideas start Under review.
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
  const [body, setBody] = useState<string>(initialCategory === "bug" ? BUG_TEMPLATES[getLocale()] : "");
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
    if (
      category === "bug" &&
      (isUntouchedTemplate(body) || body.trimEnd().endsWith(BUG_TEMPLATES[getLocale()].trim()))
    ) {
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
        <RequiredNote />
        <label>
          <span>
            {t("ideas.form.title")}
            <Req />
          </span>
          <input
            name="title"
            required
            maxLength={100}
            value={title}
            onChange={(input) => setTitle(input.currentTarget.value)}
          />
        </label>
        <label>
          <span>
            {t("ideas.form.details")}
            <Req />
          </span>
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
