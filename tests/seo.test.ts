import { describe, expect, it } from "vitest";
import { canonicalMeta, PUBLIC_PAGE_PATHS, streamerCanonicalPath } from "../app/lib/seo";

const matches = [
  { id: "root", loaderData: { origin: "https://streambullets.com" }, pathname: "/", params: {}, handle: undefined },
];

describe("canonical URLs", (): void => {
  it("uses configured origins for public pages and omits links without shell data", (): void => {
    for (const path of PUBLIC_PAGE_PATHS) {
      expect(canonicalMeta(matches, path)).toEqual([
        { tagName: "link", rel: "canonical", href: `https://streambullets.com${path}` },
      ]);
    }
    expect(canonicalMeta([], "/")).toEqual([]);
  });

  it("preserves resolved tab, entry and event identity", (): void => {
    expect(streamerCanonicalPath("demo", "topics", null, null)).toBe("/@demo");
    expect(streamerCanonicalPath("demo", "about", null, null)).toBe("/@demo?view=about");
    expect(streamerCanonicalPath("demo", "polls", "a&b", null)).toBe("/@demo?entry=a%26b");
    expect(streamerCanonicalPath("demo", "schedule", null, "event-id")).toBe("/@demo?view=schedule&event=event-id");
    expect(streamerCanonicalPath("demo", "topics", "entry-id", "event-id")).toBe("/@demo?entry=entry-id");
  });
});
