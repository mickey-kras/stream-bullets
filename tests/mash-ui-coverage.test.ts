import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { Dialog as RadixDialog } from "radix-ui";
import { CommunityView } from "../app/components/community/community-view";
import { ScheduleForm } from "../app/components/schedule/schedule-form";
import { EventDialog } from "../app/components/schedule/event-dialog";
import { scoreText } from "../app/components/mash/mash-card";
import { MashBars, MashWinner } from "../app/components/mash/mash-parts";
import { MASH_DRAW } from "../app/lib/mash";

describe("Mash score presentation", (): void => {
  it("announces the viewer's side first while preserving opponent order", (): void => {
    expect(scoreText(["Sun", "Moon", "Stars"], [1234, 2, 3], 1, 10)).toBe(
      "Moon (your side) 2, Sun 1,234, Stars 3. 10 s left.",
    );
    expect(scoreText(["Sun", "Moon"], [], null, 5)).toBe("Sun 0, Moon 0. 5 s left.");
  });

  it("keeps empty scores readable and marks the selected side independently of color", (): void => {
    const empty: string = renderToStaticMarkup(createElement(MashBars, { sides: ["Sun", "Moon"], totals: [] }));
    expect(empty.match(/data-mash-total="\d">0</gu)).toHaveLength(2);
    expect(empty).not.toContain("is-mine");
    const selected: string = renderToStaticMarkup(
      createElement(MashBars, {
        sides: ["Sun", "Moon"],
        totals: [1, 2],
        mySide: 1,
      }),
    );
    expect(selected).toContain('class="mash-side-total is-mine"');
    expect(selected).toContain("(your side)</span>");
    expect(selected).toContain('data-mash-pct="0">33%');
    expect(selected).toContain('data-mash-pct="1">67%');
    const overlay: string = renderToStaticMarkup(
      createElement(MashBars, {
        sides: ["Sun", "Moon"],
        totals: [1, 2],
        mySide: 1,
        big: true,
      }),
    );
    expect(overlay).toContain('class="mash-bars big"');
    expect(overlay).not.toContain("mine-tag");
  });

  it("presents a draw without winner confetti in both card and overlay layouts", (): void => {
    for (const big of [false, true]) {
      const markup: string = renderToStaticMarkup(
        createElement(MashWinner, {
          sides: ["Sun", "Moon"],
          winner: MASH_DRAW,
          big,
        }),
      );
      expect(markup).toContain("Final");
      expect(markup).toContain("<strong>Draw</strong>");
      expect(markup).not.toContain("<i ");
      expect(markup.includes('class="mash-winner big"')).toBe(big);
    }
  });
});

describe("empty community and schedule presentations", (): void => {
  it("offers topics when an owner has removed every community card", (): void => {
    const markup: string = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/@quiet_host?view=community"] },
        createElement(CommunityView, {
          name: "Quiet host",
          cards: [],
          support: { links: [], visible: true, card: false },
          owner: false,
          writable: true,
          adding: false,
          onAdding: (): void => undefined,
          onChanged: (): Promise<void> => Promise.resolve(),
        }),
      ),
    );
    expect(markup).toContain("Nothing here yet.");
    expect(markup).toContain('href="/@quiet_host?view=topics"');
    expect(markup).not.toContain('class="community-grid');
    expect(markup).not.toContain("card-tools");
  });

  it("starts an empty schedule with a blank channel and no topic picker or event dialog", (): void => {
    const markup: string = renderToStaticMarkup(
      createElement(
        RadixDialog.Root,
        { open: true },
        createElement(ScheduleForm, {
          formId: "empty-schedule",
          event: null,
          zone: "UTC",
          events: [],
          topics: [],
          onSubmit: (): Promise<void> => Promise.resolve(),
        }),
      ),
    );
    expect(markup).toContain('id="empty-schedule"');
    expect(markup).toMatch(/name="url"[^>]*value=""/u);
    expect(markup).not.toContain('class="topic-chips"');
    expect(
      renderToStaticMarkup(
        createElement(EventDialog, {
          event: null,
          step: "view",
          zone: "UTC",
          handle: "quiet_host",
          name: "Quiet host",
          owner: false,
          events: [],
          topics: [],
          onStep: (): void => undefined,
          onClose: (): void => undefined,
          onChanged: (): Promise<void> => Promise.resolve(),
        }),
      ),
    ).toBe("");
  });
});
