// Checks on a machine translation of a comment. The translation must keep the Markdown structure, the code,
// the links and the mentions of the source. A translation that fails a check is not shown.

export interface MentionRange {
  userId: string;
  start: number;
  end: number;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

// The number of each Markdown mark and of the line breaks.
function shape(text: string): string {
  return [
    count(text, /\*\*/gu),
    count(text, /~~/gu),
    count(text, /```/gu),
    count(text, /^> /gmu),
    count(text, /^- /gmu),
    count(text, /^\d+\. /gmu),
    count(text, /\n/gu),
  ].join(",");
}

function codeSpans(text: string): string {
  return (text.match(/```[\s\S]*?```|`[^`\n]+`/gu) ?? []).join("\n");
}

function links(text: string): string {
  return (text.match(/(?:https?:\/\/|mailto:)[^\s)]+/gu) ?? []).join("\n");
}

/** Whether `translation` has the same Markdown marks, line breaks, code and links as `source`. */
export function keepsStructure(source: string, translation: string): boolean {
  return (
    shape(source) === shape(translation) &&
    codeSpans(source) === codeSpans(translation) &&
    links(source) === links(translation)
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
