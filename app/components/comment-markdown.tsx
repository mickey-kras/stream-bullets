import { useMemo, type ReactNode } from "react";
import { parseCommentMarkdown, type MarkdownBlock, type MarkdownInline } from "../lib/comment-markdown";
import type { CommentMention } from "../types";

export const USER_LINK_REL = "nofollow ugc noopener noreferrer";

function inline(node: MarkdownInline, key: number): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "mention":
      return (
        <strong className="comment-mention" key={key} title={node.userId}>
          {node.text}
        </strong>
      );
    case "break":
      return <br key={key} />;
    case "code":
      return <code key={key}>{node.text}</code>;
    case "strong":
      return <strong key={key}>{node.children.map(inline)}</strong>;
    case "emphasis":
      return <em key={key}>{node.children.map(inline)}</em>;
    case "strike":
      return <del key={key}>{node.children.map(inline)}</del>;
    case "link":
      return (
        <a key={key} href={node.href} target="_blank" rel={USER_LINK_REL}>
          {node.children.map(inline)}
        </a>
      );
  }
}

function block(node: MarkdownBlock, key: number): ReactNode {
  switch (node.kind) {
    case "paragraph":
      return <p key={key}>{node.children.map(inline)}</p>;
    case "inline":
      return node.children.map(inline);
    case "quote":
      return <blockquote key={key}>{node.children.map(block)}</blockquote>;
    case "codeBlock":
      return (
        <pre key={key}>
          <code>{node.text}</code>
        </pre>
      );
    case "list": {
      const items: ReactNode[] = node.items.map(
        (item: MarkdownBlock[], index: number): ReactNode => <li key={index}>{item.map(block)}</li>,
      );
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

export function CommentMarkdown({
  text,
  mentions,
}: Readonly<{ text: string; mentions?: readonly CommentMention[] }>): ReactNode {
  const blocks: MarkdownBlock[] = useMemo(
    (): MarkdownBlock[] => parseCommentMarkdown(text, mentions),
    [text, mentions],
  );
  return blocks.map(block);
}
