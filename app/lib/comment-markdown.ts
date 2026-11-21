import { Lexer, Tokenizer, type Token, type Tokens } from "marked";
import type { CommentMention } from "../types";

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "mention"; userId: string; text: string }
  | { kind: "break" }
  | { kind: "code"; text: string }
  | { kind: "strong" | "emphasis" | "strike"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { kind: "paragraph" | "inline"; children: MarkdownInline[] }
  | { kind: "quote"; children: MarkdownBlock[] }
  | { kind: "list"; ordered: boolean; start: number | null; items: MarkdownBlock[][] }
  | { kind: "codeBlock"; text: string };

// Quotes and lists nest by recursion in the lexer, so an unbounded depth can exhaust the stack.
export const MAX_NESTING = 8;

const LINK_PROTOCOLS: ReadonlySet<string> = new Set<string>(["http:", "https:", "mailto:"]);

// Private-use markers hold each mention's place so Markdown syntax in or around a name cannot split it.
const MARK_OPEN = "";
const MARK_CLOSE = "";
const MARKERS = /[]/gu;
const PLACEHOLDER = /(\d+)/u;
const PLACEHOLDERS = /(\d+)/gu;

interface MarkedSource {
  source: string;
  labels: MarkdownInline[];
}

class CommentTokenizer extends Tokenizer {
  private depth = 0;

  private nested<Result>(tokenize: () => Result | undefined): Result | undefined {
    if (this.depth >= MAX_NESTING) return undefined;
    this.depth += 1;
    try {
      return tokenize();
    } finally {
      this.depth -= 1;
    }
  }

  override blockquote(src: string): Tokens.Blockquote | undefined {
    return this.nested((): Tokens.Blockquote | undefined => super.blockquote(src));
  }

  override list(src: string): Tokens.List | undefined {
    return this.nested((): Tokens.List | undefined => super.list(src));
  }

  override code(): undefined {
    return undefined;
  }

  override heading(): undefined {
    return undefined;
  }

  override lheading(): undefined {
    return undefined;
  }

  override hr(): undefined {
    return undefined;
  }

  override html(): undefined {
    return undefined;
  }

  override def(): undefined {
    return undefined;
  }

  override table(): undefined {
    return undefined;
  }

  override tag(): undefined {
    return undefined;
  }

  override reflink(): undefined {
    return undefined;
  }
}

function markMentions(text: string, mentions: readonly CommentMention[]): MarkedSource {
  const labels: MarkdownInline[] = [];
  let source = "";
  let offset = 0;
  for (const mention of [...mentions].sort((a: CommentMention, b: CommentMention): number => a.start - b.start)) {
    if (mention.start < offset || mention.end <= mention.start || mention.end > text.length) continue;
    source += `${text.slice(offset, mention.start).replace(MARKERS, "")}${MARK_OPEN}${labels.length}${MARK_CLOSE}`;
    labels.push({ kind: "mention", userId: mention.userId, text: text.slice(mention.start, mention.end) });
    offset = mention.end;
  }
  return { source: source + text.slice(offset).replace(MARKERS, ""), labels };
}

function labelText(label: MarkdownInline | undefined): string {
  return label?.kind === "mention" ? label.text : "";
}

function plain(value: string, labels: readonly MarkdownInline[]): string {
  return value.replace(PLACEHOLDERS, (_match: string, index: string): string => labelText(labels[Number(index)]));
}

function textNodes(value: string, labels: readonly MarkdownInline[]): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  for (const [index, part] of value.split(PLACEHOLDER).entries()) {
    if (index % 2 === 1) nodes.push(labels[Number(part)] ?? { kind: "text", text: "" });
    else if (part) nodes.push({ kind: "text", text: part });
  }
  return nodes;
}

function linkTarget(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

const WRAPPERS: ReadonlyMap<string, "strong" | "emphasis" | "strike"> = new Map<
  string,
  "strong" | "emphasis" | "strike"
>([
  ["strong", "strong"],
  ["em", "emphasis"],
  ["del", "strike"],
]);

const LITERAL_TEXT: ReadonlySet<string> = new Set<string>(["text", "escape"]);

function childTokens(token: Token): readonly Token[] {
  return "tokens" in token ? (token.tokens ?? []) : [];
}

function inlineNodes(tokens: readonly Token[], labels: readonly MarkdownInline[]): MarkdownInline[] {
  return tokens.flatMap((token: Token): MarkdownInline[] => inlineNode(token, labels));
}

function inlineNode(token: Token, labels: readonly MarkdownInline[]): MarkdownInline[] {
  const wrapper: "strong" | "emphasis" | "strike" | undefined = WRAPPERS.get(token.type);
  if (wrapper) return [{ kind: wrapper, children: inlineNodes(childTokens(token), labels) }];
  if (token.type === "br") return [{ kind: "break" }];
  if (token.type === "codespan") return [{ kind: "code", text: plain((token as Tokens.Codespan).text, labels) }];
  if (token.type === "link") {
    const link = token as Tokens.Link;
    const href: string | null = linkTarget(plain(link.href, labels));
    if (href !== null) return [{ kind: "link", href, children: inlineNodes(link.tokens, labels) }];
  }
  if (LITERAL_TEXT.has(token.type)) {
    const nested: readonly Token[] = childTokens(token);
    return nested.length > 0 ? inlineNodes(nested, labels) : textNodes((token as Tokens.Text).text, labels);
  }
  return textNodes(token.raw, labels);
}

function listBlock(list: Tokens.List, labels: readonly MarkdownInline[]): MarkdownBlock {
  return {
    kind: "list",
    ordered: list.ordered,
    start: typeof list.start === "number" ? list.start : null,
    items: list.items.map((item: Tokens.ListItem): MarkdownBlock[] => blockNodes(item.tokens, labels)),
  };
}

function blockNodes(tokens: readonly Token[], labels: readonly MarkdownInline[]): MarkdownBlock[] {
  return tokens.flatMap((token: Token): MarkdownBlock[] => blockNode(token, labels));
}

function blockNode(token: Token, labels: readonly MarkdownInline[]): MarkdownBlock[] {
  if (token.type === "space") return [];
  if (token.type === "paragraph") return [{ kind: "paragraph", children: inlineNodes(childTokens(token), labels) }];
  if (token.type === "blockquote") return [{ kind: "quote", children: blockNodes(childTokens(token), labels) }];
  if (token.type === "list") return [listBlock(token as Tokens.List, labels)];
  if (token.type === "code") return [{ kind: "codeBlock", text: plain((token as Tokens.Code).text, labels) }];
  return [{ kind: "inline", children: inlineNode(token, labels) }];
}

/** Parses the author's raw comment text into the supported Markdown subset; everything else stays literal text. */
export function parseCommentMarkdown(text: string, mentions: readonly CommentMention[] = []): MarkdownBlock[] {
  const { source, labels }: MarkedSource = markMentions(text, mentions);
  const lexer = new Lexer({ gfm: true, breaks: true, tokenizer: new CommentTokenizer() });
  return blockNodes(lexer.lex(source), labels);
}
