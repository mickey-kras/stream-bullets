import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { requestJson, errorMessage } from "./api";

export interface MentionSelection {
  userId: string;
  start: number;
  end: number;
}
interface Candidate {
  id: string;
  name: string;
  handle: string | null;
}

export interface TextEdit {
  start: number;
  end: number;
  insertedLength: number;
}

export function retainedMentions(
  mentions: MentionSelection[],
  edit: TextEdit,
): MentionSelection[] {
  const shift = edit.insertedLength - (edit.end - edit.start);
  return mentions.flatMap((mention: MentionSelection): MentionSelection[] => {
    if (mention.end <= edit.start) return [mention];
    if (mention.start >= edit.end)
      return [
        { ...mention, start: mention.start + shift, end: mention.end + shift },
      ];
    return [];
  });
}

export function MentionInput({
  entryId,
  value,
  mentions,
  onChange,
  onMentionsChange,
  label,
  placeholder,
  disabled,
}: Readonly<{
  entryId: string;
  value: string;
  mentions: MentionSelection[];
  onChange: (value: string) => void;
  onMentionsChange: (mentions: MentionSelection[]) => void;
  label: string;
  placeholder: string;
  disabled: boolean;
}>): ReactNode {
  const id = useId();
  const editRange = useRef<{
    start: number;
    end: number;
    inputType: string;
  } | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [users, setUsers] = useState<Candidate[]>([]);
  const [active, setActive] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const remember = (event: InputEvent): void => {
      editRange.current = {
        start: element.selectionStart,
        end: element.selectionEnd,
        inputType: event.inputType,
      };
    };
    element.addEventListener("beforeinput", remember);
    return () => element.removeEventListener("beforeinput", remember);
  }, []);
  useEffect(() => {
    const element = input.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + 2}px`;
    }
  }, [value]);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestJson<{ users: Candidate[] }>(
        `/api/entries/${encodeURIComponent(entryId)}/mention-candidates?query=${encodeURIComponent(token.query)}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setUsers(result.users);
            setLoading(false);
          }
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(cause));
            setLoading(false);
          }
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [entryId, token]);
  function detect(element: HTMLTextAreaElement): void {
    const end = element.selectionStart;
    const match = /(?:^|\s)@([^@\n]{0,40})$/u.exec(element.value.slice(0, end));
    if (!match || mentions.length >= 5) {
      setToken(null);
      return;
    }
    setToken({ start: end - match[1].length - 1, end, query: match[1] });
    setUsers([]);
    setActive(0);
    setError("");
    setLoading(true);
  }
  function select(user: Candidate): void {
    if (
      !token ||
      mentions.some((mention: MentionSelection) => mention.userId === user.id)
    )
      return;
    const label = `@${user.name}`;
    const next =
      value.slice(0, token.start) + label + " " + value.slice(token.end);
    if (next.length > 2000) return;
    onMentionsChange([
      ...retainedMentions(mentions, {
        start: token.start,
        end: token.end,
        insertedLength: label.length + 1,
      }),
      { userId: user.id, start: token.start, end: token.start + label.length },
    ]);
    onChange(next);
    setToken(null);
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(
        token.start + label.length + 1,
        token.start + label.length + 1,
      );
    });
  }
  const options = users.filter(
    (user: Candidate) =>
      !mentions.some((mention: MentionSelection) => mention.userId === user.id),
  );
  return (
    <div className="mention-input">
      <textarea
        ref={input}
        data-composer
        value={value}
        required
        disabled={disabled}
        maxLength={2000}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        aria-controls={token ? id : undefined}
        aria-autocomplete="list"
        aria-expanded={Boolean(token)}
        aria-activedescendant={
          token && options[active] ? `${id}-${active}` : undefined
        }
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget))
            setToken(null);
        }}
        onClick={(event) => detect(event.currentTarget)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const range = editRange.current;
          editRange.current = null;
          if (range && !range.inputType.startsWith("history")) {
            let { start, end } = range;
            if (start === end && range.inputType.startsWith("delete")) {
              const removed = value.length - next.length;
              if (range.inputType.endsWith("Backward"))
                start = Math.max(0, start - removed);
              else end += removed;
            }
            const insertedLength = next.length - value.length + end - start;
            onMentionsChange(
              insertedLength >= 0
                ? retainedMentions(mentions, { start, end, insertedLength })
                : [],
            );
          } else onMentionsChange([]);
          onChange(next);
          detect(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (!token || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setToken(null);
          }
          if (
            options.length &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            setActive(
              (index: number) =>
                (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                options.length,
            );
          }
          if (event.key === "Enter" && options[active]) {
            event.preventDefault();
            select(options[active]);
          }
        }}
      />
      {token && (
        <div className="mention-options">
          <div
            role="listbox"
            id={id}
            aria-label={t("discussion.mentionPeople")}
          >
            {options.map((user: Candidate, index: number) => (
              <button
                key={user.id}
                id={`${id}-${index}`}
                className="mention-option"
                type="button"
                role="option"
                aria-selected={index === active}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => select(user)}
              >
                <strong>{user.name}</strong>
                <span className="mention-label">
                  {user.handle ? `@${user.handle}` : user.id}
                </span>
              </button>
            ))}
          </div>
          <output>
            {loading
              ? t("discussion.mentionLoading")
              : error || (options.length ? "" : t("discussion.mentionEmpty"))}
          </output>
        </div>
      )}
    </div>
  );
}
