import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { expect, it } from "vitest";
import Streamers from "../app/routes/streamers";
import type { FeaturedStreamer } from "../app/server/featured-streamer.server";
import type { Streamer } from "../app/types";

it("gives signed-out visitors a host request link when the directory is empty", async (): Promise<void> => {
  const handler = createStaticHandler([{
    path: "/streamers",
    Component: Streamers,
    loader: () => ({ streamers: [], total: 0, nextCursor: null, featured: null, query: "", intent: null }),
  }]);
  const result = await handler.query(new Request("https://stream.example.test/streamers"));
  if (result instanceof Response) throw new Error("Expected directory data.");
  const markup: string = renderToStaticMarkup(createElement(StaticRouterProvider, {
    router: createStaticRouter(handler.dataRoutes, result), context: result,
  }));
  expect(markup).toContain("No streamer pages yet.");
  expect(markup).toContain('href="/streamers?dialog=host"');
  expect(markup).toContain("Viewers can ask their streamer to join.");
  expect(markup).not.toContain('id="ideas-strip-title"');
});


it("shows the official page as the ideas strip, not as a streamer, and sends voting to ideas", async (): Promise<void> => {
  const official: Streamer = {
    id: "official", handle: "streambullets", name: "StreamBullets", about: "", avatar: null,
    background: null, ownerId: "owner", logo: null, ownerAvatarPreset: null, isOfficial: true,
    status: "active", statusReason: null, statusChangedAt: null, handleChangedAt: null,
  };
  const featured: FeaturedStreamer = { handle: official.handle, name: official.name, isOfficial: true, entries: [] };
  const handler = createStaticHandler([{
    path: "/streamers", Component: Streamers,
    loader: () => ({ streamers: [official], total: 1, nextCursor: null, featured, query: "", intent: "vote" }),
  }]);
  const result = await handler.query(new Request("https://stream.example.test/streamers?then=vote"));
  if (result instanceof Response) throw new Error("Expected directory data.");
  const markup: string = renderToStaticMarkup(createElement(StaticRouterProvider, {
    router: createStaticRouter(handler.dataRoutes, result), context: result,
  }));
  expect(markup).toContain("Public pages");
  expect(markup).toContain('id="ideas-strip-title"');
  expect(markup).toContain("Help shape StreamBullets.");
  expect(markup).toContain('href="/@streambullets?view=topics"');
  expect(markup).not.toContain('href="/@streambullets?view=polls"');
  // The official page is the only page, so the list of streamers is empty.
  expect(markup).not.toContain("streamer-card");
  expect(markup).toContain("No streamer pages yet.");
});

it("keeps a second official page as a card when the ideas strip stands for the first one", async (): Promise<void> => {
  const base: Streamer = {
    id: "official", handle: "streambullets", name: "StreamBullets", about: "", avatar: null,
    background: null, ownerId: "owner", logo: null, ownerAvatarPreset: null, isOfficial: true,
    status: "active", statusReason: null, statusChangedAt: null, handleChangedAt: null,
  };
  const second: Streamer = { ...base, id: "second", handle: "second_official", name: "Second official" };
  const featured: FeaturedStreamer = { handle: base.handle, name: base.name, isOfficial: true, entries: [] };
  const handler = createStaticHandler([{
    path: "/streamers", Component: Streamers,
    loader: () => ({ streamers: [base, second], total: 2, nextCursor: null, featured, query: "", intent: null }),
  }]);
  const result = await handler.query(new Request("https://stream.example.test/streamers"));
  if (result instanceof Response) throw new Error("Expected directory data.");
  const markup: string = renderToStaticMarkup(createElement(StaticRouterProvider, {
    router: createStaticRouter(handler.dataRoutes, result), context: result,
  }));
  expect(markup).toContain('href="/@second_official"');
  expect(markup).toContain('class="official-badge"');
  expect(markup).toContain("Showing 1 page");
});

it("offers a native no-results recovery link that preserves the visitor intent", async (): Promise<void> => {
  const handler = createStaticHandler([{
    path: "/streamers", Component: Streamers,
    loader: () => ({ streamers: [], total: 0, nextCursor: null, featured: null, query: "missing", intent: "vote" }),
  }]);
  const result = await handler.query(new Request("https://stream.example.test/streamers?query=missing&then=vote"));
  if (result instanceof Response) throw new Error("Expected directory data.");
  const markup: string = renderToStaticMarkup(createElement(StaticRouterProvider, {
    router: createStaticRouter(handler.dataRoutes, result), context: result,
  }));
  expect(markup).toContain('href="/streamers?then=vote"');
  expect(markup).toContain("Clear search</a>");
  expect(markup).toContain("No streamers match");
});
