import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import StreamerPage from "../app/routes/streamer";
import { PollCard } from "../app/components/poll";
import type { Entry, EntryStatus, SortOrder, Streamer } from "../app/types";

const NOW: number = Date.UTC(2026, 10, 12, 12);

function streamer(official: boolean): Streamer {
  return {
    id: official ? "official" : "page",
    handle: official ? "streambullets" : "test_host",
    name: official ? "StreamBullets" : "Test host",
    about: "",
    avatar: null,
    background: null,
    ownerId: "owner",
    logo: null,
    ownerAvatarPreset: null,
    isOfficial: official,
    status: "active",
    statusReason: null,
    statusChangedAt: null,
    handleChangedAt: null,
  };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    streamerId: "page",
    authorId: "author",
    author: "Author",
    avatar: null,
    avatarPreset: null,
    kind: "topic",
    title: "A topic",
    body: "",
    category: "Gaming",
    createdAt: NOW - 60_000,
    endsAt: null,
    revealed: false,
    options: [],
    counts: null,
    total: 0,
    likes: 0,
    dislikes: 0,
    comments: 0,
    reaction: 0,
    myVote: null,
    status: null,
    statusReason: null,
    reported: false,
    mash: null,
    ...overrides,
  };
}

/** Renders the streamer page's Topics tab with loader data, as the server does. */
async function renderBoard(
  options: Readonly<{ official: boolean; entries: Entry[]; query?: string; status?: EntryStatus | null }>,
): Promise<string> {
  const page: Streamer = streamer(options.official);
  const sort: SortOrder = "top";
  const data = {
    board: { streamer: page, entries: options.entries, nextCursor: null, revision: 0, serverNow: NOW },
    selected: null,
    viewer: null,
    moderator: false,
    providers: ["github"],
    view: "topics",
    sort,
    query: options.query ?? "",
    status: options.status ?? null,
    events: [],
    linkedEvent: null,
    openEvent: null,
    mode: "feed",
    serverNow: NOW,
    cards: null,
    support: { links: [], card: false },
    topicChoices: [],
    intent: null,
  };
  const handler = createStaticHandler([{ path: "/:handle", Component: StreamerPage, loader: () => data }]);
  const params = new URLSearchParams({ view: "topics" });
  if (options.query) params.set("query", options.query);
  if (options.status) params.set("status", options.status);
  const result = await handler.query(new Request(`https://stream.example.test/@${page.handle}?${params}`));
  if (result instanceof Response) throw new Error("Expected board data.");
  return renderToStaticMarkup(
    createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, result), context: result }),
  );
}

describe("board states", (): void => {
  it("shows an empty status filter as a filter result with a way back, not as an empty board", async (): Promise<void> => {
    const markup: string = await renderBoard({ official: true, entries: [], status: "shipped" });
    expect(markup).toContain("No ideas have the status “Shipped”.");
    expect(markup).toContain('href="/@streambullets?view=topics"');
    expect(markup).toContain("0 ideas");
    expect(markup).not.toContain("No ideas here yet.");
    expect(markup).not.toContain("Nothing here yet.");
  });

  it("shows an empty search as a search result with Clear search, not as an empty board", async (): Promise<void> => {
    const markup: string = await renderBoard({ official: false, entries: [], query: "zzz" });
    expect(markup).toContain("No topics match your search.");
    expect(markup).toContain("Clear search");
    expect(markup).toContain('href="/@test_host?view=topics&amp;sort=top"');
    expect(markup).not.toContain("No topics yet");
    expect(markup).not.toContain("Nothing here yet.");
  });

  it("keeps the empty board state and its suggestion action when nothing is filtered", async (): Promise<void> => {
    const markup: string = await renderBoard({ official: true, entries: [] });
    expect(markup).toContain("No ideas here yet.");
    expect(markup).toContain('class="empty-cta"');
    expect(markup).not.toContain("No ideas have the status");
  });

  it("renders long titles, zero votes and many comments as plain rows without nested controls", async (): Promise<void> => {
    const title: string = `${"A very long topic title that keeps going ".repeat(6)}end`;
    const markup: string = await renderBoard({
      official: false,
      entries: [entry({ title, comments: 1234 }), entry({ id: "entry-2", title: "Second", likes: 3, dislikes: 1 })],
    });
    expect(markup).toContain(title);
    expect(markup).toContain("0 likes, 0 dislikes, 1,234 comments");
    expect(markup).toContain('data-entry-id="entry-1"');
    // Each row is one button: no link or button inside it.
    const rows: string[] = markup.split('<button type="button" class="topic').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const inner: string = row.slice(0, row.indexOf("</button>"));
      expect(inner).not.toMatch(/<(a|button)\b/);
    }
    // The detail title can take focus when a phone swaps the list for the detail.
    expect(markup).toContain('<h2 class="detail-title" tabindex="-1">');
  });
});

describe("poll states", (): void => {
  function card(poll: Entry, signedIn: boolean = true): string {
    return renderToStaticMarkup(
      createElement(PollCard, {
        entry: poll,
        now: NOW,
        signedIn,
        owner: false,
        pending: false,
        onAction: (): void => undefined,
        onDiscuss: (): void => undefined,
        onDelete: async (): Promise<void> => undefined,
      }),
    );
  }
  const options: Pick<Entry, "kind" | "options" | "counts"> = {
    kind: "choice",
    options: ["Yes", "No"],
    counts: [0, 0],
  };

  it("keeps a poll without an end time open, with zero votes and separate like and dislike controls", (): void => {
    const markup: string = card(entry({ ...options, endsAt: null }));
    expect(markup).toContain("0 votes");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*class="poll-option/);
    // Like and Dislike are two buttons, each with its own pressed state and name.
    const reactions: string[] = markup.split('aria-pressed="false"').slice(1);
    expect(reactions.filter((button: string) => button.includes(">Like poll, <"))).toHaveLength(1);
    expect(reactions.filter((button: string) => button.includes(">Dislike poll, <"))).toHaveLength(1);
    expect(markup).toContain('data-entry-id="entry-1"');
  });

  it("closes a poll whose end time passed and a revealed poll", (): void => {
    for (const poll of [
      entry({ ...options, endsAt: NOW - 1 }),
      entry({ ...options, endsAt: null, revealed: true, counts: [2, 1], total: 3 }),
    ]) {
      const markup: string = card(poll);
      expect(markup).toContain("Voting is closed");
    }
  });
});
