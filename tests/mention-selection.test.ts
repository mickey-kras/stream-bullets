import { afterEach, describe, expect, it, vi } from "vitest";
import { retainedMentions, type MentionSelection } from "../app/components/mention-input";
import { draftSchema, readDraft } from "../app/lib/discussion-draft";

const selection: MentionSelection = {
  userId: "public-account",
  start: 3,
  end: 7,
};
describe("selected mention identity during editing", () => {
  it("moves a selected account when text is inserted before its label", () => {
    expect(retainedMentions([selection], { start: 1, end: 2, insertedLength: 5 })).toEqual([
      { ...selection, start: 7, end: 11 },
    ]);
  });
  it("drops identity if the selected label is modified", () => {
    expect(retainedMentions([selection], { start: 5, end: 6, insertedLength: 1 })).toEqual([]);
  });
  it("keeps identity when text after the label changes", () => {
    expect(retainedMentions([selection], { start: 8, end: 8, insertedLength: 6 })).toEqual([selection]);
  });
  it("drops a deleted label and shifts a later selected account", () => {
    expect(
      retainedMentions(
        [
          { userId: "a", start: 0, end: 4 },
          { userId: "b", start: 5, end: 7 },
        ],
        { start: 0, end: 5, insertedLength: 0 },
      ),
    ).toEqual([{ userId: "b", start: 0, end: 2 }]);
  });
  it("does not transfer selected identity to a pasted identical label", () => {
    expect(
      retainedMentions([{ userId: "a", start: 0, end: 4 }], {
        start: 5,
        end: 5,
        insertedLength: 5,
      }),
    ).toEqual([{ userId: "a", start: 0, end: 4 }]);
  });
  it("retains the intended account when an identically named account is deleted", () => {
    expect(
      retainedMentions(
        [
          { userId: "a", start: 0, end: 4 },
          { userId: "b", start: 5, end: 9 },
        ],
        { start: 4, end: 9, insertedLength: 0 },
      ),
    ).toEqual([{ userId: "a", start: 0, end: 4 }]);
  });
  it("uses UTF-16 offsets for insertion before emoji and names", () => {
    expect(retainedMentions([selection], { start: 0, end: 0, insertedLength: 3 })).toEqual([
      { ...selection, start: 6, end: 10 },
    ]);
  });
  it("restores drafts with opaque account IDs used by authentication", () => {
    const draft = {
      text: "@Ana draft",
      mentions: [{ userId: "opaqueAccount123", start: 0, end: 4 }],
      replyText: "@Bob reply",
      replyMentions: [{ userId: "anotherAccount", start: 0, end: 4 }],
      replyId: "11111111-1111-4111-8111-111111111111",
    };
    expect(draftSchema.parse(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("draft storage failures", () => {
  it("reports unavailable storage without throwing away the current editor", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (): never => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
    expect(readDraft("entry").unavailable).toBe(true);
  });
  it("reports a browser policy that denies the storage property itself", () => {
    vi.stubGlobal("sessionStorage", null);
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: (): never => {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
    expect(readDraft("entry").unavailable).toBe(true);
  });
  it("reports a corrupt saved draft", () => {
    vi.stubGlobal("sessionStorage", { getItem: (): string => "{invalid" });
    expect(readDraft("entry").unavailable).toBe(true);
  });
  it("restores root and reply state together using opaque identities", () => {
    const draft = {
      text: "@Ana unsent",
      mentions: [{ userId: "account", start: 0, end: 4 }],
      replyText: "Unsent reply",
      replyMentions: [],
      replyId: "11111111-1111-4111-8111-111111111111",
    };
    vi.stubGlobal("sessionStorage", { getItem: (): string => JSON.stringify(draft) });
    expect(readDraft("entry")).toEqual({ draft, unavailable: false });
  });
});
