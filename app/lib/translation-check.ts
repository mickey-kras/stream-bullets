// Checks on a machine translation of a comment. The translation must keep the Markdown structure, the code,
// the links and the mentions of the source. A translation that fails a check is not shown.

import { parseCommentMarkdown, type MarkdownBlock, type MarkdownInline } from "./comment-markdown";

export interface MentionRange {
  userId: string;
  start: number;
  end: number;
}

// The parsed comment without its text: the blocks, the marks, the line breaks, the code and the link addresses.
function inlineShape(nodes: readonly MarkdownInline[]): unknown[] {
  return nodes.flatMap((node: MarkdownInline): unknown[] => {
    if (node.kind === "text" || node.kind === "mention") return [];
    // A line break in a paragraph is not structure. The model joins lines that the author divided by hand.
    if (node.kind === "break") return [];
    if (node.kind === "code") return [{ code: node.text }];
    if (node.kind === "link") return [{ link: node.href, children: inlineShape(node.children) }];
    return [{ mark: node.kind, children: inlineShape(node.children) }];
  });
}

function blockShape(blocks: readonly MarkdownBlock[]): unknown[] {
  return blocks.map((block: MarkdownBlock): unknown => {
    if (block.kind === "codeBlock") return { codeBlock: block.text };
    if (block.kind === "quote") return { quote: blockShape(block.children) };
    if (block.kind === "list") return { list: block.ordered, start: block.start, items: block.items.map(blockShape) };
    return { [block.kind]: inlineShape(block.children) };
  });
}

/**
 * Whether `translation` has the same structure as `source`. The comment renderer parses the two texts, so the
 * check reads each form of a mark, a code block and a link as the page shows it.
 */
export function keepsStructure(source: string, translation: string): boolean {
  return (
    JSON.stringify(blockShape(parseCommentMarkdown(source))) ===
    JSON.stringify(blockShape(parseCommentMarkdown(translation)))
  );
}

/**
 * The mention ranges in `translation`. Each mention label of the source must be in the translation as the same
 * text. The labels are found in the order of the source. Null when a label is missing.
 */
export function moveMentions(
  source: string,
  mentions: readonly MentionRange[],
  translation: string,
): MentionRange[] | null {
  const ordered: MentionRange[] = [...mentions].sort((a: MentionRange, b: MentionRange): number => a.start - b.start);
  const moved: MentionRange[] = [];
  const taken: [number, number][] = [];
  for (const mention of ordered) {
    const label: string = source.slice(mention.start, mention.end);
    let from: number = 0;
    let found: number = -1;
    while (found === -1) {
      const at: number = translation.indexOf(label, from);
      if (at === -1) return null;
      const free: boolean = taken.every(
        ([start, end]: [number, number]): boolean => at >= end || at + label.length <= start,
      );
      if (free) found = at;
      else from = at + 1;
    }
    taken.push([found, found + label.length]);
    moved.push({ userId: mention.userId, start: found, end: found + label.length });
  }
  return moved;
}

/** The answer of the model: a line `ORIGINAL=<code>`, a line `---`, then the translation. Null when the form is wrong. */
export function readAnswer(answer: string): string | null {
  const match = /^ORIGINAL=[^\n]*\n---\n([\s\S]+)$/u.exec(answer.trim());
  return match ? match[1] : null;
}
