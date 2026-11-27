import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ToolsHead } from "../app/components/tools/tools-head";
import { IconLink } from "../app/components/ui/icon-button";
import { DEFAULT_LOCALE, LOCALES, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { toolsViews, type ToolsView } from "../app/lib/shell";

// The head of Streamer tools, as the server renders it. The styles show the text tabs or the icon tabs, and one of
// the two names in the title: tests/e2e/shell.spec.ts covers what shows at each width.

function head(view: ToolsView): string {
  const Stub = createRoutesStub([{ path: "/tools", Component: () => createElement(ToolsHead, { view }) }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/tools"] }));
}

/** The section links of the head, one string for each link. */
function tabs(html: string): string[] {
  return html.split("</nav>")[0].split("<a ").slice(1);
}

const ICONS: Readonly<Record<ToolsView, string>> = { live: "live", overlay: "layers", channels: "channels" };
const NAMES: Readonly<Record<ToolsView, string>> = { live: "Live", overlay: "Overlay", channels: "Channels" };

describe("head of Streamer tools", (): void => {
  afterEach((): void => {
    setLocaleSource((): Locale => DEFAULT_LOCALE);
  });

  it("has one link for each section, with its icon, its name, and a tooltip", (): void => {
    const links: string[] = tabs(head("live"));
    expect(links).toHaveLength(toolsViews.length);
    toolsViews.forEach((view: ToolsView, index: number): void => {
      const link: string = links[index];
      expect(link, view).toContain(`href="/tools?view=${view}"`);
      // The name is the accessible name and the tooltip of a tab that shows only its icon.
      expect(link, view).toContain(`aria-label="${NAMES[view]}"`);
      expect(link, view).toContain(`title="${NAMES[view]}"`);
      expect(link, view).toMatch(
        new RegExp(`<svg[^>]*class="[^"]*icon-24 icon-${ICONS[view]}[^"]*"[^>]*aria-hidden="true"`),
      );
      expect(link, view).toContain(`<span class="tools-tab-label">${NAMES[view]}</span>`);
    });
  });

  it("marks only the open section as the current page", (): void => {
    for (const open of toolsViews) {
      const links: string[] = tabs(head(open));
      toolsViews.forEach((view: ToolsView, index: number): void => {
        const current: boolean = links[index].includes('aria-current="page"');
        expect(current, `${view} while ${open} is open`).toBe(view === open);
        expect(links[index].includes('class="active"'), `${view} while ${open} is open`).toBe(view === open);
      });
    }
  });

  it("has one title, with the name of the page and the name of the open section", (): void => {
    for (const view of toolsViews) {
      const html: string = head(view);
      expect(html.match(/<h1/g), view).toHaveLength(1);
      expect(html, view).toContain(
        `<h1><span class="tools-page-name">Streamer tools</span><span class="tools-section-name">${NAMES[view]}</span></h1>`,
      );
      // A phone hides the line above the title with the name of the page.
      expect(html, view).toContain('<span class="eyebrow tools-page-name">Behind the mic · owner only</span>');
      // The section links are before the title in the document: a phone pins them below the site header.
      expect(html.indexOf("<nav"), view).toBeLessThan(html.indexOf("<h1"));
      expect(html, view).toContain('aria-label="Streamer tools sections"');
    }
  });

  it("names each section in each language", async (): Promise<void> => {
    await Promise.all(LOCALES.map((locale: Locale) => loadCatalog(locale)));
    for (const locale of LOCALES) {
      setLocaleSource((): Locale => locale);
      const labels: string[] = tabs(head("live")).map(
        (link: string): string => /aria-label="([^"]*)"/.exec(link)?.[1] ?? "",
      );
      expect(labels, locale).toHaveLength(toolsViews.length);
      for (const label of labels) expect(label.trim(), locale).not.toBe("");
      expect(new Set(labels).size, locale).toBe(toolsViews.length);
    }
  });
});

describe("icon link", (): void => {
  it("is a link with the look of an icon button, a name, and a tooltip", (): void => {
    const html: string = renderToStaticMarkup(
      createElement(IconLink, { label: "Edit the overlay", icon: "pencil", href: "/tools?view=overlay" }),
    );
    expect(html).toMatch(
      /^<a class="icon-button" aria-label="Edit the overlay" title="Edit the overlay" href="\/tools\?view=overlay"><svg[^>]*aria-hidden="true"/,
    );
    expect(html).toContain("icon-20 icon-pencil");
    const custom: string = renderToStaticMarkup(
      createElement(IconLink, {
        label: "Edit",
        icon: "pencil",
        href: "/x",
        title: "Open the editor",
        className: "wide",
      }),
    );
    expect(custom).toContain('class="icon-button wide"');
    expect(custom).toContain('aria-label="Edit"');
    expect(custom).toContain('title="Open the editor"');
  });
});
