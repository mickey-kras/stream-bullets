import { CodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CODE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import { QuoteNode } from "@lexical/rich-text";
import {
  $applyNodeReplacement,
  $getRoot,
  TextNode,
  type EditorConfig,
  type Klass,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
} from "lexical";
import type { MentionSelection } from "../components/mention-input";

// Private-use characters mark a mention in the Markdown text that the editor reads and writes.
// The stored comment text never has them.
const OPEN = "";
const SPLIT = "";
const CLOSE = "";
// Each part excludes the marks, so the search does not go back over text that it already read.
const MARKED_MENTION = /([^]+)([^]+)/u;

export interface CommentValue {
  text: string;
  mentions: MentionSelection[];
}

type SerializedMentionNode = SerializedTextNode & { userId: string };

// One mention is one unit: the caret does not go into it, and one Backspace removes all of it.
export class MentionNode extends TextNode {
  readonly __userId: string;

  static override getType(): string {
    return "mention";
  }

  static override clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__userId, node.__text, node.__key);
  }

  constructor(userId: string, text: string, key?: NodeKey) {
    super(text, key);
    this.__userId = userId;
  }

  static override importJSON(serialized: SerializedMentionNode): MentionNode {
    return $createMentionNode(serialized.userId, serialized.text);
  }

  override exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), userId: this.__userId };
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const element: HTMLElement = super.createDOM(config);
    element.className = "mention";
    return element;
  }

  override canInsertTextBefore(): boolean {
    return false;
  }

  override canInsertTextAfter(): boolean {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  getUserId(): string {
    return this.__userId;
  }
}

export function $createMentionNode(userId: string, label: string): MentionNode {
  return $applyNodeReplacement(new MentionNode(userId, label).setMode("token"));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

const MENTION: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node: LexicalNode): string | null =>
    $isMentionNode(node) ? `${OPEN}${node.getUserId()}${SPLIT}${node.getTextContent()}${CLOSE}` : null,
  importRegExp: MARKED_MENTION,
  // No text that a person types makes a mention. The list of people makes it.
  regExp: /(?!)/u,
  replace: (node: TextNode, match: RegExpMatchArray): void => {
    node.replace($createMentionNode(match[1], match[2]));
  },
  type: "text-match",
};

// The same formats that the comment renderer shows: see app/lib/comment-markdown.ts.
export const COMMENT_TRANSFORMERS: Transformer[] = [
  MENTION,
  BOLD_STAR,
  ITALIC_STAR,
  // The page also shows the underscore forms. The editor reads them and writes the star forms.
  BOLD_UNDERSCORE,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  INLINE_CODE,
  LINK,
  UNORDERED_LIST,
  ORDERED_LIST,
  QUOTE,
  CODE,
];

export const COMMENT_NODES: Klass<LexicalNode>[] = [QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode, MentionNode];

// Put the marks around each mention range. Ranges that do not fit the text are ignored.
export function markMentions(value: CommentValue): string {
  const ordered: MentionSelection[] = [...value.mentions].sort(
    (a: MentionSelection, b: MentionSelection): number => b.start - a.start,
  );
  let text: string = value.text;
  for (const mention of ordered) {
    if (mention.start < 0 || mention.end > text.length || mention.start >= mention.end) continue;
    const label: string = text.slice(mention.start, mention.end);
    text = `${text.slice(0, mention.start)}${OPEN}${mention.userId}${SPLIT}${label}${CLOSE}${text.slice(mention.end)}`;
  }
  return text;
}

// Remove the marks and give the range of each mention in the clean text.
export function unmarkMentions(marked: string): CommentValue {
  const mentions: MentionSelection[] = [];
  let text: string = "";
  let rest: string = marked;
  for (let match = MARKED_MENTION.exec(rest); match; match = MARKED_MENTION.exec(rest)) {
    text += rest.slice(0, match.index);
    mentions.push({ userId: match[1], start: text.length, end: text.length + match[2].length });
    text += match[2];
    rest = rest.slice(match.index + match[0].length);
  }
  return { text: text + rest, mentions };
}

// Call these two functions in an editor update or read.
export function $readComment(): CommentValue {
  return unmarkMentions($convertToMarkdownString(COMMENT_TRANSFORMERS, undefined, true));
}

export function $writeComment(value: CommentValue): void {
  $convertFromMarkdownString(markMentions(value), COMMENT_TRANSFORMERS, undefined, true);
  // Code does not make mention nodes: a mention in code shows as its label.
  for (const node of $getRoot().getAllTextNodes()) {
    const text: string = node.getTextContent();
    if (!$isMentionNode(node) && text.includes(OPEN)) node.setTextContent(unmarkMentions(text).text);
  }
}
