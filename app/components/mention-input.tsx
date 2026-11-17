import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
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

export function retainedMentions(mentions: MentionSelection[], edit: TextEdit): MentionSelection[] {
  const shift = edit.insertedLength - (edit.end - edit.start);
  return mentions.flatMap((mention: MentionSelection): MentionSelection[] => {
    if (mention.end <= edit.start) return [mention];
    if (mention.start >= edit.end) return [{ ...mention, start: mention.start + shift, end: mention.end + shift }];
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
  const history = useRef<{ values: { text: string; mentions: MentionSelection[] }[]; index: number }>({
    values: [{ text: value, mentions }],
    index: 0,
  });
  function remember(next: string, selected: MentionSelection[]): void {
    const state = history.current;
    if (state.values[state.index].text !== value) {
      state.values = [{ text: value, mentions }];
      state.index = 0;
    }
    state.values.splice(state.index + 1);
    state.values.push({ text: next, mentions: selected });
    if (state.values.length > 2001) state.values.splice(1, 1);
    state.index = state.values.length - 1;
  }
  function restore(next: string, direction: -1 | 1): MentionSelection[] {
    const state = history.current;
    for (let index = state.index + direction; index >= 0 && index < state.values.length; index += direction) {
      if (state.values[index].text !== next) continue;
      state.index = index;
      return state.values[index].mentions;
    }
    remember(next, []);
    return [];
  }
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
        .catch((error_: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(error_));
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
    if (!token || mentions.some((mention: MentionSelection) => mention.userId === user.id)) return;
    const label = `@${user.name}`;
    const next = value.slice(0, token.start) + label + " " + value.slice(token.end);
    if (next.length > 2000) return;
    const selected: MentionSelection[] = [
      ...retainedMentions(mentions, {
        start: token.start,
        end: token.end,
        insertedLength: label.length + 1,
      }),
      { userId: user.id, start: token.start, end: token.start + label.length },
    ];
    remember(next, selected);
    onMentionsChange(selected);
    onChange(next);
    setToken(null);
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(token.start + label.length + 1, token.start + label.length + 1);
    });
  }
  const options = users.filter(
    (user: Candidate) => !mentions.some((mention: MentionSelection) => mention.userId === user.id),
  );
  function editedMentions(next: string): MentionSelection[] {
    const range = editRange.current;
    editRange.current = null;
    if (range?.inputType === "historyUndo" || range?.inputType === "historyRedo")
      return restore(next, range.inputType === "historyUndo" ? -1 : 1);
    let selected: MentionSelection[] = [];
    if (range) {
      let { start, end } = range;
      if (start === end && range.inputType.startsWith("delete")) {
        const removed: number = value.length - next.length;
        if (range.inputType.endsWith("Backward")) start = Math.max(0, start - removed);
        else end += removed;
      }
      const insertedLength: number = next.length - value.length + end - start;
      if (insertedLength >= 0) selected = retainedMentions(mentions, { start, end, insertedLength });
    }
    remember(next, selected);
    return selected;
  }
  function change(event: ChangeEvent<HTMLTextAreaElement>): void {
    const next: string = event.currentTarget.value;
    onMentionsChange(editedMentions(next));
    onChange(next);
    detect(event.currentTarget);
  }
  let mentionStatus: string = error || (options.length ? "" : t("discussion.mentionEmpty"));
  if (loading) mentionStatus = t("discussion.mentionLoading");
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
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setToken(null);
        }}
        onClick={(event) => detect(event.currentTarget)}
        onChange={change}
        onKeyDown={(event) => {
          if (!token || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setToken(null);
          }
          if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActive(
              (index: number) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length,
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
          <ul id={id} aria-label={t("discussion.mentionPeople")}>
            {options.map((user: Candidate, index: number) => (
              <li key={user.id}>
                <button
                  className="mention-option"
                  type="button"
                  data-active={index === active}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => select(user)}
                >
                  <strong>{user.name}</strong>
                  <span className="mention-label">{user.handle ? `@${user.handle}` : user.id}</span>
                </button>
              </li>
            ))}
          </ul>
          <output className="sr-only">
            {options[active] ? `${options[active].name} - ${options[active].handle ?? options[active].id}` : ""}
          </output>
          <output>{mentionStatus}</output>
        </div>
      )}
    </div>
  );
}
