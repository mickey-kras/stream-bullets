import { describe, expect, it } from "vitest";
import { keepsStructure, moveMentions, readAnswer } from "../app/lib/translation-check";

describe("translation checks", (): void => {
  it("accepts a translation with the same marks, code and links", (): void => {
    const source = "**Great** stream, see `/help`\n- one\n- two\n[guide](https://example.test/a?b=1)";
    const good = "**Toller** Stream, siehe `/help`\n- eins\n- zwei\n[Anleitung](https://example.test/a?b=1)";
    expect(keepsStructure(source, good)).toBe(true);
  });
  it.each([
    ["a lost bold mark", "**Great** stream", "Toller Stream"],
    ["a lost quote mark", "> quoted\n\nreply", "zitiert\n\nAntwort"],
    ["changed code", "run `!jump` now", "jetzt `!springen` ausführen"],
    ["a changed link", "see https://example.test/a", "siehe https://example.test/b"],
    ["a changed mail address", "Mail [us](mailto:help@example.test)", "Mail [uns](mailto:wrong@example.test)"],
    ["a lost line break", "one\ntwo", "eins zwei"],
  ])("refuses %s", (_name: string, source: string, translation: string): void => {
    expect(keepsStructure(source, translation)).toBe(false);
  });
  it("moves each mention range to the place of its label in the translation", (): void => {
    const source = "Thanks @owner and @Other Viewer, it works";
    const mentions = [
      { userId: "u2", start: 18, end: 31 },
      { userId: "u1", start: 7, end: 13 },
    ];
    const translation = "Danke @owner und @Other Viewer, es geht";
    expect(moveMentions(source, mentions, translation)).toEqual([
      { userId: "u1", start: 6, end: 12 },
      { userId: "u2", start: 17, end: 30 },
    ]);
  });
  it("gives each of two equal labels its own place", (): void => {
    const source = "@Ann and @Ann";
    const mentions = [
      { userId: "u1", start: 0, end: 4 },
      { userId: "u1", start: 9, end: 13 },
    ];
    expect(moveMentions(source, mentions, "@Ann und @Ann")).toEqual([
      { userId: "u1", start: 0, end: 4 },
      { userId: "u1", start: 9, end: 13 },
    ]);
  });
  it("gives no ranges when a label is not in the translation", (): void => {
    expect(moveMentions("hi @Bob Lee", [{ userId: "u1", start: 3, end: 11 }], "hallo @Bob")).toBeNull();
  });
  it("reads the translation from the answer form and refuses another form", (): void => {
    expect(readAnswer("ORIGINAL=en\n---\nHallo\nWelt")).toBe("Hallo\nWelt");
    expect(readAnswer("  ORIGINAL=ru\n---\nHello  ")).toBe("Hello");
    expect(readAnswer("Hello")).toBeNull();
    expect(readAnswer("ORIGINAL=en\n---\n")).toBeNull();
  });
});
