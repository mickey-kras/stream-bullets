import { Children, useMemo, type ReactNode } from "react";
import { parseCommentMarkdown, type MarkdownBlock, type MarkdownInline } from "../lib/comment-markdown";
import type { CommentMention } from "../types";

export const USER_LINK_REL = "nofollow ugc noopener noreferrer";

// The nodes of a comment have no identity and never change order: `Children.toArray` gives each element its key.
function inlines(nodes: readonly MarkdownInline[]): ReactNode[] {
  return Children.toArray(nodes.map((node: MarkdownInline): ReactNode => inline(node)));
}

function blocks(nodes: readonly MarkdownBlock[]): ReactNode[] {
  return Children.toArray(nodes.map((node: MarkdownBlock): ReactNode => block(node)));
}

function inline(node: MarkdownInline): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "mention":
      return (
        <strong className="comment-mention" title={node.userId}>
          {node.text}
        </strong>
      );
    case "break":
      return <br />;
    case "code":
      return <code>{node.text}</code>;
    case "strong":
      return <strong>{inlines(node.children)}</strong>;
    case "emphasis":
      return <em>{inlines(node.children)}</em>;
    case "strike":
      return <del>{inlines(node.children)}</del>;
    case "link":
      return (
        <a href={node.href} target="_blank" rel={USER_LINK_REL}>
          {inlines(node.children)}
        </a>
      );
  }
}

function block(node: MarkdownBlock): ReactNode {
  switch (node.kind) {
    case "paragraph":
      return <p>{inlines(node.children)}</p>;
    case "inline":
      return inlines(node.children);
    case "quote":
      return <blockquote>{blocks(node.children)}</blockquote>;
    case "codeBlock":
      return (
        <pre>
          <code>{node.text}</code>
        </pre>
      );
    case "list": {
      const items: ReactNode[] = Children.toArray(
        node.items.map((item: MarkdownBlock[]): ReactNode => <li>{blocks(item)}</li>),
      );
      return node.ordered ? <ol start={node.start ?? undefined}>{items}</ol> : <ul>{items}</ul>;
    }
  }
}

export function CommentMarkdown({
  text,
  mentions,
}: Readonly<{ text: string; mentions?: readonly CommentMention[] }>): ReactNode {
  const parsed: MarkdownBlock[] = useMemo(
    (): MarkdownBlock[] => parseCommentMarkdown(text, mentions),
    [text, mentions],
  );
  return blocks(parsed);
}
