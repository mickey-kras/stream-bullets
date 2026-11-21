import { $createCodeNode, $isCodeNode } from "@lexical/code-core";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { $isLinkNode, $toggleLink } from "@lexical/link";
import { $isListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, registerList } from "@lexical/list";
import { $generateNodesFromMarkdownString, registerMarkdownShortcuts } from "@lexical/markdown";
import { $createQuoteNode, $isQuoteNode, registerRichText } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
  createEditor,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  type TextFormatType,
} from "lexical";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, type MessageId } from "../i18n";
import {
  $createMentionNode,
  $isMentionNode,
  $readComment,
  $writeComment,
  COMMENT_NODES,
  COMMENT_TRANSFORMERS,
  type CommentValue,
} from "../lib/rich-comment";
import { errorMessage, requestJson } from "./api";
import type { MentionSelection } from "./mention-input";
import { Icon, type IconName } from "./ui/icon";

const MAX_LENGTH = 2000;
const MAX_MENTIONS = 5;

interface Candidate {
  id: string;
  name: string;
  handle: string | null;
}

// The "@" text before the caret that opens the list of people.
interface Token {
  key: string;
  start: number;
  end: number;
  query: string;
}

type Block = "paragraph" | "quote" | "code" | "bullet" | "number";

interface Active {
  formats: ReadonlySet<TextFormatType>;
  block: Block;
  link: boolean;
}

// The link field takes the focus when the author opens it.
const focusInput = (input: HTMLInputElement | null): void => input?.focus();

const NO_FORMAT: Active = { formats: new Set<TextFormatType>(), block: "paragraph", link: false };

const TEXT_BUTTONS: readonly { format: TextFormatType; icon: IconName; label: MessageId }[] = [
  { format: "bold", icon: "bold", label: "editor.bold" },
  { format: "italic", icon: "italic", label: "editor.italic" },
  { format: "strikethrough", icon: "strikethrough", label: "editor.strikethrough" },
  { format: "code", icon: "code", label: "editor.code" },
];

const BLOCK_BUTTONS: readonly { block: Exclude<Block, "paragraph">; icon: IconName; label: MessageId }[] = [
  { block: "bullet", icon: "list-bullet", label: "editor.bulletList" },
  { block: "number", icon: "list-number", label: "editor.numberList" },
  { block: "quote", icon: "quote", label: "editor.quote" },
  { block: "code", icon: "code-block", label: "editor.codeBlock" },
];

function $blockOf(selection: RangeSelection): Block {
  const top: LexicalNode | null = selection.anchor.getNode().getTopLevelElement();
  if ($isQuoteNode(top)) return "quote";
  if ($isCodeNode(top)) return "code";
  if ($isListNode(top)) return top.getListType() === "number" ? "number" : "bullet";
  return "paragraph";
}

function $activeOf(): Active {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return NO_FORMAT;
  const formats = new Set<TextFormatType>();
  for (const { format } of TEXT_BUTTONS) if (selection.hasFormat(format)) formats.add(format);
  const node: LexicalNode = selection.anchor.getNode();
  return { formats, block: $blockOf(selection), link: $isLinkNode(node) || $isLinkNode(node.getParent()) };
}

function $tokenOf(mentionCount: number): Token | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || mentionCount >= MAX_MENTIONS) return null;
  const node: LexicalNode = selection.anchor.getNode();
  if (!$isTextNode(node) || $isMentionNode(node) || node.hasFormat("code") || $isCodeNode(node.getParent()))
    return null;
  const end: number = selection.anchor.offset;
  const match = /(?:^|\s)@([^@\n]{0,40})$/u.exec(node.getTextContent().slice(0, end));
  return match ? { key: node.getKey(), start: end - match[1].length - 1, end, query: match[1] } : null;
}

function sameValue(a: CommentValue, text: string, mentions: readonly MentionSelection[]): boolean {
  return (
    a.text === text &&
    a.mentions.length === mentions.length &&
    a.mentions.every(
      (mention: MentionSelection, index: number): boolean =>
        mention.userId === mentions[index].userId &&
        mention.start === mentions[index].start &&
        mention.end === mentions[index].end,
    )
  );
}

// A comment editor that shows the formats while the person types. It reads and writes the same Markdown text
// and mention ranges as MentionInput.
export function RichCommentInput({
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
  const listId: string = useId();
  const linkId: string = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<LexicalEditor | null>(null);
  const emitted = useRef<CommentValue>({ text: value, mentions });
  const handlers = useRef({ onChange, onMentionsChange });
  handlers.current = { onChange, onMentionsChange };
  const [active, setActive] = useState<Active>(NO_FORMAT);
  const [empty, setEmpty] = useState<boolean>(value === "");
  const [token, setToken] = useState<Token | null>(null);
  const [users, setUsers] = useState<Candidate[]>([]);
  const [choice, setChoice] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const picker = useRef<{ token: Token | null; options: Candidate[]; choice: number }>({
    token: null,
    options: [],
    choice: 0,
  });

  // Start a new search each time the text after "@" changes.
  function showToken(next: Token | null): void {
    const before: Token | null = picker.current.token;
    setToken(next);
    if (!next || next.query === before?.query) return;
    setUsers([]);
    setChoice(0);
    setError("");
    setLoading(true);
  }

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const editor: LexicalEditor = createEditor({
      namespace: "comment",
      nodes: COMMENT_NODES,
      onError: (error_: Error): void => {
        throw error_;
      },
      theme: { text: { bold: "ed-bold", italic: "ed-italic", strikethrough: "ed-strike", code: "ed-code" } },
    });
    editorRef.current = editor;
    editor.update(() => $writeComment(emitted.current), { discrete: true });
    // No HTML tag gives the textbox role to an element with editable content.
    element.setAttribute("role", "textbox");
    editor.setRootElement(element);
    const closeList = (event: FocusEvent): void => {
      const next: EventTarget | null = event.relatedTarget;
      if (!(next instanceof Node && element.parentElement?.contains(next))) setToken(null);
    };
    element.addEventListener("focusout", closeList);
    const stop: (() => void)[] = [
      registerRichText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      registerList(editor),
      registerMarkdownShortcuts(editor, COMMENT_TRANSFORMERS),
      editor.registerUpdateListener(
        ({ editorState, prevEditorState }: { editorState: EditorState; prevEditorState: EditorState }): void => {
          const next: CommentValue = editorState.read($readComment);
          if (next.text.length > MAX_LENGTH) {
            editor.setEditorState(prevEditorState);
            return;
          }
          editorState.read(() => {
            setActive($activeOf());
            showToken($tokenOf(next.mentions.length));
          });
          setEmpty(next.text === "");
          if (sameValue(emitted.current, next.text, next.mentions)) return;
          emitted.current = next;
          handlers.current.onMentionsChange(next.mentions);
          handlers.current.onChange(next.text);
        },
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event: ClipboardEvent | InputEvent | KeyboardEvent): boolean => {
          const text: string | undefined =
            event instanceof ClipboardEvent ? event.clipboardData?.getData("text/plain") : undefined;
          const selection = $getSelection();
          if (!text || !$isRangeSelection(selection)) return false;
          const node: LexicalNode = selection.anchor.getNode();
          // Text in a code block or in inline code stays as the author pasted it.
          if ($isCodeNode(node) || $isCodeNode(node.getParent())) return false;
          if ($isTextNode(node) && node.hasFormat("code")) return false;
          event.preventDefault();
          selection.insertNodes($generateNodesFromMarkdownString(text, COMMENT_TRANSFORMERS, true));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event: KeyboardEvent): boolean => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            setLinkUrl("");
            return true;
          }
          const state = picker.current;
          if (!state.token || event.isComposing) return false;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setToken(null);
            return true;
          }
          if (state.options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const step: number = event.key === "ArrowDown" ? 1 : state.options.length - 1;
            setChoice((index: number): number => (index + step) % state.options.length);
            return true;
          }
          if (event.key === "Enter" && state.options[state.choice]) {
            event.preventDefault();
            select(state.options[state.choice]);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      for (const unregister of stop) unregister();
      element.removeEventListener("focusout", closeList);
      editor.setRootElement(null);
      editorRef.current = null;
    };
  }, []);

  // The form can set a new value, for example an empty one after a post. The editor then shows that value.
  useEffect(() => {
    if (sameValue(emitted.current, value, mentions)) return;
    emitted.current = { text: value, mentions };
    editorRef.current?.update(() => $writeComment(emitted.current));
  }, [value, mentions]);

  useEffect(() => {
    editorRef.current?.setEditable(!disabled);
  }, [disabled]);

  const query: string | null = token ? token.query : null;
  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestJson<{ users: Candidate[] }>(
        `/api/entries/${encodeURIComponent(entryId)}/mention-candidates?query=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setUsers(result.users);
          setLoading(false);
        })
        .catch((error_: unknown) => {
          if (controller.signal.aborted) return;
          setError(errorMessage(error_));
          setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [entryId, query]);

  const options: Candidate[] = users.filter(
    (user: Candidate): boolean => !mentions.some((mention: MentionSelection): boolean => mention.userId === user.id),
  );
  picker.current = { token, options, choice };

  function select(user: Candidate): void {
    const current: Token | null = picker.current.token;
    const editor = editorRef.current;
    if (!current || !editor) return;
    editor.update(() => {
      const node: LexicalNode | null = $getNodeByKey(current.key);
      if (!$isTextNode(node)) return;
      const parts = node.splitText(current.start, current.end);
      const target = current.start === 0 ? parts[0] : parts[1];
      const mention = $createMentionNode(user.id, `@${user.name}`);
      target.replace(mention);
      const space = $createTextNode(" ");
      mention.insertAfter(space);
      space.select();
    });
    setToken(null);
    editor.focus();
  }

  function setBlock(block: Exclude<Block, "paragraph">): void {
    const editor = editorRef.current;
    if (!editor) return;
    const off: boolean = active.block === block;
    if (block === "bullet" || block === "number") {
      if (off) editor.update(() => $setBlocksType($getSelection(), (): ElementNode => $createParagraphNode()));
      else
        editor.dispatchCommand(
          block === "bullet" ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND,
          undefined,
        );
    } else {
      editor.update(() =>
        $setBlocksType($getSelection(), (): ElementNode => {
          if (off) return $createParagraphNode();
          return block === "quote" ? $createQuoteNode() : $createCodeNode();
        }),
      );
    }
    editor.focus();
  }

  // The link field is in the form of the comment. Thus it is not a form of its own.
  function applyLink(): void {
    const url: string = (linkUrl ?? "").trim();
    const editor = editorRef.current;
    if (!editor || !/^(https?:\/\/|mailto:)\S+$/iu.test(url)) return;
    editor.update(() => $toggleLink(url));
    setLinkUrl(null);
    editor.focus();
  }

  function linkButton(): void {
    const editor = editorRef.current;
    if (!editor) return;
    if (active.link) {
      editor.update(() => $toggleLink(null));
      editor.focus();
    } else setLinkUrl(linkUrl === null ? "" : null);
  }

  let mentionStatus: string = error || (options.length ? "" : t("discussion.mentionEmpty"));
  if (loading) mentionStatus = t("discussion.mentionLoading");
  return (
    <div className="mention-input rich-input" data-empty={empty} data-disabled={disabled}>
      <div className="ed-toolbar" role="toolbar" aria-label={t("editor.toolbar")}>
        {TEXT_BUTTONS.map(({ format, icon, label: name }) => (
          <button
            key={format}
            type="button"
            aria-label={t(name)}
            title={t(name)}
            aria-pressed={active.formats.has(format)}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => editorRef.current?.dispatchCommand(FORMAT_TEXT_COMMAND, format)}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
        <button
          type="button"
          aria-label={t(active.link ? "editor.unlink" : "editor.link")}
          title={t(active.link ? "editor.unlink" : "editor.link")}
          aria-pressed={active.link}
          aria-expanded={linkUrl !== null}
          aria-controls={linkUrl === null ? undefined : linkId}
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={linkButton}
        >
          <Icon name="link" size={18} />
        </button>
        {BLOCK_BUTTONS.map(({ block, icon, label: name }) => (
          <button
            key={block}
            type="button"
            aria-label={t(name)}
            title={t(name)}
            aria-pressed={active.block === block}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setBlock(block)}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
      </div>
      {linkUrl !== null && (
        <div id={linkId} className="ed-link">
          <input
            type="url"
            ref={focusInput}
            value={linkUrl}
            aria-label={t("editor.linkUrl")}
            placeholder="https://"
            onChange={(event) => setLinkUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Enter applies the link and must not post the comment.
                event.preventDefault();
                applyLink();
              }
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setLinkUrl(null);
              editorRef.current?.focus();
            }}
          />
          <button type="button" onClick={applyLink}>
            {t("editor.linkApply")}
          </button>
        </div>
      )}
      <div
        ref={root}
        className="ed-content comment-text"
        data-composer
        aria-multiline="true"
        aria-label={label}
        aria-required="true"
        aria-disabled={disabled}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        aria-controls={token ? listId : undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
      />
      {token && (
        <div className="mention-options">
          <ul id={listId} aria-label={t("discussion.mentionPeople")}>
            {options.map((user: Candidate, index: number) => (
              <li key={user.id}>
                <button
                  className="mention-option"
                  type="button"
                  data-active={index === choice}
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
            {options[choice] ? `${options[choice].name} - ${options[choice].handle ?? options[choice].id}` : ""}
          </output>
          <output>{mentionStatus}</output>
        </div>
      )}
    </div>
  );
}
