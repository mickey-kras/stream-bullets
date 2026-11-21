import { createEditor, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
  $readComment,
  $writeComment,
  COMMENT_NODES,
  markMentions,
  unmarkMentions,
  type CommentValue,
} from "../app/lib/rich-comment";

function roundTrip(value: CommentValue): CommentValue {
  const editor: LexicalEditor = createEditor({
    namespace: "test",
    nodes: COMMENT_NODES,
    onError: (error: Error): void => {
      throw error;
    },
  });
  editor.update(() => $writeComment(value), { discrete: true });
  return editor.getEditorState().read($readComment);
}

describe("mention marks", (): void => {
  it("marks each range and gives the same ranges back", (): void => {
    const value: CommentValue = {
      text: "@Ann and @Bob Lee, look.",
      mentions: [
        { userId: "u2", start: 9, end: 17 },
        { userId: "u1", start: 0, end: 4 },
      ],
    };
    const marked: string = markMentions(value);
    expect(marked).not.toBe(value.text);
    expect(unmarkMentions(marked)).toEqual({
      text: value.text,
      mentions: [
        { userId: "u1", start: 0, end: 4 },
        { userId: "u2", start: 9, end: 17 },
      ],
    });
  });
  it("ignores a range that does not fit the text", (): void => {
    const value: CommentValue = { text: "short", mentions: [{ userId: "u1", start: 3, end: 40 }] };
    expect(markMentions(value)).toBe("short");
  });
  it("leaves text without marks unchanged", (): void => {
    expect(unmarkMentions("plain *text*")).toEqual({ text: "plain *text*", mentions: [] });
  });
});

describe("comment editor text", (): void => {
  it.each([
    "Plain text.",
    "First line\nSecond line",
    "Para one\n\nPara two",
    "**bold** *italic* ~~gone~~ `code`",
    "A [link](https://example.test/a) here",
    "- one\n- two",
    "1. one\n2. two",
    "> quoted",
    "```\nconst a = 1;\n  indented\n```",
  ])("keeps %j", (text: string): void => {
    expect(roundTrip({ text, mentions: [] })).toEqual({ text, mentions: [] });
  });
  it("keeps a mention and its range next to formatted text", (): void => {
    const value: CommentValue = {
      text: "**Hi** @Bob Lee, see `x`",
      mentions: [{ userId: "u7", start: 7, end: 15 }],
    };
    expect(roundTrip(value)).toEqual(value);
  });
  it("keeps a mention label with Markdown characters as plain text", (): void => {
    const value: CommentValue = { text: "@a_b_c *d* hi", mentions: [{ userId: "u9", start: 0, end: 10 }] };
    expect(roundTrip(value)).toEqual(value);
  });
});
