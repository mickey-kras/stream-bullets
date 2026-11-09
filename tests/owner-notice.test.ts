import { describe, expect, it } from "vitest";
import { ownerNotice } from "../app/lib/moderation";

describe("ownerNotice", () => {
  const nov5 = Date.UTC(2026, 10, 5, 12);

  it("says nothing for an active page", () => {
    expect(ownerNotice("active", "spam", nov5)).toBe("");
  });

  it("gives the date, the reason, then what it means, like the mockup", () => {
    expect(ownerNotice("frozen", "harassment", nov5)).toBe(
      "Your page was frozen on Nov 5, 2026. Reason: Harassment or hate. " +
        "Your content stays visible, but no one can post or vote.",
    );
    expect(ownerNotice("suspended", null, nov5)).toBe(
      "Your page was suspended on Nov 5, 2026. It's hidden from the public until the suspension is lifted.",
    );
  });

  it("falls back to the undated notice for pages moderated before the date was kept", () => {
    expect(ownerNotice("frozen", "Old free text")).toBe(
      "Your page is frozen. Your content stays visible, but no one can post or vote. Reason: Old free text.",
    );
  });
});
